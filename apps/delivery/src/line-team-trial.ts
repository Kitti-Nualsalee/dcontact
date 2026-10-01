/**
 * Owner: Delivery/Channels — ช่วงทีมทดสอบส่ง-รับ LINE บน UAT (#567, amendment #358 2026-10-01)
 *
 * ทางเดียวของการตอบกลับ (T1/T2): admin ของ tenant pilot ตอบข้อความขาเข้าหนึ่งรายการด้วย text ≤500 ตัวอักษร
 * ระบบส่ง push ไปหาผู้ส่งคนนั้น ผ่าน Contact Governance + gate/cap/barrier ของ S2 ชุดเดิมทั้งหมด:
 *
 * 1. ผู้รับ = ผู้ส่งของข้อความขาเข้าแบบ one-to-one (fingerprint จาก vault — userId ไม่ออกนอก vault)
 * 2. ต้องมี authorization ของ trial (`S2_LINE_TEAM_TRIAL_V1`) ที่ APPROVED และยังไม่หมดอายุของผู้รับคนนั้น
 * 3. Governance อนุญาตและจอง (consent/quiet hours/frequency) ก่อนเข้า outbox
 * 4. text เข้ารหัสลง `dl_line_trial_sends` ก่อน barrier — retry เป็น request เดิม byte ต่อ byte
 * 5. outbound adapter เดิมตัดสิน gate/cap/attempt; cap ของ trial มาจากแถว authorization
 *
 * ไม่มี log ของ text หรือ userId; audit มีแค่ digest และ machine code
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  withTenantDatabaseTransaction,
  type DlLineRunAuthorization,
  type DlLineScopeGate,
  type PrismaClient,
} from '@d-contact/db';
import {
  actionKey as toActionKey,
  contactId as toContactId,
  identityId as toIdentityId,
  reservationId as toReservationId,
  tenantId as toTenantId,
  LINE_TEAM_TRIAL_CONTENT_CLASS,
  LINE_TEAM_TRIAL_MAX_CAPS,
  LINE_TEAM_TRIAL_PROFILE,
} from '@d-contact/cxa-contracts';
import { LineProviderAttemptRepository } from './line-attempt-repository.js';
import type { LineControlActor, LineControlPlane } from './line-control-plane.js';
import type { LineGateScope } from './line-control-repository.js';
import type { LineQuotaSnapshot } from './line-control-policy.js';
import { LineDeliveryEnqueue } from './line-delivery-enqueue.js';
import type { LineAccessTokenResolver, LineOutboundAdapter } from './line-outbound-adapter.js';
import {
  LINE_FIXTURE_CONTENT_SOURCE,
  lineContentClassDigest,
  type LineContentSource,
  type LineResolvedContent,
} from './line-push-request.js';
import type { EncryptedLineWebhookPayloadVault } from './line-webhook-payload-vault.js';

export const LINE_TEAM_TRIAL_SOURCE = 'S2_TEAM_TRIAL';
const TRIAL_CONTENT_PREFIX = 'trial-text:';
const TRIAL_CONTENT_REF =
  /^trial-text:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
/** control character ยกเว้นขึ้นบรรทัดใหม่ — LINE text รองรับ newline */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const QUOTA_CACHE_MS = 5 * 60_000;
const ACCEPTED_OUTCOMES = new Set(['LINE_ACCEPTED', 'LINE_ACCEPTED_REPLAY']);

/** digest ของ content class ที่ allowlist ของ trial ผูกไว้ */
export function lineTeamTrialContentDigest(): string {
  return lineContentClassDigest(
    LINE_TEAM_TRIAL_CONTENT_CLASS,
    LINE_TEAM_TRIAL_MAX_CAPS.textMaxLength,
  );
}

export function isLineTeamTrialContentRef(contentRef: string): boolean {
  return TRIAL_CONTENT_REF.test(contentRef);
}

/** text ที่ส่งได้: trim แล้ว 1–500 ตัวอักษร (นับ code point) ไม่มี control character นอกจาก newline */
export function normalizeLineTrialText(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.replace(/\r\n?/g, '\n').trim();
  const length = [...text].length;
  if (length < 1 || length > LINE_TEAM_TRIAL_MAX_CAPS.textMaxLength) return null;
  if (CONTROL.test(text)) return null;
  return text;
}

export interface LinePayloadKey {
  keyRef: string;
  key: Buffer;
}

