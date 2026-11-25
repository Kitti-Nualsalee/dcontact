/**
 * Owner: Integrations — click-to-call of the embedded dphone (E1.14 #488)
 *
 * Authority: E1.6 #462 items 3, 5; the decision gap ruling at #464 (2026-09-28)
 *
 * - the host only fills in the number, the agent must press dial themselves — this endpoint is called only when the agent presses dial in dphone
 * - the origin comes from a still-current `embedded` lease; the contact is resolved from the number on the server side (the host's `contactId` is not trusted)
 * - `authorizeAndReserve()` purpose `SERVICE` channel `VOICE`; BLOCK/DEFER/REVIEW → no outbound call
 * - ALLOW → `dialing` only when the Voice Delivery Gate commits the durable queue; if there is no gate or
 *   the gate rejects before the durable barrier, the reservation must be released and `unavailable` answered
 * - answers the host without PII; rate limit per agent; audit every time (the number is not kept)
 */
import { randomUUID } from 'node:crypto';
import { C360ContactPointError, normalizeC360Phone } from '@d-contact/contact-points';
import {
  eligibleLegacyIdentityByKey,
  Prisma,
  withTenantDatabaseTransaction,
  type PrismaClient,
} from '@d-contact/db';
import type { CallResultMessage } from '@d-contact/dphone-embed';
import type {
  AuthorizationOutcome,
  AuthorizeAndReserveInput,
  ReservationCommand,
} from '@d-contact/cxa-contracts';

export const CLICK_TO_CALL_PURPOSE = 'SERVICE';
export const CLICK_TO_CALL_SOURCE = 'DPHONE_CLICK_TO_CALL';
export const OUTBOUND_VOICE_NOT_ENABLED = 'OUTBOUND_VOICE_NOT_ENABLED';

export interface ClickToCallGovernance {
  authorizeAndReserve(
    tenantId: string,
    input: AuthorizeAndReserveInput,
  ): Promise<AuthorizationOutcome>;
  changeReservationState(
    tenantId: string,
    reservationId: string,
    command: ReservationCommand,
  ): Promise<unknown>;
}

export interface ClickToCallActor {
  tenantId: string;
  userId: string;
}

/** the Delivery owner answers QUEUED only after the claim and the durable outbox commit */
export interface ClickToCallVoiceDelivery {
  enqueue(input: {
    tenantId: string;
    userId: string;
    leaseId: string;
    actionKey: string;
    reservationId: string;
    contactId: string;
    identityId: string;
    correlationId: string;
  }): Promise<
    | { status: 'QUEUED' }
    | {
        status: 'UNAVAILABLE';
        reasonCode: string;
        reservationReleased?: true;
        reservationFinalized?: true;
      }
  >;
  cancel?(input: {
    tenantId: string;
    userId: string;
    leaseId: string;
    actionKey: string;
    correlationId: string;
  }): Promise<
    | { status: 'CANCELLED' }
    | { status: 'RECONCILING' }
    | { status: 'FINAL' }
    | { status: 'NOT_FOUND' }
  >;
}

export type ClickToCallOutcome =
  { status: 'result'; message: CallResultMessage; hostOrigin: string } | { status: 'not_found' };

export type ClickToCallCancelOutcome =
  | {
      status: 'result';
      hostOrigin: string;
      result: { requestId: string; status: 'cancelled' | 'reconciling' | 'final' };
    }
  | { status: 'not_found' };

/** the number for comparing identity: drop separators, keep the digits and a leading `+` */
export function normalizeDialNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\+?[0-9][0-9 ()-]{1,30}$/.test(trimmed)) return null;
  const digits = trimmed.replace(/[^0-9]/g, '');
  return digits.length >= 3 && digits.length <= 20 ? digits : null;
}

/** a sandbox internal number that telephony allows to dial (`freeswitch-voice-target-resolver.ts`) */
const SANDBOX_EXTENSION = /^1[0-9]{3}$/;

