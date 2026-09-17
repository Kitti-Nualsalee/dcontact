import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import {
  ReservationBindingError,
  type AuthorizationOutcome,
  type ContactGovernancePort,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import { CampaignFixtures, openOriginateGate } from './campaign-fixtures.js';
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
    await owner.obOriginateRolloutAudit.deleteMany({ where: { tenantId } });
    await owner.obOriginateRolloutScope.deleteMany({ where: { tenantId } });
    await owner.obOriginateRollout.deleteMany({ where: { tenantId } });
    await owner.cg4ScopeKillSwitch.deleteMany({ where: { tenantId } });
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

/** gate ที่เปิดถึง SCOPED_INTERNAL_ENABLED พร้อม allowlist ของ campaign/queue ใน fixture */
function openScopedGate(f: Awaited<ReturnType<typeof fixture>>) {
  return openOriginateGate(f.application, f.tenantId, 'SCOPED_INTERNAL_ENABLED', {
    campaigns: [f.campaignId],
    callbackQueues: [f.queueId],
  });
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
  const gate = await openScopedGate(f);

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
  const gate = new DialerOwnerBarrierGate(f.application);
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
  const gate = await openOriginateGate(f.application, f.tenantId, 'SHADOW_RECEIPT');
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
  const gate = await openScopedGate(f);
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
  const gate = await openScopedGate(f);
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
  const gate = await openScopedGate(f);
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
  const gate = await openScopedGate(f);
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
  const gate = await openScopedGate(f);
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
  const gate = await openScopedGate(f);
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
  const gate = await openScopedGate(f);
  const barrier = new DialerOriginateBarrier(f.application, governance, allowAllScope, gate, {
    transport: new ScriptedTelephonyTransport(),
  });
  const target = await admittedTarget(f);
  const first = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
  assert.equal(first, 'ORIGINATED');

  const second = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-2');
  assert.equal(second, 'NOT_ELIGIBLE');
});

/** transport ที่นับครั้งที่ถูกเรียก — ใช้พิสูจน์ว่าหยุดก่อน provider boundary จริง */
class CountingTransport extends ScriptedTelephonyTransport {
  calls = 0;
  override async originate(request: Parameters<ScriptedTelephonyTransport['originate']>[0]) {
    this.calls += 1;
    return super.originate(request);
  }
}

/** Governance port ที่ตอบผลตามที่กำหนดและนับการเรียก — สำหรับผลที่ fixture จริงสร้างยาก */
function scriptedGovernance(
  real: ContactGovernancePort,
  script: {
    authorize?: () => Promise<AuthorizationOutcome>;
    claim?: () => Promise<never>;
  },
) {
  const calls = { authorize: 0, claim: 0 };
  const port: ContactGovernancePort = {
    authorizeAndReserve: async (tenant, input) => {
      calls.authorize += 1;
      return script.authorize ? script.authorize() : real.authorizeAndReserve(tenant, input);
    },
    claimReservationForDelivery: async (input) => {
      calls.claim += 1;
      return script.claim ? script.claim() : real.claimReservationForDelivery(input);
    },
    renewReservationLease: (input) => real.renewReservationLease(input),
    beginProviderSubmission: (input) => real.beginProviderSubmission(input),
    confirmProviderAcceptance: (input) => real.confirmProviderAcceptance(input),
    releaseBeforeSubmit: (input) => real.releaseBeforeSubmit(input),
    settleDelivery: (input) => real.settleDelivery(input),
  };
  return { port, calls };
}

test('OWNER_CONFORMANCE ตรวจเงื่อนไขฝั่ง owner ครบแล้วหยุดก่อนจอง Governance reservation', async (t) => {
  const f = await fixture(t);
  const { port, calls } = scriptedGovernance(new ContactGovernanceService(f.application), {});
  const gate = await openOriginateGate(f.application, f.tenantId, 'OWNER_CONFORMANCE', {
    campaigns: [f.campaignId],
    callbackQueues: [f.queueId],
  });
  const transport = new CountingTransport();
  const barrier = new DialerOriginateBarrier(f.application, port, allowAllScope, gate, {
    transport,
  });
  const target = await admittedTarget(f);
  const callback = await scheduledCallback(f);

  assert.equal(
    await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1'),
    'CONFORMANCE_OBSERVED',
  );
  assert.equal(
    await barrier.originateCallback(f.tenantId, callback.id, 'corr-2'),
    'CONFORMANCE_OBSERVED',
  );
  assert.equal(calls.authorize, 0, 'ห้ามจอง reservation ก่อนขั้น SCOPED_INTERNAL_ENABLED');
  assert.equal(transport.calls, 0);
  assert.equal(await f.owner.cgReservation.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(
    (await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } })).state,
    'ADMITTED',
  );
  assert.equal(
    (await f.owner.obCallback.findUniqueOrThrow({ where: { id: callback.id } })).state,
    'SCHEDULED',
  );

  // ต่อให้ allowlist ครบ ถ้าเงื่อนไขฝั่ง owner ไม่ผ่านต้องไม่รายงานว่า conform
  const denying = new DialerOriginateBarrier(f.application, port, denyAllScope, gate, {
    transport,
  });
  assert.equal(
    await denying.originateCampaignTarget(f.tenantId, target.id, 'corr-3'),
    'SCOPE_DENIED',
  );
});

