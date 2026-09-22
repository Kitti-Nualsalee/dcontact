import { randomUUID } from 'node:crypto';
import {
  JOURNEY_DELEGABLE_CAPABILITIES,
  JOURNEY_DELEGATION_MAX_SECONDS,
  type JourneyAuthoringAuthorizationDecision,
  type JourneyAuthoringAuthorizationPort,
  type JourneyAuthoringAuthorizationRequest,
  type JourneyAuthoringCapability,
  type JourneyAuthoringErrorCode,
} from '@d-contact/cxa-contracts';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

type Tx = Prisma.TransactionClient;

/**
 * J5.3 (#341): IAM adapter ของ Journey authoring — แหล่งเดียวที่ resolve subject/team/grant/delegation
 * ปัจจุบัน (Phase Spec #337 §1 `packages/iam`, คำตัดสิน #331)
 *
 * - อ่านจาก canonical store ใน transaction ของ command ทุกครั้ง ไม่มี cache และไม่อ่าน `users.role`
 * - service/shared principal ไม่มีสิทธิ์ authoring ใด ๆ (ห้ามเป็น maker/reviewer/approver/publisher)
 * - team inactive ทำให้ edit/review/publish/resume ไม่ได้ แต่ยังอ่านและโอนย้ายได้
 * - delegation ใช้ได้เฉพาะ read/edit(+submit), exact scope, อยู่ในช่วงเวลา, ยังไม่ถูกเพิกถอน และ
 *   delegator ต้องยังมี direct grant อยู่ ณ ตอนนี้ (ห้ามมอบต่อ)
 */

const DELEGABLE: ReadonlySet<string> = new Set(JOURNEY_DELEGABLE_CAPABILITIES);
const READ_ONLY: ReadonlySet<string> = new Set(['journey.read', 'template.read']);

const deny = (code: JourneyAuthoringErrorCode): JourneyAuthoringAuthorizationDecision => ({
  allowed: false,
  code,
});

export class IamJourneyAuthoringAuthorizer implements JourneyAuthoringAuthorizationPort<Tx> {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async authorize(
    transaction: Tx,
    request: JourneyAuthoringAuthorizationRequest,
  ): Promise<JourneyAuthoringAuthorizationDecision> {
    const { tenantId, subjectId, capability, scope } = request;
    const subject = await transaction.iamAuthoringSubject.findUnique({
      where: { tenantId_subjectId: { tenantId, subjectId } },
    });
    if (!subject || subject.isServicePrincipal) return deny('CAPABILITY_REQUIRED');

    const team = await transaction.team.findFirst({
      where: { tenantId, id: scope.teamId },
      select: { isActive: true },
    });
    if (!team) return deny('CAPABILITY_REQUIRED');
    if (!team.isActive && !READ_ONLY.has(capability) && !request.allowInactiveTeam) {
      return deny('OWNER_TEAM_INACTIVE');
    }

    const now = this.now();
    const scopeVersion = await this.scopeVersion(transaction, tenantId, scope.teamId);
    const allowed = (source: 'DIRECT' | 'DELEGATION', delegationId: string | null) =>
      ({
        allowed: true,
        source,
        delegationId,
        authorizationEpoch: subject.authorizationEpoch,
        scopeVersion,
        directReviewAuthority: subject.directReviewAuthority,
        authenticationStrength: subject.authenticationStrength === 'STRONG' ? 'STRONG' : 'STANDARD',
      }) as const;

    if (await this.hasDirectGrant(transaction, request, subjectId, now)) {
      return allowed('DIRECT', null);
    }
    if (request.requireDirect || !DELEGABLE.has(capability)) return deny('CAPABILITY_REQUIRED');

    const scopes = [
      { scopeKind: 'TEAM', scopeId: scope.teamId },
      ...(scope.resource ? [{ scopeKind: scope.resource.kind, scopeId: scope.resource.id }] : []),
    ];
    const delegations = await transaction.iamAuthoringDelegation.findMany({
      where: {
        tenantId,
        delegateSubjectId: subjectId,
        capability,
        startsAt: { lte: now },
        expiresAt: { gt: now },
        OR: scopes,
      },
      orderBy: { createdAt: 'asc' },
    });
    for (const delegation of delegations) {
      const revoked = await transaction.iamAuthoringDelegationRevocation.findUnique({
        where: { tenantId_delegationId: { tenantId, delegationId: delegation.id } },
      });
      if (revoked) continue;
      const delegator = await transaction.iamAuthoringSubject.findUnique({
        where: { tenantId_subjectId: { tenantId, subjectId: delegation.delegatorSubjectId } },
      });
      if (!delegator || delegator.isServicePrincipal) continue;
      // no chaining: delegator ต้องยังถือ direct grant เอง — delegation ที่ได้มาต่อไม่นับ
      if (await this.hasDirectGrant(transaction, request, delegation.delegatorSubjectId, now)) {
        return allowed('DELEGATION', delegation.id);
      }
    }
    return deny(delegations.length > 0 ? 'DELEGATION_INVALID' : 'CAPABILITY_REQUIRED');
  }

