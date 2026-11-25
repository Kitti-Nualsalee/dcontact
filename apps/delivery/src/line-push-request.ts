/**
 * Owner: Delivery/Channels — canonical request before the submission barrier (S2.4 #370, #357 §2)
 *
 * Everything that decides the content of a request must happen "before" the barrier and be persisted once:
 * the fixture version, the resolved recipient, the canonical payload, the payload digest and the retry key
 *
 * After the barrier the recipient/content must not change and a new key must not be minted — every retry must be a
 * byte-identical copy of the original request with the original `X-Line-Retry-Key`, otherwise LINE treats it as a different request
 * and the recipient would get a duplicate message
 */
import { createHash } from 'node:crypto';

/** An approved fixture of S2 — immutable and a closed set (#357 §1) */
export const LINE_SERVICE_NOTIFICATION_FIXTURES = Object.freeze({
  'fixture:service-notification/v1': Object.freeze({
    version: 1,
    messages: Object.freeze([
      Object.freeze({
        type: 'text',
        text: 'แจ้งเตือนจากระบบบริการลูกค้า กรุณาตอบกลับข้อความนี้หากต้องการให้ติดต่อกลับ', // allow-thai: customer-facing LINE message content, bound by payload digest
      }),
    ]),
  }),
});

export type LineFixtureRef = keyof typeof LINE_SERVICE_NOTIFICATION_FIXTURES;

export class LineFixtureUnknownError extends Error {
  readonly code = 'LINE_FIXTURE_UNKNOWN';
  constructor(readonly contentRef: string) {
    super(`LINE fixture is not in the approved set: ${contentRef}`);
    this.name = 'LineFixtureUnknownError';
  }
}

export function isLineFixtureRef(contentRef: string): contentRef is LineFixtureRef {
  return Object.hasOwn(LINE_SERVICE_NOTIFICATION_FIXTURES, contentRef);
}

export function resolveLineFixture(contentRef: string) {
  if (!isLineFixtureRef(contentRef)) throw new LineFixtureUnknownError(contentRef);
  return LINE_SERVICE_NOTIFICATION_FIXTURES[contentRef];
}

export function lineContentDigest(contentRef: string): string {
  const fixture = resolveLineFixture(contentRef);
  return createHash('sha256')
    .update(JSON.stringify({ contentRef, version: fixture.version, messages: fixture.messages }))
    .digest('hex');
}

export interface LineCanonicalRequest {
  contentRef: string;
  fixtureVersion: number;
  messages: ReadonlyArray<Record<string, unknown>>;
  /** digest of the payload actually sent (includes the recipient as a fingerprint, not the real value) */
  providerPayloadDigest: string;
  recipientFingerprint: string;
}

/**
 * The payload digest binds to the recipient by fingerprint, not userId — so the receipt can prove that a retry
 * is the original request without keeping the raw recipient in evidence (#357 §4)
 */
export function buildLineCanonicalRequest(input: {
  contentRef: string;
  recipientFingerprint: string;
}): LineCanonicalRequest {
  const fixture = resolveLineFixture(input.contentRef);
  const messages = fixture.messages as ReadonlyArray<Record<string, unknown>>;
  const providerPayloadDigest = createHash('sha256')
    .update(
      JSON.stringify({
        contentRef: input.contentRef,
        version: fixture.version,
        messages,
        recipientFingerprint: input.recipientFingerprint,
      }),
    )
    .digest('hex');
  return {
    contentRef: input.contentRef,
    fixtureVersion: fixture.version,
    messages,
    providerPayloadDigest,
    recipientFingerprint: input.recipientFingerprint,
  };
}

// ── Content that is not a fixture (#567 team trial) ───────────────────────────────

/**
 * The resolved content of one delivery: an S2 fixture or the trial's text persisted before the barrier.
 * `gateDigest` is the value the gate compares with the allowlist — fixture = the fixture digest, trial = the content class digest
 * (every trial text is in one class; the digest of the real text is in `dl_line_trial_sends`)
 */
export interface LineResolvedContent {
  contentRef: string;
  version: number;
  messages: ReadonlyArray<Record<string, unknown>>;
  gateDigest: string;
}

export interface LineContentSource {
  resolve(tenantId: string, contentRef: string): Promise<LineResolvedContent>;
}

/** The original content source of S2: the closed fixture set only */
export const LINE_FIXTURE_CONTENT_SOURCE: LineContentSource = Object.freeze({
  async resolve(_tenantId: string, contentRef: string): Promise<LineResolvedContent> {
    const fixture = resolveLineFixture(contentRef);
    return {
      contentRef,
      version: fixture.version,
      messages: fixture.messages as ReadonlyArray<Record<string, unknown>>,
      gateDigest: lineContentDigest(contentRef),
    };
  },
});

/** digest of the content class that the trial allowlist binds (text ≤ maxLength) */
export function lineContentClassDigest(contentClass: string, maxLength: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ contentClass, version: 1, type: 'text', maxLength }))
    .digest('hex');
}

/** canonical request from resolved content — a fixture yields the same as `buildLineCanonicalRequest` byte for byte */
export function buildLineCanonicalRequestFrom(
  content: LineResolvedContent,
  recipientFingerprint: string,
): LineCanonicalRequest {
  const providerPayloadDigest = createHash('sha256')
    .update(
      JSON.stringify({
        contentRef: content.contentRef,
        version: content.version,
        messages: content.messages,
        recipientFingerprint,
      }),
    )
    .digest('hex');
  return {
    contentRef: content.contentRef,
    fixtureVersion: content.version,
    messages: content.messages,
    providerPayloadDigest,
    recipientFingerprint,
  };
}

const HEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `X-Line-Retry-Key` must be a hexadecimal UUID (#357 §2) — LINE rejects any other value */
export function isLineRetryKey(value: string): boolean {
  return HEX_UUID.test(value);
}

/**
 * the retry key of one delivery is derived from the identity already persisted, so it is the same every time
 * even when a worker restarts — no `randomUUID` because a new value = the recipient gets a duplicate message
 */
export function deriveLineRetryKey(tenantId: string, deliveryId: string): string {
  const digest = createHash('sha256').update(`line-retry|${tenantId}|${deliveryId}`).digest('hex');
  const hex = digest.slice(0, 32);
  // force the UUID v4/variant shape so LINE accepts it while staying deterministic
  const v4 = `${hex.slice(0, 12)}4${hex.slice(13, 16)}`;
  const variant = `${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`;
  return `${v4.slice(0, 8)}-${v4.slice(8, 12)}-${v4.slice(12, 16)}-${variant}-${hex.slice(20, 32)}`;
}

// ── Retry window / backoff (#357 §3, #358 caps) ─────────────────────────────

/** After 24 hours LINE may see the original retry key as a new request — we stop before reaching that line */
export const LINE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const LINE_BACKOFF_BASE_MS = 30_000;
export const LINE_BACKOFF_MAX_MS = 15 * 60_000;

/** bounded exponential backoff: every retry counts toward the rate limit so it must not be frequent (#357 §3) */
export function lineBackoffMs(attemptNo: number): number {
  const exponent = Math.max(0, attemptNo - 1);
  return Math.min(LINE_BACKOFF_BASE_MS * 2 ** exponent, LINE_BACKOFF_MAX_MS);
}

export function lineRetryWindowExpired(firstAttemptAt: Date, now: Date): boolean {
  return now.getTime() - firstAttemptAt.getTime() >= LINE_RETRY_WINDOW_MS;
}