test('SCOPED_INTERNAL_ENABLED originate เฉพาะ campaign/queue ใน allowlist และถอน scope แล้วหยุดทันที', async (t) => {
  const f = await fixture(t);
  const { port, calls } = scriptedGovernance(new ContactGovernanceService(f.application), {});
  const gate = await openOriginateGate(f.application, f.tenantId, 'SCOPED_INTERNAL_ENABLED');
  const transport = new CountingTransport();
  const barrier = new DialerOriginateBarrier(f.application, port, allowAllScope, gate, {
    transport,
  });
  const target = await admittedTarget(f);
  const callback = await scheduledCallback(f);

  assert.equal(await barrier.originateCampaignTarget(f.tenantId, target.id, 'c1'), 'OUT_OF_SCOPE');
  assert.equal(await barrier.originateCallback(f.tenantId, callback.id, 'c2'), 'OUT_OF_SCOPE');
  assert.equal(calls.authorize, 0);
  assert.equal(transport.calls, 0);

  const compliance = { role: 'COMPLIANCE' as const, ref: 'compliance-2' };
  await gate.allowScope(f.tenantId, compliance, 'CALLBACK_QUEUE', f.queueId);
  assert.equal(await barrier.originateCampaignTarget(f.tenantId, target.id, 'c3'), 'OUT_OF_SCOPE');
  assert.equal(await barrier.originateCallback(f.tenantId, callback.id, 'c4'), 'ORIGINATED');

  await gate.allowScope(f.tenantId, compliance, 'CAMPAIGN', f.campaignId);
  await gate.revokeScope(
    f.tenantId,
    { role: 'PLATFORM_OPERATOR', ref: 'operator-1' },
    'CAMPAIGN',
    f.campaignId,
  );
  assert.equal(await barrier.originateCampaignTarget(f.tenantId, target.id, 'c5'), 'OUT_OF_SCOPE');
  assert.equal(
    (await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } })).state,
    'ADMITTED',
    'นอก scope ต้องไม่เปลี่ยน owner state',
  );
});

test('kill จาก Dialer instance อื่นปิด originate ทุก instance ทันที', async (t) => {
  const f = await fixture(t);
  const gate = await openScopedGate(f);
  const transport = new CountingTransport();
  const barrier = new DialerOriginateBarrier(
    f.application,
    new ContactGovernanceService(f.application),
    allowAllScope,
    gate,
    { transport },
  );
  const target = await admittedTarget(f);

  // instance อื่นที่มี gate object ของตัวเองแต่ชี้ฐานข้อมูลเดียวกัน
  await new DialerOwnerBarrierGate(f.application).kill(
    f.tenantId,
    { role: 'PLATFORM_OPERATOR', ref: 'operator-on-other-instance' },
    'DUPLICATE_ORIGINATE',
  );

  assert.equal(await barrier.originateCampaignTarget(f.tenantId, target.id, 'c1'), 'GATE_CLOSED');
  assert.equal(transport.calls, 0);
});

test('Governance ตอบไม่ได้ fail closed โดยไม่จองและไม่เปลี่ยน owner state', async (t) => {
  const f = await fixture(t);
  const { port } = scriptedGovernance(new ContactGovernanceService(f.application), {
    authorize: () => Promise.reject(new Error('governance database unavailable')),
  });
  const transport = new CountingTransport();
  const barrier = new DialerOriginateBarrier(
    f.application,
    port,
    allowAllScope,
    await openScopedGate(f),
    { transport },
  );
  const target = await admittedTarget(f);
  const callback = await scheduledCallback(f);

  assert.equal(
    await barrier.originateCampaignTarget(f.tenantId, target.id, 'c1'),
    'GOVERNANCE_UNAVAILABLE',
  );
  assert.equal(
    await barrier.originateCallback(f.tenantId, callback.id, 'c2'),
    'GOVERNANCE_UNAVAILABLE',
  );
  assert.equal(transport.calls, 0);
  assert.equal(
    (await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } })).state,
    'ADMITTED',
  );
  assert.equal(
    (await f.owner.obCallback.findUniqueOrThrow({ where: { id: callback.id } })).state,
    'SCHEDULED',
  );
});

