import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { TelephonySipRegistrationFlushCommand } from '@d-contact/shared';
import type { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';

export interface E1RegistrationFlushInput {
  tenantId: string;
  command: TelephonySipRegistrationFlushCommand;
}

export class E1RegistrationFlusher {
  constructor(
    private readonly database: PrismaClient,
    private readonly adapter: Pick<FreeSwitchCommandAdapter, 'handle'>,
  ) {}

  flush(input: E1RegistrationFlushInput) {
    return withTenantDatabaseTransaction(
      this.database,
      input.tenantId,
      async (transaction) => {
        const credential = await transaction.agentSipCredential.findFirst({
          where: {
            tenantId: input.tenantId,
            workSessionLeaseId: input.command.workSessionLeaseId,
            telephonyNodeId: input.command.telephonyNodeId,
            extension: input.command.extension,
            sipDomain: input.command.sipDomain,
            revokedAt: { not: null },
            workSessionLease: { releasedAt: { not: null } },
          },
          select: { userId: true },
        });
        if (!credential) return false;
        await transaction.$queryRaw(Prisma.sql`
          SELECT id FROM users WHERE tenant_id = ${input.tenantId}::uuid
            AND id = ${credential.userId}::uuid FOR UPDATE
        `);
        const active = await transaction.agentSipCredential.count({
          where: {
            tenantId: input.tenantId,
            telephonyNodeId: input.command.telephonyNodeId,
            extension: input.command.extension,
            sipDomain: input.command.sipDomain,
            revokedAt: null,
            workSessionLease: { releasedAt: null },
          },
        });
        if (active > 0) return false;
        const eventId = `e1-sandbox:sip.registration.flush:${input.command.workSessionLeaseId}`;
        const completed = await transaction.dlVoiceAuditEvent.findFirst({
          where: { tenantId: input.tenantId, eventId, code: 'E1_SANDBOX_REGISTRATION_FLUSHED' },
        });
        if (completed) return true;
        await this.adapter.handle(input.command, input.tenantId);
        await transaction.dlVoiceAuditEvent.create({
          data: {
            id: randomUUID(),
            tenantId: input.tenantId,
            eventId,
            code: 'E1_SANDBOX_REGISTRATION_FLUSHED',
            actorRef: 'system:e1-sandbox',
            subjectId: input.command.workSessionLeaseId,
            occurredAt: new Date(),
          },
        });
        return true;
      },
      { timeout: 10_000 },
    );
  }
}
