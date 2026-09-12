/**
 * J2.5 — Dialer owner implementation of `J2DialerOwnerPort` for
 * `ADMIT_CAMPAIGN_TARGET` only. Dialer is the sole canonical writer of
 * `ob_campaign_*` per #121 — Journey never creates/starts/pauses/edits a
 * Campaign, and admission here never originates/sends (that's a separate,
 * later concern; see #133 out of scope).
 *
 * `SCHEDULE_CALLBACK`/`CANCEL_*`/`SUPERSEDE_*` are other tickets' scope
 * (J2.6/J2.8) — this service satisfies the `J2DialerOwnerPort` type but
 * fails closed with `DialerCommandNotImplementedError` for them rather than
 * inventing behavior the Phase Contract hasn't authorized.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  actionKey as toActionKey,
  commandId as toCommandId,
  tenantId as toTenantId,
  J2_ERROR_CONTRACT,
  type J2DialerOwnerCommandV1,
  type J2DialerOwnerPort,
  type J2ErrorCode,
  type J2FailureClass,
  type J2OwnerActionQueryV1,
  type J2OwnerCommandPersistedV1,
  type J2OwnerResultPayloadV1,
  type TeamContactScopeAuthorizer,
  type TenantId,
} from '@d-contact/cxa-contracts';

export class DialerCommandHashConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(readonly actionKey: string) {
    super(`Dialer command actionKey มีอยู่แล้วด้วย requestHash ต่างกัน: ${actionKey}`);
    this.name = 'DialerCommandHashConflictError';
  }
}

export class DialerCommandNotImplementedError extends Error {
  constructor(readonly commandType: string) {
    super(`Dialer ยังไม่รองรับ command type นี้ใน J2.5: ${commandType}`);
    this.name = 'DialerCommandNotImplementedError';
  }
}

export interface AdmitDecision {
  status: 'ADMITTED' | 'ALREADY_ADMITTED' | 'REJECTED';
  code: string;
  category: string;
  reasonCode: string;
  failureClass: J2FailureClass;
  retryDisposition: string;
  recordId?: string;
  recordVersion?: number;
}

export function rejection(
  code: J2ErrorCode,
  failureClass: J2FailureClass,
  reasonCode: string,
): AdmitDecision {
  const error = J2_ERROR_CONTRACT[code];
  return {
    status: 'REJECTED',
    code,
    category: error.category,
    reasonCode,
    failureClass,
    retryDisposition: error.retryDisposition,
  };
}

export function admitted(
  status: 'ADMITTED' | 'ALREADY_ADMITTED',
  reasonCode: string,
  recordId: string,
  recordVersion: number,
): AdmitDecision {
  return {
    status,
    code: status,
    category: 'BUSINESS',
    reasonCode,
    failureClass: 'NONE',
    retryDisposition: 'NONE',
    recordId,
    recordVersion,
  };
}

export class DialerAdmitCampaignTargetService implements J2DialerOwnerPort {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly scopeAuthorizer: TeamContactScopeAuthorizer,
    options: { id?: () => string; now?: () => Date } = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  async persistCommand(
    tenant: TenantId,
    command: J2DialerOwnerCommandV1,
  ): Promise<J2OwnerCommandPersistedV1> {
    if (command.commandType !== 'ADMIT_CAMPAIGN_TARGET') {
      throw new DialerCommandNotImplementedError(command.commandType);
    }

    await withTenantDatabaseTransaction(this.database, tenant, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`ob-command:${tenant}:${command.actionKey}`}))`,
      );
      const existing = await transaction.obDialerCommandInbox.findUnique({
        where: { tenantId_actionKey: { tenantId: tenant, actionKey: command.actionKey } },
      });
      if (existing) {
        if (existing.requestHash !== command.requestHash) {
          throw new DialerCommandHashConflictError(command.actionKey);
        }
        return;
      }

      const decision = await this.decide(transaction, tenant, command);
      await transaction.obDialerCommandInbox.create({
        data: {
          id: this.id(),
          tenantId: tenant,
          commandId: command.commandId,
          actionKey: command.actionKey,
          commandType: command.commandType,
          requestHash: command.requestHash,
          status: decision.status,
          code: decision.code,
          category: decision.category,
          reasonCode: decision.reasonCode,
          failureClass: decision.failureClass,
          retryDisposition: decision.retryDisposition,
          ...(decision.recordId ? { recordId: decision.recordId } : {}),
          ...(decision.recordVersion !== undefined
            ? { recordVersion: decision.recordVersion }
            : {}),
          correlationId: command.commandId,
          observedAt: this.now(),
        },
      });
    });
    return {
      status: 'PERSISTED',
      commandId: command.commandId,
      actionKey: command.actionKey,
      requestHash: command.requestHash,
    };
  }

  async queryAction(
    tenant: TenantId,
    query: J2OwnerActionQueryV1,
  ): Promise<J2OwnerResultPayloadV1 | undefined> {
    const row = await withTenantDatabaseTransaction(this.database, tenant, (transaction) =>
      transaction.obDialerCommandInbox.findUnique({
        where: { tenantId_actionKey: { tenantId: tenant, actionKey: query.actionKey } },
      }),
    );
    if (!row || row.requestHash !== query.requestHash) return undefined;
    return {
      contractVersion: 1,
      commandId: toCommandId(row.commandId),
      actionKey: toActionKey(row.actionKey),
      requestHash: row.requestHash,
      commandType: 'ADMIT_CAMPAIGN_TARGET',
      status: row.status as J2OwnerResultPayloadV1['status'],
      code: row.code as J2OwnerResultPayloadV1['code'],
      category: row.category as J2OwnerResultPayloadV1['category'],
      reasonCode: row.reasonCode,
      failureClass: row.failureClass as J2OwnerResultPayloadV1['failureClass'],
      retryDisposition: row.retryDisposition as J2OwnerResultPayloadV1['retryDisposition'],
      observedAt: row.observedAt.toISOString(),
      ...(row.recordId && row.recordVersion !== null
        ? {
            ownerAggregate: {
              type: 'campaign_target' as const,
              id: row.recordId,
              version: row.recordVersion,
            },
          }
        : {}),
    };
  }

  private async decide(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    command: Extract<J2DialerOwnerCommandV1, { commandType: 'ADMIT_CAMPAIGN_TARGET' }>,
  ): Promise<AdmitDecision> {
    const [contact, sourceTeam, targetTeam] = await Promise.all([
      transaction.contact.findFirst({
        where: { id: command.contactId, tenantId },
        select: { id: true },
      }),
      transaction.team.findFirst({
        where: { id: command.sourceOwnerTeamId, tenantId },
        select: { id: true },
      }),
      transaction.team.findFirst({
        where: { id: command.targetOwnerTeamId, tenantId },
        select: { id: true },
      }),
    ]);

    // ไม่เปิดเผยว่า contact/team มีอยู่จริงใน tenant อื่นหรือไม่ — ปฏิเสธเหมือนไม่พบเสมอ
    if (!contact) return rejection('CONTACT_NOT_FOUND', 'AUTHORIZATION', 'CONTACT_NOT_FOUND');
    if (!sourceTeam) {
      return rejection('TEAM_SEGMENT_NOT_ALLOWED', 'AUTHORIZATION', 'SOURCE_TEAM_NOT_FOUND');
    }
    if (!targetTeam) {
      return rejection('TEAM_SEGMENT_NOT_ALLOWED', 'AUTHORIZATION', 'TARGET_TEAM_NOT_FOUND');
    }

    // ตรวจ current WORK scope ของทั้งสอง team role ก่อน admit — audit ทั้งคู่ตาม #121
    const at = this.now().toISOString();
    const tenant = toTenantId(tenantId);
    const [sourceScope, targetScope] = await Promise.all([
      this.scopeAuthorizer.authorize({
        tenantId: tenant,
        teamId: command.sourceOwnerTeamId,
        contactId: command.contactId,
        permission: 'CONTACT',
        at,
      }),
      this.scopeAuthorizer.authorize({
        tenantId: tenant,
        teamId: command.targetOwnerTeamId,
        contactId: command.contactId,
        permission: 'CONTACT',
        at,
      }),
    ]);
    if (sourceScope.decision === 'DENY' || targetScope.decision === 'DENY') {
      return rejection('TEAM_SEGMENT_NOT_ALLOWED', 'AUTHORIZATION', 'WORK_SCOPE_DENIED');
    }

    const campaign = await transaction.obCampaign.findFirst({
      where: { id: command.intent.campaignId, tenantId },
    });
    if (!campaign) {
      return rejection('OWNER_REJECTED', 'BUSINESS', 'CAMPAIGN_BINDING_INVALID');
    }
    if (campaign.status === 'STOPPED' || campaign.status === 'COMPLETED') {
      return rejection(
        'OWNER_REJECTED',
        'BUSINESS',
        campaign.status === 'STOPPED' ? 'CAMPAIGN_STOPPED' : 'CAMPAIGN_COMPLETED',
      );
    }

    const policy = await transaction.obCampaignAdmissionPolicy.findUnique({
      where: { tenantId_campaignId: { tenantId, campaignId: campaign.id } },
    });
    const admissionPolicyVersion = policy?.version ?? 1;
    const allowCrossCampaignDuplicate = policy?.allowCrossCampaignDuplicate ?? false;

    // serialize decision ต่อ (campaign, contact) กันสอง command แข่งกัน admit ซ้ำ
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`ob-admission:${tenantId}:${campaign.id}:${command.contactId}`}))`,
    );

    const existingTarget = await transaction.obCampaignTarget.findUnique({
      where: {
        tenantId_campaignId_contactId: {
          tenantId,
          campaignId: campaign.id,
          contactId: command.contactId,
        },
      },
    });
    if (existingTarget) {
      return admitted(
        'ALREADY_ADMITTED',
        'CAMPAIGN_TARGET_ALREADY_ADMITTED',
        existingTarget.id,
        existingTarget.version,
      );
    }

    if (!allowCrossCampaignDuplicate) {
      const crossCampaignDuplicate = await transaction.obCampaignTarget.findFirst({
        where: { tenantId, contactId: command.contactId, campaignId: { not: campaign.id } },
        select: { id: true },
      });
      if (crossCampaignDuplicate) {
        return rejection('OWNER_REJECTED', 'BUSINESS', 'DUPLICATE_CONTACT_CROSS_CAMPAIGN');
      }
    }

    const state = campaign.status === 'ACTIVE' ? 'ADMITTED' : 'DEFERRED';
    const created = await transaction.obCampaignTarget.create({
      data: {
        id: this.id(),
        tenantId,
        campaignId: campaign.id,
        contactId: command.contactId,
        state,
        sourceOwnerTeamId: command.sourceOwnerTeamId,
        targetOwnerTeamId: command.targetOwnerTeamId,
        admissionPolicyVersion,
      },
    });
    return admitted(
      'ADMITTED',
      state === 'ADMITTED' ? 'CAMPAIGN_ACTIVE_ADMITTED' : 'CAMPAIGN_DEFERRED_ADMITTED',
      created.id,
      created.version,
    );
  }
}
