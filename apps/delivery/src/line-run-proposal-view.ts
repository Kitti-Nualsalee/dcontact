/**
 * Owner: Delivery/Channels — one-shot proposal shown to the user to confirm before `S2-LINE-PR02` (S2.6 #366)
 *
 * Authority: #360 §C, #358 §E
 *
 * This view gathers every value the approver must see in one place and binds them with `presentationDigest`:
 * final main SHA + config/migration/registry digests, tenant/channel/sender as opaque values,
 * recipient fingerprint (not the LINE user ID), fixture + text + content digest, credential
 * version/fingerprint/expiry, cap/quota snapshot, retry UUID and the 30-minute expiry
 *
 * The user confirms with a digest matching character for character; any changed value changes the digest and the old approval is unusable.
 * The fixture text may live only in this view — `lineRunProposalEvidence` strips it down to the content digest
 * before it enters an immutable artifact (#360 §E)
 */
import { LINE_PILOT_CAPS } from '@d-contact/cxa-contracts';
import { isLineRetryKey, lineContentDigest, resolveLineFixture } from './line-push-request.js';
import { lineChannelFingerprint } from './line-provider-conformance.js';
import { stableSha256 } from './line-provider-evidence-bundle.js';

export interface LineRunProposalViewInput {
  finalMainSha: string;
  digests: { config: string; migrations: string; registry: string };
  run: {
    id: string;
    tenantId: string;
    proposalDigest: string;
    configDigest: string;
    credentialRefId: string;
    credentialVersion: number;
    capLogicalDeliveries: number;
    capProviderAttempts: number;
    proposedAt: Date;
    expiresAt: Date;
  };
  gate: {
    channelAccountId: string;
    senderIdentityId: string;
    purpose: string;
    contactKind: string;
  };
  allowlistEntry: { recipientFingerprint: string; contentRef: string; contentDigest: string };
  credential: { fingerprint: string; expiresAt: Date | null; credentialKind: string };
  /** current cap usage from the gate's ledger — not the profile's constants */
  capUsage: { recipientLast24h: number; last24h: number; lifetime: number };
  quota: {
    type: 'limited' | 'none';
    targetLimit: number | null;
    totalUsage: number;
    observedAt: Date;
  };
  retryKey: string;
}

export interface LineRunProposalView {
  type: 'line.run-proposal';
  runAuthorizationId: string;
  proposalDigest: string;
  finalMainSha: string;
  digests: { config: string; migrations: string; registry: string };
  tenantId: string;
  channelAccountId: string;
  senderIdentityId: string;
  purpose: string;
  contactKind: string;
  recipientFingerprint: string;
  fixture: { contentRef: string; version: number; text: string[]; contentDigest: string };
  credential: {
    refId: string;
    version: number;
    kind: string;
    fingerprint: string;
    expiresAt: string | null;
  };
  caps: {
    logicalDeliveriesPerRun: number;
    providerAttemptsPerLogicalDelivery: number;
    recipientPer24h: { used: number; max: number };
    per24h: { used: number; max: number };
    lifetime: { used: number; max: number };
  };
  quota: {
    type: 'limited' | 'none';
    targetLimit: number | null;
    totalUsage: number;
    observedAt: string;
  };
  retryKey: string;
  proposedAt: string;
  expiresAt: string;
  presentationDigest: string;
}

