/**
 * Owner: Delivery/Channels — LINE outbound adapter และ exact-key reconciliation (S2.4 #370)
 *
 * Authority: #357 (submission/retry matrix), #358 (rollout/caps), #361 (Attempt/Touch), #362 §6
 *
 * กติกาที่ทั้งไฟล์นี้ยืนอยู่บน:
 *
 * 1. **Barrier**: canonical payload + `providerRequestKey` ถูก persist ก่อนแตะ network เสมอ
 *    แถวที่ผ่าน `SUBMITTING` แล้วห้าม submit ใหม่ — ทำได้แค่ reconcile ด้วย request เดิม
 * 2. **Exact-key retry**: retry คือ re-POST ของ request เดิม byte ต่อ byte พร้อม `X-Line-Retry-Key`
 *    เดิม ไม่ใช่การส่งใหม่ ดังนั้นห้าม mint key ใหม่ไม่ว่ากรณีใด
 * 3. **ไม่เดา acceptance**: `2xx` และ `409 + accepted request id` เท่านั้นที่เป็น accepted;
 *    timeout/5xx/response ผิดรูปคือ "ไม่รู้ผล" ซึ่งต่างจาก "ไม่ได้ส่ง"
 * 4. **ไม่มี DELIVERED/DELIVERY_FAILED**: LINE push ไม่มี receipt ต่อข้อความ (#359 §F) adapter จึง
 *    รายงานได้แค่ accepted/rejected/unknown แล้วให้ Governance ตัดสิน Attempt/refund
 * 5. **window 24 ชม.**: เลย window แล้วยังไม่รู้ผล = `LINE_RETRY_WINDOW_EXPIRED` + quarantine + kill
 *    ห้ามส่งซ้ำด้วย key ใหม่เพื่อ "ให้จบ"
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
  buildLineCanonicalRequest,
  deriveLineRetryKey,
  isLineRetryKey,
  lineBackoffMs,
  lineContentDigest,
  lineRetryWindowExpired,
  type LineCanonicalRequest,
} from './line-push-request.js';
import {
  classifyLineResponse,
  type LineProviderTransport,
  type LineTransportResult,
} from './line-provider-transport.js';
import { OutboxRepository } from './outbox-repository.js';

/** recipient จริงอยู่ใน protected store; adapter เห็นแค่ ref แล้วให้ resolver คืนค่าในหน่วยความจำ */
export interface LineRecipientResolver {
  resolve(input: {
    tenantId: string;
    recipientProtectedRef: string;
  }): Promise<{ userId: string } | null>;
}

