/**
 * Test support for S2.1 (#365) only — no production path imports this file
 *
 * Creates two tenants with a reservation + an outbox LINE_MESSAGING_API row through the owner connection
 * (the real LINE adapter arrives in S2.4) then has every repository use the application role with RLS really in effect.
 * The values here are synthetic fixtures: no LINE user ID, token or real message content
 */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { LineAuditRepository } from './line-audit-repository.js';
import { LineProviderAttemptRepository } from './line-attempt-repository.js';
import { LineControlRepository, type LineGateScope } from './line-control-repository.js';
import { LineWebhookRepository } from './line-webhook-repository.js';
import { OutboxRepository } from './outbox-repository.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

/** Channel ID of the test OA per #356 — a public identifier of the channel, not a credential */
export const PILOT_CHANNEL_ACCOUNT_ID = '2007056595';
export const PILOT_SENDER = 'sender-approved-test-only';

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type LinePersistenceFixture = Awaited<ReturnType<typeof createLinePersistenceFixture>>;

export async function createLinePersistenceFixture() {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantIds = [randomUUID(), randomUUID()] as const;
  const contactIds = new Map<string, string>();
  const suffix = tenantIds[0].slice(0, 8);

  for (const [index, tenantId] of tenantIds.entries()) {
    await owner.tenant.create({
      data: {
        id: tenantId,
        name: `S2 LINE ${suffix}-${index}`,
        slug: `s2-line-${suffix}-${index}`,
        sipDomain: `${suffix}-${index}.s2-line.test`,
      },
    });
    const contactId = randomUUID();
    await owner.contact.create({
      data: { id: contactId, tenantId, displayName: 'S2 LINE synthetic contact' },
    });
    contactIds.set(tenantId, contactId);
  }

  let sequence = 0;

  /** An outbox LINE row with a bound reservation — the key values are UUIDs in the form of X-Line-Retry-Key */
  async function seedDelivery(
    tenantId: string,
    adapter: 'LINE_MESSAGING_API' | 'TEST_ADAPTER' = 'LINE_MESSAGING_API',
    /** S2.4 runs with the current time, so the lease/expiry must be shifted by that test's clock */
    at?: Date,
  ) {
    sequence += 1;
    const reservationId = randomUUID();
    const actionKey = `s2-action-${suffix}-${sequence}`;
    const deliveryId = `dlv_${suffix}_${sequence}`;
    const providerRequestKey = randomUUID();
    const channel = adapter === 'LINE_MESSAGING_API' ? 'LINE' : 'EMAIL';
    await owner.cgReservation.create({
      data: {
        id: reservationId,
        tenantId,
        contactId: contactIds.get(tenantId)!,
        channel,
        purpose: 'SERVICE_NOTIFICATION',
        source: 'JOURNEY',
        sourceId: `journey-${sequence}`,
        actionKey,
        inputHash: digest(actionKey),
        expiresAt: new Date((at ?? new Date('2026-09-22T10:00:00.000Z')).getTime() + 15 * 60_000),
        settlementStatus: 'CLAIMED',
        // S2.4 calls beginProviderSubmission, which CASes against the real reservation leaseVersion
        leaseVersion: 1,
        leaseExpiresAt: new Date(
          (at ?? new Date('2026-09-22T10:00:00.000Z')).getTime() + 10 * 60_000,
        ),
        deliveryId,
      },
    });
    await owner.dlOutboxEntry.create({
      data: {
        tenantId,
        actionKey,
        reservationId,
        deliveryId,
        providerRequestKey,
        adapter,
        channel,
        contactId: contactIds.get(tenantId)!,
        purpose: 'SERVICE_NOTIFICATION',
        source: 'JOURNEY',
        senderIdentityId: PILOT_SENDER,
        contentRef: 'fixture:service-notification/v1',
        inputHash: digest(`input-${actionKey}`),
        leaseVersion: 1,
        leaseExpiresAt: new Date(
          (at ?? new Date('2026-09-22T10:00:00.000Z')).getTime() + 10 * 60_000,
        ),
        correlationId: `corr-${suffix}-${sequence}`,
      },
    });
    return { tenantId, reservationId, actionKey, deliveryId, providerRequestKey };
  }

  /**
   * S2.6b (#403): a reservation Governance already approved but with no delivery bound yet — the target of
   * `LineDeliveryEnqueue`, which must claim through Governance itself
   */
  async function seedReservation(
    tenantId: string,
    at = new Date(),
    /** #567: actionKey set by the caller (trial uses `s2-trial-<sendId>`) */
    fixedActionKey?: string,
  ) {
    sequence += 1;
    const reservationId = randomUUID();
    const actionKey = fixedActionKey ?? `s2-enqueue-${suffix}-${sequence}`;
    await owner.cgReservation.create({
      data: {
        id: reservationId,
        tenantId,
        contactId: contactIds.get(tenantId)!,
        channel: 'LINE',
        purpose: 'SERVICE_NOTIFICATION',
        source: 'JOURNEY',
        sourceId: `journey-${sequence}`,
        actionKey,
        inputHash: digest(actionKey),
        expiresAt: new Date(at.getTime() + 15 * 60_000),
      },
    });
    return { tenantId, reservationId, actionKey, contactId: contactIds.get(tenantId)! };
  }

  /** The Attempt Governance writes after the provider accepted — used as the target of Touch correlation */
  async function seedAcceptedAttempt(delivery: Awaited<ReturnType<typeof seedDelivery>>) {
    const id = randomUUID();
    await owner.cgAttempt.create({
      data: {
        id,
        tenantId: delivery.tenantId,
        reservationId: delivery.reservationId,
        deliveryId: delivery.deliveryId,
        outcomeRef: `ocr_${digest(delivery.deliveryId).slice(0, 32)}`,
        contactId: contactIds.get(delivery.tenantId)!,
        channel: 'LINE',
        purpose: 'SERVICE_NOTIFICATION',
        source: 'JOURNEY',
        outcome: 'PROVIDER_ACCEPTED',
        occurredAt: new Date('2026-09-22T10:01:00.000Z'),
        correlationId: 'corr-attempt',
      },
    });
    return id;
  }

  function scope(tenantId: string): LineGateScope {
    return {
      tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      senderIdentityId: PILOT_SENDER,
      purpose: 'SERVICE_NOTIFICATION',
      contactKind: 'SERVICE',
    };
  }

  const control = new LineControlRepository(application);

  /** gate + allowlist + credential + run authorization fully approved, with consume */
  async function seedApprovedRun(
    tenantId: string,
    label = 'run',
    /** S2.4 binds the allowlist to the digest of the real fixture, so it can be overridden additively */
    overrides: {
      contentRef?: string;
      contentDigest?: string;
      configDigest?: string;
      /** a run has a 30-minute TTL — a test using the current time must propose the run at that time too */
      proposedAt?: Date;
      /** S2.6b: a recipient whose fingerprint matches the webhook sender and the Keychain ref */
      recipientFingerprint?: string;
      recipientProtectedRef?: string;
    } = {},
  ) {
    const gate = await control.ensureGate(randomUUID(), scope(tenantId));
    const allowlist = await control.addAllowlistEntry({
      id: randomUUID(),
      ...scope(tenantId),
      gateId: gate.id,
      recipientFingerprint: overrides.recipientFingerprint ?? digest(`recipient-${label}`),
      recipientProtectedRef: overrides.recipientProtectedRef ?? `prot:recipient:${randomUUID()}`,
      contentRef: overrides.contentRef ?? 'fixture:service-notification/v1',
      contentDigest: overrides.contentDigest ?? digest('content-v1'),
      configDigest: overrides.configDigest ?? digest('config-v1'),
      validFrom: new Date(
        (overrides.proposedAt ?? new Date('2026-09-22T00:00:00.000Z')).getTime() - 86_400_000,
      ),
      validUntil: new Date(
        (overrides.proposedAt ?? new Date('2026-09-22T00:00:00.000Z')).getTime() + 7 * 86_400_000,
      ),
      approvalAuditRef: `audit:allowlist:${label}`,
    });
    const credential = await control.registerCredentialRef({
      id: randomUUID(),
      tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
      version: Number.parseInt(randomUUID().slice(0, 6), 16) + 1,
      keychainService: 'd-contact.line.2007056595',
      keychainAccount: 'channel-access-token',
      fingerprint: digest(`fingerprint-${label}-${randomUUID()}`),
      issuedAt: new Date('2026-09-22T00:00:00.000Z'),
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
    });
    const proposedAt = overrides.proposedAt ?? new Date('2026-09-22T10:00:00.000Z');
    const run = await control.proposeRun({
      id: randomUUID(),
      tenantId,
      gateId: gate.id,
      allowlistEntryId: allowlist.id,
      credentialRefId: credential.id,
      credentialVersion: credential.version,
      proposalDigest: digest(`proposal-${label}-${randomUUID()}`),
      configDigest: digest('config-v1'),
      capLogicalDeliveries: 1,
      capProviderAttempts: 4,
      proposedBy: 'platform-operator-1',
      proposedAt,
      expiresAt: new Date(proposedAt.getTime() + 30 * 60_000),
    });
    await control.approveRun(tenantId, run.id, 'TENANT_ADMIN', 'tenant-admin-1', proposedAt);
    const approved = await control.approveRun(
      tenantId,
      run.id,
      'COMPLIANCE',
      'compliance-1',
      proposedAt,
    );
    return { gate, allowlist, credential, run: approved!, proposedAt };
  }

  /** SQL as the application role under a tenant context — used to prove grant/trigger/RLS */
  function asApplication(tenantId: string, sql: string) {
    return withTenantDatabaseTransaction(application, tenantId, (transaction) =>
      transaction.$executeRawUnsafe(sql),
    );
  }

  return {
    owner,
    application,
    contactIdOf: (tenantId: string) => contactIds.get(tenantId)!,
    tenantA: tenantIds[0],
    tenantB: tenantIds[1],
    control,
    attempts: new LineProviderAttemptRepository(application),
    webhooks: new LineWebhookRepository(application),
    audit: new LineAuditRepository(application),
    lineOutbox: new OutboxRepository(application, 'LINE_MESSAGING_API'),
    testOutbox: new OutboxRepository(application, 'TEST_ADAPTER'),
    seedDelivery,
    seedReservation,
    seedAcceptedAttempt,
    seedApprovedRun,
    scope,
    asApplication,
    async dispose() {
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        // #567: a trial send references an inbox/run so it must be deleted first
        await owner.dlLineTrialSend.deleteMany(where);
        await owner.dlLineTouchCorrelation.deleteMany(where);
        await owner.dlLineInboundMessage.deleteMany(where);
        await owner.dlLineWebhookPayload.deleteMany(where);
        await owner.dlLineEventOutboxEntry.deleteMany(where);
        await owner.dlLineWebhookInboxEntry.deleteMany(where);
        await owner.dlLineCapLedgerEntry.deleteMany(where);
        await owner.dlLineRunAuthorization.deleteMany(where);
        await owner.dlLineAllowlistEntry.deleteMany(where);
        await owner.dlLineCredentialRef.deleteMany(where);
        await owner.dlLineScopeGate.deleteMany(where);
        await owner.dlLineAuditEvent.deleteMany(where);
        await owner.dlProviderSubmissionAttempt.deleteMany(where);
        // S2.4 calls the real CG command so there is a receipt bound to the reservation that must be cleared first
        await owner.cgReservationCommandReceipt.deleteMany(where);
        await owner.cgTouch.deleteMany(where);
        await owner.cgAttempt.deleteMany(where);
        await owner.dlOutboxEntry.deleteMany(where);
        await owner.cgReservation.deleteMany(where);
        await owner.contact.deleteMany(where);
        await owner.tenant.deleteMany({ where: { id: tenantId } });
      }
      await Promise.all([owner.$disconnect(), application.$disconnect()]);
    },
  };
}
