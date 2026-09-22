/**
 * Test support ของ S2.1 (#365) เท่านั้น — production path ไม่ import ไฟล์นี้
 *
 * สร้าง tenant สองรายพร้อม reservation + outbox แถว LINE_MESSAGING_API ผ่าน owner connection
 * (LINE adapter จริงมาใน S2.4) แล้วให้ repository ทั้งหมดใช้ application role ที่ RLS ทำงานจริง
 * ค่าในนี้เป็น fixture สังเคราะห์: ไม่มี LINE user ID, token หรือเนื้อหาข้อความจริง
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

/** Channel ID ของ test OA ตาม #356 — เป็น identifier สาธารณะของ channel ไม่ใช่ credential */
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

  /** outbox แถว LINE พร้อม reservation ที่ผูกกัน — ค่า key เป็น UUID ตามรูปแบบ X-Line-Retry-Key */
  async function seedDelivery(
    tenantId: string,
    adapter: 'LINE_MESSAGING_API' | 'TEST_ADAPTER' = 'LINE_MESSAGING_API',
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
        expiresAt: new Date('2026-09-22T10:15:00.000Z'),
        settlementStatus: 'CLAIMED',
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
        leaseExpiresAt: new Date('2026-09-22T10:10:00.000Z'),
        correlationId: `corr-${suffix}-${sequence}`,
      },
    });
    return { tenantId, reservationId, actionKey, deliveryId, providerRequestKey };
  }

  /** Attempt ที่ Governance เขียนหลัง provider accepted — ใช้เป็นปลายทางของ Touch correlation */
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

  /** gate + allowlist + credential + run authorization ที่อนุมัติครบ พร้อม consume */
  async function seedApprovedRun(tenantId: string, label = 'run') {
    const gate = await control.ensureGate(randomUUID(), scope(tenantId));
    const allowlist = await control.addAllowlistEntry({
      id: randomUUID(),
      ...scope(tenantId),
      gateId: gate.id,
      recipientFingerprint: digest(`recipient-${label}`),
      recipientProtectedRef: `prot:recipient:${randomUUID()}`,
      contentRef: 'fixture:service-notification/v1',
      contentDigest: digest('content-v1'),
      configDigest: digest('config-v1'),
      validFrom: new Date('2026-09-22T00:00:00.000Z'),
      validUntil: new Date('2026-09-29T00:00:00.000Z'),
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
    const proposedAt = new Date('2026-09-22T10:00:00.000Z');
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

  /** SQL ในฐานะ application role ภายใต้ tenant context — ใช้พิสูจน์ grant/trigger/RLS */
  function asApplication(tenantId: string, sql: string) {
    return withTenantDatabaseTransaction(application, tenantId, (transaction) =>
      transaction.$executeRawUnsafe(sql),
    );
  }

  return {
    owner,
    application,
    tenantA: tenantIds[0],
    tenantB: tenantIds[1],
    control,
    attempts: new LineProviderAttemptRepository(application),
    webhooks: new LineWebhookRepository(application),
    audit: new LineAuditRepository(application),
    lineOutbox: new OutboxRepository(application, 'LINE_MESSAGING_API'),
    testOutbox: new OutboxRepository(application, 'TEST_ADAPTER'),
    seedDelivery,
    seedAcceptedAttempt,
    seedApprovedRun,
    scope,
    asApplication,
    async dispose() {
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await owner.dlLineTouchCorrelation.deleteMany(where);
        await owner.dlLineWebhookInboxEntry.deleteMany(where);
        await owner.dlLineCapLedgerEntry.deleteMany(where);
        await owner.dlLineRunAuthorization.deleteMany(where);
        await owner.dlLineAllowlistEntry.deleteMany(where);
        await owner.dlLineCredentialRef.deleteMany(where);
        await owner.dlLineScopeGate.deleteMany(where);
        await owner.dlLineAuditEvent.deleteMany(where);
        await owner.dlProviderSubmissionAttempt.deleteMany(where);
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