export class ClickToCallService {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly database: PrismaClient,
    private readonly deps: {
      hostOriginOfLease(actor: ClickToCallActor, leaseId: string): Promise<string | null>;
      governance: ClickToCallGovernance;
      now?: () => Date;
      id?: () => string;
      /** per agent — the default is 10 attempts / 60 seconds */
      rate?: { limit: number; windowMs: number };
      voiceDelivery?: ClickToCallVoiceDelivery;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? randomUUID;
  }

  async request(
    actor: ClickToCallActor,
    input: { leaseId: string; requestId: string; number: string },
    correlationId: string,
  ): Promise<ClickToCallOutcome> {
    const hostOrigin = await this.deps.hostOriginOfLease(actor, input.leaseId);
    if (!hostOrigin) return { status: 'not_found' };
    // the actionKey binds to the lease + the host requestId: resending gets the same result (idempotent at Governance)
    const actionKey = `dphone-click-to-call:${input.leaseId}:${input.requestId}`;
    const audit = { actor, input, hostOrigin, actionKey, correlationId };

    if (!this.allow(actor)) {
      const message = result(input.requestId, 'rate_limited', true, 'RATE_LIMITED');
      await this.audit(audit, { message, contactId: null, outcome: null });
      return { status: 'result', message, hostOrigin };
    }

    const number = normalizeDialNumber(input.number);
    if (!number) {
      const message = result(input.requestId, 'blocked', true, 'INVALID_NUMBER');
      await this.audit(audit, { message, contactId: null, outcome: null });
      return { status: 'result', message, hostOrigin };
    }

    const target = await this.resolveTarget(actor.tenantId, input.number, number);
    const outcome = await this.deps.governance.authorizeAndReserve(actor.tenantId, {
      channel: 'VOICE',
      purpose: CLICK_TO_CALL_PURPOSE,
      source: CLICK_TO_CALL_SOURCE,
      sourceId: input.leaseId,
      actionKey,
      policyVersion: 1,
      ...(target
        ? { contactId: target.contactId, identityId: target.identityId }
        : { identityResolution: 'NOT_FOUND' as const }),
    });

    let message: CallResultMessage;
    if (outcome.decision === 'ALLOW') {
      const delivery =
        outcome.reservationId && target && this.deps.voiceDelivery
          ? await this.deps.voiceDelivery.enqueue({
              tenantId: actor.tenantId,
              userId: actor.userId,
              leaseId: input.leaseId,
              actionKey,
              reservationId: outcome.reservationId,
              contactId: target.contactId,
              identityId: target.identityId,
              correlationId,
            })
          : { status: 'UNAVAILABLE' as const, reasonCode: OUTBOUND_VOICE_NOT_ENABLED };
      if (delivery.status === 'QUEUED') {
        message = result(input.requestId, 'dialing', false, 'QUEUED');
      } else {
        // no durable queue or the queue rejects before the submission barrier — give the permission back at once
        if (
          outcome.reservationId &&
          !delivery.reservationReleased &&
          !delivery.reservationFinalized
        ) {
          await this.deps.governance.changeReservationState(
            actor.tenantId,
            outcome.reservationId,
            'RELEASE',
          );
        }
        message = result(input.requestId, 'unavailable', false, delivery.reasonCode);
      }
    } else {
      message = result(input.requestId, 'blocked', true, outcome.reasonCode);
      if (outcome.decision === 'DEFER' && outcome.nextEligibleAt) {
        message.retryAt = outcome.nextEligibleAt;
      }
    }
    message.decisionId = outcome.decisionId;
    await this.audit(audit, { message, contactId: target?.contactId ?? null, outcome });
    return { status: 'result', message, hostOrigin };
  }

  async cancel(
    actor: ClickToCallActor,
    input: { leaseId: string; requestId: string },
    correlationId: string,
  ): Promise<ClickToCallCancelOutcome> {
    const hostOrigin = await this.deps.hostOriginOfLease(actor, input.leaseId);
    if (!hostOrigin || !this.deps.voiceDelivery?.cancel) return { status: 'not_found' };
    const cancelled = await this.deps.voiceDelivery.cancel({
      tenantId: actor.tenantId,
      userId: actor.userId,
      leaseId: input.leaseId,
      actionKey: `dphone-click-to-call:${input.leaseId}:${input.requestId}`,
      correlationId,
    });
    if (cancelled.status === 'NOT_FOUND') return { status: 'not_found' };
    return {
      status: 'result',
      hostOrigin,
      result: {
        requestId: input.requestId,
        status:
          cancelled.status === 'CANCELLED'
            ? 'cancelled'
            : cancelled.status === 'FINAL'
              ? 'final'
              : 'reconciling',
      },
    };
  }