/** access token ออกมาในหน่วยความจำเท่านั้น (S2.3 `LineCredentialBoundary`) */
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
   * quota advisory ที่ผู้เรียก poll มาก่อนสั่งรัน (#358 §A) — ไม่มี snapshot = gate ปฏิเสธ
   * adapter ไม่ poll เองเพื่อไม่ให้ทุก retry ยิง quota API เพิ่มและกิน rate limit
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
   * ส่งครั้งแรกของ delivery หนึ่งใบ — เรียกได้เฉพาะแถวที่ยัง `QUEUED`
   * แถวที่ผ่าน barrier แล้วต้องไป `reconcile` เท่านั้น
   */
  async submit(command: LineSubmitCommand): Promise<LineSubmitOutcome> {
    const entry = await this.require(command);
    if (entry.state === 'SETTLED') return { status: 'NOOP', reason: 'ALREADY_SETTLED' };
    if (entry.state === 'SUBMITTED') return { status: 'NOOP', reason: 'ALREADY_ACCEPTED' };
    if (entry.state !== 'QUEUED') return this.reconcile(command);

    const canonical = buildLineCanonicalRequest({
      contentRef: entry.contentRef,
      recipientFingerprint: command.recipientFingerprint,
    });
    const grant = await this.options.control.beginRun(this.options.actor, {
      tenantId: command.tenantId,
      scope: command.scope,
      runAuthorizationId: command.runAuthorizationId,
      deliveryId: command.deliveryId,
      recipientFingerprint: command.recipientFingerprint,
      contentDigest: lineContentDigest(entry.contentRef),
      configDigest: this.options.configDigest,
      ...(command.quota ? { quota: command.quota } : {}),
      at: this.now(),
    });
    if (grant.status === 'DENIED') return { status: 'DENIED', code: grant.code };
    // restart หลังข้าม barrier: cap บอกว่า commit ไปแล้ว ห้าม submit ใหม่ (#362 §11)
    if (grant.barrier === 'POST') return this.reconcile(command, grant);

    await this.emit(entry, 'PRE_BARRIER', command.correlationId);
    return this.attempt(entry, command, canonical, grant, 1);
  }

  /**
   * exact-key reconciliation — ใช้กับแถวที่ผ่าน barrier แล้วและยังไม่รู้ผล
   * ไม่มี path ไหนในเมธอดนี้ที่สร้าง key ใหม่หรือเปลี่ยน payload
   */
  async reconcile(command: LineSubmitCommand, granted?: LineRunGrant): Promise<LineSubmitOutcome> {
    const entry = await this.require(command);
    if (entry.state === 'SETTLED') return { status: 'NOOP', reason: 'ALREADY_SETTLED' };
    if (entry.state === 'SUBMITTED') return { status: 'NOOP', reason: 'ALREADY_ACCEPTED' };

    const canonical = buildLineCanonicalRequest({
      contentRef: entry.contentRef,
      recipientFingerprint: command.recipientFingerprint,
    });
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
          contentDigest: lineContentDigest(entry.contentRef),
          configDigest: this.options.configDigest,
          ...(command.quota ? { quota: command.quota } : {}),
          at: this.now(),
        });
        return result.status === 'AUTHORIZED' ? result : undefined;
      })());
    if (!grant) return { status: 'DENIED', code: 'LINE_GATE_AUTHORIZATION_DENIED' };

    return this.attempt(entry, command, canonical, grant, attemptNo);
  }

  /** หนึ่ง attempt = หนึ่ง HTTP request + หนึ่ง receipt เสมอ ไม่ว่าผลจะเป็นอะไร */
  private async attempt(
    entry: DlOutboxEntry,
    command: LineSubmitCommand,
    canonical: LineCanonicalRequest,
    grant: LineRunGrant,
    attemptNo: number,
  ): Promise<LineSubmitOutcome> {
    const reserved = await this.options.control.reserveProviderAttempt(
      this.options.actor,
      {
        tenantId: command.tenantId,
        scope: command.scope,
        runAuthorizationId: command.runAuthorizationId,
        deliveryId: command.deliveryId,
        recipientFingerprint: command.recipientFingerprint,
        contentDigest: lineContentDigest(entry.contentRef),
        configDigest: this.options.configDigest,
        ...(command.quota ? { quota: command.quota } : {}),
        at: this.now(),
      },
      grant.gate,
      grant.run,
      attemptNo,
    );
    if (reserved.status === 'DENIED') {
      // attempt cap หมด = ไม่มีสิทธิ์ยิงเพิ่ม แต่ผลเดิมยังไม่รู้ จึงคงเป็น unknown ไม่ใช่ failure
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
      // transport โยน = ไม่รู้ผล ห้ามถือว่าไม่ได้ส่ง
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
    return this.markReconciling(entry, command, classification.outcomeCode, attemptNo);
  }

  /** provider รับ request แล้ว: Attempt 1 / Touch 0 / refund 0 (#361 §B) */
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
    // auth/quota เป็นปัญหาระดับบัญชี ไม่ใช่ของ delivery ใบเดียว — ดึง kill switch ทันที (#358 §F)
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

  /** ไม่รู้ผล: reservation ค้างเป็น UNKNOWN_RECONCILING และ sweeper ห้าม release (#362 §6) */
  private async markReconciling(
    entry: DlOutboxEntry,
    command: LineSubmitCommand,
    outcomeCode: LineProviderOutcomeCode,
    attemptNo: number,
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
          contentDigest: lineContentDigest(entry.contentRef),
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

  /** เลย retry window: หยุดยิง ปล่อยให้คนมาตรวจ และ kill gate — ห้ามส่งใหม่ด้วย key ใหม่ */
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
    // key ที่ persist ไว้ตั้งแต่ enqueue เป็นค่าจริงเสมอ; derive ใช้เฉพาะแถวเก่าที่ key ไม่ใช่ UUID
    return isLineRetryKey(entry.providerRequestKey)
      ? entry.providerRequestKey
      : deriveLineRetryKey(entry.tenantId, entry.deliveryId);
  }

  private outcomeRef(entry: DlOutboxEntry, outcomeCode: LineProviderOutcomeCode): string {
    return `ocr_line_${entry.deliveryId}_${outcomeCode.toLowerCase()}`.slice(0, 64);
  }

  private async require(command: LineSubmitCommand): Promise<DlOutboxEntry> {
    const entry = await this.outbox.findByDeliveryId(command.tenantId, command.deliveryId);
    if (!entry) throw new Error(`LINE outbox ไม่มี delivery ${command.deliveryId}`);
    return entry;
  }

  /** lifecycle event เป็น metadata ล้วน — ไม่มี recipient, payload หรือ token (#362 §5) */
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
