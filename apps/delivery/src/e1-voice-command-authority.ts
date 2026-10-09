import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { VoiceOriginateCommandPublisher } from './voice-originate-dispatcher.js';

type E1VoiceCommandInput = Parameters<VoiceOriginateCommandPublisher['publish']>[0];

export class DatabaseE1VoiceCommandAuthority {
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  claim(input: E1VoiceCommandInput): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT id FROM dl_voice_scope_gates
        WHERE tenant_id = ${input.tenantId}::uuid
          AND telephony_node_id = ${input.command.telephonyNodeId} FOR UPDATE
      `);
      await transaction.$queryRaw(Prisma.sql`
        SELECT id FROM dl_outbox_entries WHERE tenant_id = ${input.tenantId}::uuid
          AND delivery_id = ${input.command.deliveryId} FOR UPDATE
      `);
      const outbox = await transaction.dlOutboxEntry.findFirst({
        where: {
          tenantId: input.tenantId,
          deliveryId: input.command.deliveryId,
          providerRequestKey: input.command.providerRequestKey,
          adapter: 'FREESWITCH_ORIGINATE',
          channel: 'VOICE',
        },
      });
      const voice = await transaction.dlVoiceOriginate.findFirst({
        where: {
          tenantId: input.tenantId,
          deliveryId: input.command.deliveryId,
          telephonyNodeId: input.command.telephonyNodeId,
        },
      });
      if (!outbox || !voice) return false;
      if (input.command.type === 'call.cancel') {
        if (
          voice.state !== 'CANCEL_REQUESTED' ||
          outbox.state !== 'RECONCILING' ||
          voice.originationUuid !== input.command.callUuid
        )
          return false;
      } else {
        const now = this.now();
        if (
          outbox.state !== 'SUBMITTING' ||
          voice.state !== 'QUEUED' ||
          voice.originationUuid !== input.command.originationUuid ||
          voice.targetIdentityId !== input.command.targetIdentityId ||
          voice.agentExtension !== input.command.agentExtension
        )
          return false;
        const gate = await transaction.dlVoiceScopeGate.findFirst({
          where: {
            tenantId: input.tenantId,
            telephonyNodeId: voice.telephonyNodeId,
            businessState: 'SANDBOX',
            technicalSwitchOn: true,
            killed: false,
          },
        });
        if (!gate) return false;
        const [allowlist, cap, reservation, lease, identity, credential] = await Promise.all([
          transaction.dlVoiceAllowlistEntry.findFirst({
            where: {
              tenantId: input.tenantId,
              gateId: gate.id,
              agentUserId: voice.agentUserId,
              targetIdentityId: voice.targetIdentityId,
              revokedAt: null,
              validFrom: { lte: now },
              validUntil: { gt: now },
            },
          }),
          transaction.dlVoiceCapLedgerEntry.findFirst({
            where: {
              tenantId: input.tenantId,
              gateId: gate.id,
              deliveryId: voice.deliveryId,
              agentUserId: voice.agentUserId,
            },
          }),
          transaction.cgReservation.findFirst({
            where: {
              tenantId: input.tenantId,
              id: outbox.reservationId,
              actionKey: outbox.actionKey,
              deliveryId: outbox.deliveryId,
              providerRequestKey: outbox.providerRequestKey,
              leaseVersion: outbox.leaseVersion,
              submissionStartedAt: { not: null },
              settlementStatus: 'UNKNOWN_RECONCILING',
              state: 'RESERVED',
              contactId: outbox.contactId,
              identityId: voice.targetIdentityId,
              channel: 'VOICE',
            },
          }),
          transaction.agentWorkSessionLease.findFirst({
            where: {
              tenantId: input.tenantId,
              id: voice.workSessionLeaseId,
              userId: voice.agentUserId,
              releasedAt: null,
              expiresAt: { gt: now },
            },
          }),
          transaction.contactIdentity.findFirst({
            where: {
              tenantId: input.tenantId,
              id: voice.targetIdentityId,
              type: 'PHONE',
              contactId: outbox.contactId,
            },
            select: { value: true },
          }),
          transaction.agentSipCredential.findFirst({
            where: {
              tenantId: input.tenantId,
              userId: voice.agentUserId,
              workSessionLeaseId: voice.workSessionLeaseId,
              extension: voice.agentExtension,
              telephonyNodeId: voice.telephonyNodeId,
              revokedAt: null,
            },
            select: { workSessionLeaseId: true },
          }),
        ]);
        if (
          !allowlist ||
          !cap ||
          !reservation ||
          !lease ||
          !credential ||
          !identity ||
          !/^1[0-9]{3}$/.test(identity.value.trim())
        )
          return false;
      }
      const claimed = await transaction.dlVoiceAuditEvent.createMany({
        data: [
          {
            id: randomUUID(),
            tenantId: input.tenantId,
            eventId: `e1-sandbox:${input.command.type}:${outbox.deliveryId}`,
            code: 'E1_SANDBOX_COMMAND_CLAIMED',
            actorRef: 'system:e1-sandbox',
            subjectId: outbox.deliveryId,
            occurredAt: this.now(),
          },
        ],
        skipDuplicates: true,
      });
      return claimed.count === 1;
    });
  }
}