  private async hasDirectGrant(
    transaction: Tx,
    request: JourneyAuthoringAuthorizationRequest,
    subjectId: string,
    now: Date,
  ) {
    const { tenantId, capability, scope } = request;
    const grant = await transaction.iamAuthoringCapabilityGrant.findFirst({
      where: {
        tenantId,
        subjectId,
        capability,
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          {
            OR: [
              { scopeKind: 'TENANT', scopeId: tenantId },
              // visibility TENANT: grant อ่านของทีมใดก็ได้ใน tenant นี้ก็พอ
              request.anyTeam && READ_ONLY.has(capability)
                ? { scopeKind: 'TEAM' }
                : { scopeKind: 'TEAM', scopeId: scope.teamId },
              ...(scope.resource
                ? [{ scopeKind: scope.resource.kind, scopeId: scope.resource.id }]
                : []),
            ],
          },
        ],
      },
      select: { id: true },
    });
    return grant !== null;
  }

  private async scopeVersion(transaction: Tx, tenantId: string, teamId: string) {
    const row = await transaction.iamAuthoringScopeVersion.findUnique({
      where: { tenantId_scopeKind_scopeId: { tenantId, scopeKind: 'TEAM', scopeId: teamId } },
      select: { scopeVersion: true },
    });
    return row?.scopeVersion ?? 1;
  }
}

export class JourneyAuthoringDelegationError extends Error {
  constructor(readonly code: 'DELEGATION_INVALID' | 'DELEGATION_EXPIRED') {
    super(`journey authoring delegation: ${code}`);
    this.name = 'JourneyAuthoringDelegationError';
  }
}

/**
 * delegation แบบ append-only (#331 §6): สร้างได้เมื่อ delegator มี direct grant ตรง scope เอง,
 * มอบให้คนอื่นที่เป็นมนุษย์ใน tenant เดียวกัน, ไม่เกิน 8 ชั่วโมง; เพิกถอนคือแถวใหม่ ไม่ใช่แก้แถวเดิม
 */
export class IamJourneyAuthoringDelegations {
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
  ) {}

  async delegate(input: {
    readonly tenantId: string;
    readonly delegatorSubjectId: string;
    readonly delegateSubjectId: string;
    readonly capability: JourneyAuthoringCapability;
    readonly scope: {
      readonly kind: 'TEAM' | 'JOURNEY' | 'TEMPLATE';
      readonly id: string;
      readonly teamId: string;
    };
    readonly durationSeconds: number;
    readonly evidenceRef: string;
  }): Promise<{ readonly delegationId: string; readonly expiresAt: string }> {
    if (
      !DELEGABLE.has(input.capability) ||
      input.delegatorSubjectId === input.delegateSubjectId ||
      !(input.durationSeconds > 0 && input.durationSeconds <= JOURNEY_DELEGATION_MAX_SECONDS)
    ) {
      throw new JourneyAuthoringDelegationError('DELEGATION_INVALID');
    }
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const direct = await new IamJourneyAuthoringAuthorizer(this.now).authorize(transaction, {
        tenantId: input.tenantId,
        subjectId: input.delegatorSubjectId,
        capability: input.capability,
        scope: {
          teamId: input.scope.teamId,
          ...(input.scope.kind === 'TEAM'
            ? {}
            : { resource: { kind: input.scope.kind, id: input.scope.id } }),
        },
        requireDirect: true,
      });
      if (!direct.allowed) throw new JourneyAuthoringDelegationError('DELEGATION_INVALID');
      const delegate = await transaction.iamAuthoringSubject.findUnique({
        where: {
          tenantId_subjectId: { tenantId: input.tenantId, subjectId: input.delegateSubjectId },
        },
      });
      if (!delegate || delegate.isServicePrincipal) {
        throw new JourneyAuthoringDelegationError('DELEGATION_INVALID');
      }
      const startsAt = this.now();
      const expiresAt = new Date(startsAt.getTime() + input.durationSeconds * 1_000);
      const delegationId = this.id();
      await transaction.iamAuthoringDelegation.create({
        data: {
          id: delegationId,
          tenantId: input.tenantId,
          delegatorSubjectId: input.delegatorSubjectId,
          delegateSubjectId: input.delegateSubjectId,
          capability: input.capability,
          scopeKind: input.scope.kind,
          scopeId: input.scope.id,
          startsAt,
          expiresAt,
          evidenceRef: input.evidenceRef,
        },
      });
      return { delegationId, expiresAt: expiresAt.toISOString() };
    });
  }

  async revoke(input: {
    readonly tenantId: string;
    readonly delegationId: string;
    readonly reasonCode: string;
    readonly revokedByRef: string;
  }): Promise<void> {
    await withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      await transaction.iamAuthoringDelegationRevocation.createMany({
        data: [
          {
            id: this.id(),
            tenantId: input.tenantId,
            delegationId: input.delegationId,
            reasonCode: input.reasonCode,
            revokedByRef: input.revokedByRef,
            revokedAt: this.now(),
          },
        ],
        // เพิกถอนซ้ำเป็น no-op — แถวแรกคือหลักฐาน
        skipDuplicates: true,
      });
    });
  }
}
