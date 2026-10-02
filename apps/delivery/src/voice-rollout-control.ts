import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type DlVoiceRolloutState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';

export interface VoiceRolloutScope {
  tenantId: string;
  telephonyNodeId: string;
}

export interface VoiceRolloutAuthorizationInput extends VoiceRolloutScope {
  deliveryId: string;
  agentUserId: string;
  targetIdentityId: string;
  at: Date;
}

export type VoiceRolloutEvaluationInput = Omit<VoiceRolloutAuthorizationInput, 'deliveryId'>;

export type VoiceRolloutAuthorization =
  | { status: 'ALLOWED'; state: 'SANDBOX' | 'CAPPED_PILOT'; replay: boolean }
  | { status: 'DENIED'; reasonCode: string };

export interface VoiceRolloutAuthority {
  evaluate(input: VoiceRolloutEvaluationInput): Promise<VoiceRolloutAuthorization>;
  authorize(input: VoiceRolloutAuthorizationInput): Promise<VoiceRolloutAuthorization>;
}

const ADVANCE_ORDER: DlVoiceRolloutState[] = ['DISABLED', 'DRY_RUN', 'SANDBOX', 'CAPPED_PILOT'];

export class VoiceRolloutControlPlane implements VoiceRolloutAuthority {
  constructor(
    private readonly database: PrismaClient,
    private readonly id: () => string = randomUUID,
  ) {}

  ensureScope(scope: VoiceRolloutScope) {
    return withTenantDatabaseTransaction(this.database, scope.tenantId, async (transaction) => {
      await transaction.dlVoiceScopeGate.createMany({
        data: [{ id: this.id(), ...scope }],
        skipDuplicates: true,
      });
      return transaction.dlVoiceScopeGate.findFirstOrThrow({ where: scope });
    });
  }

