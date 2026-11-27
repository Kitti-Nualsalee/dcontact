/**
 * #1061 — callbacks an Agent schedules from the work they hold, round one
 *
 * Dialer stays the only writer of `ob_callbacks` (ADR-011): apps/api calls this class in-process, the same way
 * it calls the Cases owner writer. Rules confirmed by the owner (28 Nov 2026):
 * - the Agent who scheduled it dials; 15 minutes after the time, if that Agent is not online, it moves to the team
 * - internal numbers only (`1xxx`), there is no PSTN route yet
 * - Contact Governance is asked when scheduling and again before dialing; DNC and calling hours are never skipped.
 *   Dialer does not hold the Governance port (CG4-REG02): apps/api asks Governance and passes the decision in
 *
 * Every command carries a commandId (`command_receipts`) and, except scheduling, an expectedVersion on
 * `ob_callbacks.version`. The timeline (`ob_callback_events`) never holds the phone number or the note.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';

export const AGENT_CALLBACK_NOTE_MAX = 500;
/** an internal number that managed telephony may dial in round one */
export const AGENT_CALLBACK_DIALABLE = /^1[0-9]{3}$/;
export const AGENT_CALLBACK_MIN_LEAD_MS = 60_000;
export const AGENT_CALLBACK_MAX_AHEAD_MS = 30 * 24 * 60 * 60_000;
export const AGENT_CALLBACK_EXPIRY_MS = 24 * 60 * 60_000;
export const AGENT_CALLBACK_ESCALATE_MS = 15 * 60_000;

export type AgentCallbackErrorCode =
  | 'AGENT_REQUIRED'
  | 'TEAM_REQUIRED'
  | 'INVALID_INPUT'
  | 'WORK_NOT_FOUND'
  | 'WORK_NOT_ACTIVE'
  | 'CONTACT_REQUIRED'
  | 'NUMBER_NOT_FOUND'
  | 'NUMBER_NOT_DIALABLE'
  | 'NO_VOICE_QUEUE'
  | 'CALLBACK_EXISTS'
  | 'CALLBACK_NOT_FOUND'
  | 'CALLBACK_NOT_SCHEDULED'
  | 'GOVERNANCE_BLOCKED'
  | 'GOVERNANCE_REVIEW'
  | 'NO_WORK_SESSION'
  | 'AGENT_NOT_AVAILABLE'
  | 'VOICE_NOT_READY'
  | 'VERSION_CONFLICT'
  | 'COMMAND_ID_REUSED'
  | 'COMMAND_PAYLOAD_MISMATCH';

export type AgentCallbackErrorKind = 'FORBIDDEN' | 'INVALID' | 'NOT_FOUND' | 'CONFLICT';

const ERROR_KIND: Record<AgentCallbackErrorCode, AgentCallbackErrorKind> = {
  AGENT_REQUIRED: 'FORBIDDEN',
  TEAM_REQUIRED: 'FORBIDDEN',
  INVALID_INPUT: 'INVALID',
  WORK_NOT_FOUND: 'NOT_FOUND',
  WORK_NOT_ACTIVE: 'CONFLICT',
  CONTACT_REQUIRED: 'CONFLICT',
  NUMBER_NOT_FOUND: 'INVALID',
  NUMBER_NOT_DIALABLE: 'INVALID',
  NO_VOICE_QUEUE: 'CONFLICT',
  CALLBACK_EXISTS: 'CONFLICT',
  CALLBACK_NOT_FOUND: 'NOT_FOUND',
  CALLBACK_NOT_SCHEDULED: 'CONFLICT',
  GOVERNANCE_BLOCKED: 'CONFLICT',
  GOVERNANCE_REVIEW: 'CONFLICT',
  NO_WORK_SESSION: 'CONFLICT',
  AGENT_NOT_AVAILABLE: 'CONFLICT',
  VOICE_NOT_READY: 'CONFLICT',
  VERSION_CONFLICT: 'CONFLICT',
  COMMAND_ID_REUSED: 'CONFLICT',
  COMMAND_PAYLOAD_MISMATCH: 'CONFLICT',
};

export class AgentCallbackError extends Error {
  readonly kind: AgentCallbackErrorKind;

  constructor(
    readonly code: AgentCallbackErrorCode,
    readonly field?: string,
  ) {
    super(field ? `${code}: ${field}` : code);
    this.name = 'AgentCallbackError';
    this.kind = ERROR_KIND[code];
  }
}

export interface AgentCallbackActor {
  tenantId: string;
  userId: string;
}

export interface AgentCallbackRef {
  callbackId: string;
  version: number;
}

