/**
 * J2.9 follow-up — compatibility profile conformance.
 *
 * `DialerOriginateBarrier` ผูกกับ `ContactGovernancePort` ซึ่งเป็น interface เท่านั้น
 * แต่เดิมพิสูจน์ได้แค่เชิงโครงสร้าง (compile ผ่าน) ยังไม่เคยมี test ยืนยันว่า *พฤติกรรม*
 * ของ barrier เหมือนกันจริงเมื่อสลับ implementation
 *
 * ไฟล์นี้รัน scenario ชุดเดียวกันผ่านสอง profile ที่ #137 ระบุไว้:
 *   - `TEST_ADAPTER`    -> `ContactGovernanceFake` (ใช้ตอน S1 ยังไม่ merge)
 *   - `CG3_INTEGRATED`  -> `ContactGovernanceService` ตัวจริงบน Postgres
 * แล้ว assert ว่าได้ `OriginateOutcome` และ terminal state ตรงกันทุกช่อง ไม่ใช่แค่
 * ตรวจทีละ profile แยกกัน — ถ้า implementation ไหน drift ออกจากสัญญา test นี้จะจับได้
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import {
  tenantId as toTenantId,
  type ContactGovernancePort,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import { ContactGovernanceFake } from '@d-contact/cxa-contracts/testing/contact-governance-fake.js';
import { CampaignFixtures } from './campaign-fixtures.js';
import { DialerOriginateBarrier, type OriginateOutcome } from './dialer-originate-barrier.js';
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

const SENDER_IDENTITY = 'dialer-originate-test-adapter';

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
      name: `J2.9 conformance ${suffix}`,
      slug: `j2-9-conf-${suffix}`,
      sipDomain: `${suffix}.j2-9-conf.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Dialer' } });
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'J2.9 contact' } });
  await owner.queue.create({
    data: { id: queueId, tenantId, name: 'Collections', channels: ['VOICE'] },
  });
  for (const purpose of ['CAMPAIGN_OUTREACH', 'CALLBACK_OUTREACH'] as const) {
    await owner.cgConsent.create({
      data: {
        tenantId,
        contactId,
        purpose,
        channel: 'VOICE',
        status: 'GRANTED',
        lawfulBasis: 'CONSENT',
        evidence: { source: 'integration-test' },
        grantedAt: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
    });
  }

  const campaignId = randomUUID();
  await new CampaignFixtures(application).upsertCampaign({
    tenantId,
    id: campaignId,
    key: 'campaign-1',
    status: 'ACTIVE',
  });

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

type Fixture = Awaited<ReturnType<typeof fixture>>;

interface SeedRequest {
  actionKey: string;
  sourceId: string;
  purpose: 'CAMPAIGN_OUTREACH' | 'CALLBACK_OUTREACH';
}

/**
 * profile หนึ่งตัวคือ "วิธีได้มาซึ่ง ContactGovernancePort" บวก "วิธีทำให้ ALLOW"
 * — `CG3_INTEGRATED` ใช้ consent จริงใน DB จึงไม่ต้อง seed อะไรเพิ่ม
 */
interface GovernanceProfile {
  readonly name: 'TEST_ADAPTER' | 'CG3_INTEGRATED';
  create(f: Fixture): ContactGovernancePort;
  allow(port: ContactGovernancePort, f: Fixture, request: SeedRequest): void;
}

