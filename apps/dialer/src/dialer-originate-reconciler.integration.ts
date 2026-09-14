/**
 * J2.9 follow-up — พิสูจน์ crash recovery ของ originate barrier:
 * แถวที่ค้าง `ORIGINATING` จน lease หมดต้องถูกกวาดเข้า `RECONCILING` โดยไม่ originate ซ้ำ
 * และไม่แตะ reservation ของ Governance เลย
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import type { TeamContactScopeAuthorizer } from '@d-contact/cxa-contracts';
import { CampaignFixtures } from './campaign-fixtures.js';
import { DialerOriginateBarrier } from './dialer-originate-barrier.js';
import { DialerOriginateReconciler } from './dialer-originate-reconciler.js';
import { DialerOwnerBarrierGate } from './dialer-owner-barrier-gate.js';
import { ScriptedTelephonyTransport } from './dialer-telephony-test-transport.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const allowAllScope: TeamContactScopeAuthorizer = {
  async authorize(input) {
    return { decision: 'ALLOW', scopeVersion: 1, evaluatedAt: input.at };
  },
};

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const contactId = randomUUID();
  const queueId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.9 reconcile ${suffix}`,
      slug: `j2-9-reconcile-${suffix}`,
      sipDomain: `${suffix}.j2-9-reconcile.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Dialer' } });
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'J2.9 contact' } });
  await owner.queue.create({
    data: { id: queueId, tenantId, name: 'Collections', channels: ['VOICE'] },
  });

  const fixtures = new CampaignFixtures(application);
  const campaignId = randomUUID();
  await fixtures.upsertCampaign({ tenantId, id: campaignId, key: 'campaign-1', status: 'ACTIVE' });

  t.after(async () => {
    await owner.cgReservationCommandReceipt.deleteMany({ where: { tenantId } });
    await owner.cgTouch.deleteMany({ where: { tenantId } });
    await owner.cgAttempt.deleteMany({ where: { tenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId } });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.cgConsent.deleteMany({ where: { tenantId } });
    await owner.obCampaignTarget.deleteMany({ where: { tenantId } });
    await owner.obCallback.deleteMany({ where: { tenantId } });
    await owner.obCampaignAdmissionPolicy.deleteMany({ where: { tenantId } });
    await owner.obCampaign.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  return { owner, application, tenantId, teamId, contactId, queueId, campaignId };
}

/** จำลอง crash: แถวค้าง ORIGINATING โดย lease หมดไปแล้ว */
function stuckTarget(f: Awaited<ReturnType<typeof fixture>>, leaseExpiresAt: Date) {
  return f.owner.obCampaignTarget.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      campaignId: f.campaignId,
      contactId: f.contactId,
      state: 'ORIGINATING',
      originateLeaseExpiresAt: leaseExpiresAt,
      sourceOwnerTeamId: f.teamId,
      targetOwnerTeamId: f.teamId,
      admissionPolicyVersion: 1,
    },
  });
}

function stuckCallback(f: Awaited<ReturnType<typeof fixture>>, leaseExpiresAt: Date) {
  return f.owner.obCallback.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      contactId: f.contactId,
      queueId: f.queueId,
      requestedFor: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60 * 60_000),
      state: 'ORIGINATING',
      originateLeaseExpiresAt: leaseExpiresAt,
      sourceOwnerTeamId: f.teamId,
      targetOwnerTeamId: f.teamId,
    },
  });
}

test('target ที่ค้าง ORIGINATING จน lease หมด ถูกกวาดเข้า RECONCILING ไม่ originate ซ้ำ', async (t) => {
  const f = await fixture(t);
  const target = await stuckTarget(f, new Date(Date.now() - 60_000));
  const reconciler = new DialerOriginateReconciler(f.application);

  const evidence = await reconciler.reconcileExpired(f.tenantId, 'corr-reconcile');

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.kind, 'campaign_target');
  assert.equal(evidence[0]!.recordId, target.id);

  const updated = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(updated.state, 'RECONCILING');
  assert.equal(updated.originateLeaseExpiresAt, null);
  // ห้ามแตะ Governance: ไม่มี reservation ใหม่ และไม่มี attempt/touch เพิ่ม
  assert.equal(await f.owner.cgReservation.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await f.owner.cgAttempt.count({ where: { tenantId: f.tenantId } }), 0);
});