  async advanceState(
    scope: VoiceRolloutScope,
    target: DlVoiceRolloutState,
    actorRef: string,
    at: Date,
  ) {
    return withTenantDatabaseTransaction(this.database, scope.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM dl_voice_scope_gates
        WHERE tenant_id = ${scope.tenantId}::uuid AND telephony_node_id = ${scope.telephonyNodeId}
        FOR UPDATE
      `);
      const gate = await transaction.dlVoiceScopeGate.findFirstOrThrow({
        where: { tenantId: scope.tenantId, id: rows[0]?.id ?? '' },
      });
      if (
        gate.killed ||
        ADVANCE_ORDER.indexOf(target) !== ADVANCE_ORDER.indexOf(gate.businessState) + 1
      ) {
        throw new Error('VOICE_ROLLOUT_INVALID_TRANSITION');
      }
      const updated = await transaction.dlVoiceScopeGate.update({
        where: { id: gate.id },
        data: { businessState: target, version: { increment: 1 } },
      });
      await this.audit(
        transaction,
        scope.tenantId,
        `advance:${gate.id}:${updated.version}`,
        'VOICE_ROLLOUT_ADVANCED',
        actorRef,
        gate.id,
        at,
      );
      return updated;
    });
  }

  async setTechnicalSwitch(scope: VoiceRolloutScope, enabled: boolean, actorRef: string, at: Date) {
    return withTenantDatabaseTransaction(this.database, scope.tenantId, async (transaction) => {
      const current = await transaction.dlVoiceScopeGate.findUniqueOrThrow({
        where: { tenantId_telephonyNodeId: scope },
      });
      if (enabled && current.killed) throw new Error('VOICE_ROLLOUT_KILLED');
      const gate = await transaction.dlVoiceScopeGate.update({
        where: { tenantId_telephonyNodeId: scope },
        data: { technicalSwitchOn: enabled, version: { increment: 1 } },
      });
      await this.audit(
        transaction,
        scope.tenantId,
        `switch:${gate.id}:${gate.version}`,
        enabled ? 'VOICE_SWITCH_ENABLED' : 'VOICE_SWITCH_DISABLED',
        actorRef,
        gate.id,
        at,
      );
      return gate;
    });
  }

  async configureCaps(
    scope: VoiceRolloutScope,
    caps: {
      tenantPerMinute: number;
      tenantPerDay: number;
      agentPerMinute: number;
      agentPerDay: number;
    },
    actorRef: string,
    at: Date,
  ) {
    if (Object.values(caps).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('VOICE_ROLLOUT_INVALID_CAP');
    }
    return withTenantDatabaseTransaction(this.database, scope.tenantId, async (transaction) => {
      const gate = await transaction.dlVoiceScopeGate.update({
        where: { tenantId_telephonyNodeId: scope },
        data: {
          capPerMinute: caps.tenantPerMinute,
          capPerDay: caps.tenantPerDay,
          agentCapPerMinute: caps.agentPerMinute,
          agentCapPerDay: caps.agentPerDay,
          version: { increment: 1 },
        },
      });
      await this.audit(
        transaction,
        scope.tenantId,
        `caps:${gate.id}:${gate.version}`,
        'VOICE_CAPS_CONFIGURED',
        actorRef,
        gate.id,
        at,
      );
      return gate;
    });
  }

  async kill(scope: VoiceRolloutScope, actorRef: string, at: Date) {
    return withTenantDatabaseTransaction(this.database, scope.tenantId, async (transaction) => {
      const gate = await transaction.dlVoiceScopeGate.update({
        where: { tenantId_telephonyNodeId: scope },
        data: { killed: true, technicalSwitchOn: false, version: { increment: 1 } },
      });
      await this.audit(
        transaction,
        scope.tenantId,
        `kill:${gate.id}:${gate.version}`,
        'VOICE_ROLLOUT_KILLED',
        actorRef,
        gate.id,
        at,
      );
      return gate;
    });
  }

  async allow(
    input: VoiceRolloutScope & {
      agentUserId: string;
      targetIdentityId: string;
      validFrom: Date;
      validUntil: Date;
      actorRef: string;
    },
  ) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const gate = await transaction.dlVoiceScopeGate.findFirstOrThrow({
        where: { tenantId: input.tenantId, telephonyNodeId: input.telephonyNodeId },
      });
      const entry = await transaction.dlVoiceAllowlistEntry.upsert({
        where: {
          tenantId_gateId_agentUserId_targetIdentityId: {
            tenantId: input.tenantId,
            gateId: gate.id,
            agentUserId: input.agentUserId,
            targetIdentityId: input.targetIdentityId,
          },
        },
        update: { validFrom: input.validFrom, validUntil: input.validUntil, revokedAt: null },
        create: {
          id: this.id(),
          tenantId: input.tenantId,
          gateId: gate.id,
          agentUserId: input.agentUserId,
          targetIdentityId: input.targetIdentityId,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
        },
      });
      await this.audit(
        transaction,
        input.tenantId,
        `allow:${entry.id}:${input.validUntil.toISOString()}`,
        'VOICE_ALLOWLISTED',
        input.actorRef,
        entry.id,
        input.validFrom,
      );
      return entry;
    });
  }

  evaluate(input: VoiceRolloutEvaluationInput): Promise<VoiceRolloutAuthorization> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const gate = await transaction.dlVoiceScopeGate.findFirst({
        where: { tenantId: input.tenantId, telephonyNodeId: input.telephonyNodeId },
      });
      if (!gate || !gate.technicalSwitchOn) {
        return { status: 'DENIED', reasonCode: 'VOICE_SCOPE_DISABLED' };
      }
      if (gate.killed) return { status: 'DENIED', reasonCode: 'VOICE_SCOPE_KILLED' };
      if (
        gate.businessState !== 'DRY_RUN' &&
        gate.businessState !== 'SANDBOX' &&
        gate.businessState !== 'CAPPED_PILOT'
      ) {
        return { status: 'DENIED', reasonCode: 'VOICE_SCOPE_DISABLED' };
      }
      const allowed = await transaction.dlVoiceAllowlistEntry.findFirst({
        where: {
          tenantId: input.tenantId,
          gateId: gate.id,
          agentUserId: input.agentUserId,
          targetIdentityId: input.targetIdentityId,
          revokedAt: null,
          validFrom: { lte: input.at },
          validUntil: { gt: input.at },
        },
      });
      if (!allowed) return { status: 'DENIED', reasonCode: 'VOICE_SCOPE_NOT_ALLOWLISTED' };
      if (gate.businessState === 'DRY_RUN') {
        await this.audit(
          transaction,
          input.tenantId,
          `dry-run:${this.id()}`,
          'VOICE_DRY_RUN_EVALUATED',
          'system:voice-delivery',
          gate.id,
          input.at,
        );
        return { status: 'DENIED', reasonCode: 'VOICE_DRY_RUN' };
      }
      return { status: 'ALLOWED', state: gate.businessState, replay: false };
    });
  }

  authorize(input: VoiceRolloutAuthorizationInput): Promise<VoiceRolloutAuthorization> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM dl_voice_scope_gates
        WHERE tenant_id = ${input.tenantId}::uuid AND telephony_node_id = ${input.telephonyNodeId}
        FOR UPDATE
      `);
      if (!rows[0]) return { status: 'DENIED', reasonCode: 'VOICE_SCOPE_DISABLED' };
      const gate = await transaction.dlVoiceScopeGate.findFirstOrThrow({
        where: { tenantId: input.tenantId, id: rows[0].id },
      });
      if (gate.killed) return { status: 'DENIED', reasonCode: 'VOICE_SCOPE_KILLED' };
      if (
        !gate.technicalSwitchOn ||
        (gate.businessState !== 'SANDBOX' && gate.businessState !== 'CAPPED_PILOT')
      ) {
        return { status: 'DENIED', reasonCode: 'VOICE_SCOPE_DISABLED' };
      }
      const allowed = await transaction.dlVoiceAllowlistEntry.findFirst({
        where: {
          tenantId: input.tenantId,
          gateId: gate.id,
          agentUserId: input.agentUserId,
          targetIdentityId: input.targetIdentityId,
          revokedAt: null,
          validFrom: { lte: input.at },
          validUntil: { gt: input.at },
        },
      });
      if (!allowed) return { status: 'DENIED', reasonCode: 'VOICE_SCOPE_NOT_ALLOWLISTED' };
      const replay = await transaction.dlVoiceCapLedgerEntry.findFirst({
        where: { tenantId: input.tenantId, deliveryId: input.deliveryId },
      });
      if (replay) return { status: 'ALLOWED', state: gate.businessState, replay: true };
      const minute = new Date(input.at.getTime() - 60_000);
      const day = new Date(input.at.getTime() - 86_400_000);
      const [minuteCount, dayCount, agentMinuteCount, agentDayCount] = await Promise.all([
        transaction.dlVoiceCapLedgerEntry.count({
          where: { tenantId: input.tenantId, gateId: gate.id, reservedAt: { gte: minute } },
        }),
        transaction.dlVoiceCapLedgerEntry.count({
          where: { tenantId: input.tenantId, gateId: gate.id, reservedAt: { gte: day } },
        }),
        transaction.dlVoiceCapLedgerEntry.count({
          where: {
            tenantId: input.tenantId,
            gateId: gate.id,
            agentUserId: input.agentUserId,
            reservedAt: { gte: minute },
          },
        }),
        transaction.dlVoiceCapLedgerEntry.count({
          where: {
            tenantId: input.tenantId,
            gateId: gate.id,
            agentUserId: input.agentUserId,
            reservedAt: { gte: day },
          },
        }),
      ]);
      if (
        minuteCount >= gate.capPerMinute ||
        dayCount >= gate.capPerDay ||
        agentMinuteCount >= gate.agentCapPerMinute ||
        agentDayCount >= gate.agentCapPerDay
      )
        return { status: 'DENIED', reasonCode: 'VOICE_RATE_CAP_EXCEEDED' };
      await transaction.dlVoiceCapLedgerEntry.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          gateId: gate.id,
          deliveryId: input.deliveryId,
          agentUserId: input.agentUserId,
          reservedAt: input.at,
        },
      });
      await this.audit(
        transaction,
        input.tenantId,
        `cap:${input.deliveryId}`,
        'VOICE_CAP_RESERVED',
        'SYSTEM',
        input.deliveryId,
        input.at,
      );
      return { status: 'ALLOWED', state: gate.businessState, replay: false };
    });
  }

  private async audit(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    eventId: string,
    code: string,
    actorRef: string,
    subjectId: string,
    occurredAt: Date,
  ) {
    await transaction.dlVoiceAuditEvent.createMany({
      data: [{ id: this.id(), tenantId, eventId, code, actorRef, subjectId, occurredAt }],
      skipDuplicates: true,
    });
  }
}