const testAdapterProfile: GovernanceProfile = {
  name: 'TEST_ADAPTER',
  create: () => new ContactGovernanceFake(() => Date.now()),
  allow(port, f, request) {
    (port as ContactGovernanceFake).seed(
      toTenantId(f.tenantId),
      {
        channel: 'VOICE',
        purpose: request.purpose,
        source: 'DIALER_ORIGINATE',
        sourceId: request.sourceId,
        actionKey: request.actionKey,
        policyVersion: 1,
        contactId: f.contactId,
      },
      {
        decisionId: randomUUID(),
        decision: 'ALLOW',
        reasonCode: 'CONSENT_GRANTED',
        policyVersion: 1,
        trace: [],
        reservationId: randomUUID(),
        reservationExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
      true,
      SENDER_IDENTITY,
    );
  },
};

const cg3IntegratedProfile: GovernanceProfile = {
  name: 'CG3_INTEGRATED',
  create: (f) => new ContactGovernanceService(f.application),
  allow: () => undefined,
};

const PROFILES = [testAdapterProfile, cg3IntegratedProfile];

function openGate(tenantId: string): DialerOwnerBarrierGate {
  const gate = new DialerOwnerBarrierGate();
  gate.propose(tenantId, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(tenantId, 'COMPLIANCE');
  gate.propose(tenantId, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(tenantId, 'COMPLIANCE');
  return gate;
}

function admittedTarget(f: Fixture) {
  return f.owner.obCampaignTarget.create({
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
}

function scheduledCallback(f: Fixture) {
  return f.owner.obCallback.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      contactId: f.contactId,
      queueId: f.queueId,
      requestedFor: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60 * 60_000),
      sourceOwnerTeamId: f.teamId,
      targetOwnerTeamId: f.teamId,
    },
  });
}

/** ผลลัพธ์ที่ต้องตรงกันข้าม profile — outcome ที่ barrier คืน บวก state สุดท้ายในตาราง owner */
interface ScenarioResult {
  outcome: OriginateOutcome;
  terminalState: string;
  leaseCleared: boolean;
}

type Scenario = {
  name: string;
  /**
   * ผลที่ถูกต้องจริง ๆ — ต้องมีคู่กับการเทียบข้าม profile เสมอ ไม่งั้น test จะผ่าน
   * แม้ทั้งสอง implementation พังเหมือนกัน (เช่นคืน GATE_CLOSED หมดทุก scenario)
   */
  expected: ScenarioResult;
  run(f: Fixture, profile: GovernanceProfile): Promise<ScenarioResult>;
};

const SCENARIOS: Scenario[] = [
  {
    name: 'campaign target ที่ผ่าน scope+governance originate สำเร็จ',
    expected: { outcome: 'ORIGINATED', terminalState: 'CONSUMED', leaseCleared: true },
    async run(f, profile) {
      const target = await admittedTarget(f);
      const port = profile.create(f);
      profile.allow(port, f, {
        actionKey: `originate:campaign-target:${target.id}`,
        sourceId: target.id,
        purpose: 'CAMPAIGN_OUTREACH',
      });
      const barrier = new DialerOriginateBarrier(
        f.application,
        port,
        allowAllScope,
        openGate(f.tenantId),
        { transport: new ScriptedTelephonyTransport() },
      );
      const outcome = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
      const row = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
      return {
        outcome,
        terminalState: row.state,
        leaseCleared: row.originateLeaseExpiresAt === null,
      };
    },
  },
  {
    name: 'TEST_ADAPTER ตอบ REJECTED แล้ว target กลับไป DEFERRED',
    expected: { outcome: 'REJECTED', terminalState: 'DEFERRED', leaseCleared: true },
    async run(f, profile) {
      const target = await admittedTarget(f);
      const port = profile.create(f);
      profile.allow(port, f, {
        actionKey: `originate:campaign-target:${target.id}`,
        sourceId: target.id,
        purpose: 'CAMPAIGN_OUTREACH',
      });
      const transport = new ScriptedTelephonyTransport();
      transport.script(target.id, { status: 'REJECTED', reasonCode: 'TEST_ADAPTER_REJECTED' });
      const barrier = new DialerOriginateBarrier(
        f.application,
        port,
        allowAllScope,
        openGate(f.tenantId),
        { transport },
      );
      const outcome = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
      const row = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
      return {
        outcome,
        terminalState: row.state,
        leaseCleared: row.originateLeaseExpiresAt === null,
      };
    },
  },
  {
    name: 'callback ที่ถึงเวลาแล้ว originate สำเร็จ',
    expected: { outcome: 'ORIGINATED', terminalState: 'CONSUMED', leaseCleared: true },
    async run(f, profile) {
      const callback = await scheduledCallback(f);
      const port = profile.create(f);
      profile.allow(port, f, {
        actionKey: `originate:callback:${callback.id}`,
        sourceId: callback.id,
        purpose: 'CALLBACK_OUTREACH',
      });
      const barrier = new DialerOriginateBarrier(
        f.application,
        port,
        allowAllScope,
        openGate(f.tenantId),
        { transport: new ScriptedTelephonyTransport() },
      );
      const outcome = await barrier.originateCallback(f.tenantId, callback.id, 'corr-1');
      const row = await f.owner.obCallback.findUniqueOrThrow({ where: { id: callback.id } });
      return {
        outcome,
        terminalState: row.state,
        leaseCleared: row.originateLeaseExpiresAt === null,
      };
    },
  },
  {
    name: 'scope ที่ deny หยุดก่อนถึง governance',
    expected: { outcome: 'SCOPE_DENIED', terminalState: 'DEFERRED', leaseCleared: true },
    async run(f, profile) {
      const target = await admittedTarget(f);
      const barrier = new DialerOriginateBarrier(
        f.application,
        profile.create(f),
        denyAllScope,
        openGate(f.tenantId),
        { transport: new ScriptedTelephonyTransport() },
      );
      const outcome = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
      const row = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
      return {
        outcome,
        terminalState: row.state,
        leaseCleared: row.originateLeaseExpiresAt === null,
      };
    },
  },
  {
    name: 'gate ปิดอยู่ ปฏิเสธก่อนแตะอะไรเลย',
    expected: { outcome: 'GATE_CLOSED', terminalState: 'ADMITTED', leaseCleared: true },
    async run(f, profile) {
      const target = await admittedTarget(f);
      const barrier = new DialerOriginateBarrier(
        f.application,
        profile.create(f),
        allowAllScope,
        new DialerOwnerBarrierGate(),
        { transport: new ScriptedTelephonyTransport() },
      );
      const outcome = await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1');
      const row = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
      return {
        outcome,
        terminalState: row.state,
        leaseCleared: row.originateLeaseExpiresAt === null,
      };
    },
  },
];

for (const scenario of SCENARIOS) {
  test(`conformance: ${scenario.name} — TEST_ADAPTER และ CG3_INTEGRATED ให้ผลเหมือนกัน`, async (t) => {
    const results = new Map<GovernanceProfile['name'], ScenarioResult>();
    for (const profile of PROFILES) {
      // tenant แยกต่อ profile เพื่อไม่ให้ reservation ของรอบแรกไปชนกับรอบสอง
      const f = await fixture(t);
      const result = await scenario.run(f, profile);
      // ตรวจค่าจริงก่อน แล้วค่อยเทียบข้าม profile — กัน false pass ตอนพังเหมือนกันทั้งคู่
      assert.deepEqual(result, scenario.expected, `profile ${profile.name} ให้ผลไม่ตรงที่ควรเป็น`);
      results.set(profile.name, result);
    }

    assert.deepEqual(
      results.get('TEST_ADAPTER'),
      results.get('CG3_INTEGRATED'),
      `พฤติกรรม barrier ต่างกันระหว่าง profile: ${JSON.stringify([...results])}`,
    );
  });
}

test('ทุก profile ที่ประกาศไว้ถูกทดสอบจริง — กันการเพิ่ม profile แล้วลืมเขียน conformance', () => {
  assert.deepEqual(
    PROFILES.map((p) => p.name).sort(),
    ['CG3_INTEGRATED', 'TEST_ADAPTER'],
  );
});