function encrypt(text: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

/**
 * แหล่งเนื้อหาของ adapter: `trial-text:<sendId>` → text ที่ถอดรหัสจาก `dl_line_trial_sends`
 * อย่างอื่นส่งต่อให้ fixture ของ S2 — gate จึงเห็น digest ของ content class สำหรับ trial เสมอ
 */
export class LineTeamTrialContentSource implements LineContentSource {
  constructor(
    private readonly database: PrismaClient,
    private readonly keyring: { key(keyRef: string): Buffer | undefined },
    private readonly fallback: LineContentSource = LINE_FIXTURE_CONTENT_SOURCE,
  ) {}

  async resolve(tenantId: string, contentRef: string): Promise<LineResolvedContent> {
    const sendId = TRIAL_CONTENT_REF.exec(contentRef)?.[1];
    if (!sendId) return this.fallback.resolve(tenantId, contentRef);
    const row = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineTrialSend.findFirst({ where: { tenantId, id: sendId } }),
    );
    const key = row ? this.keyring.key(row.keyRef) : undefined;
    if (!row || !key) throw new LineTeamTrialContentError();
    let text: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
      decipher.setAuthTag(row.authTag);
      text = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new LineTeamTrialContentError();
    }
    // digest ใน DB ต้องตรงกับ text ที่ถอดได้ — ไม่ตรง = แถวถูกแก้ ห้ามส่ง
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== row.contentDigest) {
      throw new LineTeamTrialContentError();
    }
    return {
      contentRef,
      version: 1,
      messages: [{ type: 'text', text }],
      gateDigest: lineTeamTrialContentDigest(),
    };
  }
}

export class LineTeamTrialContentError extends Error {
  readonly code = 'LINE_CONTENT_REJECTED';
  constructor() {
    super('เนื้อหาของ trial ใช้ไม่ได้');
    this.name = 'LineTeamTrialContentError';
  }
}

export type LineTeamTrialReplyCode =
  | 'TEXT_INVALID'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INBOUND_NOT_FOUND'
  | 'RECIPIENT_NOT_ALLOWLISTED'
  | 'TRIAL_NOT_ACTIVE'
  | 'KILLED'
  | 'CAP_EXCEEDED'
  | 'CONSENT_DENIED'
  | 'PROVIDER_UNAVAILABLE'
  | 'REJECTED'
  | 'DENIED';

export type LineTeamTrialReplyResult =
  | { status: 'SENT' | 'PENDING'; deliveryId: string; replay: boolean }
  | { status: 'FAILED'; code: LineTeamTrialReplyCode; deliveryId?: string };

const CAP_CODES = new Set([
  'RUN_DELIVERY_CAP_EXCEEDED',
  'CONTACT_WINDOW_CAP_EXCEEDED',
  'SUBMISSION_WINDOW_CAP_EXCEEDED',
  'LIFETIME_CAP_EXCEEDED',
  'CONCURRENT_SUBMISSION_CAP_EXCEEDED',
  'CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED',
]);

/** แปลง code ของ gate/adapter เป็น code ที่หน้าจอแสดงได้ — ไม่บอกรายละเอียดภายใน */
export function lineTeamTrialFailureCode(code: string): LineTeamTrialReplyCode {
  if (code === 'LINE_GATE_KILLED') return 'KILLED';
  if (CAP_CODES.has(code)) return 'CAP_EXCEEDED';
  if (code === 'RUN_AUTHORIZATION_EXPIRED' || code === 'RUN_AUTHORIZATION_MISSING') {
    return 'TRIAL_NOT_ACTIVE';
  }
  if (code === 'LINE_CREDENTIAL_UNAVAILABLE' || code === 'CREDENTIAL_UNAVAILABLE') {
    return 'PROVIDER_UNAVAILABLE';
  }
  return 'DENIED';
}

export interface LineTeamTrialStatus {
  active: boolean;
  killed: boolean;
  expiresAt: string | null;
  recipients: number;
  /** การส่งที่นับใน cap 24 ชม. ล่าสุด (ทั้ง gate) และเพดานของ trial */
  last24h: number;
  per24h: number | null;
  perRecipientPer24h: number | null;
}