  private allow(actor: ClickToCallActor): boolean {
    const { limit, windowMs } = this.deps.rate ?? { limit: 10, windowMs: 60_000 };
    const key = `${actor.tenantId}:${actor.userId}`;
    const now = this.now().getTime();
    const times = (this.recent.get(key) ?? []).filter((time) => now - time < windowMs);
    if (times.length >= limit) {
      this.recent.set(key, times);
      return false;
    }
    times.push(now);
    this.recent.set(key, times);
    return true;
  }

  /**
   * finds the identity of the destination number — not found or ambiguous = unspecified (NOT_FOUND)
   *
   * C3 (#793) bridge: a sandbox internal number (`^1\d{3}$`, matching what telephony restricts) keeps the exact
   * match as before so the sandbox Voice policy does not change (a separate decision gap is opened); other numbers must parse
   * through the international contact point parser and match only an ACTIVE point that comes from the legacy identity
   * of a single contact, never falling back to comparing pure digits with the raw value
   */
  private resolveTarget(
    tenantId: string,
    raw: string,
    digits: string,
  ): Promise<{ contactId: string; identityId: string } | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      if (SANDBOX_EXTENSION.test(raw.trim())) {
        const rows = await tx.$queryRaw<{ contact_id: string; identity_id: string }[]>(Prisma.sql`
          SELECT id::text AS identity_id, contact_id::text AS contact_id FROM contact_identities
          WHERE tenant_id = ${tenantId}::uuid AND type = 'PHONE'
            AND regexp_replace(value, '[^0-9]', '', 'g') = ${digits}
          LIMIT 2`);
        return rows.length === 1
          ? { contactId: rows[0]!.contact_id, identityId: rows[0]!.identity_id }
          : null;
      }
      let phone;
      try {
        phone = normalizeC360Phone(raw, null);
      } catch (error) {
        if (error instanceof C360ContactPointError) return null;
        throw error;
      }
      const resolved = await eligibleLegacyIdentityByKey(tx, tenantId, {
        kind: 'PHONE',
        normalizationVersion: phone.normalizationVersion,
        normalizedValue: phone.normalizedValue,
      });
      return resolved.status === 'RESOLVED'
        ? { contactId: resolved.contactId, identityId: resolved.identityId }
        : null;
    });
  }

  private async audit(
    context: {
      actor: ClickToCallActor;
      input: { leaseId: string; requestId: string };
      hostOrigin: string;
      actionKey: string;
      correlationId: string;
    },
    detail: {
      message: CallResultMessage;
      contactId: string | null;
      outcome: AuthorizationOutcome | null;
    },
  ) {
    await withTenantDatabaseTransaction(this.database, context.actor.tenantId, (tx) =>
      tx.dphoneClickToCallAuditEvent.create({
        data: {
          id: this.id(),
          tenantId: context.actor.tenantId,
          actorUserId: context.actor.userId,
          leaseId: context.input.leaseId,
          hostOrigin: context.hostOrigin,
          requestId: context.input.requestId,
          actionKey: context.actionKey,
          contactId: detail.contactId,
          decisionId: detail.outcome?.decisionId ?? null,
          decision: detail.outcome?.decision ?? null,
          reasonCode: detail.message.reasonCode ?? 'UNKNOWN',
          outcome: detail.message.status,
          correlationId: context.correlationId,
          occurredAt: this.now(),
        },
      }),
    );
  }
}

function result(
  requestId: string,
  status: CallResultMessage['status'],
  blocked: boolean,
  reasonCode: string,
): CallResultMessage {
  return { v: 1, type: 'dphone.call.result', requestId, status, blocked, reasonCode };
}
