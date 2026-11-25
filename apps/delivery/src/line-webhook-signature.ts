/**
 * Owner: Delivery/Channels — raw-body security boundary of the LINE webhook (S2.5 #369, #359 §B)
 *
 * Mandatory order: limit method/size → read the raw bytes as received → HMAC-SHA256 with the channel secret
 * → compare in constant time only, and only then may it decode/parse
 *
 * Never re-serialize or normalize the body before verify because whitespace/emoji change the digest,
 * and never log the signature or body in any case — the functions here return only a boolean and a code
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** LINE can send a body up to MB scale; beyond this size it is rejected before reading so ingress is not a channel for flooding memory */
export const LINE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export function lineSignature(rawBody: Buffer, channelSecret: string): string {
  return createHmac('sha256', channelSecret).update(rawBody).digest('base64');
}

/**
 * compare signatures in constant time — a different length counts as a mismatch without leaking where it differs
 * and does not throw so that the timing of an exception does not become an oracle
 */
export function verifyLineSignature(
  rawBody: Buffer,
  channelSecret: string,
  headerSignature: string | undefined,
): boolean {
  if (!headerSignature || headerSignature.length === 0) return false;
  const expected = Buffer.from(lineSignature(rawBody, channelSecret), 'utf8');
  const received = Buffer.from(headerSignature, 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