/** dependency ที่ service ต้องใช้ — แยกให้เทสต์ประกอบด้วยของปลอมได้ */
export interface LineTeamTrialDependencies {
  database: PrismaClient;
  control: LineControlPlane;
  governance: {
    authorizeAndReserve(
      tenantId: ReturnType<typeof toTenantId>,
      input: Record<string, unknown>,
    ): Promise<{
      decision: string;
      reasonCode?: string | null;
      reservationId?: string | null;
      reservationExpiresAt?: string | null;
    }>;
    claimReservationForDelivery: ConstructorParameters<
      typeof LineDeliveryEnqueue
    >[1]['claimReservationForDelivery'];
  };
  /** adapter ต่อ config digest ของ gate ณ ตอนส่ง (operator ตั้ง gate ใหม่ได้โดยไม่ต้อง restart) */
  adapter: (configDigest: string) => Pick<LineOutboundAdapter, 'submit'>;
  vault: Pick<EncryptedLineWebhookPayloadVault, 'read'>;
  payloadKey: LinePayloadKey;
  credentials: LineAccessTokenResolver;
  transport: {
    getQuota(accessToken: string): Promise<{ type: string; value?: number }>;
    getConsumption(accessToken: string): Promise<{ totalUsage: number }>;
  };
  scope: LineGateScope;
  /** actor ระบบที่ execute run (EXECUTE_RUN เป็นของ Platform Operator ตาม #358 §E) */
  executor: LineControlActor;
  now?: () => Date;
  id?: () => string;
}

export class LineTeamTrialReplies {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly enqueue: LineDeliveryEnqueue;
  private quotaCache: { at: number; snapshot: LineQuotaSnapshot } | undefined;

  constructor(private readonly deps: LineTeamTrialDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? randomUUID;
    this.enqueue = new LineDeliveryEnqueue(deps.database, deps.governance, {
      approvedContent: isLineTeamTrialContentRef,
    });
  }

  private get tenantId(): string {
    return this.deps.scope.tenantId;
  }

  private tx<T>(work: Parameters<typeof withTenantDatabaseTransaction<T>>[2]): Promise<T> {
    return withTenantDatabaseTransaction(this.deps.database, this.tenantId, work);
  }

  async reply(input: {
    inboxEntryId: string;
    text: unknown;
    idempotencyKey: string;
    actorRef: string;
  }): Promise<LineTeamTrialReplyResult> {
    const text = normalizeLineTrialText(input.text);
    if (!text || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      return { status: 'FAILED', code: 'TEXT_INVALID' };
    }
    const contentDigest = createHash('sha256').update(text, 'utf8').digest('hex');

    // idempotency: key เดิม + text เดิม = ผลเดิม (ส่งต่อถ้ายังไม่จบ); text ต่าง = conflict
    const previous = await this.tx((transaction) =>
      transaction.dlLineTrialSend.findFirst({
        where: { tenantId: this.tenantId, idempotencyKey: input.idempotencyKey },
      }),
    );
    if (previous) {
      if (
        previous.contentDigest !== contentDigest ||
        previous.inboxEntryId !== input.inboxEntryId
      ) {
        return { status: 'FAILED', code: 'IDEMPOTENCY_CONFLICT' };
      }
      return this.submit(previous.runAuthorizationId, previous.deliveryId, true);
    }

    const entry = await this.tx((transaction) =>
      transaction.dlLineWebhookInboxEntry.findFirst({
        where: {
          tenantId: this.tenantId,
          id: input.inboxEntryId,
          channelAccountId: this.deps.scope.channelAccountId,
        },
      }),
    );
    if (!entry || entry.eventType !== 'message') {
      return { status: 'FAILED', code: 'INBOUND_NOT_FOUND' };
    }
    const projection = await this.deps.vault.read(this.tenantId, entry);
    if (!projection?.isOneToOne) return { status: 'FAILED', code: 'INBOUND_NOT_FOUND' };

    const gate = await this.deps.control.findGate(this.deps.scope);
    if (!gate) return { status: 'FAILED', code: 'TRIAL_NOT_ACTIVE' };
    if (gate.killed) return { status: 'FAILED', code: 'KILLED' };
    const found = await this.trialRunFor(gate, projection.sourceFingerprint);
    if (found === 'NOT_ALLOWLISTED') return { status: 'FAILED', code: 'RECIPIENT_NOT_ALLOWLISTED' };
    if (!found) return { status: 'FAILED', code: 'TRIAL_NOT_ACTIVE' };
    const { run } = found;

    const sendId = this.id();
    const actionKey = `s2-trial-${sendId}`;
    const correlationId = `s2-trial-${sendId}`;
    const decision = await this.deps.governance.authorizeAndReserve(toTenantId(this.tenantId), {
      contactId: run.contactId!,
      ...(run.identityId ? { identityId: run.identityId } : {}),
      channel: 'LINE',
      purpose: this.deps.scope.purpose,
      contactKind: this.deps.scope.contactKind,
      senderIdentityId: this.deps.scope.senderIdentityId,
      source: LINE_TEAM_TRIAL_SOURCE,
      sourceId: actionKey,
      actionKey,
      policyVersion: 1,
    });
    if (decision.decision !== 'ALLOW' || !decision.reservationId) {
      return { status: 'FAILED', code: 'CONSENT_DENIED' };
    }
    const queued = await this.enqueue.enqueue({
      tenantId: toTenantId(this.tenantId),
      correlationId,
      reservationId: toReservationId(decision.reservationId),
      actionKey: toActionKey(actionKey),
      contactId: toContactId(run.contactId!),
      ...(run.identityId ? { identityId: toIdentityId(run.identityId) } : {}),
      purpose: this.deps.scope.purpose,
      source: LINE_TEAM_TRIAL_SOURCE,
      senderIdentityId: this.deps.scope.senderIdentityId,
      contentRef: `${TRIAL_CONTENT_PREFIX}${sendId}`,
      leaseExpiresAt:
        decision.reservationExpiresAt ?? new Date(this.now().getTime() + 10 * 60_000).toISOString(),
    });
    if (queued.status === 'ERROR') return { status: 'FAILED', code: 'DENIED' };

    const sealed = encrypt(text, this.deps.payloadKey.key);
    await this.tx((transaction) =>
      transaction.dlLineTrialSend.create({
        data: {
          id: sendId,
          tenantId: this.tenantId,
          runAuthorizationId: run.id,
          inboxEntryId: entry.id,
          deliveryId: queued.deliveryId,
          idempotencyKey: input.idempotencyKey,
          contentDigest,
          keyRef: this.deps.payloadKey.keyRef,
          iv: sealed.iv,
          authTag: sealed.authTag,
          ciphertext: sealed.ciphertext,
          actorRef: input.actorRef,
        },
      }),
    );
    return this.submit(run.id, queued.deliveryId, false);
  }

