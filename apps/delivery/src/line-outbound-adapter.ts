/**
 * Owner: Delivery/Channels — LINE outbound adapter and exact-key reconciliation (S2.4 #370)
 *
 * Authority: #357 (submission/retry matrix), #358 (rollout/caps), #361 (Attempt/Touch), #362 §6
 *
 * Rules the whole file stands on:
 *
 * 1. **Barrier**: the canonical payload + `providerRequestKey` are always persisted before touching the network.
 *    A row that has passed `SUBMITTING` must not submit again — it can only reconcile with the original request
 * 2. **Exact-key retry**: a retry is a re-POST of the original request byte for byte with the original `X-Line-Retry-Key`,
 *    not a new send, so never mint a new key under any circumstance
 * 3. **Never guess acceptance**: only `2xx` and `409 + accepted request id` are accepted;
 *    timeout/5xx/malformed response means "outcome unknown", which differs from "not sent"
 * 4. **No DELIVERED/DELIVERY_FAILED**: a LINE push has no per-message receipt (#359 §F), so the adapter
 *    can only report accepted/rejected/unknown and lets Governance decide Attempt/refund
 * 5. **24-hour window**: past the window with the outcome still unknown = `LINE_RETRY_WINDOW_EXPIRED` + quarantine + kill;
 *    never resend with a new key just to "make it finish"
 */
import { randomUUID } from 'node:crypto';
import type { DlOutboxEntry, PrismaClient } from '@d-contact/db';
import {
  actionKey as toActionKey,
  deliveryId as toDeliveryId,
  lineNormalizedOutcome,
  lineProviderSettlement,
  outcomeRef as toOutcomeRef,
  providerRequestKey as toProviderRequestKey,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactGovernancePort,
  type LineDeliveryLifecycleEventV1,
  type LineLifecycleState,
  type LineProviderOutcomeCode,
  type LineRejectionScope,
} from '@d-contact/cxa-contracts';
import { LineProviderAttemptRepository } from './line-attempt-repository.js';
import { LineEventOutboxRepository } from './line-event-outbox.js';
import type { LineControlActor, LineControlPlane, LineRunGrant } from './line-control-plane.js';
import type { LineGateScope } from './line-control-repository.js';
import type { LineQuotaSnapshot } from './line-control-policy.js';
import {
  buildLineCanonicalRequestFrom,
  deriveLineRetryKey,
  isLineRetryKey,
  LINE_FIXTURE_CONTENT_SOURCE,
  lineBackoffMs,
  lineRetryWindowExpired,
  type LineCanonicalRequest,
  type LineContentSource,
  type LineResolvedContent,
} from './line-push-request.js';
import {
  classifyLineResponse,
  type LineProviderTransport,
  type LineTransportResult,
} from './line-provider-transport.js';
import { OutboxRepository } from './outbox-repository.js';

/** The real recipient lives in the protected store; the adapter sees only a ref and has the resolver return the value in memory */
export interface LineRecipientResolver {
  resolve(input: {
    tenantId: string;
    recipientProtectedRef: string;
  }): Promise<{ userId: string } | null>;
}

/** The access token exists only in memory (S2.3 `LineCredentialBoundary`) */
export interface LineAccessTokenResolver {
  resolve(input: {
    tenantId: string;
    credentialRefId: string;
    version: number;
  }): Promise<{ accessToken: string } | null>;
}

export interface LineOutboundAdapterOptions {
  database: PrismaClient;
  governance: ContactGovernancePort;
  control: LineControlPlane;
  transport: LineProviderTransport;
  recipients: LineRecipientResolver;
  credentials: LineAccessTokenResolver;
  actor: LineControlActor;
  configDigest: string;
  /** #567: source of content for `contentRef` — unspecified = only the closed S2 fixture set */
  content?: LineContentSource;
  now?: () => Date;
  id?: () => string;
}

export interface LineSubmitCommand {
  tenantId: string;
  deliveryId: string;
  scope: LineGateScope;
  runAuthorizationId: string;
  recipientFingerprint: string;
  recipientProtectedRef: string;
  correlationId: string;
  /**
   * Advisory quota that the caller polls before ordering a run (#358 §A) — no snapshot = the gate rejects.
   * The adapter does not poll itself so that not every retry fires the quota API again and eats the rate limit
   */
  quota?: LineQuotaSnapshot;
}

