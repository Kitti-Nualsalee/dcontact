import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import type { TeamContactScopeAuthorizer } from '@d-contact/cxa-contracts';
import { CampaignFixtures } from './campaign-fixtures.js';
import { DialerOriginateBarrier } from './dialer-originate-barrier.js';
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
const denyAllScope: TeamContactScopeAuthorizer = {
  async authorize(input) {
    return { decision: 'DENY', reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED', evaluatedAt: input.at };
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
      name: `J2.9 dialer ${suffix}`,
      slug: `j2-9-dialer-${suffix}`,
      sipDomain: `${suffix}.j2-9-dialer.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Dialer' } });
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'J2.9 contact' } });
  await owner.queue.create({
    data: { id: queueId, tenantId, name: 'Collections', channels: ['VOICE'] },
  });
  await owner.cgConsent.create({
    data: {
      tenantId,
      contactId,
      purpose: 'CAMPAIGN_OUTREACH',
      channel: 'VOICE',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
  });
  await owner.cgConsent.create({
    data: {
      tenantId,
      contactId,
      purpose: 'CALLBACK_OUTREACH',
      channel: 'VOICE',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
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

async function admittedTarget(
  f: Awaited<ReturnType<typeof fixture>>,
  state: 'ADMITTED' | 'DEFERRED' = 'ADMITTED',
) {
  return f.owner.obCampaignTarget.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      campaignId: f.campaignId,
      contactId: f.contactId,
      state,
      sourceOwnerTeamId: f.teamId,
      targetOwnerTeamId: f.teamId,
      admissionPolicyVersion: 1,
    },
  });
}

async function scheduledCallback(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: { requestedFor?: Date; expiresAt?: Date } = {},
) {
  const requestedFor = overrides.requestedFor ?? new Date(Date.now() - 60_000);
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 60 * 60_000);
  return f.owner.obCallback.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      contactId: f.contactId,
      queueId: f.queueId,
      requestedFor,
      expiresAt,
      sourceOwnerTeamId: f.teamId,
      targetOwnerTeamId: f.teamId,
    },
  });
}

test('campaign target ที่ ADMITTED และผ่าน scope+governance สด originate สำเร็จเป็น CONSUMED', async (t) => {
  const f = await fixture(t);
  const governance = new ContactGovernanceService(f.application);
  const gate = new DialerOwnerBarrierGate();
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(f.tenantId, 'COMPLIANCE');
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(f.tenantId, 'COMPLIANCE');

  const barrier = new DialerOriginateBarrier(f.application, governance, allowAllScope, gate, {
    transport: new ScriptedTelephonyTransport(),
  });
  const target = await admittedTarget(f);

  const outcome = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
  assert.equal(outcome, 'ORIGINATED');

  const updated = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(updated.state, 'CONSUMED');
});

test('gate DISABLED ปฏิเสธก่อนแตะ scope/governance เลย', async (t) => {
  const f = await fixture(t);
  const governance = new ContactGovernanceService(f.application);
  const gate = new DialerOwnerBarrierGate();
  const barrier = new DialerOriginateBarrier(f.application, governance, allowAllScope, gate, {
    transport: new ScriptedTelephonyTransport(),
  });
  const target = await admittedTarget(f);

  const outcome = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
  assert.equal(outcome, 'GATE_CLOSED');

  const unchanged = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(unchanged.state, 'ADMITTED');
});

test('SHADOW_RECEIPT ตรวจ scope สดแล้วหยุดก่อนเรียก governance หรือแตะ state ใด ๆ', async (t) => {
  const f = await fixture(t);
  const governance = new ContactGovernanceService(f.application);
  const gate = new DialerOwnerBarrierGate();
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(f.tenantId, 'COMPLIANCE');
  const barrier = new DialerOriginateBarrier(f.application, governance, allowAllScope, gate, {
    transport: new ScriptedTelephonyTransport(),
  });
  const target = await admittedTarget(f);

  const outcome = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
  assert.equal(outcome, 'SHADOW_OBSERVED');

  const unchanged = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(unchanged.state, 'ADMITTED');
  assert.equal(await f.owner.cgReservation.count({ where: { tenantId: f.tenantId } }), 0);
});

test('scope ที่ deny สด (ไม่ reuse admission decision) เลื่อน target เข้า DEFERRED', async (t) => {
  const f = await fixture(t);
  const governance = new ContactGovernanceService(f.application);
  const gate = new DialerOwnerBarrierGate();
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(f.tenantId, 'COMPLIANCE');
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(f.tenantId, 'COMPLIANCE');
  const barrier = new DialerOriginateBarrier(f.application, governance, denyAllScope, gate, {
    transport: new ScriptedTelephonyTransport(),
  });
  const target = await admittedTarget(f);

  const outcome = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
  assert.equal(outcome, 'SCOPE_DENIED');

  const updated = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(updated.state, 'DEFERRED');
});

test('TEST_ADAPTER ที่ REJECTED settle เป็น PROVIDER_REJECTED แล้ว target กลับไป DEFERRED ให้ retry', async (t) => {
  const f = await fixture(t);
  const governance = new ContactGovernanceService(f.application);
  const gate = new DialerOwnerBarrierGate();
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(f.tenantId, 'COMPLIANCE');
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(f.tenantId, 'COMPLIANCE');
  const target = await admittedTarget(f);
  const transport = new ScriptedTelephonyTransport();
  transport.script(target.id, { status: 'REJECTED', reasonCode: 'NO_ANSWER' });
  const barrier = new DialerOriginateBarrier(f.application, governance, allowAllScope, gate, {
    transport,
  });

  const outcome = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
  assert.equal(outcome, 'REJECTED');

  const updated = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(updated.state, 'DEFERRED');
});

test('campaign ที่ไม่ใช่ ACTIVE อีกแล้ว (แม้ target ยัง ADMITTED) fail closed เข้า DEFERRED', async (t) => {
  const f = await fixture(t);
  const governance = new ContactGovernanceService(f.application);
  const gate = new DialerOwnerBarrierGate();
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(f.tenantId, 'COMPLIANCE');
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(f.tenantId, 'COMPLIANCE');
  const barrier = new DialerOriginateBarrier(f.application, governance, allowAllScope, gate, {
    transport: new ScriptedTelephonyTransport(),
  });
  const target = await admittedTarget(f);
  await f.owner.obCampaign.update({ where: { id: f.campaignId }, data: { status: 'STOPPED' } });

  const outcome = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
  assert.equal(outcome, 'NOT_ELIGIBLE');
  const updated = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(updated.state, 'DEFERRED');
});

test('callback ที่ SCHEDULED และถึงเวลาแล้ว originate สำเร็จเป็น CONSUMED', async (t) => {
  const f = await fixture(t);
  const governance = new ContactGovernanceService(f.application);
  const gate = new DialerOwnerBarrierGate();
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(f.tenantId, 'COMPLIANCE');
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(f.tenantId, 'COMPLIANCE');
  const barrier = new DialerOriginateBarrier(f.application, governance, allowAllScope, gate, {
    transport: new ScriptedTelephonyTransport(),
  });
  const callback = await scheduledCallback(f);

  const outcome = await barrier.originateCallback(f.tenantId, callback.id, 'corr-1');
  assert.equal(outcome, 'ORIGINATED');
  const updated = await f.owner.obCallback.findUniqueOrThrow({ where: { id: callback.id } });
  assert.equal(updated.state, 'CONSUMED');
});

test('callback ที่ยังไม่ถึงเวลา (เกิน early tolerance) ยังไม่ eligible', async (t) => {
  const f = await fixture(t);
  const governance = new ContactGovernanceService(f.application);
  const gate = new DialerOwnerBarrierGate();
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(f.tenantId, 'COMPLIANCE');
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(f.tenantId, 'COMPLIANCE');
  const barrier = new DialerOriginateBarrier(f.application, governance, allowAllScope, gate, {
    transport: new ScriptedTelephonyTransport(),
  });
  const callback = await scheduledCallback(f, { requestedFor: new Date(Date.now() + 60 * 60_000) });

  const outcome = await barrier.originateCallback(f.tenantId, callback.id, 'corr-1');
  assert.equal(outcome, 'NOT_ELIGIBLE');
  const unchanged = await f.owner.obCallback.findUniqueOrThrow({ where: { id: callback.id } });
  assert.equal(unchanged.state, 'SCHEDULED');
});

test('callback ที่เลย expiresAt แล้วถือว่า EXPIRED โดยไม่แตะ scope/governance', async (t) => {
  const f = await fixture(t);
  const governance = new ContactGovernanceService(f.application);
  const gate = new DialerOwnerBarrierGate();
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(f.tenantId, 'COMPLIANCE');
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(f.tenantId, 'COMPLIANCE');
  const barrier = new DialerOriginateBarrier(f.application, governance, allowAllScope, gate, {
    transport: new ScriptedTelephonyTransport(),
  });
  const callback = await scheduledCallback(f, {
    requestedFor: new Date(Date.now() - 2 * 60 * 60_000),
    expiresAt: new Date(Date.now() - 60 * 60_000),
  });

  const outcome = await barrier.originateCallback(f.tenantId, callback.id, 'corr-1');
  assert.equal(outcome, 'EXPIRED');
});

test('restart-safety: target ที่ไม่ใช่ ADMITTED อีกแล้ว (เช่น originate ไปก่อนหน้า) เป็น NOT_ELIGIBLE ไม่ originate ซ้ำ', async (t) => {
  const f = await fixture(t);
  const governance = new ContactGovernanceService(f.application);
  const gate = new DialerOwnerBarrierGate();
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(f.tenantId, 'COMPLIANCE');
  gate.propose(f.tenantId, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(f.tenantId, 'COMPLIANCE');
  const barrier = new DialerOriginateBarrier(f.application, governance, allowAllScope, gate, {
    transport: new ScriptedTelephonyTransport(),
  });
  const target = await admittedTarget(f);
  const first = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
  assert.equal(first, 'ORIGINATED');

  const second = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-2');
  assert.equal(second, 'NOT_ELIGIBLE');
});