/** what Contact Governance is asked about; apps/api turns it into `authorizeAndReserve` */
export interface AgentCallbackDecisionRequest {
  stage: 'SCHEDULE' | 'DIAL';
  commandId: string;
  callbackId?: string;
  interactionId?: string;
  contactId: string;
  identityId: string;
}

export interface AgentCallbackDecision {
  decision: 'ALLOW' | 'BLOCK' | 'DEFER' | 'REVIEW';
  decisionId: string;
  reasonCode: string;
  /** DEFER: the first time Governance would allow, when it can tell */
  nextEligibleAt?: string;
  /** DIAL only, called once: true = the call was placed (confirm), false = nothing was placed (release) */
  settle?(placed: boolean): Promise<void>;
}

export type AgentCallbackDecider = (
  request: AgentCallbackDecisionRequest,
) => Promise<AgentCallbackDecision>;

export interface AgentCallbackNumber {
  identityId: string;
  value: string;
  dialable: boolean;
}

export interface AgentCallbackOptions {
  interactionId: string;
  contactId: string;
  contactName: string | null;
  numbers: AgentCallbackNumber[];
  queue: { id: string; name: string } | null;
  /** the open callback of this customer, if any (one at a time) */
  existingCallbackId: string | null;
}

export type AgentCallbackState = 'SCHEDULED' | 'ORIGINATING';

export interface AgentCallbackView {
  id: string;
  version: number;
  state: AgentCallbackState;
  contactId: string;
  contactName: string | null;
  number: string;
  note: string | null;
  requestedFor: string;
  expiresAt: string;
  /** the time has come */
  due: boolean;
  /** moved to the team; any Agent of the team may dial it */
  team: boolean;
  mine: boolean;
  createdByName: string | null;
  lastReasonCode: string | null;
  attemptCount: number;
}

export interface AgentCallbackMaintenance {
  expired: number;
  escalated: number;
  connected: number;
  notConnected: number;
}

/** places the callback call in the caller's transaction (apps/api wires the managed voice runtime of apps/router) */
export interface CallbackCallPort {
  start(
    transaction: Prisma.TransactionClient,
    input: {
      tenantId: string;
      queueId: string;
      agentId: string;
      contactId: string;
      destination: string;
      callbackId: string;
    },
  ): Promise<{ interactionId: string }>;
}

export type AgentCallbackDialResult =
  | (AgentCallbackRef & { status: 'DIALING'; interactionId: string })
  /** Governance: not now; the callback moved to the time Governance gave */
  | (AgentCallbackRef & { status: 'DEFERRED'; requestedFor: string; reasonCode: string })
  /** Governance: never (e.g. do not call); the callback was cancelled */
  | (AgentCallbackRef & { status: 'BLOCKED'; reasonCode: string })
  /** Governance: needs a person to look first; the callback stays */
  | (AgentCallbackRef & { status: 'REVIEW'; reasonCode: string });

type Transaction = Prisma.TransactionClient;

interface TeamActor extends AgentCallbackActor {
  teamId: string;
}

interface CallbackRow {
  id: string;
  version: number;
  state: string;
  agent_id: string | null;
  target_owner_team_id: string;
  contact_id: string;
  identity_id: string;
  queue_id: string;
  requested_for: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuidInput(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new AgentCallbackError('INVALID_INPUT', field);
  return value.toLowerCase();
}

export function versionInput(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new AgentCallbackError('INVALID_INPUT', 'expectedVersion');
  return value;
}

export function noteInput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new AgentCallbackError('INVALID_INPUT', 'note');
  const trimmed = value.trim();
  if (trimmed.length > AGENT_CALLBACK_NOTE_MAX)
    throw new AgentCallbackError('INVALID_INPUT', 'note');
  return trimmed.length === 0 ? null : trimmed;
}

/** at least one minute ahead and at most 30 days ahead of `now` */
export function requestedForInput(value: unknown, now: Date): Date {
  if (typeof value !== 'string') throw new AgentCallbackError('INVALID_INPUT', 'requestedFor');
  const at = new Date(value);
  if (
    !Number.isFinite(at.getTime()) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    at.getTime() < now.getTime() + AGENT_CALLBACK_MIN_LEAD_MS ||
    at.getTime() > now.getTime() + AGENT_CALLBACK_MAX_AHEAD_MS
  )
    throw new AgentCallbackError('INVALID_INPUT', 'requestedFor');
  return at;
}

/** digits of an internal number, or null when the value is not one */
export function dialableNumber(value: string): string | null {
  const digits = value.replace(/[\s()-]/g, '');
  return AGENT_CALLBACK_DIALABLE.test(digits) ? digits : null;
}

function digest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

