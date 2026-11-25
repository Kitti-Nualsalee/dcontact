/**
 * Owner: Integrations — screen-pop of the embedded dphone (E1.14 #488)
 *
 * Authority: E1.6 #462 items 1–2, 5; Phase Contract E1.8 #464
 *
 * - the origin comes only from a still-current `embedded` lease (not accepted from the browser), then the configured level is read without a cache
 * - checks the Contact Governance disclosure every time before sending, then reduces the level (does not close it entirely):
 *   a team with no `VIEW` scope on the segment → only `interactionId` remains; restriction/objection → no more than `ids`
 * - the payload is built with `projectScreenPop` (an allowlist per level) + `policyVersion`/`decisionId`
 * - there is no disclosure log per screen-pop (a limitation already accepted in E1.6 item 5)
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
 * the team's `VIEW` permission on the contact's segment — owned by IAM
 * ADR-027 designs `VIEW` but IAM still has only `WORK`/`CONTACT`, so `UnavailableTeamSegmentViewScope` is used
 * (fail closed: there is never a scope) until IAM adds `VIEW` — no other permission may stand in
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
 * restrictions treated as a "restriction of processing or an objection to disclosure" (E1.6 item 2)
 * DNC/CONSENT_REVOKED are bans on contact per channel, not on disclosing data, so they are not in the list
 */
export const DISCLOSURE_RESTRICTION_TYPES = ['OBJECTION', 'REGULATORY', 'INBOUND_SAFETY'] as const;

/** the Contact Governance disclosure check (a new port per E1.8) */
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
    // the contact cannot be identified yet: no segment to check and no contact-level restriction
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
  /** the origin has screen-pop off (the default) — nothing is sent to the host */
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

  /** only this agent's work (voice) */
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

/** the call-hold state lives on the iframe's SIP side — the server knows only ringing/active/ended */
function callStateOf(state: string): ScreenPopSource['callState'] {
  if (state === 'QUEUED' || state === 'ASSIGNED') return 'RINGING';
  if (state === 'ACTIVE') return 'ACTIVE';
  return 'ENDED';
}