export class LineRunProposalViewError extends Error {
  constructor(
    readonly code:
      | 'CONTENT_DIGEST_MISMATCH'
      | 'CONFIG_DIGEST_MISMATCH'
      | 'RETRY_KEY_INVALID'
      | 'PROPOSAL_TTL_INVALID'
      | 'CAP_SNAPSHOT_EXCEEDED'
      | 'FINAL_MAIN_SHA_INVALID',
  ) {
    super(`cannot build the proposal view: ${code}`);
    this.name = 'LineRunProposalViewError';
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Check before showing: the view the user sees must match what the worker will really send. If the allowlist content digest
 * does not match the fixture or the cap is already full, fail right here rather than letting the user approve something that cannot be sent
 */
export function buildLineRunProposalView(input: LineRunProposalViewInput): LineRunProposalView {
  if (!FULL_SHA.test(input.finalMainSha)) {
    throw new LineRunProposalViewError('FINAL_MAIN_SHA_INVALID');
  }
  const { run, gate, allowlistEntry, credential } = input;
  const fixture = resolveLineFixture(allowlistEntry.contentRef);
  if (lineContentDigest(allowlistEntry.contentRef) !== allowlistEntry.contentDigest) {
    throw new LineRunProposalViewError('CONTENT_DIGEST_MISMATCH');
  }
  if (run.configDigest !== input.digests.config) {
    throw new LineRunProposalViewError('CONFIG_DIGEST_MISMATCH');
  }
  if (!isLineRetryKey(input.retryKey)) throw new LineRunProposalViewError('RETRY_KEY_INVALID');
  const ttl = run.expiresAt.getTime() - run.proposedAt.getTime();
  if (ttl <= 0 || ttl > LINE_PILOT_CAPS.runAuthorizationTtlMinutes * 60_000) {
    throw new LineRunProposalViewError('PROPOSAL_TTL_INVALID');
  }
  const caps = {
    logicalDeliveriesPerRun: run.capLogicalDeliveries,
    providerAttemptsPerLogicalDelivery: run.capProviderAttempts,
    recipientPer24h: {
      used: input.capUsage.recipientLast24h,
      max: LINE_PILOT_CAPS.logicalDeliveriesPerRecipientPer24h,
    },
    per24h: { used: input.capUsage.last24h, max: LINE_PILOT_CAPS.logicalDeliveriesPer24h },
    lifetime: { used: input.capUsage.lifetime, max: LINE_PILOT_CAPS.logicalDeliveriesLifetime },
  };
  if (
    caps.recipientPer24h.used >= caps.recipientPer24h.max ||
    caps.per24h.used >= caps.per24h.max ||
    caps.lifetime.used >= caps.lifetime.max
  ) {
    throw new LineRunProposalViewError('CAP_SNAPSHOT_EXCEEDED');
  }

  const view: Omit<LineRunProposalView, 'presentationDigest'> = {
    type: 'line.run-proposal',
    runAuthorizationId: run.id,
    proposalDigest: run.proposalDigest,
    finalMainSha: input.finalMainSha,
    digests: { ...input.digests },
    tenantId: run.tenantId,
    channelAccountId: gate.channelAccountId,
    senderIdentityId: gate.senderIdentityId,
    purpose: gate.purpose,
    contactKind: gate.contactKind,
    recipientFingerprint: allowlistEntry.recipientFingerprint,
    fixture: {
      contentRef: allowlistEntry.contentRef,
      version: fixture.version,
      text: fixture.messages.map((message) => String(message.text ?? '')),
      contentDigest: allowlistEntry.contentDigest,
    },
    credential: {
      refId: run.credentialRefId,
      version: run.credentialVersion,
      kind: credential.credentialKind,
      fingerprint: credential.fingerprint,
      expiresAt: credential.expiresAt?.toISOString() ?? null,
    },
    caps,
    quota: {
      type: input.quota.type,
      targetLimit: input.quota.targetLimit,
      totalUsage: input.quota.totalUsage,
      observedAt: input.quota.observedAt.toISOString(),
    },
    retryKey: input.retryKey,
    proposedAt: run.proposedAt.toISOString(),
    expiresAt: run.expiresAt.toISOString(),
  };
  return { ...view, presentationDigest: stableSha256(view) };
}

/** Check that the value the user typed to confirm matches the digest character for character — no prefix or different case accepted */
export function lineProposalApprovalMatches(
  view: LineRunProposalView,
  confirmedDigest: string,
): boolean {
  const { presentationDigest, ...body } = view;
  return presentationDigest === stableSha256(body) && confirmedDigest === presentationDigest;
}

/**
 * The shape that may enter an immutable artifact: no fixture text, and the Channel ID is reduced to a fingerprint.
 * The digest of the full view remains, so it can later be proven which view the user approved
 */
export function lineRunProposalEvidence(view: LineRunProposalView) {
  const { fixture, channelAccountId, ...rest } = view;
  return {
    ...rest,
    type: 'line.run-proposal.evidence' as const,
    channelAccountFingerprint: lineChannelFingerprint(channelAccountId),
    fixture: {
      contentRef: fixture.contentRef,
      version: fixture.version,
      contentDigest: fixture.contentDigest,
    },
  };
}

/** Text for the screen/ticket the user reads before confirming — the last line is the digest that must be typed back */
export function renderLineRunProposal(view: LineRunProposalView): string {
  const lines = [
    'LINE capped pilot — one-shot proposal (S2-LINE-PR02)',
    `final main SHA: ${view.finalMainSha}`,
    `config digest: ${view.digests.config}`,
    `migrations digest: ${view.digests.migrations}`,
    `registry digest: ${view.digests.registry}`,
    `tenant: ${view.tenantId}`,
    `channel: ${view.channelAccountId} / sender: ${view.senderIdentityId}`,
    `purpose/contact kind: ${view.purpose} / ${view.contactKind}`,
    `recipient fingerprint: ${view.recipientFingerprint}`,
    `fixture: ${view.fixture.contentRef} v${view.fixture.version}`,
    ...view.fixture.text.map((text) => `  message: ${text}`),
    `content digest: ${view.fixture.contentDigest}`,
    `credential: ${view.credential.kind} #${view.credential.version} fingerprint ${view.credential.fingerprint} expires ${view.credential.expiresAt ?? 'not specified'}`,
    `caps: ${view.caps.logicalDeliveriesPerRun} delivery/run, attempts ≤ ${view.caps.providerAttemptsPerLogicalDelivery}, recipient 24h ${view.caps.recipientPer24h.used}/${view.caps.recipientPer24h.max}, 24h ${view.caps.per24h.used}/${view.caps.per24h.max}, lifetime ${view.caps.lifetime.used}/${view.caps.lifetime.max}`,
    `quota: ${view.quota.type} ${view.quota.totalUsage}/${view.quota.targetLimit ?? '∞'} as of ${view.quota.observedAt}`,
    `retry key: ${view.retryKey}`,
    `proposal digest: ${view.proposalDigest}`,
    `expires: ${view.expiresAt}`,
    `confirm with the presentation digest: ${view.presentationDigest}`,
  ];
  return `${lines.join('\n')}\n`;
}
