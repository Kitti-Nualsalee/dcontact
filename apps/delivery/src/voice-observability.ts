import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { VoiceRolloutControlPlane } from './voice-rollout-control.js';

const IN_FLIGHT_STATES = ['SUBMITTING', 'SUBMITTED', 'RECONCILING'] as const;

export interface VoiceObservabilitySnapshot {
  tenantId: string;
  observedAt: string;
  settlement: {
    inFlight: number;
    reconciling: number;
    cancelRequested: number;
    oldestInFlightAgeSeconds: number | null;
  };
  control: {
    killedScopes: number;
    technicalSwitchOn: number;
    dryRunEvaluations: number;
  };
}

export async function voiceObservabilitySnapshot(
  database: PrismaClient,
  input: { tenantId: string; now?: Date },
): Promise<VoiceObservabilitySnapshot> {
  const now = input.now ?? new Date();
  return withTenantDatabaseTransaction(database, input.tenantId, async (transaction) => {
    const outbox = { tenantId: input.tenantId, adapter: 'FREESWITCH_ORIGINATE' as const };
    const [inFlight, reconciling, cancelRequested, oldest, gates, dryRunEvaluations] =
      await Promise.all([
        transaction.dlOutboxEntry.count({
          where: { ...outbox, state: { in: [...IN_FLIGHT_STATES] } },
        }),
        transaction.dlOutboxEntry.count({ where: { ...outbox, state: 'RECONCILING' } }),
        transaction.dlVoiceOriginate.count({
          where: { tenantId: input.tenantId, state: 'CANCEL_REQUESTED' },
        }),
        transaction.dlOutboxEntry.findFirst({
          where: { ...outbox, state: { in: [...IN_FLIGHT_STATES] } },
          orderBy: { updatedAt: 'asc' },
          select: { submittedAt: true, updatedAt: true },
        }),
        transaction.dlVoiceScopeGate.findMany({
          where: { tenantId: input.tenantId },
          select: { killed: true, technicalSwitchOn: true },
        }),
        transaction.dlVoiceAuditEvent.count({
          where: { tenantId: input.tenantId, code: 'VOICE_DRY_RUN_EVALUATED' },
        }),
      ]);
    const oldestAt = oldest?.submittedAt ?? oldest?.updatedAt;
    return {
      tenantId: input.tenantId,
      observedAt: now.toISOString(),
      settlement: {
        inFlight,
        reconciling,
        cancelRequested,
        oldestInFlightAgeSeconds: oldestAt
          ? Math.max(0, Math.round((now.getTime() - oldestAt.getTime()) / 1_000))
          : null,
      },
      control: {
        killedScopes: gates.filter((gate) => gate.killed).length,
        technicalSwitchOn: gates.filter((gate) => gate.technicalSwitchOn).length,
        dryRunEvaluations,
      },
    };
  });
}

export type VoiceAlertCode =
  | 'VOICE_SETTLEMENT_STUCK'
  | 'VOICE_UNKNOWN_RECONCILING'
  | 'VOICE_CANCEL_REQUESTED'
  | 'VOICE_SCOPE_KILLED';

export interface VoiceAlert {
  code: VoiceAlertCode;
  severity: 'WARNING' | 'CRITICAL';
  value: number;
  threshold: number;
}

export const VOICE_SETTLEMENT_STUCK_SECONDS = 2 * 60;

export function evaluateVoiceAlerts(
  snapshot: VoiceObservabilitySnapshot,
  stuckSeconds = VOICE_SETTLEMENT_STUCK_SECONDS,
): VoiceAlert[] {
  const alerts: VoiceAlert[] = [];
  const over = (
    code: VoiceAlertCode,
    severity: VoiceAlert['severity'],
    value: number | null,
    threshold: number,
  ) => {
    if (value !== null && value > threshold) alerts.push({ code, severity, value, threshold });
  };
  over(
    'VOICE_SETTLEMENT_STUCK',
    'CRITICAL',
    snapshot.settlement.oldestInFlightAgeSeconds,
    stuckSeconds,
  );
  over('VOICE_UNKNOWN_RECONCILING', 'WARNING', snapshot.settlement.reconciling, 0);
  over('VOICE_CANCEL_REQUESTED', 'WARNING', snapshot.settlement.cancelRequested, 0);
  over('VOICE_SCOPE_KILLED', 'WARNING', snapshot.control.killedScopes, 0);
  return alerts;
}

/**
 * Kill เฉพาะ scope ที่มี voice delivery ค้างหลัง barrier; ไม่มีการ resend หรือ settle อัตโนมัติ.
 */
export async function killStuckVoiceScopes(
  database: PrismaClient,
  input: { tenantId: string; now?: Date; stuckSeconds?: number; actorRef?: string },
): Promise<string[]> {
  const now = input.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - (input.stuckSeconds ?? VOICE_SETTLEMENT_STUCK_SECONDS) * 1_000,
  );
  const nodes = await withTenantDatabaseTransaction(database, input.tenantId, (transaction) =>
    transaction.$queryRaw<Array<{ telephony_node_id: string }>>(Prisma.sql`
      SELECT DISTINCT voice.telephony_node_id
      FROM dl_voice_originates AS voice
      JOIN dl_outbox_entries AS outbox
        ON outbox.tenant_id = voice.tenant_id AND outbox.delivery_id = voice.delivery_id
      JOIN dl_voice_scope_gates AS gate
        ON gate.tenant_id = voice.tenant_id AND gate.telephony_node_id = voice.telephony_node_id
      WHERE voice.tenant_id = ${input.tenantId}::uuid
        AND outbox.adapter = 'FREESWITCH_ORIGINATE'
        AND outbox.state IN ('SUBMITTING', 'SUBMITTED', 'RECONCILING')
        AND outbox.updated_at <= ${cutoff}
        AND gate.killed = false
    `),
  );
  const rollout = new VoiceRolloutControlPlane(database);
  for (const node of nodes) {
    await rollout.kill(
      { tenantId: input.tenantId, telephonyNodeId: node.telephony_node_id },
      input.actorRef ?? 'system:voice-stuck-watchdog',
      now,
    );
  }
  return nodes.map((node) => node.telephony_node_id);
}