  /** ส่ง (หรือส่งต่อ) delivery ของ trial หนึ่งใบผ่าน adapter เดิม */
  private async submit(
    runAuthorizationId: string,
    deliveryId: string,
    replay: boolean,
  ): Promise<LineTeamTrialReplyResult> {
    const run = await this.tx((transaction) =>
      transaction.dlLineRunAuthorization.findFirst({
        where: { tenantId: this.tenantId, id: runAuthorizationId },
      }),
    );
    const allowlist = run
      ? await this.tx((transaction) =>
          transaction.dlLineAllowlistEntry.findFirst({
            where: { tenantId: this.tenantId, id: run.allowlistEntryId },
          }),
        )
      : null;
    if (!run || !allowlist) return { status: 'FAILED', code: 'TRIAL_NOT_ACTIVE', deliveryId };
    const gate = await this.deps.control.findGate(this.deps.scope);
    if (!gate?.configDigest) return { status: 'FAILED', code: 'TRIAL_NOT_ACTIVE', deliveryId };
    const quota = await this.quota(run);
    if (!quota) return { status: 'FAILED', code: 'PROVIDER_UNAVAILABLE', deliveryId };
    const outcome = await this.deps.adapter(gate.configDigest).submit({
      tenantId: this.tenantId,
      deliveryId,
      scope: this.deps.scope,
      runAuthorizationId: run.id,
      recipientFingerprint: allowlist.recipientFingerprint,
      recipientProtectedRef: allowlist.recipientProtectedRef,
      correlationId: `s2-trial-${deliveryId}`,
      quota,
    });
    switch (outcome.status) {
      case 'ACCEPTED':
        return { status: 'SENT', deliveryId, replay };
      case 'NOOP':
        return this.settled(deliveryId);
      case 'RECONCILING':
        return { status: 'PENDING', deliveryId, replay };
      case 'REJECTED':
      case 'QUARANTINED':
        return { status: 'FAILED', code: 'REJECTED', deliveryId };
      case 'DENIED':
        return { status: 'FAILED', code: lineTeamTrialFailureCode(outcome.code), deliveryId };
    }
  }

  /** delivery ที่จบไปแล้ว: ผลจริงมาจาก receipt ล่าสุด (accepted = ส่งแล้ว, อย่างอื่น = ถูกปฏิเสธ) */
  private async settled(deliveryId: string): Promise<LineTeamTrialReplyResult> {
    const attempts = await new LineProviderAttemptRepository(this.deps.database).listForDelivery(
      this.tenantId,
      deliveryId,
    );
    const last = attempts.at(-1);
    if (last && ACCEPTED_OUTCOMES.has(last.outcomeCode ?? '')) {
      return { status: 'SENT', deliveryId, replay: true };
    }
    return { status: 'FAILED', code: 'REJECTED', deliveryId };
  }

