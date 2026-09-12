/**
 * J2.4 — Cases owner implementation of `J2CaseOwnerPort` for `ENSURE_CASE`.
 *
 * Cases is the sole canonical writer of `cs_*` per #121 — Journey never
 * selects `caseId`, writes `cs_*` directly, or forces a reopen across
 * case-type policy. `persistCommand` durably receives the command and
 * computes the CREATED/LINKED/REOPENED/REJECTED decision synchronously in
 * the same transaction; `J2OwnerPort` is a pull model (`queryAction` reads
 * the already-computed result back), so there is no separate relay/worker
 * needed for this minimal slice (relay transport is out of scope — #132).
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  actionKey as toActionKey,
  commandId as toCommandId,
  J2_ERROR_CONTRACT,
  type J2CaseOwnerCommandV1,
  type J2CaseOwnerPort,
  type J2ErrorCode,
  type J2FailureClass,
  type J2OwnerActionQueryV1,
  type J2OwnerCommandPersistedV1,
  type J2OwnerResultPayloadV1,
  type TenantId,
} from '@d-contact/cxa-contracts';

export class CaseCommandHashConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(readonly actionKey: string) {
    super(`Cases command actionKey มีอยู่แล้วด้วย requestHash ต่างกัน: ${actionKey}`);
    this.name = 'CaseCommandHashConflictError';
  }
}

export interface EnsureCaseDecision {
  status: 'CREATED' | 'LINKED' | 'REOPENED' | 'REJECTED';
  code: string;
  category: string;
  reasonCode: string;
  failureClass: J2FailureClass;
  retryDisposition: string;
  caseId?: string;
  caseVersion?: number;
}

export function rejection(
  code: J2ErrorCode,
  failureClass: J2FailureClass,
  reasonCode: string,
): EnsureCaseDecision {
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

export function success(
  status: 'CREATED' | 'LINKED' | 'REOPENED',
  reasonCode: string,
  caseId: string,
  caseVersion: number,
): EnsureCaseDecision {
  return {
    status,
    code: status,
    category: 'BUSINESS',
    reasonCode,
    failureClass: 'NONE',
    retryDisposition: 'NONE',
    caseId,
    caseVersion,
  };
}

export class CasesEnsureCaseService implements J2CaseOwnerPort {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: { id?: () => string } = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  /**
   * duplicate ที่ commit แล้วคืน PERSISTED เดิมโดยไม่ประมวลผลซ้ำ; key เดิม
   * payload ต่างถูกปฏิเสธเป็น IDEMPOTENCY_CONFLICT ตาม #123
   */
  async persistCommand(
    tenant: TenantId,
    command: J2CaseOwnerCommandV1,
  ): Promise<J2OwnerCommandPersistedV1> {
    await withTenantDatabaseTransaction(this.database, tenant, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cs-command:${tenant}:${command.actionKey}`}))`,
      );
      const existing = await transaction.csCommandInbox.findUnique({
        where: { tenantId_actionKey: { tenantId: tenant, actionKey: command.actionKey } },
      });
      if (existing) {
        if (existing.requestHash !== command.requestHash) {
          throw new CaseCommandHashConflictError(command.actionKey);
        }
        return;
      }

      const decision = await this.decide(transaction, tenant, command);
      await transaction.csCommandInbox.create({
        data: {
          id: this.id(),
          tenantId: tenant,
          commandId: command.commandId,
          actionKey: command.actionKey,
          requestHash: command.requestHash,
          status: decision.status,
          code: decision.code,
          category: decision.category,
          reasonCode: decision.reasonCode,
          failureClass: decision.failureClass,
          retryDisposition: decision.retryDisposition,
          ...(decision.caseId ? { caseId: decision.caseId } : {}),
          ...(decision.caseVersion !== undefined ? { caseVersion: decision.caseVersion } : {}),
          correlationId: command.commandId,
          observedAt: new Date(),
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
      transaction.csCommandInbox.findUnique({
        where: { tenantId_actionKey: { tenantId: tenant, actionKey: query.actionKey } },
      }),
    );
    if (!row || row.requestHash !== query.requestHash) return undefined;
    return {
      contractVersion: 1,
      commandId: toCommandId(row.commandId),
      actionKey: toActionKey(row.actionKey),
      requestHash: row.requestHash,
      commandType: 'ENSURE_CASE',
      status: row.status as J2OwnerResultPayloadV1['status'],
      code: row.code as J2OwnerResultPayloadV1['code'],
      category: row.category as J2OwnerResultPayloadV1['category'],
      reasonCode: row.reasonCode,
      failureClass: row.failureClass as J2OwnerResultPayloadV1['failureClass'],
      retryDisposition: row.retryDisposition as J2OwnerResultPayloadV1['retryDisposition'],
      observedAt: row.observedAt.toISOString(),
      ...(row.caseId && row.caseVersion !== null
        ? { ownerAggregate: { type: 'case' as const, id: row.caseId, version: row.caseVersion } }
        : {}),
    };
  }

  private async decide(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    command: J2CaseOwnerCommandV1,
  ): Promise<EnsureCaseDecision> {
    const [contact, targetTeam, typePolicy, routingPolicy] = await Promise.all([
      transaction.contact.findFirst({
        where: { id: command.contactId, tenantId },
        select: { id: true },
      }),
      transaction.team.findFirst({
        where: { id: command.targetOwnerTeamId, tenantId },
        select: { id: true },
      }),
      transaction.csCaseTypePolicy.findUnique({
        where: { tenantId_policyRef: { tenantId, policyRef: command.intent.caseTypePolicyRef } },
      }),
      transaction.csRoutingPolicy.findUnique({
        where: { tenantId_policyRef: { tenantId, policyRef: command.intent.routingPolicyRef } },
      }),
    ]);

    // ไม่เปิดเผยว่า contact/team มีอยู่จริงใน tenant อื่นหรือไม่ — ปฏิเสธเหมือนไม่พบเสมอ
    if (!contact) return rejection('CONTACT_NOT_FOUND', 'AUTHORIZATION', 'CONTACT_NOT_FOUND');
    if (!targetTeam) {
      return rejection('TEAM_SEGMENT_NOT_ALLOWED', 'AUTHORIZATION', 'TARGET_TEAM_NOT_FOUND');
    }
    if (!typePolicy) {
      return rejection('OWNER_REJECTED', 'BUSINESS', 'CASE_TYPE_POLICY_NOT_FOUND');
    }
    if (!routingPolicy) {
      return rejection('OWNER_REJECTED', 'BUSINESS', 'ROUTING_POLICY_NOT_FOUND');
    }

    // serialize dedupe decision ต่อ (contact, case type) กันสอง command แข่งกันสร้าง
    // เคสซ้ำสำหรับลูกค้า/ประเภทเดียวกัน
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cs-case-dedupe:${tenantId}:${command.contactId}:${typePolicy.caseTypeKey}`}))`,
    );

    const existingCase = await transaction.csCase.findFirst({
      where: { tenantId, contactId: command.contactId, caseTypeKey: typePolicy.caseTypeKey },
      orderBy: { createdAt: 'desc' },
    });

    if (existingCase?.status === 'OPEN') {
      const linked = await transaction.csCase.update({
        where: { id: existingCase.id },
        data: { version: { increment: 1 } },
      });
      await this.recordActivity(transaction, tenantId, linked.id, 'LINKED', command);
      return success('LINKED', 'CASE_OPEN_MATCHED', linked.id, linked.version);
    }

    if (existingCase?.status === 'RESOLVED' && typePolicy.reopenAllowed) {
      const reopened = await transaction.csCase.update({
        where: { id: existingCase.id },
        data: {
          status: 'OPEN',
          version: { increment: 1 },
          reopenCount: { increment: 1 },
          resolvedAt: null,
        },
      });
      await this.recordActivity(transaction, tenantId, reopened.id, 'REOPENED', command);
      return success('REOPENED', 'CASE_REOPEN_POLICY_ALLOWED', reopened.id, reopened.version);
    }

    // ไม่มี match เดิมเลย, หรือมีแต่ CLOSED, หรือ RESOLVED ที่ reopen ไม่ได้ (ห้าม
    // reopen เงียบ ๆ ตาม #121) — เปิดเคสใหม่เสมอ; ถ้ามีเคสเดิมให้เชื่อม RELATED
    const created = await transaction.csCase.create({
      data: {
        id: this.id(),
        tenantId,
        contactId: command.contactId,
        caseTypeKey: typePolicy.caseTypeKey,
        routingRef: routingPolicy.queueRef,
        status: 'OPEN',
        version: 1,
      },
    });
    if (existingCase) {
      await transaction.csCaseLink.create({
        data: {
          id: this.id(),
          tenantId,
          caseId: created.id,
          relatedCaseId: existingCase.id,
          kind: 'RELATED',
        },
      });
    }
    await this.recordActivity(transaction, tenantId, created.id, 'CREATED', command);
    return success(
      'CREATED',
      existingCase ? 'CASE_CLOSED_RELATED_NEW' : 'CASE_NO_MATCH',
      created.id,
      created.version,
    );
  }

  private async recordActivity(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    caseId: string,
    kind: 'CREATED' | 'LINKED' | 'REOPENED',
    command: J2CaseOwnerCommandV1,
  ): Promise<void> {
    await transaction.csCaseActivity.create({
      data: {
        id: this.id(),
        tenantId,
        caseId,
        kind,
        interactionId: command.interactionId,
        outcomeType: command.sourceOutcome.outcomeType,
        outcomeId: command.sourceOutcome.outcomeId,
        outcomeVersion: command.sourceOutcome.outcomeVersion,
        correlationId: command.commandId,
      },
    });
  }
}