export type LineSubmitOutcome =
  | { status: 'ACCEPTED'; outcomeCode: LineProviderOutcomeCode; attemptNo: number }
  | {
      status: 'REJECTED';
      outcomeCode: LineProviderOutcomeCode;
      rejectionScope: LineRejectionScope;
      attemptNo: number;
    }
  | {
      status: 'RECONCILING';
      outcomeCode: LineProviderOutcomeCode;
      attemptNo: number;
      nextAttemptAt: Date;
    }
  | { status: 'QUARANTINED'; outcomeCode: 'LINE_RETRY_WINDOW_EXPIRED'; attemptNo: number }
  | { status: 'DENIED'; code: string }
  | { status: 'NOOP'; reason: 'ALREADY_SETTLED' | 'ALREADY_ACCEPTED' };

export class LineOutboundAdapter {
  private readonly outbox: OutboxRepository;
  private readonly attempts: LineProviderAttemptRepository;
  private readonly events: LineEventOutboxRepository;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: LineOutboundAdapterOptions) {
    this.outbox = new OutboxRepository(options.database, 'LINE_MESSAGING_API');
    this.attempts = new LineProviderAttemptRepository(options.database);
    this.events = new LineEventOutboxRepository(options.database);
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  /**
   * The first send of one delivery — callable only on a row still `QUEUED`.
   * A row that has crossed the barrier must go through `reconcile` only
   */
  async submit(command: LineSubmitCommand): Promise<LineSubmitOutcome> {
    const entry = await this.require(command);
    if (entry.state === 'SETTLED') return { status: 'NOOP', reason: 'ALREADY_SETTLED' };
    if (entry.state === 'SUBMITTED') return { status: 'NOOP', reason: 'ALREADY_ACCEPTED' };
    if (entry.state !== 'QUEUED') return this.reconcile(command);

    const content = await this.content(entry);
    const canonical = buildLineCanonicalRequestFrom(content, command.recipientFingerprint);
    const grant = await this.options.control.beginRun(this.options.actor, {
      tenantId: command.tenantId,
      scope: command.scope,
      runAuthorizationId: command.runAuthorizationId,
      deliveryId: command.deliveryId,
      recipientFingerprint: command.recipientFingerprint,
      contentDigest: content.gateDigest,
      configDigest: this.options.configDigest,
      ...(command.quota ? { quota: command.quota } : {}),
      at: this.now(),
    });
    if (grant.status === 'DENIED') return { status: 'DENIED', code: grant.code };
    // restart after crossing the barrier: the cap says it was already committed, must not submit again (#362 §11)
    if (grant.barrier === 'POST') return this.reconcile(command, grant);

    await this.emit(entry, 'PRE_BARRIER', command.correlationId);
    return this.attempt(entry, command, canonical, grant, 1, content);
  }

  /** Content of this row — resolved once per call and used for both the gate and the request (they must not differ) */
  private content(entry: DlOutboxEntry): Promise<LineResolvedContent> {
    return (this.options.content ?? LINE_FIXTURE_CONTENT_SOURCE).resolve(
      entry.tenantId,
      entry.contentRef,
    );
  }

  /**
   * exact-key reconciliation — for rows that have crossed the barrier and whose outcome is still unknown.
   * No path in this method creates a new key or changes the payload
   */
  async reconcile(command: LineSubmitCommand, granted?: LineRunGrant): Promise<LineSubmitOutcome> {
    const entry = await this.require(command);
    if (entry.state === 'SETTLED') return { status: 'NOOP', reason: 'ALREADY_SETTLED' };
    if (entry.state === 'SUBMITTED') return { status: 'NOOP', reason: 'ALREADY_ACCEPTED' };

    const content = await this.content(entry);
    const canonical = buildLineCanonicalRequestFrom(content, command.recipientFingerprint);
    const history = await this.attempts.listForDelivery(command.tenantId, command.deliveryId);
    const first = history[0];
    const attemptNo = history.length + 1;
    if (first && lineRetryWindowExpired(first.startedAt, this.now())) {
      return this.quarantine(entry, command, attemptNo - 1);
    }

    const grant =
      granted ??
      (await (async () => {
        const result = await this.options.control.beginRun(this.options.actor, {
          tenantId: command.tenantId,
          scope: command.scope,
          runAuthorizationId: command.runAuthorizationId,
          deliveryId: command.deliveryId,
          recipientFingerprint: command.recipientFingerprint,
          contentDigest: content.gateDigest,
          configDigest: this.options.configDigest,
          ...(command.quota ? { quota: command.quota } : {}),
          at: this.now(),
        });
        return result.status === 'AUTHORIZED' ? result : undefined;
      })());
    if (!grant) return { status: 'DENIED', code: 'LINE_GATE_AUTHORIZATION_DENIED' };

    return this.attempt(entry, command, canonical, grant, attemptNo, content);
  }

  /** One attempt = one HTTP request + one receipt, always, whatever the result */
  private async attempt(
    entry: DlOutboxEntry,
    command: LineSubmitCommand,
    canonical: LineCanonicalRequest,
    grant: LineRunGrant,
    attemptNo: number,
    content: LineResolvedContent,
  ): Promise<LineSubmitOutcome> {
    const reserved = await this.options.control.reserveProviderAttempt(
      this.options.actor,
      {
        tenantId: command.tenantId,
        scope: command.scope,
        runAuthorizationId: command.runAuthorizationId,
        deliveryId: command.deliveryId,
        recipientFingerprint: command.recipientFingerprint,
        contentDigest: content.gateDigest,
        configDigest: this.options.configDigest,
        ...(command.quota ? { quota: command.quota } : {}),
        at: this.now(),
      },
      grant.gate,
      grant.run,
      attemptNo,
    );
    if (reserved.status === 'DENIED') {
      // attempt cap exhausted = no right to fire more but the original outcome is still unknown, so it stays unknown, not failure
      return { status: 'DENIED', code: reserved.code };
    }

    const retryKey = this.retryKey(entry);
    const recipient = await this.options.recipients.resolve({
      tenantId: command.tenantId,
      recipientProtectedRef: command.recipientProtectedRef,
    });
    const credential = await this.options.credentials.resolve({
      tenantId: command.tenantId,
      credentialRefId: grant.credential.id,
      version: grant.credential.version,
    });
    if (!recipient || !credential) return { status: 'DENIED', code: 'LINE_CREDENTIAL_UNAVAILABLE' };

    // ── submission barrier ────────────────────────────────────────────────
    if (entry.state === 'QUEUED') {
      await this.options.governance.beginProviderSubmission({
        tenantId: toTenantId(command.tenantId),
        correlationId: command.correlationId,
        reservationId: toReservationId(entry.reservationId),
        actionKey: toActionKey(entry.actionKey),
        deliveryId: toDeliveryId(entry.deliveryId),
        expectedLeaseVersion: entry.leaseVersion,
        providerRequestKey: toProviderRequestKey(retryKey),
      });
      await this.outbox.advance(command.tenantId, command.deliveryId, ['QUEUED'], {
        state: 'SUBMITTING',
      });
      await this.options.control.commitDelivery(command.tenantId, command.deliveryId, this.now());
      await this.emit(entry, 'POST_BARRIER', command.correlationId);
    }

    const startedAt = this.now();
    let result: LineTransportResult;
    try {
      result = await this.options.transport.push({
        to: recipient.userId,
        messages: canonical.messages,
        retryKey,
        accessToken: credential.accessToken,
      });
    } catch {
      // transport threw = outcome unknown, must not be treated as not sent
      result = { kind: 'NO_RESPONSE', reason: 'NETWORK' };
    }
    const finishedAt = this.now();
    const classification = classifyLineResponse(result);
    const response = result.kind === 'RESPONSE' ? result.response : undefined;

    await this.attempts.record({
      id: this.id(),
      tenantId: command.tenantId,
      deliveryId: command.deliveryId,
      providerRequestKey: retryKey,
      attemptNo,
      providerPayloadDigest: canonical.providerPayloadDigest,
      startedAt,
      finishedAt,
      ...(response?.httpStatus ? { httpStatus: response.httpStatus } : {}),
      outcomeCode: classification.outcomeCode,
      ...(classification.rejectionScope ? { rejectionScope: classification.rejectionScope } : {}),
      ...(response?.requestId ? { lineRequestId: response.requestId } : {}),
      ...(response?.acceptedRequestId ? { lineAcceptedRequestId: response.acceptedRequestId } : {}),
      ...(response?.sentMessageIds ? { sentMessageIds: [...response.sentMessageIds] } : {}),
    });

    if (classification.accepted)
      return this.confirm(entry, command, classification.outcomeCode, attemptNo);
    if (!classification.reconcile) {
      return this.reject(
        entry,
        command,
        classification.outcomeCode,
        classification.rejectionScope!,
        attemptNo,
      );
    }
    return this.markReconciling(entry, command, classification.outcomeCode, attemptNo, content);
  }

  /** The provider accepted the request: Attempt 1 / Touch 0 / refund 0 (#361 §B) */
  private async confirm(
    entry: DlOutboxEntry,
    command: LineSubmitCommand,
    outcomeCode: LineProviderOutcomeCode,
    attemptNo: number,
  ): Promise<LineSubmitOutcome> {
    const bound = {
      tenantId: toTenantId(command.tenantId),
      correlationId: command.correlationId,
      reservationId: toReservationId(entry.reservationId),
      actionKey: toActionKey(entry.actionKey),
      deliveryId: toDeliveryId(entry.deliveryId),
    };
    const retryKey = this.retryKey(entry);
    await this.options.governance.confirmProviderAcceptance({
      ...bound,
      providerRequestKey: toProviderRequestKey(retryKey),
    });
    await this.outbox.advance(command.tenantId, command.deliveryId, ['SUBMITTING', 'RECONCILING'], {
      state: 'SUBMITTED',
      submittedAt: this.now(),
    });
    await this.emit(entry, 'ACCEPTED', command.correlationId, outcomeCode);

    await this.options.governance.settleDelivery({
      ...bound,
      providerRequestKey: toProviderRequestKey(retryKey),
      outcomeRef: toOutcomeRef(this.outcomeRef(entry, outcomeCode)),
      outcome: lineNormalizedOutcome(outcomeCode),
      occurredAt: this.now().toISOString(),
    });
    await this.settle(entry, command, outcomeCode);
    return { status: 'ACCEPTED', outcomeCode, attemptNo };
  }

  private async reject(
    entry: DlOutboxEntry,
    command: LineSubmitCommand,
    outcomeCode: LineProviderOutcomeCode,
    rejectionScope: LineRejectionScope,
    attemptNo: number,
  ): Promise<LineSubmitOutcome> {
    const settlement = lineProviderSettlement(outcomeCode, rejectionScope);
    await this.options.governance.settleDelivery({
      tenantId: toTenantId(command.tenantId),
      correlationId: command.correlationId,
      reservationId: toReservationId(entry.reservationId),
      actionKey: toActionKey(entry.actionKey),
      deliveryId: toDeliveryId(entry.deliveryId),
      providerRequestKey: toProviderRequestKey(this.retryKey(entry)),
      outcomeRef: toOutcomeRef(this.outcomeRef(entry, outcomeCode)),
      outcome: lineNormalizedOutcome(outcomeCode),
      rejectionScope: settlement.countsAsAttempt ? 'RECIPIENT' : 'OPERATIONAL',
      occurredAt: this.now().toISOString(),
    });
    // auth/quota is an account-level problem, not of a single delivery — pull the kill switch immediately (#358 §F)
    if (outcomeCode === 'LINE_AUTH_INVALID' || outcomeCode === 'LINE_MONTHLY_QUOTA_EXHAUSTED') {
      const gate = await this.options.control.findGate(command.scope);
      if (gate) {
        await this.options.control.killOnSignal(
          gate,
          outcomeCode === 'LINE_AUTH_INVALID' ? 'AUTH_FAILURE' : 'QUOTA_EXHAUSTED',
          this.now(),
        );
      }
    }
    await this.settle(entry, command, outcomeCode);
    return { status: 'REJECTED', outcomeCode, rejectionScope, attemptNo };
  }

  /** Unknown outcome: the reservation stays UNKNOWN_RECONCILING and the sweeper must not release (#362 §6) */
  private async markReconciling(
    entry: DlOutboxEntry,
    command: LineSubmitCommand,
    outcomeCode: LineProviderOutcomeCode,
    attemptNo: number,
    content: LineResolvedContent,
  ): Promise<LineSubmitOutcome> {
    await this.outbox.advance(command.tenantId, command.deliveryId, ['SUBMITTING', 'RECONCILING'], {
      state: 'RECONCILING',
    });
    const gate = await this.options.control.findGate(command.scope);
    if (gate) {
      await this.options.control.enterUnknownReconciling(
        {
          tenantId: command.tenantId,
          scope: command.scope,
          runAuthorizationId: command.runAuthorizationId,
          deliveryId: command.deliveryId,
          recipientFingerprint: command.recipientFingerprint,
          contentDigest: content.gateDigest,
          configDigest: this.options.configDigest,
          at: this.now(),
        },
        gate.id,
        command.runAuthorizationId,
      );
    }
    await this.options.governance.settleDelivery({
      tenantId: toTenantId(command.tenantId),
      correlationId: command.correlationId,
      reservationId: toReservationId(entry.reservationId),
      actionKey: toActionKey(entry.actionKey),
      deliveryId: toDeliveryId(entry.deliveryId),
      providerRequestKey: toProviderRequestKey(this.retryKey(entry)),
      outcomeRef: toOutcomeRef(this.outcomeRef(entry, outcomeCode)),
      outcome: 'UNKNOWN_RECONCILING',
      occurredAt: this.now().toISOString(),
    });
    await this.emit(entry, 'RECONCILING', command.correlationId, outcomeCode);
    return {
      status: 'RECONCILING',
      outcomeCode,
      attemptNo,
      nextAttemptAt: new Date(this.now().getTime() + lineBackoffMs(attemptNo)),
    };
  }

  /** Past the retry window: stop firing, leave it for a human to inspect, and kill the gate — never resend with a new key */
  private async quarantine(
    entry: DlOutboxEntry,
    command: LineSubmitCommand,
    attemptNo: number,
  ): Promise<LineSubmitOutcome> {
    await this.outbox.advance(command.tenantId, command.deliveryId, ['SUBMITTING', 'RECONCILING'], {
      state: 'RECONCILING',
    });
    const gate = await this.options.control.findGate(command.scope);
    if (gate) {
      await this.options.control.killOnSignal(gate, 'UNKNOWN_OUTCOME_EXPIRED', this.now());
    }
    await this.emit(entry, 'RECONCILING', command.correlationId, 'LINE_RETRY_WINDOW_EXPIRED');
    return { status: 'QUARANTINED', outcomeCode: 'LINE_RETRY_WINDOW_EXPIRED', attemptNo };
  }

  private async settle(
    entry: DlOutboxEntry,
    command: LineSubmitCommand,
    outcomeCode: LineProviderOutcomeCode,
  ) {
    await this.outbox.advance(
      command.tenantId,
      command.deliveryId,
      ['SUBMITTING', 'SUBMITTED', 'RECONCILING'],
      {
        state: 'SETTLED',
        settledAt: this.now(),
        outcome:
          lineNormalizedOutcome(outcomeCode) === 'PROVIDER_ACCEPTED'
            ? 'PROVIDER_ACCEPTED'
            : 'PROVIDER_REJECTED',
        outcomeRef: this.outcomeRef(entry, outcomeCode),
      },
    );
    await this.options.control.exitUnknownReconciling(
      command.tenantId,
      command.deliveryId,
      this.now(),
    );
    await this.emit(entry, 'SETTLED', command.correlationId, outcomeCode);
  }

  private retryKey(entry: DlOutboxEntry): string {
    // the key persisted since enqueue is always the real value; derive is used only for old rows whose key is not a UUID
    return isLineRetryKey(entry.providerRequestKey)
      ? entry.providerRequestKey
      : deriveLineRetryKey(entry.tenantId, entry.deliveryId);
  }

  private outcomeRef(entry: DlOutboxEntry, outcomeCode: LineProviderOutcomeCode): string {
    return `ocr_line_${entry.deliveryId}_${outcomeCode.toLowerCase()}`.slice(0, 64);
  }

  private async require(command: LineSubmitCommand): Promise<DlOutboxEntry> {
    const entry = await this.outbox.findByDeliveryId(command.tenantId, command.deliveryId);
    if (!entry) throw new Error(`LINE outbox has no delivery ${command.deliveryId}`);
    return entry;
  }

  /** lifecycle event is pure metadata — no recipient, payload or token (#362 §5) */
  private async emit(
    entry: DlOutboxEntry,
    state: LineLifecycleState,
    correlationId: string,
    outcomeCode?: LineProviderOutcomeCode,
  ) {
    const event: LineDeliveryLifecycleEventV1 = {
      type: 'delivery.line.lifecycle.v1',
      eventId: `line-lifecycle:${entry.deliveryId}:${state}${outcomeCode ? `:${outcomeCode}` : ''}`,
      tenantId: toTenantId(entry.tenantId),
      occurredAt: this.now().toISOString(),
      correlationId,
      state,
      actionKey: toActionKey(entry.actionKey),
      reservationId: toReservationId(entry.reservationId),
      deliveryId: toDeliveryId(entry.deliveryId),
      providerRequestKey: toProviderRequestKey(this.retryKey(entry)),
      ...(outcomeCode ? { outcomeCode } : {}),
    };
    await this.events.enqueue({
      id: this.id(),
      tenantId: entry.tenantId,
      event,
      orderingKey: entry.deliveryId,
    });
  }
}