  /** authorization ของ trial ที่ใช้ได้ของผู้รับคนนี้ หรือบอกว่าไม่อยู่ใน allowlist ของ trial */
  private async trialRunFor(
    gate: DlLineScopeGate,
    recipientFingerprint: string,
  ): Promise<{ run: DlLineRunAuthorization } | 'NOT_ALLOWLISTED' | null> {
    const at = this.now();
    const entries = await this.tx((transaction) =>
      transaction.dlLineAllowlistEntry.findMany({
        where: {
          tenantId: this.tenantId,
          gateId: gate.id,
          recipientFingerprint,
          contentRef: LINE_TEAM_TRIAL_CONTENT_CLASS,
          revokedAt: null,
          validFrom: { lte: at },
          validUntil: { gt: at },
        },
        select: { id: true },
      }),
    );
    if (entries.length === 0) return 'NOT_ALLOWLISTED';
    const run = await this.tx((transaction) =>
      transaction.dlLineRunAuthorization.findFirst({
        where: {
          tenantId: this.tenantId,
          gateId: gate.id,
          profile: LINE_TEAM_TRIAL_PROFILE,
          allowlistEntryId: { in: entries.map((entry) => entry.id) },
          state: 'APPROVED',
          expiresAt: { gt: at },
        },
        orderBy: { proposedAt: 'desc' },
      }),
    );
    return run ? { run } : null;
  }

  /** quota advisory ของ LINE (#358 §D) — cache 5 นาทีเพื่อไม่ให้ทุกการตอบยิง quota API */
  private async quota(run: DlLineRunAuthorization): Promise<LineQuotaSnapshot | undefined> {
    const now = this.now().getTime();
    if (this.quotaCache && now - this.quotaCache.at < QUOTA_CACHE_MS) {
      return this.quotaCache.snapshot;
    }
    const token = await this.deps.credentials.resolve({
      tenantId: this.tenantId,
      credentialRefId: run.credentialRefId,
      version: run.credentialVersion,
    });
    if (!token) return undefined;
    try {
      const quota = await this.deps.transport.getQuota(token.accessToken);
      const consumption = await this.deps.transport.getConsumption(token.accessToken);
      if (quota.type !== 'limited' && quota.type !== 'none') return undefined;
      const snapshot: LineQuotaSnapshot = {
        type: quota.type,
        ...(quota.type === 'limited' && quota.value !== undefined
          ? { targetLimit: quota.value }
          : {}),
        totalUsage: consumption.totalUsage,
        observedAt: new Date(now),
      };
      this.quotaCache = { at: now, snapshot };
      return snapshot;
    } catch {
      return undefined;
    }
  }

  async status(): Promise<LineTeamTrialStatus> {
    const at = this.now();
    const gate = await this.deps.control.findGate(this.deps.scope);
    const runs = gate
      ? await this.tx((transaction) =>
          transaction.dlLineRunAuthorization.findMany({
            where: {
              tenantId: this.tenantId,
              gateId: gate.id,
              profile: LINE_TEAM_TRIAL_PROFILE,
              state: 'APPROVED',
              expiresAt: { gt: at },
            },
          }),
        )
      : [];
    const last24h = gate
      ? await this.tx((transaction) =>
          transaction.dlLineCapLedgerEntry.count({
            where: {
              tenantId: this.tenantId,
              gateId: gate.id,
              capKind: 'LOGICAL_DELIVERY',
              state: { not: 'RELEASED' },
              reservedAt: { gte: new Date(at.getTime() - 86_400_000) },
            },
          }),
        )
      : 0;
    const first = runs[0];
    return {
      active: runs.length > 0 && !gate?.killed,
      killed: Boolean(gate?.killed),
      expiresAt: first
        ? new Date(Math.min(...runs.map((run) => run.expiresAt.getTime()))).toISOString()
        : null,
      recipients: runs.length,
      last24h,
      per24h: first?.capPer24h ?? null,
      perRecipientPer24h: first?.capRecipientPer24h ?? null,
    };
  }

  /** T5: admin คนไหนก็ kill ได้ทันที — ยก kill ทำได้ทาง CLI + approval เท่านั้น */
  async kill(actorRef: string): Promise<{ killed: boolean }> {
    const gate = await this.deps.control.findGate(this.deps.scope);
    if (!gate) return { killed: false };
    if (gate.killed) return { killed: true };
    await this.deps.control.kill(
      { role: 'TENANT_ADMIN', ref: actorRef },
      gate,
      'OPERATOR_KILL',
      this.now(),
    );
    return { killed: true };
  }
}
