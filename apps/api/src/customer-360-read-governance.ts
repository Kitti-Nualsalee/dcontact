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
 * Cus360 C2 (#792) S2: a read-only Contact Governance status summary of the profile (R1 J, E1 I)
 *
 * - does not call authorize/reserve, writes no audit/touch/attempt and does not use the adapter's service credential:
 *   reads through the CG fact loader (read) under the actor's customer permission only
 * - status: CONTEXT_REQUIRED (channel + purpose not given yet) / READY / UNAVAILABLE (owner fails or the identity
 *   is not canonical yet) — every status has asOf and no status means "allowed to contact" (`contactPermission` is
 *   always NOT_EVALUATED; real permission happens at the CG authorize when contacting)
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
  // CG binds to the canonical contact: MERGED/AMBIGUOUS has no interpretable status yet → unavailable, not allowed
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
    // the same predicate the CG owner uses when deciding (contact-governance-service.ts: authorizeAndReserve/reservation):
    // includes tenant-level restrictions (contactId null) and a null channel/purpose = applies to every value; there is no identity in this context
    // so only identityId null is counted. CG does not yet export a read function for this part — the predicate is temporarily duplicated (see the PR)
    const activeRestrictionCount = await tx.cgRestriction.count({
      where: {
        tenantId: actor.tenantId,
        startsAt: { lte: now },
        AND: [
          { OR: [{ contactId: null }, { contactId }] },
          { identityId: null },
          { OR: [{ channel: null }, { channel: context.channel }] },
          { OR: [{ purpose: null }, { purpose: context.purpose }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ],
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
