/**
 * Owner: Delivery/Channels — the team test period for sending/receiving LINE on UAT (#567, amendment #358 2026-10-01)
 *
 * The only route of a reply (T1/T2): an admin of the pilot tenant replies to one inbound message with text ≤500 characters
 * and the system pushes to that sender through Contact Governance + the existing S2 gate/cap/barrier set in full:
 *
 * 1. the recipient = the sender of the one-to-one inbound message (fingerprint from the vault — userId never leaves the vault)
 * 2. there must be an APPROVED and unexpired trial authorization (`S2_LINE_TEAM_TRIAL_V1`) for that recipient
 * 3. Governance permits and reserves (consent/quiet hours/frequency) before entering the outbox
 * 4. the text is encrypted into `dl_line_trial_sends` before the barrier — a retry is the original request byte for byte
 * 5. the existing outbound adapter decides gate/cap/attempt; the trial's cap comes from the authorization row
 *
 * No log of text or userId; audit has only a digest and a machine code
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
import type { ContactGovernanceService } from '@d-contact/contact-governance';
import type { LineControlActor, LineControlPlane } from './line-control-plane.js';
import type { LineProviderTransport } from './line-provider-transport.js';
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
/** control characters except newline — LINE text supports newline */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const QUOTA_CACHE_MS = 5 * 60_000;
const ACCEPTED_OUTCOMES = new Set(['LINE_ACCEPTED', 'LINE_ACCEPTED_REPLAY']);

/** digest of the content class that the trial allowlist binds */
export function lineTeamTrialContentDigest(): string {
  return lineContentClassDigest(
    LINE_TEAM_TRIAL_CONTENT_CLASS,
    LINE_TEAM_TRIAL_MAX_CAPS.textMaxLength,
  );
}

export function isLineTeamTrialContentRef(contentRef: string): boolean {
  return TRIAL_CONTENT_REF.test(contentRef);
}

/** text that can be sent: trimmed, 1–500 characters (counted by code point), no control character other than newline */
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
 * source of content for the adapter: `trial-text:<sendId>` → the text decrypted from `dl_line_trial_sends`
 * anything else is forwarded to the S2 fixture — so the gate always sees the content class digest for a trial
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
    // the digest in the DB must match the decrypted text — a mismatch = the row was edited, must not send
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
    super('the trial content is unusable');
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

/** Convert a gate/adapter code into a code the screen can show — reveals no internal detail */
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
  /** sends counted in the latest 24-hour cap (the whole gate) and the trial ceiling */
  last24h: number;
  per24h: number | null;
  perRecipientPer24h: number | null;
}

/** dependencies the service needs — separated so tests can assemble it with fakes */
export interface LineTeamTrialDependencies {
  database: PrismaClient;
  control: LineControlPlane;
  governance: Pick<ContactGovernanceService, 'authorizeAndReserve' | 'claimReservationForDelivery'>;
  /** the adapter attaches to the gate's config digest at send time (the operator can set a new gate without restarting) */
  adapter: (configDigest: string) => Pick<LineOutboundAdapter, 'submit'>;
  vault: Pick<EncryptedLineWebhookPayloadVault, 'read'>;
  payloadKey: LinePayloadKey;
  credentials: LineAccessTokenResolver;
  transport: Pick<LineProviderTransport, 'getQuota' | 'getConsumption'>;
  scope: LineGateScope;
  /** the system actor that executes the run (EXECUTE_RUN belongs to the Platform Operator per #358 §E) */
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

    // idempotency: same key + same text = same result (forward on if not finished); different text = conflict
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

  /** send (or forward) one trial delivery through the existing adapter */
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

  /** a delivery already finished: the real result comes from the latest receipt (accepted = sent, anything else = rejected) */
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

  /** the trial authorization usable by this recipient, or says it is not in the trial allowlist */
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

  /** advisory LINE quota (#358 §D) — cached 5 minutes so that not every reply fires the quota API */
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
        ...(quota.type === 'limited' && typeof quota.value === 'number'
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

  /** T5: any admin can kill immediately — lifting a kill is possible only via the CLI + approval */
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