test('callback ที่ค้าง ORIGINATING จน lease หมด ถูกกวาดเข้า RECONCILING เช่นกัน', async (t) => {
  const f = await fixture(t);
  const callback = await stuckCallback(f, new Date(Date.now() - 60_000));
  const reconciler = new DialerOriginateReconciler(f.application);

  const evidence = await reconciler.reconcileExpired(f.tenantId, 'corr-reconcile');

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.kind, 'callback');

  const updated = await f.owner.obCallback.findUniqueOrThrow({ where: { id: callback.id } });
  assert.equal(updated.state, 'RECONCILING');
  assert.equal(updated.originateLeaseExpiresAt, null);
});

test('แถวที่ lease ยังไม่หมด (originate กำลังเดินอยู่จริง) ต้องไม่ถูกแตะ', async (t) => {
  const f = await fixture(t);
  const target = await stuckTarget(f, new Date(Date.now() + 60_000));
  const reconciler = new DialerOriginateReconciler(f.application);

  const evidence = await reconciler.reconcileExpired(f.tenantId, 'corr-reconcile');

  assert.equal(evidence.length, 0);
  const unchanged = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(unchanged.state, 'ORIGINATING');
});

test('รัน sweeper ซ้ำเป็น replay ไม่ใช่การ settle รอบสอง', async (t) => {
  const f = await fixture(t);
  const target = await stuckTarget(f, new Date(Date.now() - 60_000));
  const reconciler = new DialerOriginateReconciler(f.application);

  const first = await reconciler.reconcileExpired(f.tenantId, 'corr-1');
  const second = await reconciler.reconcileExpired(f.tenantId, 'corr-2');

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);

  const updated = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(updated.state, 'RECONCILING');
  // version ขยับครั้งเดียวเท่านั้น (1 -> 2) รอบสองไม่เขียนซ้ำ
  assert.equal(updated.version, 2);
});

test('sweeper ไม่ข้าม tenant — แถวค้างของ tenant อื่นไม่ถูกกวาด', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const mine = await stuckTarget(f, new Date(Date.now() - 60_000));
  const theirs = await stuckTarget(other, new Date(Date.now() - 60_000));
  const reconciler = new DialerOriginateReconciler(f.application);

  const evidence = await reconciler.reconcileExpired(f.tenantId, 'corr-1');

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.recordId, mine.id);
  const untouched = await other.owner.obCampaignTarget.findUniqueOrThrow({
    where: { id: theirs.id },
  });
  assert.equal(untouched.state, 'ORIGINATING');
});

test('originate ที่สำเร็จตามปกติล้าง lease ทิ้ง จึงไม่ถูก sweeper กวาดภายหลัง', async (t) => {
  const f = await fixture(t);
  await f.owner.cgConsent.create({
    data: {
      tenantId: f.tenantId,
      contactId: f.contactId,
      purpose: 'CAMPAIGN_OUTREACH',
      channel: 'VOICE',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
  });
  const gate = new DialerOwnerBarrierGate();
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(f.tenantId, 'COMPLIANCE');
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(f.tenantId, 'COMPLIANCE');
  const barrier = new DialerOriginateBarrier(
    f.application,
    new ContactGovernanceService(f.application),
    allowAllScope,
    gate,
    { transport: new ScriptedTelephonyTransport() },
  );
  const target = await f.owner.obCampaignTarget.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      campaignId: f.campaignId,
      contactId: f.contactId,
      state: 'ADMITTED',
      sourceOwnerTeamId: f.teamId,
      targetOwnerTeamId: f.teamId,
      admissionPolicyVersion: 1,
    },
  });

  assert.equal(await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1'), 'ORIGINATED');

  const settled = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(settled.state, 'CONSUMED');
  assert.equal(settled.originateLeaseExpiresAt, null);

  const evidence = await new DialerOriginateReconciler(f.application).reconcileExpired(
    f.tenantId,
    'corr-2',
  );
  assert.deepEqual(evidence, []);
});