test('Governance BLOCK/DEFER/REVIEW หยุดก่อน provider boundary ทุกผล', async (t) => {
  const f = await fixture(t);
  const gate = await openScopedGate(f);
  for (const [decision, expected] of [
    ['BLOCK', 'GOVERNANCE_BLOCKED'],
    ['DEFER', 'GOVERNANCE_DEFERRED'],
    ['REVIEW', 'GOVERNANCE_REVIEW'],
  ] as const) {
    const { port } = scriptedGovernance(new ContactGovernanceService(f.application), {
      authorize: async () =>
        ({ decision, reasonCode: `SCRIPTED_${decision}` }) as unknown as AuthorizationOutcome,
    });
    const transport = new CountingTransport();
    const barrier = new DialerOriginateBarrier(f.application, port, allowAllScope, gate, {
      transport,
    });
    const target = await admittedTarget(f);
    const callback = await scheduledCallback(f);

    assert.equal(await barrier.originateCampaignTarget(f.tenantId, target.id, 'c1'), expected);
    assert.equal(await barrier.originateCallback(f.tenantId, callback.id, 'c2'), expected);
    assert.equal(transport.calls, 0, `${decision} ต้องไม่ถึง transport`);
    assert.equal(
      (await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } })).state,
      'DEFERRED',
    );
    assert.equal(
      (await f.owner.obCallback.findUniqueOrThrow({ where: { id: callback.id } })).state,
      'SCHEDULED',
    );
    await f.owner.obCampaignTarget.delete({ where: { id: target.id } });
    await f.owner.obCallback.delete({ where: { id: callback.id } });
  }
});

test('reservation ที่ถูก invalidate ระหว่างจองกับ claim ถอยกลับโดยไม่มี provider I/O', async (t) => {
  const f = await fixture(t);
  const { port, calls } = scriptedGovernance(new ContactGovernanceService(f.application), {
    claim: () => Promise.reject(new ReservationBindingError('RESERVATION_NOT_RESERVED')),
  });
  const transport = new CountingTransport();
  const barrier = new DialerOriginateBarrier(
    f.application,
    port,
    allowAllScope,
    await openScopedGate(f),
    { transport },
  );
  const target = await admittedTarget(f);
  const callback = await scheduledCallback(f);

  assert.equal(
    await barrier.originateCampaignTarget(f.tenantId, target.id, 'c1'),
    'RESERVATION_INVALIDATED',
  );
  assert.equal(
    await barrier.originateCallback(f.tenantId, callback.id, 'c2'),
    'RESERVATION_INVALIDATED',
  );
  assert.equal(calls.claim, 2);
  assert.equal(transport.calls, 0);
  const settledTarget = await f.owner.obCampaignTarget.findUniqueOrThrow({
    where: { id: target.id },
  });
  assert.equal(settledTarget.state, 'DEFERRED');
  assert.equal(settledTarget.originateLeaseExpiresAt, null, 'ห้ามค้าง ORIGINATING ให้ sweeper');
  const settledCallback = await f.owner.obCallback.findUniqueOrThrow({
    where: { id: callback.id },
  });
  assert.equal(settledCallback.state, 'SCHEDULED');
  assert.equal(settledCallback.originateLeaseExpiresAt, null);
});

test('CG4 scoped kill switch ของ Governance มีผลเหนือ Dialer originate แม้ gate ของ Dialer เปิดอยู่', async (t) => {
  const f = await fixture(t);
  await f.owner.cg4ScopeKillSwitch.create({
    data: {
      tenantId: f.tenantId,
      scopeKey: `contact:${f.contactId}`,
      reasonCode: 'INCIDENT_CONTAINMENT',
      evidenceRef: 'incident-1',
      activatedByRef: 'compliance-1',
      activatedAt: new Date(),
    },
  });
  const transport = new CountingTransport();
  const barrier = new DialerOriginateBarrier(
    f.application,
    new ContactGovernanceService(f.application),
    allowAllScope,
    await openScopedGate(f),
    { transport },
  );
  const target = await admittedTarget(f);
  const callback = await scheduledCallback(f);

  assert.equal(
    await barrier.originateCampaignTarget(f.tenantId, target.id, 'c1'),
    'GOVERNANCE_REVIEW',
  );
  assert.equal(await barrier.originateCallback(f.tenantId, callback.id, 'c2'), 'GOVERNANCE_REVIEW');
  assert.equal(transport.calls, 0);
  assert.equal(
    await f.owner.cgReservation.count({ where: { tenantId: f.tenantId, state: 'RESERVED' } }),
    0,
  );
});
