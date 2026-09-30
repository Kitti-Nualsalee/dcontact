/**
 * Owner: Integrations — screen-pop ของ dphone ที่ถูกฝัง (E1.14 #488)
 *
 * Authority: E1.6 #462 ข้อ 1–2, 5; Phase Contract E1.8 #464
 *
 * - origin มาจาก lease `embedded` ที่ยัง current เท่านั้น (ไม่รับจาก browser) แล้วอ่านระดับที่ตั้งไว้แบบไม่ cache
 * - ตรวจ disclosure ของ Contact Governance ทุกครั้งก่อนส่ง แล้วลดระดับ (ไม่ปิดทั้งหมด):
 *   ทีมไม่มี scope `VIEW` บน segment → เหลือ `interactionId`; restriction/objection → ไม่เกิน `ids`
 * - payload สร้างด้วย `projectScreenPop` (allowlist ต่อระดับ) + `policyVersion`/`decisionId`
 * - ไม่มี disclosure log ต่อ screen-pop (ข้อจำกัดที่ยอมรับแล้วใน E1.6 ข้อ 5)
 */
import { randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  contactId as toContactId,
  teamId as toTeamId,
  tenantId as toTenantId,
} from '@d-contact/cxa-contracts';
import {
  effectiveScreenPopLevel,
  projectScreenPop,
  type DisclosureDecision,
  type ScreenPopMessage,
  type ScreenPopSource,
} from '@d-contact/dphone-embed';
import { IamTeamContactScopeAuthorizer } from '@d-contact/iam';

export const SCREEN_POP_POLICY_VERSION = 'e1.screen-pop.disclosure/v1';

/**
 * สิทธิ์ `VIEW` ของทีมบน segment ของ contact — IAM เป็นเจ้าของ
 * ADR-027 ออกแบบ `VIEW` ไว้ แต่ IAM ยังมีแค่ `WORK`/`CONTACT` จึงใช้ `UnavailableTeamSegmentViewScope`
 * (fail closed: ไม่มี scope เสมอ) จนกว่า IAM จะเพิ่ม `VIEW` — ห้ามใช้ permission อื่นแทน
 */
export interface TeamSegmentViewScope {
  canView(input: { tenantId: string; agentUserId: string; contactId: string }): Promise<boolean>;
}

export class UnavailableTeamSegmentViewScope implements TeamSegmentViewScope {
  async canView(): Promise<boolean> {
    return false;
  }
}

export class IamTeamSegmentViewScope implements TeamSegmentViewScope {
  private readonly authorizer: IamTeamContactScopeAuthorizer;

  constructor(private readonly database: PrismaClient) {
    this.authorizer = new IamTeamContactScopeAuthorizer(database);
  }

  async canView(input: {
    tenantId: string;
    agentUserId: string;
    contactId: string;
  }): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const agent = await transaction.user.findFirst({
        where: { id: input.agentUserId, tenantId: input.tenantId, isActive: true },
        select: { teamId: true },
      });
      if (!agent?.teamId) return false;
      const decision = await this.authorizer.authorize(
        {
          tenantId: toTenantId(input.tenantId),
          teamId: toTeamId(agent.teamId),
          contactId: toContactId(input.contactId),
          permission: 'VIEW',
          at: new Date().toISOString(),
        },
        transaction,
      );
      return decision.decision === 'ALLOW';
    });
  }
}

/**
 * restriction ที่ถือว่าเป็น "restriction of processing หรือ objection ต่อการเปิดเผย" (E1.6 ข้อ 2)
 * DNC/CONSENT_REVOKED เป็นข้อห้ามการติดต่อตามช่องทาง ไม่ใช่การเปิดเผยข้อมูล จึงไม่อยู่ในรายการ
 */
export const DISCLOSURE_RESTRICTION_TYPES = ['OBJECTION', 'REGULATORY', 'INBOUND_SAFETY'] as const;

/** disclosure check ของ Contact Governance (port ใหม่ตาม E1.8) */
export interface ScreenPopDisclosurePort {
  check(input: {
    tenantId: string;
    agentUserId: string;
    contactId: string | null;
  }): Promise<DisclosureDecision>;
}

export class ContactGovernanceDisclosureCheck implements ScreenPopDisclosurePort {
  constructor(
    private readonly database: PrismaClient,
    private readonly viewScope: TeamSegmentViewScope,
    private readonly options: { now?: () => Date; id?: () => string } = {},
  ) {}

