import type { Prisma } from '@d-contact/db';
import type { ContactChannel } from '@d-contact/cxa-contracts';
import { loadCg3Facts, resolveEffectivePreference } from '@d-contact/contact-governance';
import {
  C360ReadError,
  requireReadableC360Contact,
  runC360OwnerSection,
  type C360VerifiedActor,
} from '@d-contact/customer-360';

/**
 * Cus360 C2 (#792) S2: สรุปสถานะ Contact Governance ของโปรไฟล์ (R1 J, E1 I) แบบอ่านอย่างเดียว
 *
 * - ไม่เรียก authorize/reserve, ไม่เขียน audit/touch/attempt และไม่ใช้ service credential ของ adapter:
 *   อ่านผ่าน fact loader ของ CG (read) ภายใต้สิทธิ์ลูกค้าของ actor เท่านั้น
 * - สถานะ: CONTEXT_REQUIRED (ยังไม่ระบุ channel + purpose) / READY / UNAVAILABLE (owner ล้ม หรือ identity
 *   ยังไม่ canonical) — ทุกสถานะมี asOf และไม่มีสถานะไหนแปลว่า "อนุญาตให้ติดต่อ" (`contactPermission` เป็น
 *   NOT_EVALUATED เสมอ; การอนุญาตจริงเกิดที่ authorize ของ CG เมื่อจะติดต่อ)
 */

const CHANNELS = new Set<string>(['VOICE', 'WEBCHAT', 'LINE', 'FACEBOOK', 'WHATSAPP', 'EMAIL']);

export type C360GovernanceSummary =
  | { state: 'CONTEXT_REQUIRED'; asOf: string; requires: ['channel', 'purpose'] }
  | {
      state: 'UNAVAILABLE';
      asOf: string;
      reason: 'OWNER_UNAVAILABLE' | 'IDENTITY_NOT_CANONICAL';
      retryable: boolean;
    }
  | {
      state: 'READY';
      asOf: string;
      contactPermission: 'NOT_EVALUATED';
      context: { channel: string; purpose: string };
      aggregateVersion: number;
      preference: { decision: string; version: number } | null;
      callbackPending: boolean;
      activeExceptionCount: number;
      activeRestrictionCount: number;
    };

function parseContext(body: unknown): { channel: ContactChannel; purpose: string } | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body))
    throw new C360ReadError(400, 'VALIDATION_FAILED', false, [
      { field: 'body', code: 'OBJECT_REQUIRED' },
    ]);
  const input = body as Record<string, unknown>;
  for (const field of Object.keys(input))
    if (field !== 'channel' && field !== 'purpose')
      throw new C360ReadError(400, 'VALIDATION_FAILED', false, [{ field, code: 'UNKNOWN_FIELD' }]);
  const { channel, purpose } = input;
  if (channel === undefined && purpose === undefined) return null;
  if (typeof channel !== 'string' || !CHANNELS.has(channel))
    throw new C360ReadError(400, 'VALIDATION_FAILED', false, [
      { field: 'channel', code: 'CHANNEL_INVALID' },
    ]);
  if (
    typeof purpose !== 'string' ||
    purpose.trim().length === 0 ||
    purpose.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(purpose)
  )
    throw new C360ReadError(400, 'VALIDATION_FAILED', false, [
      { field: 'purpose', code: 'PURPOSE_INVALID' },
    ]);
  return { channel: channel as ContactChannel, purpose: purpose.trim() };
}

export async function readC360GovernanceSummary(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  contactId: string,
  body: unknown,
): Promise<C360GovernanceSummary> {
  const context = parseContext(body);
  const access = await requireReadableC360Contact(tx, actor, contactId);
  const asOf = new Date().toISOString();
  if (!context) return { state: 'CONTEXT_REQUIRED', asOf, requires: ['channel', 'purpose'] };
  // CG ผูกกับ contact canonical: MERGED/AMBIGUOUS ยังไม่มีสถานะที่ตีความได้ → unavailable ไม่ใช่ allowed
  if (access.identity === 'MERGED' || access.identity === 'AMBIGUOUS')
    return { state: 'UNAVAILABLE', asOf, reason: 'IDENTITY_NOT_CANONICAL', retryable: false };
  const section = await runC360OwnerSection(tx, async () => {
    const now = new Date();
    const facts = await loadCg3Facts(tx, {
      tenantId: actor.tenantId,
      contactId,
      channel: context.channel,
      purpose: context.purpose,
      now,
    });
    const preference = resolveEffectivePreference(facts.preferences, {
      now,
      channel: context.channel,
      purpose: context.purpose,
      preferences: facts.preferences,
    });
    const activeRestrictionCount = await tx.cgRestriction.count({
      where: {
        tenantId: actor.tenantId,
        contactId,
        startsAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    return {
      aggregateVersion: facts.aggregateVersion,
      preference: preference
        ? { decision: preference.decision ?? 'ALLOW', version: preference.version }
        : null,
      callbackPending: facts.activeCallback !== undefined,
      activeExceptionCount: facts.activeExceptions.length,
      activeRestrictionCount,
    };
  });
  if (section.state === 'UNAVAILABLE')
    return { state: 'UNAVAILABLE', asOf: section.asOf, reason: section.reason, retryable: true };
  return {
    state: 'READY',
    asOf: section.asOf,
    contactPermission: 'NOT_EVALUATED',
    context: { channel: context.channel, purpose: context.purpose },
    ...section.data,
  };
}