export class AgentCallbacks {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly deps: {
      /** absent = dialing is not wired (`VOICE_NOT_READY`) */
      calls?: CallbackCallPort;
      id?: () => string;
      now?: () => Date;
    },
  ) {
    this.id = deps.id ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  /** what the schedule dialog needs for a work item the Agent holds */
  async options(
    actor: AgentCallbackActor,
    interactionValue: unknown,
  ): Promise<AgentCallbackOptions> {
    const interactionId = uuidInput(interactionValue, 'interactionId');
    return this.read(actor, async (transaction, teamActor) => {
      const work = await this.heldWork(transaction, teamActor, interactionId);
      const [contact, identities, queue, existing] = await Promise.all([
        transaction.contact.findFirst({
          where: { tenantId: teamActor.tenantId, id: work.contactId },
          select: { displayName: true },
        }),
        transaction.contactIdentity.findMany({
          where: { tenantId: teamActor.tenantId, contactId: work.contactId, type: 'PHONE' },
          select: { id: true, value: true },
          orderBy: [{ value: 'asc' }, { id: 'asc' }],
        }),
        this.callbackQueue(transaction, teamActor, work.queueId),
        transaction.obCallback.findFirst({
          where: {
            tenantId: teamActor.tenantId,
            contactId: work.contactId,
            origin: 'AGENT',
            state: { in: ['SCHEDULED', 'ORIGINATING'] },
          },
          select: { id: true },
        }),
      ]);
      return {
        interactionId,
        contactId: work.contactId,
        contactName: contact?.displayName ?? null,
        numbers: identities.map((identity) => ({
          identityId: identity.id,
          value: identity.value,
          dialable: dialableNumber(identity.value) !== null,
        })),
        queue,
        existingCallbackId: existing?.id ?? null,
      };
    });
  }

  async schedule(
    actor: AgentCallbackActor,
    body: Record<string, unknown>,
    decide: AgentCallbackDecider,
  ): Promise<AgentCallbackRef> {
    const commandId = uuidInput(body.commandId, 'commandId');
    const interactionId = uuidInput(body.interactionId, 'interactionId');
    const identityId = uuidInput(body.identityId, 'identityId');
    const note = noteInput(body.note);
    const requestedFor = requestedForInput(body.requestedFor, this.now());
    const payloadDigest = digest([1, interactionId, identityId, requestedFor.toISOString(), note]);

    // A command already committed answers the earlier result without asking Governance again
    const replay = await this.replay(actor, commandId, 'callback.schedule', payloadDigest);
    if (replay) return replay;

    const target = await this.read(actor, async (transaction, teamActor) => {
      const work = await this.heldWork(transaction, teamActor, interactionId);
      await this.dialableIdentity(transaction, teamActor, work.contactId, identityId);
      return work;
    });
    // Scheduling asks only "may this customer be called at all" (DNC, consent): calling hours are checked at dial time,
    // so DEFER is accepted here
    const outcome = await decide({
      stage: 'SCHEDULE',
      commandId,
      interactionId,
      contactId: target.contactId,
      identityId,
    });
    // the reason (e.g. CONSENT_REQUIRED) travels as the field so the Agent sees why
    if (outcome.decision === 'BLOCK')
      throw new AgentCallbackError('GOVERNANCE_BLOCKED', outcome.reasonCode);
    if (outcome.decision === 'REVIEW')
      throw new AgentCallbackError('GOVERNANCE_REVIEW', outcome.reasonCode);

    return this.write(
      actor,
      commandId,
      'callback.schedule',
      payloadDigest,
      async (transaction, teamActor) => {
        const work = await this.heldWork(transaction, teamActor, interactionId);
        await this.dialableIdentity(transaction, teamActor, work.contactId, identityId);
        const queue = await this.callbackQueue(transaction, teamActor, work.queueId);
        if (!queue) throw new AgentCallbackError('NO_VOICE_QUEUE');
        await transaction.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:agent-callback:${teamActor.tenantId}:${work.contactId}`}, 0))`,
        );
        const open = await transaction.obCallback.findFirst({
          where: {
            tenantId: teamActor.tenantId,
            contactId: work.contactId,
            origin: 'AGENT',
            state: { in: ['SCHEDULED', 'ORIGINATING'] },
          },
          select: { id: true },
        });
        if (open) throw new AgentCallbackError('CALLBACK_EXISTS');
        const callbackId = this.id();
        await transaction.obCallback.create({
          data: {
            id: callbackId,
            tenantId: teamActor.tenantId,
            contactId: work.contactId,
            queueId: queue.id,
            agentId: teamActor.userId,
            requestedFor,
            expiresAt: new Date(requestedFor.getTime() + AGENT_CALLBACK_EXPIRY_MS),
            state: 'SCHEDULED',
            version: 1,
            sourceOwnerTeamId: teamActor.teamId,
            targetOwnerTeamId: teamActor.teamId,
            origin: 'AGENT',
            sourceInteractionId: interactionId,
            identityId,
            note,
            createdByUserId: teamActor.userId,
          },
        });
        await this.event(transaction, teamActor.tenantId, callbackId, 'SCHEDULED', {
          actorUserId: teamActor.userId,
          requestedFor,
          interactionId,
          decisionId: outcome.decisionId,
        });
        return { callbackId, version: 1 };
      },
    );
  }

  async reschedule(
    actor: AgentCallbackActor,
    callbackValue: unknown,
    body: Record<string, unknown>,
  ): Promise<AgentCallbackRef> {
    const callbackId = uuidInput(callbackValue, 'callbackId');
    const commandId = uuidInput(body.commandId, 'commandId');
    const expectedVersion = versionInput(body.expectedVersion);
    const requestedFor = requestedForInput(body.requestedFor, this.now());
    const payloadDigest = digest([1, callbackId, expectedVersion, requestedFor.toISOString()]);
    return this.write(
      actor,
      commandId,
      'callback.reschedule',
      payloadDigest,
      async (transaction, teamActor) => {
        const row = await this.lockVisible(transaction, teamActor, callbackId, expectedVersion);
        const version = await this.update(transaction, teamActor.tenantId, row, {
          requestedFor,
          expiresAt: new Date(requestedFor.getTime() + AGENT_CALLBACK_EXPIRY_MS),
        });
        await this.event(transaction, teamActor.tenantId, callbackId, 'RESCHEDULED', {
          actorUserId: teamActor.userId,
          requestedFor,
        });
        return { callbackId, version };
      },
      callbackId,
    );
  }

  async cancel(
    actor: AgentCallbackActor,
    callbackValue: unknown,
    body: Record<string, unknown>,
  ): Promise<AgentCallbackRef> {
    const callbackId = uuidInput(callbackValue, 'callbackId');
    const commandId = uuidInput(body.commandId, 'commandId');
    const expectedVersion = versionInput(body.expectedVersion);
    const payloadDigest = digest([1, callbackId, expectedVersion]);
    return this.write(
      actor,
      commandId,
      'callback.cancel',
      payloadDigest,
      async (transaction, teamActor) => {
        const row = await this.lockVisible(transaction, teamActor, callbackId, expectedVersion);
        const version = await this.update(transaction, teamActor.tenantId, row, {
          state: 'CANCELLED',
          cancelledAt: this.now(),
          cancelReasonCode: 'AGENT_CANCELLED',
          lastReasonCode: 'AGENT_CANCELLED',
        });
        await this.event(transaction, teamActor.tenantId, callbackId, 'CANCELLED', {
          actorUserId: teamActor.userId,
          reasonCode: 'AGENT_CANCELLED',
        });
        return { callbackId, version };
      },
      callbackId,
    );
  }

  /**
   * Dial a callback now. Contact Governance decides first (calling hours, DNC, caps):
   * ALLOW places the call and confirms the reservation; DEFER moves the callback to the time Governance gives;
   * BLOCK cancels it; REVIEW leaves it as it is. The Agent must hold a Work Session and be Ready with no other work
   * (checked again where the call is placed, under the managed runtime's locks)
   */
  async dial(
    actor: AgentCallbackActor,
    callbackValue: unknown,
    body: Record<string, unknown>,
    decide: AgentCallbackDecider,
  ): Promise<AgentCallbackDialResult> {
    const callbackId = uuidInput(callbackValue, 'callbackId');
    const commandId = uuidInput(body.commandId, 'commandId');
    const expectedVersion = versionInput(body.expectedVersion);
    const payloadDigest = digest([1, callbackId, expectedVersion]);
    const replay = await this.replay(actor, commandId, 'callback.dial', payloadDigest, callbackId);
    if (replay) return replay as AgentCallbackDialResult;
    if (!this.deps.calls) throw new AgentCallbackError('VOICE_NOT_READY');
    const calls = this.deps.calls;

    const target = await this.read(actor, async (transaction, teamActor) => {
      const row = await this.visible(transaction, teamActor, callbackId, expectedVersion, false);
      const now = this.now();
      const session = await transaction.agentWorkSessionLease.findFirst({
        where: {
          tenantId: teamActor.tenantId,
          userId: teamActor.userId,
          releasedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (!session) throw new AgentCallbackError('NO_WORK_SESSION');
      const destination = await this.dialableIdentity(
        transaction,
        teamActor,
        row.contact_id,
        row.identity_id,
      );
      return { row, destination };
    });

    const outcome = await decide({
      stage: 'DIAL',
      commandId,
      callbackId,
      contactId: target.row.contact_id,
      identityId: target.row.identity_id,
    });

    if (outcome.decision !== 'ALLOW') {
      await outcome.settle?.(false);
      return this.write(
        actor,
        commandId,
        'callback.dial',
        payloadDigest,
        async (transaction, teamActor) => {
          const row = await this.lockVisible(transaction, teamActor, callbackId, expectedVersion);
          const reasonCode = outcome.reasonCode;
          if (outcome.decision === 'DEFER') {
            const now = this.now();
            const earliest = now.getTime() + AGENT_CALLBACK_MIN_LEAD_MS;
            const given = outcome.nextEligibleAt ? Date.parse(outcome.nextEligibleAt) : NaN;
            // without a computable time from Governance, try again in an hour
            const requestedFor = new Date(
              Number.isFinite(given) ? Math.max(given, earliest) : now.getTime() + 60 * 60_000,
            );
            const version = await this.update(transaction, teamActor.tenantId, row, {
              requestedFor,
              expiresAt: new Date(requestedFor.getTime() + AGENT_CALLBACK_EXPIRY_MS),
              lastReasonCode: reasonCode,
            });
            await this.event(transaction, teamActor.tenantId, callbackId, 'DEFERRED', {
              actorUserId: teamActor.userId,
              reasonCode,
              requestedFor,
              decisionId: outcome.decisionId,
            });
            return {
              status: 'DEFERRED' as const,
              callbackId,
              version,
              requestedFor: requestedFor.toISOString(),
              reasonCode,
            };
          }
          if (outcome.decision === 'BLOCK') {
            const version = await this.update(transaction, teamActor.tenantId, row, {
              state: 'CANCELLED',
              cancelledAt: this.now(),
              cancelReasonCode: 'GOVERNANCE_BLOCKED',
              lastReasonCode: reasonCode,
            });
            await this.event(transaction, teamActor.tenantId, callbackId, 'BLOCKED', {
              actorUserId: teamActor.userId,
              reasonCode,
              decisionId: outcome.decisionId,
            });
            return { status: 'BLOCKED' as const, callbackId, version, reasonCode };
          }
          const version = await this.update(transaction, teamActor.tenantId, row, {
            lastReasonCode: reasonCode,
          });
          await this.event(transaction, teamActor.tenantId, callbackId, 'REVIEW', {
            actorUserId: teamActor.userId,
            reasonCode,
            decisionId: outcome.decisionId,
          });
          return { status: 'REVIEW' as const, callbackId, version, reasonCode };
        },
        callbackId,
      );
    }

    let result: AgentCallbackDialResult;
    try {
      result = await this.write(
        actor,
        commandId,
        'callback.dial',
        payloadDigest,
        async (transaction, teamActor) => {
          const row = await this.lockVisible(transaction, teamActor, callbackId, expectedVersion);
          const destination = await this.dialableIdentity(
            transaction,
            teamActor,
            row.contact_id,
            row.identity_id,
          );
          const call = await calls.start(transaction, {
            tenantId: teamActor.tenantId,
            queueId: row.queue_id,
            agentId: teamActor.userId,
            contactId: row.contact_id,
            destination,
            callbackId,
          });
          const version = await this.update(transaction, teamActor.tenantId, row, {
            state: 'ORIGINATING',
            attemptInteractionId: call.interactionId,
            attemptCount: { increment: 1 },
            lastReasonCode: null,
          });
          await this.event(transaction, teamActor.tenantId, callbackId, 'DIAL_STARTED', {
            actorUserId: teamActor.userId,
            interactionId: call.interactionId,
            decisionId: outcome.decisionId,
          });
          return {
            status: 'DIALING' as const,
            callbackId,
            version,
            interactionId: call.interactionId,
          };
        },
        callbackId,
      );
    } catch (error) {
      // nothing was placed: give the permission back at once
      await outcome.settle?.(false).catch(() => undefined);
      throw error;
    }
    // the attempt happened; a failed confirm leaves the reservation to expire on its own
    await outcome.settle?.(true).catch(() => undefined);
    return result;
  }

  /** the Agent's own callbacks plus the team's callbacks that moved to the team, oldest time first */
  async list(
    actor: AgentCallbackActor,
  ): Promise<{ items: AgentCallbackView[]; serverTime: string }> {
    return this.read(actor, async (transaction, teamActor) => {
      const now = this.now();
      const rows = await transaction.$queryRaw<
        {
          id: string;
          version: number;
          state: AgentCallbackState;
          contact_id: string;
          contact_name: string | null;
          number: string;
          note: string | null;
          requested_for: Date;
          expires_at: Date;
          agent_id: string | null;
          created_by_name: string | null;
          last_reason_code: string | null;
          attempt_count: number;
        }[]
      >(Prisma.sql`
        SELECT cb.id, cb.version, cb.state::text AS state, cb.contact_id, c.display_name AS contact_name,
               ci.value AS number, cb.note, cb.requested_for, cb.expires_at, cb.agent_id,
               author.display_name AS created_by_name, cb.last_reason_code, cb.attempt_count
          FROM ob_callbacks cb
          JOIN contacts c ON c.tenant_id = cb.tenant_id AND c.id = cb.contact_id
          JOIN contact_identities ci ON ci.tenant_id = cb.tenant_id AND ci.id = cb.identity_id
          LEFT JOIN users author ON author.tenant_id = cb.tenant_id AND author.id = cb.created_by_user_id
         WHERE cb.tenant_id = ${teamActor.tenantId}::uuid
           AND cb.origin = 'AGENT'
           AND cb.state IN ('SCHEDULED', 'ORIGINATING')
           AND (cb.agent_id = ${teamActor.userId}::uuid
                OR (cb.agent_id IS NULL AND cb.target_owner_team_id = ${teamActor.teamId}::uuid))
         ORDER BY cb.requested_for, cb.id
         LIMIT 200`);
      return {
        serverTime: now.toISOString(),
        items: rows.map((row) => ({
          id: row.id,
          version: row.version,
          state: row.state,
          contactId: row.contact_id,
          contactName: row.contact_name,
          number: row.number,
          note: row.note,
          requestedFor: row.requested_for.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          due: row.requested_for.getTime() <= now.getTime(),
          team: row.agent_id === null,
          mine: row.agent_id === teamActor.userId,
          createdByName: row.created_by_name,
          lastReasonCode: row.last_reason_code,
          attemptCount: row.attempt_count,
        })),
      };
    });
  }

  /**
   * Background round per tenant: expire, move to the team, and settle dial attempts whose call has ended.
   * Each step is one statement over the open agent callbacks, so a round is idempotent.
   */
  async maintain(tenantId: string): Promise<AgentCallbackMaintenance> {
    if (!UUID.test(tenantId)) throw new AgentCallbackError('INVALID_INPUT', 'tenantId');
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const now = this.now();
      const expired = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE ob_callbacks SET state = 'CANCELLED', cancelled_at = ${now}, cancel_reason_code = 'EXPIRED',
               last_reason_code = 'EXPIRED', version = version + 1, updated_at = ${now}
         WHERE tenant_id = ${tenantId}::uuid AND origin = 'AGENT' AND state = 'SCHEDULED'
           AND expires_at <= ${now}
        RETURNING id`);
      for (const row of expired)
        await this.event(transaction, tenantId, row.id, 'EXPIRED', { reasonCode: 'EXPIRED' });

      // "Online" = holds a Work Session that has not ended; an Agent on a break is still online
      const escalated = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE ob_callbacks cb SET agent_id = NULL, escalated_at = ${now}, last_reason_code = 'AGENT_OFFLINE',
               version = cb.version + 1, updated_at = ${now}
         WHERE cb.tenant_id = ${tenantId}::uuid AND cb.origin = 'AGENT' AND cb.state = 'SCHEDULED'
           AND cb.agent_id IS NOT NULL AND cb.escalated_at IS NULL
           AND cb.requested_for <= ${new Date(now.getTime() - AGENT_CALLBACK_ESCALATE_MS)}
           AND NOT EXISTS (
             SELECT 1 FROM agent_work_session_leases l
              WHERE l.tenant_id = cb.tenant_id AND l.user_id = cb.agent_id
                AND l.released_at IS NULL AND l.expires_at > ${now})
        RETURNING cb.id`);
      for (const row of escalated)
        await this.event(transaction, tenantId, row.id, 'ESCALATED', {
          reasonCode: 'AGENT_OFFLINE',
        });

      // A dial attempt is settled once its call has left ASSIGNED: answered by the Agent = called,
      // abandoned before the Agent answered = back to SCHEDULED so it can be dialed again
      const attempts = await transaction.$queryRaw<
        { id: string; interaction_id: string; answered: boolean }[]
      >(Prisma.sql`
        SELECT cb.id, cb.attempt_interaction_id AS interaction_id, (i.answered_at IS NOT NULL) AS answered
          FROM ob_callbacks cb
          JOIN interactions i ON i.tenant_id = cb.tenant_id AND i.id = cb.attempt_interaction_id
         WHERE cb.tenant_id = ${tenantId}::uuid AND cb.origin = 'AGENT' AND cb.state = 'ORIGINATING'
           AND i.state NOT IN ('QUEUED', 'ASSIGNED')
         FOR UPDATE OF cb`);
      let connected = 0;
      let notConnected = 0;
      for (const attempt of attempts) {
        const settled = await this.settleAttempt(
          transaction,
          tenantId,
          attempt.id,
          attempt.answered,
        );
        if (settled === 'CONNECTED') connected += 1;
        if (settled === 'NOT_CONNECTED') notConnected += 1;
      }
      return { expired: expired.length, escalated: escalated.length, connected, notConnected };
    });
  }

  private async settleAttempt(
    transaction: Transaction,
    tenantId: string,
    callbackId: string,
    answered: boolean,
  ): Promise<'CONNECTED' | 'NOT_CONNECTED'> {
    const now = this.now();
    const [row] = await transaction.$queryRaw<
      { attempt_interaction_id: string | null }[]
    >(Prisma.sql`
      UPDATE ob_callbacks SET
             state = ${answered ? 'CONSUMED' : 'SCHEDULED'}::"ObCallbackState",
             last_reason_code = ${answered ? null : 'AGENT_NOT_ANSWERED'},
             version = version + 1, updated_at = ${now}
       WHERE tenant_id = ${tenantId}::uuid AND id = ${callbackId}::uuid AND state = 'ORIGINATING'
      RETURNING attempt_interaction_id`);
    await this.event(transaction, tenantId, callbackId, answered ? 'CONNECTED' : 'NOT_CONNECTED', {
      interactionId: row?.attempt_interaction_id ?? undefined,
      ...(answered ? {} : { reasonCode: 'AGENT_NOT_ANSWERED' }),
    });
    return answered ? 'CONNECTED' : 'NOT_CONNECTED';
  }

  // ── shared pieces ──

  private async teamActor(transaction: Transaction, actor: AgentCallbackActor): Promise<TeamActor> {
    const user = await transaction.user.findFirst({
      where: { tenantId: actor.tenantId, id: actor.userId, isActive: true },
      select: { role: true, teamId: true },
    });
    if (!user || user.role !== 'AGENT') throw new AgentCallbackError('AGENT_REQUIRED');
    if (!user.teamId) throw new AgentCallbackError('TEAM_REQUIRED');
    return { ...actor, teamId: user.teamId };
  }

  private read<T>(
    actor: AgentCallbackActor,
    work: (transaction: Transaction, actor: TeamActor) => Promise<T>,
  ): Promise<T> {
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) =>
      work(transaction, await this.teamActor(transaction, actor)),
    );
  }

  /** work the Agent holds now (talking or wrap-up) and that is linked to a customer */
  private async heldWork(
    transaction: Transaction,
    actor: TeamActor,
    interactionId: string,
  ): Promise<{ contactId: string; queueId: string | null }> {
    const work = await transaction.interaction.findFirst({
      where: { tenantId: actor.tenantId, id: interactionId, agentId: actor.userId },
      select: { state: true, contactId: true, queueId: true },
    });
    // Work of another Agent or tenant is answered as not found, so its existence is not revealed
    if (!work) throw new AgentCallbackError('WORK_NOT_FOUND');
    if (work.state !== 'ACTIVE' && work.state !== 'WRAPUP')
      throw new AgentCallbackError('WORK_NOT_ACTIVE');
    if (!work.contactId) throw new AgentCallbackError('CONTACT_REQUIRED');
    return { contactId: work.contactId, queueId: work.queueId };
  }

  private async dialableIdentity(
    transaction: Transaction,
    actor: TeamActor,
    contactId: string,
    identityId: string,
  ): Promise<string> {
    const identity = await transaction.contactIdentity.findFirst({
      where: { tenantId: actor.tenantId, id: identityId, contactId, type: 'PHONE' },
      select: { value: true },
    });
    if (!identity) throw new AgentCallbackError('NUMBER_NOT_FOUND');
    const number = dialableNumber(identity.value);
    if (!number) throw new AgentCallbackError('NUMBER_NOT_DIALABLE');
    return number;
  }

  /**
   * The managed voice queue the call will run on: the queue of the source work when it is one,
   * otherwise the first managed voice queue of the Agent's team (by name)
   */
  private async callbackQueue(
    transaction: Transaction,
    actor: TeamActor,
    sourceQueueId: string | null,
  ): Promise<{ id: string; name: string } | null> {
    const rows = await transaction.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`
      SELECT q.id, q.name FROM queues q
        JOIN voice_managed_queue_policies p ON p.tenant_id = q.tenant_id AND p.queue_id = q.id
       WHERE q.tenant_id = ${actor.tenantId}::uuid AND q.is_active AND q.team_id = ${actor.teamId}::uuid
       ORDER BY (q.id = ${sourceQueueId}::uuid) DESC NULLS LAST, q.name, q.id
       LIMIT 1`);
    return rows[0] ?? null;
  }

  /** an open callback the Agent may act on: their own, or the team's once it moved to the team */
  private lockVisible(
    transaction: Transaction,
    actor: TeamActor,
    callbackId: string,
    expectedVersion: number,
  ): Promise<CallbackRow> {
    return this.visible(transaction, actor, callbackId, expectedVersion, true);
  }

  private async visible(
    transaction: Transaction,
    actor: TeamActor,
    callbackId: string,
    expectedVersion: number,
    lock: boolean,
  ): Promise<CallbackRow> {
    const [row] = await transaction.$queryRaw<CallbackRow[]>(Prisma.sql`
      SELECT id, version, state::text AS state, agent_id, target_owner_team_id, contact_id, identity_id,
             queue_id, requested_for
        FROM ob_callbacks
       WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${callbackId}::uuid AND origin = 'AGENT'
         AND (agent_id = ${actor.userId}::uuid
              OR (agent_id IS NULL AND target_owner_team_id = ${actor.teamId}::uuid))
       ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`);
    if (!row) throw new AgentCallbackError('CALLBACK_NOT_FOUND');
    if (row.state !== 'SCHEDULED') throw new AgentCallbackError('CALLBACK_NOT_SCHEDULED');
    if (row.version !== expectedVersion) throw new AgentCallbackError('VERSION_CONFLICT');
    return row;
  }

  private async update(
    transaction: Transaction,
    tenantId: string,
    row: CallbackRow,
    data: Prisma.ObCallbackUpdateManyMutationInput,
  ): Promise<number> {
    const updated = await transaction.obCallback.updateMany({
      where: { tenantId, id: row.id, version: row.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new AgentCallbackError('VERSION_CONFLICT');
    return row.version + 1;
  }

  private async event(
    transaction: Transaction,
    tenantId: string,
    callbackId: string,
    kind: string,
    detail: {
      actorUserId?: string;
      reasonCode?: string;
      requestedFor?: Date;
      interactionId?: string;
      decisionId?: string;
    },
  ): Promise<void> {
    await transaction.obCallbackEvent.create({
      data: {
        id: this.id(),
        tenantId,
        callbackId,
        kind,
        actorUserId: detail.actorUserId ?? null,
        reasonCode: detail.reasonCode ?? null,
        requestedFor: detail.requestedFor ?? null,
        interactionId: detail.interactionId ?? null,
        decisionId: detail.decisionId ?? null,
      },
    });
  }

  private async replay(
    actor: AgentCallbackActor,
    commandId: string,
    action: string,
    payloadDigest: string,
    resourceId?: string,
  ): Promise<AgentCallbackRef | null> {
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const receipt = await transaction.commandReceipt.findUnique({
        where: { tenantId_commandId: { tenantId: actor.tenantId, commandId } },
      });
      if (!receipt) return null;
      return this.checkReceipt(receipt, actor, action, payloadDigest, resourceId);
    });
  }

  private checkReceipt(
    receipt: {
      actorUserId: string;
      action: string;
      resourceId: string;
      payloadDigest: string | null;
      result: unknown;
    },
    actor: AgentCallbackActor,
    action: string,
    payloadDigest: string,
    resourceId?: string,
  ): AgentCallbackRef {
    if (
      receipt.actorUserId !== actor.userId ||
      receipt.action !== action ||
      (resourceId !== undefined && receipt.resourceId !== resourceId)
    )
      throw new AgentCallbackError('COMMAND_ID_REUSED');
    if (receipt.payloadDigest !== payloadDigest)
      throw new AgentCallbackError('COMMAND_PAYLOAD_MISMATCH');
    return receipt.result as AgentCallbackRef;
  }

  /** lock per commandId, answer an earlier result, then store the receipt with the change */
  private async write<T extends AgentCallbackRef>(
    actor: AgentCallbackActor,
    commandId: string,
    action: string,
    payloadDigest: string,
    work: (transaction: Transaction, actor: TeamActor) => Promise<T>,
    resourceId?: string,
  ): Promise<T> {
    try {
      return await withTenantDatabaseTransaction(
        this.database,
        actor.tenantId,
        async (transaction) => {
          await transaction.$executeRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.tenantId}:${commandId}`}, 0))`,
          );
          const teamActor = await this.teamActor(transaction, actor);
          const receipt = await transaction.commandReceipt.findUnique({
            where: { tenantId_commandId: { tenantId: actor.tenantId, commandId } },
          });
          if (receipt)
            return this.checkReceipt(receipt, actor, action, payloadDigest, resourceId) as T;
          const result = await work(transaction, teamActor);
          await transaction.commandReceipt.create({
            data: {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              commandId,
              resourceId: result.callbackId,
              action,
              payloadDigest,
              result: result as unknown as Prisma.InputJsonObject,
            },
          });
          return result;
        },
      );
    } catch (error) {
      // the partial unique index is the last guard against two open callbacks for one customer
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        String(error.meta?.target ?? '').includes('contact')
      )
        throw new AgentCallbackError('CALLBACK_EXISTS');
      throw error;
    }
  }
}