  async check(input: {
    tenantId: string;
    agentUserId: string;
    contactId: string | null;
  }): Promise<DisclosureDecision> {
    const decisionId = (this.options.id ?? randomUUID)();
    const base = { policyVersion: SCREEN_POP_POLICY_VERSION, decisionId };
    // ยังระบุ contact ไม่ได้: ไม่มี segment ให้ตรวจ และไม่มี restriction ระดับ contact
    if (!input.contactId) return { ...base, teamSegmentView: true, restricted: false };
    const contactId = input.contactId;
    const now = (this.options.now ?? (() => new Date()))();
    const [teamSegmentView, restriction] = await Promise.all([
      this.viewScope.canView({
        tenantId: input.tenantId,
        agentUserId: input.agentUserId,
        contactId,
      }),
      withTenantDatabaseTransaction(this.database, input.tenantId, (tx) =>
        tx.cgRestriction.findFirst({
          where: {
            tenantId: input.tenantId,
            contactId,
            type: { in: [...DISCLOSURE_RESTRICTION_TYPES] },
            startsAt: { lte: now },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: { id: true },
        }),
      ),
    ]);
    return { ...base, teamSegmentView, restricted: Boolean(restriction) };
  }
}

export interface ScreenPopActor {
  tenantId: string;
  userId: string;
}

export type ScreenPopOutcome =
  | { status: 'sent'; message: ScreenPopMessage; hostOrigin: string }
  /** origin ปิด screen-pop (ค่าเริ่มต้น) — ไม่ส่งอะไรให้ host */
  | { status: 'off' }
  | { status: 'not_found' };

export class ScreenPopService {
  constructor(
    private readonly database: PrismaClient,
    private readonly deps: {
      hostOriginOfLease(actor: ScreenPopActor, leaseId: string): Promise<string | null>;
      screenPopLevel(tenantId: string, origin: string): Promise<'off' | 'ids' | 'contact'>;
      disclosure: ScreenPopDisclosurePort;
    },
  ) {}

  async build(
    actor: ScreenPopActor,
    input: { leaseId: string; interactionId: string; requestId: string },
  ): Promise<ScreenPopOutcome> {
    const hostOrigin = await this.deps.hostOriginOfLease(actor, input.leaseId);
    if (!hostOrigin) return { status: 'not_found' };
    const setting = await this.deps.screenPopLevel(actor.tenantId, hostOrigin);
    if (setting === 'off') return { status: 'off' };

    const source = await this.source(actor, input.interactionId);
    if (!source) return { status: 'not_found' };
    const decision = await this.deps.disclosure.check({
      tenantId: actor.tenantId,
      agentUserId: actor.userId,
      contactId: source.contactId ?? null,
    });
    const effective = effectiveScreenPopLevel(setting, decision);
    if (!effective) return { status: 'off' };
    return {
      status: 'sent',
      hostOrigin,
      message: projectScreenPop({
        requestId: input.requestId,
        source,
        level: effective.level,
        ...(effective.reasonCode ? { reasonCode: effective.reasonCode } : {}),
        decision,
      }),
    };
  }

  /** งานของ agent คนนี้เท่านั้น (voice) */
  private source(actor: ScreenPopActor, interactionId: string): Promise<ScreenPopSource | null> {
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (tx) => {
      const row = await tx.interaction.findFirst({
        where: {
          id: interactionId,
          tenantId: actor.tenantId,
          agentId: actor.userId,
          channel: 'VOICE',
        },
        select: {
          id: true,
          state: true,
          direction: true,
          contactId: true,
          metadata: true,
          queue: { select: { id: true, name: true } },
          contact: { select: { displayName: true } },
        },
      });
      if (!row) return null;
      const metadata =
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      const text = (value: unknown) => (typeof value === 'string' ? value : null);
      return {
        interactionId: row.id,
        contactId: row.contactId,
        direction: row.direction === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND',
        queue: row.queue,
        callState: callStateOf(row.state),
        ani: text(metadata.caller),
        dnis: text(metadata.dnis),
        displayName: row.contact?.displayName ?? null,
      };
    });
  }
}

/** สถานะพักสายอยู่ฝั่ง SIP ของ iframe — server รู้แค่ ringing/active/จบ */
function callStateOf(state: string): ScreenPopSource['callState'] {
  if (state === 'QUEUED' || state === 'ASSIGNED') return 'RINGING';
  if (state === 'ACTIVE') return 'ACTIVE';
  return 'ENDED';
}
