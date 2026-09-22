/**
 * S2.3 (#367) acceptance: durable control plane บน Postgres จริงด้วย application role (RLS ทำงาน)
 *
 * ครอบคลุม `S2-LINE-AU01` (authority/approval/one-shot), `S2-LINE-CC01` (cap/concurrency/kill)
 * และ negative checks ฝั่ง TI/RC/OB: tenant isolation, restart, worker race, cap reservation,
 * kill latch, credential rotation และ quota ที่ fail closed
 *
 * ไม่มี network, ไม่มี LINE SDK, ไม่มี credential value และไม่มี PII — ทุกค่าเป็น fixture สังเคราะห์
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { DlLineCredentialRef, DlLineScopeGate } from '@d-contact/db';
import { LINE_PILOT_CAPS } from '@d-contact/cxa-contracts';
import {
  LineControlPlane,
  type LineControlActor,
  type LineControlOutcome,
  type LineRunResult,
} from './line-control-plane.js';
import { LineControlAuthorizationError, type LineQuotaSnapshot } from './line-control-policy.js';
import type { LineGateScope } from './line-control-repository.js';
import { assertRedactedPayload } from './line-credential-boundary.js';
import {
  createLinePersistenceFixture,
  digest,
  PILOT_CHANNEL_ACCOUNT_ID,
  type LinePersistenceFixture,
} from './line-persistence-fixture.js';

async function fixture(t: TestContext): Promise<LinePersistenceFixture> {
  const context = await createLinePersistenceFixture();
  t.after(() => context.dispose());
  return context;
}

const T0 = new Date('2026-09-22T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const DAY_MINUTES = 24 * 60;

const CONFIG_DIGEST = digest('s2.3-config-v1');
const CONTENT_DIGEST = digest('s2.3-content-v1');
const CONTENT_REF = 'fixture:service-notification/v1';

const operator: LineControlActor = { role: 'PLATFORM_OPERATOR', ref: 'platform-operator-1' };
const tenantAdmin: LineControlActor = { role: 'TENANT_ADMIN', ref: 'tenant-admin-1' };
const compliance: LineControlActor = { role: 'COMPLIANCE', ref: 'compliance-1' };

function quotaAt(minutes: number, totalUsage = 1): LineQuotaSnapshot {
  return { type: 'limited', targetLimit: 500, totalUsage, observedAt: at(minutes) };
}

/** ดึงค่าจาก outcome ที่ต้องสำเร็จ — ล้มที่นี่แปลว่า precondition ของเทสต์เองพัง */
function applied<T>(outcome: LineControlOutcome<T>, label: string): T {
  assert.equal(outcome.status, 'APPLIED', `${label}: ${JSON.stringify(outcome)}`);
  return (outcome as { status: 'APPLIED'; value: T }).value;
}

function denial(result: LineRunResult | { status: string; code?: string }): string {
  assert.equal(result.status, 'DENIED', JSON.stringify(result));
  return (result as { code: string }).code;
}

interface Pilot {
  plane: LineControlPlane;
  scope: LineGateScope;
  gate: DlLineScopeGate;
  credential: DlLineCredentialRef;
  tenantId: string;
}

/**
 * พา scope หนึ่งจาก DISABLED ไปจนถึง CAPPED_PILOT ด้วยคำสั่งจริงของ control plane เท่านั้น
 * (ไม่มีการเขียนตารางตรง ๆ) — ลำดับนี้คือ deploy order ของ #358 §A/§E
 */
async function bootstrapPilot(
  context: LinePersistenceFixture,
  tenantId: string,
  options: {
    credentialVersion?: number;
    state?: 'DRY_RUN' | 'PROVIDER_CONFORMANCE' | 'CAPPED_PILOT';
  } = {},
): Promise<Pilot> {
  const plane = new LineControlPlane({ control: context.control, audit: context.audit });
  const scope = context.scope(tenantId);
  const target = options.state ?? 'CAPPED_PILOT';
  let gate = await plane.ensureScope(operator, scope);
  gate = applied(await plane.advanceState(compliance, gate, 'DRY_RUN', null, at(0)), 'DRY_RUN');
  if (target !== 'DRY_RUN') {
    gate = applied(
      await plane.advanceState(compliance, gate, 'PROVIDER_CONFORMANCE', CONFIG_DIGEST, at(0)),
      'PROVIDER_CONFORMANCE',
    );
  }
  if (target === 'CAPPED_PILOT') {
    gate = applied(
      await plane.advanceState(compliance, gate, 'CAPPED_PILOT', null, at(0)),
      'CAPPED_PILOT',
    );
  }
  gate = applied(await plane.setTechnicalSwitch(operator, gate, true, at(0)), 'switch');

  const candidate = await plane.registerCredential(
    operator,
    {
      tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
      version: options.credentialVersion ?? 1,
      keychainService: 'd-contact.line.2007056595',
      keychainAccount: 'channel-access-token',
      fingerprint: digest(`fingerprint-${tenantId}-${options.credentialVersion ?? 1}`),
      issuedAt: new Date('2026-09-22T00:00:00.000Z'),
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
    },
    at(0),
  );
  const credential = applied(
    await plane.verifyAndActivateCredential(
      operator,
      tenantId,
      candidate.id,
      { channelAccountId: PILOT_CHANNEL_ACCOUNT_ID, verifiedAt: at(0) },
      at(0),
    ),
    'activate',
  );
  return { plane, scope, gate, credential, tenantId };
}

/** allowlist + proposal + approval สองชั้น สำหรับ recipient หนึ่งราย */
async function approveRunFor(
  pilot: Pilot,
  label: string,
  recipientFingerprint: string,
  proposedAt: Date,
) {
  // tuple เดียวมีได้แถวเดียวตาม unique index — recipient เดิมใช้ allowlist ใบเดิมเสมอ
  const allowlistEntry =
    (await pilot.plane.findAllowlistEntry(
      pilot.tenantId,
      pilot.gate.id,
      recipientFingerprint,
      CONTENT_DIGEST,
      CONFIG_DIGEST,
    )) ??
    (await pilot.plane.registerAllowlistEntry(
      tenantAdmin,
      {
        tenantId: pilot.tenantId,
        gateId: pilot.gate.id,
        scope: pilot.scope,
        recipientFingerprint,
        recipientProtectedRef: `prot:recipient:${randomUUID()}`,
        contentRef: CONTENT_REF,
        contentDigest: CONTENT_DIGEST,
        configDigest: CONFIG_DIGEST,
        validFrom: at(-60),
        validUntil: at(90 * DAY_MINUTES),
        approvalAuditRef: `audit:allowlist:${label}`,
      },
      proposedAt,
    ));
  const proposed = applied(
    await pilot.plane.proposeRun(
      operator,
      {
        tenantId: pilot.tenantId,
        gate: pilot.gate,
        allowlistEntry,
        credential: pilot.credential,
        proposalRef: `run-${label}`,
        proposedAt,
      },
      proposedAt,
    ),
    `propose ${label}`,
  );
  applied(
    await pilot.plane.approveRun(tenantAdmin, pilot.tenantId, proposed.id, proposedAt),
    `approve tenant ${label}`,
  );
  const run = applied(
    await pilot.plane.approveRun(compliance, pilot.tenantId, proposed.id, proposedAt),
    `approve compliance ${label}`,
  );
  return { allowlistEntry, run };
}

function beginCommand(
  pilot: Pilot,
  runAuthorizationId: string,
  deliveryId: string,
  recipientFingerprint: string,
  minutes: number,
) {
  return {
    tenantId: pilot.tenantId,
    scope: pilot.scope,
    runAuthorizationId,
    deliveryId,
    recipientFingerprint,
    contentDigest: CONTENT_DIGEST,
    configDigest: CONFIG_DIGEST,
    quota: quotaAt(minutes),
    at: at(minutes),
  };
}

// ── Rollout ladder (#358 §A) ─────────────────────────────────────────────────

test('ladder: แต่ละขั้นเปิดสิทธิ์เพิ่มทีละชั้น และ scope ที่ไม่มี gate ตอบ generic เสมอ', async (t) => {
  const context = await fixture(t);
  const plane = new LineControlPlane({ control: context.control, audit: context.audit });

  // ยังไม่มี gate เลย: ไม่บอกว่า tenant/scope นี้มีอยู่จริงหรือไม่
  assert.equal(
    denial(
      await plane.evaluate({
        scope: context.scope(context.tenantB),
        operation: 'LOCAL_VALIDATION',
        at: at(0),
      }),
    ),
    'LINE_GATE_SCOPE_NOT_ALLOWED',
  );

  const pilot = await bootstrapPilot(context, context.tenantA, { state: 'DRY_RUN' });
  const check = async (operation: 'LOCAL_VALIDATION' | 'TOKEN_VERIFY' | 'PUSH') =>
    plane.evaluate({
      scope: pilot.scope,
      operation,
      at: at(1),
      configDigest: CONFIG_DIGEST,
      quota: quotaAt(1),
    });

  assert.equal((await check('LOCAL_VALIDATION')).status, 'ALLOWED');
  assert.equal(denial(await check('TOKEN_VERIFY')), 'LINE_GATE_AUTHORIZATION_DENIED');
  assert.equal(denial(await check('PUSH')), 'LINE_GATE_AUTHORIZATION_DENIED');

  // DRY_RUN ตรวจ allowlist จริง ต่างกันแค่ไม่มี network: recipient ที่ไม่มีใน allowlist ถูกปฏิเสธ
  const dryRun = (recipientFingerprint: string) =>
    plane.evaluate({
      scope: pilot.scope,
      operation: 'LOCAL_VALIDATION',
      at: at(1),
      configDigest: CONFIG_DIGEST,
      recipientFingerprint,
      contentDigest: CONTENT_DIGEST,
    });
  const recipient = digest('r-ladder');
  assert.equal(denial(await dryRun(recipient)), 'LINE_GATE_SCOPE_NOT_ALLOWED');
  await plane.registerAllowlistEntry(
    tenantAdmin,
    {
      tenantId: pilot.tenantId,
      gateId: pilot.gate.id,
      scope: pilot.scope,
      recipientFingerprint: recipient,
      recipientProtectedRef: `prot:recipient:${randomUUID()}`,
      contentRef: CONTENT_REF,
      contentDigest: CONTENT_DIGEST,
      configDigest: CONFIG_DIGEST,
      validFrom: at(-60),
      validUntil: at(DAY_MINUTES),
      approvalAuditRef: 'audit:allowlist:ladder',
    },
    at(1),
  );
  assert.equal((await dryRun(recipient)).status, 'ALLOWED');
  assert.equal(denial(await dryRun(digest('r-ladder-other'))), 'LINE_GATE_SCOPE_NOT_ALLOWED');

  let gate = (await plane.findGate(pilot.scope))!;
  gate = applied(
    await plane.advanceState(compliance, gate, 'PROVIDER_CONFORMANCE', CONFIG_DIGEST, at(1)),
    'conformance',
  );
  assert.equal((await check('TOKEN_VERIFY')).status, 'ALLOWED');
  assert.equal(
    denial(await check('PUSH')),
    'LINE_GATE_AUTHORIZATION_DENIED',
    'conformance ยังห้าม push',
  );

  // ข้ามขั้นไม่ได้ และปิด switch แล้วทุกอย่างกลับเป็นปิดทันที
  assert.equal(
    denial(await plane.advanceState(compliance, gate, 'DISABLED', null, at(2))),
    'LINE_GATE_INVALID_TRANSITION',
  );
  gate = applied(await plane.setTechnicalSwitch(operator, gate, false, at(2)), 'switch off');
  assert.equal(denial(await check('LOCAL_VALIDATION')), 'LINE_GATE_TECHNICAL_SWITCH_OFF');

  // CAS: ใช้ version เก่าเขียนทับไม่ได้ ต้องอ่านใหม่ก่อนเสมอ
  const stale = await plane.setTechnicalSwitch(
    operator,
    { ...gate, version: gate.version - 1 },
    true,
    at(3),
  );
  assert.equal(stale.status, 'STALE');
});

// ── Authority (#358 §E) — S2-LINE-AU01 ───────────────────────────────────────

test('authority: role ผิดถูกปฏิเสธก่อนแตะ state และผู้เสนอ approve ตัวเองไม่ได้', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);

  await assert.rejects(
    pilot.plane.advanceState(operator, pilot.gate, 'DRY_RUN', null, at(1)),
    LineControlAuthorizationError,
  );
  await assert.rejects(
    pilot.plane.setTechnicalSwitch(compliance, pilot.gate, true, at(1)),
    LineControlAuthorizationError,
  );
  await assert.rejects(
    pilot.plane.registerAllowlistEntry(
      operator,
      {
        tenantId: pilot.tenantId,
        gateId: pilot.gate.id,
        scope: pilot.scope,
        recipientFingerprint: digest('r-authority'),
        recipientProtectedRef: `prot:recipient:${randomUUID()}`,
        contentRef: CONTENT_REF,
        contentDigest: CONTENT_DIGEST,
        configDigest: CONFIG_DIGEST,
        validFrom: at(-60),
        validUntil: at(DAY_MINUTES),
        approvalAuditRef: 'audit:allowlist:authority',
      },
      at(1),
    ),
    LineControlAuthorizationError,
  );

  const { run } = await approveRunFor(pilot, 'authority', digest('r-authority-2'), at(1));
  await assert.rejects(
    pilot.plane.approveRun(operator, pilot.tenantId, run.id, at(2)),
    LineControlAuthorizationError,
    'ผู้ execute ไม่มีสิทธิ์ approve',
  );
  await assert.rejects(
    pilot.plane.beginRun(compliance, beginCommand(pilot, run.id, 'dlv_none', digest('r'), 2)),
    LineControlAuthorizationError,
    'Compliance ไม่ใช่ผู้ execute',
  );

  // ผู้เสนอสวมหมวก Tenant Admin มา approve ใบของตัวเองไม่ได้
  const selfApproval = await pilot.plane.approveRun(
    { role: 'TENANT_ADMIN', ref: operator.ref },
    pilot.tenantId,
    run.id,
    at(2),
  );
  assert.equal(denial(selfApproval), 'LINE_GATE_AUTHORIZATION_DENIED');
});

test('authority: คนเดียวถือสอง role ได้ แต่ต้องยืนยันสองครั้งแยกกัน', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const allowlistEntry = await pilot.plane.registerAllowlistEntry(
    tenantAdmin,
    {
      tenantId: pilot.tenantId,
      gateId: pilot.gate.id,
      scope: pilot.scope,
      recipientFingerprint: digest('r-dual'),
      recipientProtectedRef: `prot:recipient:${randomUUID()}`,
      contentRef: CONTENT_REF,
      contentDigest: CONTENT_DIGEST,
      configDigest: CONFIG_DIGEST,
      validFrom: at(-60),
      validUntil: at(DAY_MINUTES),
      approvalAuditRef: 'audit:allowlist:dual',
    },
    at(1),
  );
  const run = applied(
    await pilot.plane.proposeRun(
      operator,
      {
        tenantId: pilot.tenantId,
        gate: pilot.gate,
        allowlistEntry,
        credential: pilot.credential,
        proposalRef: 'run-dual',
        proposedAt: at(1),
      },
      at(1),
    ),
    'propose',
  );

  const human = 'local-pilot-human';
  const first = applied(
    await pilot.plane.approveRun(
      { role: 'TENANT_ADMIN', ref: human },
      pilot.tenantId,
      run.id,
      at(2),
    ),
    'tenant admin',
  );
  assert.equal(first.state, 'PROPOSED', 'อนุมัติชั้นเดียวยังไม่พอ');
  const second = applied(
    await pilot.plane.approveRun({ role: 'COMPLIANCE', ref: human }, pilot.tenantId, run.id, at(3)),
    'compliance',
  );
  assert.equal(second.state, 'APPROVED');
  // ยืนยันซ้ำ role เดิมไม่เพิ่มอะไร
  assert.equal(
    (
      await pilot.plane.approveRun(
        { role: 'COMPLIANCE', ref: human },
        pilot.tenantId,
        run.id,
        at(4),
      )
    ).status,
    'DENIED',
  );
});

// ── Exact allowlist (#358 §B) ────────────────────────────────────────────────

test('allowlist: recipient/content ที่ไม่ตรงถูกปฏิเสธและ kill scope ทันที', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-exact');
  const { run } = await approveRunFor(pilot, 'exact', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);

  const wrongRecipient = await pilot.plane.beginRun(operator, {
    ...beginCommand(pilot, run.id, delivery.deliveryId, digest('r-other'), 2),
  });
  assert.equal(denial(wrongRecipient), 'LINE_GATE_SCOPE_NOT_ALLOWED');
  const killed = (await pilot.plane.findGate(pilot.scope))!;
  assert.equal(killed.killed, true);
  assert.equal(killed.killReason, 'ALLOWLIST_BINDING_MISMATCH');
  assert.equal(killed.technicalSwitchOn, false, 'kill ปิด switch ในแถวเดียวกัน');

  // authorization ยังไม่ถูกใช้: binding ไม่ผ่านตั้งแต่ก่อน consume
  const stillApproved = await context.control.findRun(pilot.tenantId, run.id);
  assert.equal(stillApproved?.state, 'APPROVED');
});

test('allowlist: revoke หรือหมดอายุ = ปฏิเสธแบบ generic โดยไม่ kill', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-revoke');
  const { allowlistEntry, run } = await approveRunFor(pilot, 'revoke', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);

  assert.equal(
    await pilot.plane.revokeAllowlistEntry(
      compliance,
      pilot.tenantId,
      allowlistEntry.id,
      'PILOT_ROLLBACK',
      at(2),
    ),
    true,
  );
  const result = await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 3),
  );
  assert.equal(denial(result), 'LINE_GATE_SCOPE_NOT_ALLOWED');
  assert.equal((await pilot.plane.findGate(pilot.scope))!.killed, false, 'revoke ปกติไม่ใช่ kill');
  // revoke ซ้ำไม่ได้ และ tuple ที่อนุมัติแล้วแก้ไม่ได้
  assert.equal(
    await pilot.plane.revokeAllowlistEntry(
      compliance,
      pilot.tenantId,
      allowlistEntry.id,
      'PILOT_ROLLBACK',
      at(4),
    ),
    false,
  );
});

// ── One-shot run authorization — S2-LINE-AU01 ────────────────────────────────

test('one-shot: worker ห้าตัวแย่ง authorization เดียวได้ผู้ชนะหนึ่งตัว', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-race');
  const { run } = await approveRunFor(pilot, 'race', recipient, at(1));
  const deliveries = await Promise.all(
    Array.from({ length: 5 }, () => context.seedDelivery(pilot.tenantId)),
  );

  const results = await Promise.all(
    deliveries.map((delivery) =>
      pilot.plane.beginRun(
        operator,
        beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2),
      ),
    ),
  );
  const authorized = results.filter((result) => result.status === 'AUTHORIZED');
  assert.equal(authorized.length, 1);
  for (const result of results.filter((item) => item.status === 'DENIED')) {
    assert.equal(denial(result), 'RUN_AUTHORIZATION_CONSUMED');
  }

  const consumed = await context.control.findRun(pilot.tenantId, run.id);
  assert.equal(consumed?.state, 'CONSUMED');
  assert.equal(
    consumed?.consumedDeliveryId,
    (authorized[0] as { logicalDelivery: { deliveryId: string } }).logicalDelivery.deliveryId,
  );
  // ledger มีหน่วย logical delivery ของผู้ชนะใบเดียว
  const ledger = await context.control.listActiveCapEntries(
    pilot.tenantId,
    pilot.gate.id,
    'LOGICAL_DELIVERY',
  );
  assert.equal(ledger.length, 1);
});

test('restart: instance ใหม่ replay delivery เดิมได้ผลเดิม ไม่ consume ซ้ำและไม่จองเพิ่ม', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-restart');
  const { run } = await approveRunFor(pilot, 'restart', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);

  const first = await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2),
  );
  assert.equal(first.status, 'AUTHORIZED');

  // process ใหม่: state ทั้งหมดต้องมาจาก Postgres ไม่มีอะไรค้างใน memory ของ instance เดิม
  const restarted = new LineControlPlane({ control: context.control, audit: context.audit });
  const replay = await restarted.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 5),
  );
  assert.equal(replay.status, 'AUTHORIZED');
  assert.equal((replay as { barrier: string }).barrier, 'PRE');
  assert.equal(
    (await context.control.listActiveCapEntries(pilot.tenantId, pilot.gate.id, 'LOGICAL_DELIVERY'))
      .length,
    1,
    'replay ต้องไม่จองหน่วยเพิ่ม',
  );

  // ข้าม barrier แล้ว restart อีกครั้ง: ได้สิทธิ์เดิมแต่เป็น POST — ต้องไป reconcile ไม่ใช่ส่งใหม่
  assert.equal(await restarted.commitDelivery(pilot.tenantId, delivery.deliveryId, at(6)), true);
  const afterBarrier = await restarted.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 7),
  );
  assert.equal(afterBarrier.status, 'AUTHORIZED');
  assert.equal((afterBarrier as { barrier: string }).barrier, 'POST');
  assert.equal((afterBarrier as { concurrencySlot?: unknown }).concurrencySlot, undefined);
});

// ── Caps (#358 §C) — S2-LINE-CC01 ────────────────────────────────────────────

test('cap: 1/recipient/24h และ 3/24h นับจาก ledger และคืนสิทธิ์เมื่อพ้นหน้าต่าง', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);

  const send = async (label: string, recipient: string, minutes: number) => {
    const { run } = await approveRunFor(pilot, label, recipient, at(minutes));
    const delivery = await context.seedDelivery(pilot.tenantId);
    const result = await pilot.plane.beginRun(
      operator,
      beginCommand(pilot, run.id, delivery.deliveryId, recipient, minutes),
    );
    if (result.status === 'AUTHORIZED') {
      await pilot.plane.commitDelivery(pilot.tenantId, delivery.deliveryId, at(minutes));
    }
    return result;
  };

  const first = digest('r-window-1');
  assert.equal((await send('w1', first, 1)).status, 'AUTHORIZED');
  // recipient เดิมภายใน 24 ชม. ถูกปฏิเสธก่อน cap ของวัน
  assert.equal(denial(await send('w1b', first, 2)), 'CONTACT_WINDOW_CAP_EXCEEDED');

  assert.equal((await send('w2', digest('r-window-2'), 3)).status, 'AUTHORIZED');
  assert.equal((await send('w3', digest('r-window-3'), 4)).status, 'AUTHORIZED');
  assert.equal(
    denial(await send('w4', digest('r-window-4'), 5)),
    'SUBMISSION_WINDOW_CAP_EXCEEDED',
    `เกิน ${LINE_PILOT_CAPS.logicalDeliveriesPer24h}/24h`,
  );

  // พ้น 24 ชม. หน้าต่างเลื่อน: recipient เดิมส่งได้อีกครั้ง
  assert.equal((await send('w5', first, DAY_MINUTES + 10)).status, 'AUTHORIZED');
});

test('cap: lifetime 10 ต่อ profile ปิดตายแม้หน้าต่างรายวันจะว่าง', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const lifetime = LINE_PILOT_CAPS.logicalDeliveriesLifetime;

  const results: string[] = [];
  for (let index = 0; index <= lifetime; index += 1) {
    const minutes = index * DAY_MINUTES + 1;
    const recipient = digest(`r-life-${index}`);
    const { run } = await approveRunFor(pilot, `life-${index}`, recipient, at(minutes));
    const delivery = await context.seedDelivery(pilot.tenantId);
    const result = await pilot.plane.beginRun(
      operator,
      beginCommand(pilot, run.id, delivery.deliveryId, recipient, minutes),
    );
    results.push(result.status === 'AUTHORIZED' ? 'AUTHORIZED' : denial(result));
    if (result.status === 'AUTHORIZED') {
      await pilot.plane.commitDelivery(pilot.tenantId, delivery.deliveryId, at(minutes));
    }
  }

  assert.deepEqual(results, [...Array(lifetime).fill('AUTHORIZED'), 'LIFETIME_CAP_EXCEEDED']);
});

test('cap: concurrency 1 — ใบที่สองถูกปฏิเสธและคืนหน่วยที่เพิ่งจอง', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const firstRecipient = digest('r-conc-1');
  const secondRecipient = digest('r-conc-2');
  const { run: runA } = await approveRunFor(pilot, 'conc-a', firstRecipient, at(1));
  const { run: runB } = await approveRunFor(pilot, 'conc-b', secondRecipient, at(1));
  const deliveryA = await context.seedDelivery(pilot.tenantId);
  const deliveryB = await context.seedDelivery(pilot.tenantId);

  assert.equal(
    (
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runA.id, deliveryA.deliveryId, firstRecipient, 2),
      )
    ).status,
    'AUTHORIZED',
  );
  const blocked = await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, runB.id, deliveryB.deliveryId, secondRecipient, 2),
  );
  assert.equal(denial(blocked), 'CONCURRENT_SUBMISSION_CAP_EXCEEDED');

  // หน่วยของใบที่ถูกปฏิเสธต้องไม่ค้างกิน budget ของวัน
  const active = await context.control.listActiveCapEntries(
    pilot.tenantId,
    pilot.gate.id,
    'LOGICAL_DELIVERY',
  );
  assert.deepEqual(
    active.map((entry) => entry.deliveryId),
    [deliveryA.deliveryId],
  );
  // one-shot ถูกเผาไปแล้วตามเจตนา: ต้องเสนอ/อนุมัติใหม่เท่านั้น
  assert.equal((await context.control.findRun(pilot.tenantId, runB.id))?.state, 'CONSUMED');

  await pilot.plane.commitDelivery(pilot.tenantId, deliveryA.deliveryId, at(3));
  const { run: runC } = await approveRunFor(pilot, 'conc-c', secondRecipient, at(4));
  const deliveryC = await context.seedDelivery(pilot.tenantId);
  assert.equal(
    (
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runC.id, deliveryC.deliveryId, secondRecipient, 4),
      )
    ).status,
    'AUTHORIZED',
    'slot ว่างแล้วหลัง commit',
  );

  // ปลุก delivery ที่ release ไปแล้วไม่ได้ — การนับ cap เชื่อไม่ได้ จึง kill
  const resurrect = await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, runB.id, deliveryB.deliveryId, secondRecipient, 5),
  );
  assert.equal(denial(resurrect), 'CAP_ACCOUNTING_INCONSISTENCY');
  assert.equal(
    (await pilot.plane.findGate(pilot.scope))!.killReason,
    'CAP_ACCOUNTING_INCONSISTENCY',
  );
});

test('cap: provider attempt ไม่เกิน 4 ต่อ delivery แล้ว kill อัตโนมัติ', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-attempt');
  const { run } = await approveRunFor(pilot, 'attempt', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);
  const command = beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2);
  assert.equal((await pilot.plane.beginRun(operator, command)).status, 'AUTHORIZED');

  const gate = (await pilot.plane.findGate(pilot.scope))!;
  for (
    let attemptNo = 1;
    attemptNo <= LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery;
    attemptNo += 1
  ) {
    const reserved = await pilot.plane.reserveProviderAttempt(
      operator,
      command,
      gate,
      run,
      attemptNo,
    );
    assert.equal(reserved.status, 'APPLIED', `attempt ${attemptNo}`);
  }
  const exhausted = await pilot.plane.reserveProviderAttempt(
    operator,
    command,
    gate,
    run,
    LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery + 1,
  );
  assert.equal(denial(exhausted), 'PROVIDER_ATTEMPT_CAP_EXCEEDED');
  const killed = (await pilot.plane.findGate(pilot.scope))!;
  assert.equal(killed.killReason, 'PROVIDER_ATTEMPTS_EXHAUSTED');
  // scope ที่ถูก kill จองอะไรเพิ่มไม่ได้อีก
  assert.equal(
    denial(await pilot.plane.reserveProviderAttempt(operator, command, killed, run, 1)),
    'LINE_GATE_KILLED',
  );
});

test('unknown-reconciling: หนึ่งใบค้าง = pause งานใหม่ทั้ง scope แต่ใบเดิมยัง reconcile ต่อได้', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const firstRecipient = digest('r-unknown-1');
  const secondRecipient = digest('r-unknown-2');
  const { run: runA } = await approveRunFor(pilot, 'unknown-a', firstRecipient, at(1));
  const deliveryA = await context.seedDelivery(pilot.tenantId);
  const commandA = beginCommand(pilot, runA.id, deliveryA.deliveryId, firstRecipient, 2);
  assert.equal((await pilot.plane.beginRun(operator, commandA)).status, 'AUTHORIZED');
  await pilot.plane.commitDelivery(pilot.tenantId, deliveryA.deliveryId, at(3));

  const gate = (await pilot.plane.findGate(pilot.scope))!;
  assert.equal(
    (await pilot.plane.enterUnknownReconciling(commandA, gate.id, runA.id)).status,
    'APPLIED',
  );

  const { run: runB } = await approveRunFor(pilot, 'unknown-b', secondRecipient, at(4));
  const deliveryB = await context.seedDelivery(pilot.tenantId);
  assert.equal(
    denial(
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runB.id, deliveryB.deliveryId, secondRecipient, 4),
      ),
    ),
    'CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED',
  );
  // ใบที่ค้างยังจอง attempt เพื่อ reconcile ด้วย key เดิมได้
  assert.equal(
    (await pilot.plane.reserveProviderAttempt(operator, commandA, gate, runA, 1)).status,
    'APPLIED',
  );

  assert.equal(
    await pilot.plane.exitUnknownReconciling(pilot.tenantId, deliveryA.deliveryId, at(5)),
    true,
  );
  const { run: runC } = await approveRunFor(pilot, 'unknown-c', secondRecipient, at(6));
  const deliveryC = await context.seedDelivery(pilot.tenantId);
  assert.equal(
    (
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runC.id, deliveryC.deliveryId, secondRecipient, 6),
      )
    ).status,
    'AUTHORIZED',
  );
});

// ── Kill / rollback (#358 §F) ────────────────────────────────────────────────

test('kill: latch ชนะทุก state, อยู่ข้าม restart และยกได้เฉพาะ Compliance ด้วย ref ใหม่', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);

  const killed = await pilot.plane.killByActor(operator, pilot.gate, at(1));
  assert.equal(killed.killReason, 'OPERATOR_KILL');
  assert.equal(killed.technicalSwitchOn, false);

  const restarted = new LineControlPlane({ control: context.control, audit: context.audit });
  assert.equal(
    denial(
      await restarted.evaluate({
        scope: pilot.scope,
        operation: 'LOCAL_VALIDATION',
        at: at(2),
        configDigest: CONFIG_DIGEST,
        quota: quotaAt(2),
      }),
    ),
    'LINE_GATE_KILLED',
  );
  assert.equal(
    denial(await restarted.setTechnicalSwitch(operator, killed, true, at(2))),
    'LINE_GATE_KILLED',
  );
  assert.equal(
    denial(await restarted.advanceState(compliance, killed, 'DRY_RUN', null, at(2))),
    'LINE_GATE_KILLED',
  );

  await assert.rejects(
    restarted.clearWithApproval(operator, killed, 'approval:kill-clear:0001', at(3)),
    LineControlAuthorizationError,
  );
  const cleared = applied(
    await restarted.clearWithApproval(compliance, killed, 'approval:kill-clear:0001', at(3)),
    'clear',
  );
  assert.equal(cleared.killed, false);
  assert.equal(cleared.businessState, 'DISABLED', 'ยก kill แล้วต้องเริ่มใหม่จาก DISABLED');
  assert.equal(cleared.technicalSwitchOn, false);

  // kill รอบถัดไปต้องใช้ ref ใหม่เสมอ ใช้ ref เดิมซ้ำไม่ได้
  const again = await restarted.kill(compliance, cleared, 'PILOT_ROLLBACK', at(4));
  assert.equal(
    denial(await restarted.clearWithApproval(compliance, again, 'approval:kill-clear:0001', at(5))),
    'LINE_GATE_AUTHORIZATION_DENIED',
  );
});

test('kill: ก่อน barrier release หน่วยได้ หลัง barrier ปลดไม่ได้', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipientA = digest('r-barrier-1');
  const recipientB = digest('r-barrier-2');
  const { run: runA } = await approveRunFor(pilot, 'barrier-a', recipientA, at(1));
  const deliveryA = await context.seedDelivery(pilot.tenantId);
  assert.equal(
    (
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runA.id, deliveryA.deliveryId, recipientA, 2),
      )
    ).status,
    'AUTHORIZED',
  );
  assert.equal(
    await pilot.plane.releaseDelivery(pilot.tenantId, deliveryA.deliveryId, at(3)),
    true,
  );
  assert.equal(
    (await context.control.listActiveCapEntries(pilot.tenantId, pilot.gate.id, 'LOGICAL_DELIVERY'))
      .length,
    0,
  );

  const { run: runB } = await approveRunFor(pilot, 'barrier-b', recipientB, at(4));
  const deliveryB = await context.seedDelivery(pilot.tenantId);
  assert.equal(
    (
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runB.id, deliveryB.deliveryId, recipientB, 4),
      )
    ).status,
    'AUTHORIZED',
  );
  assert.equal(await pilot.plane.commitDelivery(pilot.tenantId, deliveryB.deliveryId, at(5)), true);
  assert.equal(
    await pilot.plane.releaseDelivery(pilot.tenantId, deliveryB.deliveryId, at(6)),
    false,
    'หน่วยที่ commit แล้วคืนไม่ได้',
  );
  await pilot.plane.killByActor(compliance, pilot.gate, at(7));
  const ledger = await context.owner.dlLineCapLedgerEntry.findMany({
    where: {
      tenantId: pilot.tenantId,
      deliveryId: deliveryB.deliveryId,
      capKind: 'LOGICAL_DELIVERY',
    },
  });
  assert.equal(ledger[0]?.state, 'COMMITTED', 'kill ไม่ย้อนหลักฐานที่ข้าม barrier ไปแล้ว');
});

// ── Credential (#358 §G) ─────────────────────────────────────────────────────

test('credential: rotation ทำให้ run ที่ pin version เก่าไว้ข้าม barrier ไม่ได้', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-rotate');
  const { run } = await approveRunFor(pilot, 'rotate', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);

  const candidate = await pilot.plane.registerCredential(
    operator,
    {
      tenantId: pilot.tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
      version: 2,
      keychainService: 'd-contact.line.2007056595',
      keychainAccount: 'channel-access-token',
      fingerprint: digest('fingerprint-rotated'),
      issuedAt: new Date('2026-09-22T00:00:00.000Z'),
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
    },
    at(2),
  );
  const rotated = applied(
    await pilot.plane.verifyAndActivateCredential(
      operator,
      pilot.tenantId,
      candidate.id,
      { channelAccountId: PILOT_CHANNEL_ACCOUNT_ID, verifiedAt: at(2) },
      at(2),
    ),
    'rotate',
  );
  assert.equal(rotated.version, 2);
  assert.equal(
    (await context.control.findCredentialRef(pilot.tenantId, pilot.credential.id))?.status,
    'RETIRED',
    'version เก่าต้องถูก retire ใน transaction เดียวกัน',
  );

  assert.equal(
    denial(
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, run.id, delivery.deliveryId, recipient, 3),
      ),
    ),
    'CREDENTIAL_VERSION_MISMATCH',
  );

  // revoke แล้วไม่มี ACTIVE เหลือ: ทุก operation ที่แตะ provider ปิดหมด
  assert.equal(
    await pilot.plane.revokeCredential(operator, pilot.tenantId, rotated.id, at(4)),
    true,
  );
  assert.equal(
    denial(
      await pilot.plane.evaluate({
        scope: pilot.scope,
        operation: 'TOKEN_VERIFY',
        at: at(5),
        configDigest: CONFIG_DIGEST,
        quota: quotaAt(5),
      }),
    ),
    'CREDENTIAL_UNAVAILABLE',
  );
});

test('credential: client_id ไม่ตรง Channel ID = ไม่ activate และเป็นสัญญาณ auth failure', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const candidate = await pilot.plane.registerCredential(
    operator,
    {
      tenantId: pilot.tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
      version: 9,
      keychainService: 'd-contact.line.2007056595',
      keychainAccount: 'channel-access-token',
      fingerprint: digest('fingerprint-wrong-account'),
      issuedAt: new Date('2026-09-22T00:00:00.000Z'),
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
    },
    at(1),
  );
  const result = await pilot.plane.verifyAndActivateCredential(
    operator,
    pilot.tenantId,
    candidate.id,
    { channelAccountId: '1000000000', verifiedAt: at(1) },
    at(1),
  );
  assert.equal(denial(result), 'CREDENTIAL_UNAVAILABLE');
  assert.equal((result as { signal?: string }).signal, 'AUTH_FAILURE');
  assert.equal(
    (await context.control.findCredentialRef(pilot.tenantId, candidate.id))?.status,
    'CANDIDATE',
  );
});

// ── Quota advisory (#358 §D) ─────────────────────────────────────────────────

test('quota: ไม่มี snapshot = ปิด, quota หมด = kill อัตโนมัติ และไม่แทน durable cap', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-quota');
  const { run } = await approveRunFor(pilot, 'quota', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);

  assert.equal(
    denial(
      await pilot.plane.evaluate({
        scope: pilot.scope,
        operation: 'TOKEN_VERIFY',
        at: at(2),
        configDigest: CONFIG_DIGEST,
      }),
    ),
    'LINE_GATE_AUTHORIZATION_DENIED',
    'อ่าน quota ไม่ได้ = fail closed',
  );

  const exhausted = await pilot.plane.beginRun(operator, {
    ...beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2),
    quota: { type: 'limited', targetLimit: 500, totalUsage: 500, observedAt: at(2) },
  });
  assert.equal(denial(exhausted), 'LINE_GATE_AUTHORIZATION_DENIED');
  assert.equal((await pilot.plane.findGate(pilot.scope))!.killReason, 'QUOTA_EXHAUSTED');
  assert.equal(
    (await context.control.findRun(pilot.tenantId, run.id))?.state,
    'APPROVED',
    'quota ปิดก่อนถึง one-shot จึงไม่เผา authorization',
  );
});

// ── Tenant isolation และ audit ───────────────────────────────────────────────

test('tenant isolation: control plane ของอีก tenant มองไม่เห็นและตอบแบบไม่เผยข้อมูล', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-isolation');
  const { run } = await approveRunFor(pilot, 'isolation', recipient, at(1));
  const guard = await bootstrapPilot(context, context.tenantB, { credentialVersion: 1 });
  const guardDelivery = await context.seedDelivery(context.tenantB);

  // tenant B ถือ ID ของ run ฝั่ง A มาใช้ไม่ได้ และคำตอบไม่บอกว่า ID นั้นมีจริง
  const crossTenant = await guard.plane.beginRun(operator, {
    ...beginCommand(guard, run.id, guardDelivery.deliveryId, recipient, 2),
    tenantId: context.tenantB,
  });
  assert.equal(denial(crossTenant), 'RUN_AUTHORIZATION_MISSING');
  assert.equal(await context.control.findRun(context.tenantB, run.id), null);
  assert.equal(await context.control.findCredentialRef(context.tenantB, pilot.credential.id), null);
  assert.equal((await context.control.findRun(pilot.tenantId, run.id))?.state, 'APPROVED');
});

test('audit: ทุกคำสั่งมีแถว append-only, replay ไม่เพิ่มแถว และไม่มี field ต้องห้าม', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-audit');
  const { run } = await approveRunFor(pilot, 'audit', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);
  await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2),
  );

  const events = await context.audit.list(pilot.tenantId);
  const codes = events.map((event) => event.code);
  for (const expected of [
    'GATE_ADVANCED_DRY_RUN',
    'GATE_ADVANCED_PROVIDER_CONFORMANCE',
    'GATE_ADVANCED_CAPPED_PILOT',
    'GATE_TECHNICAL_SWITCH_ON',
    'CREDENTIAL_REGISTERED',
    'CREDENTIAL_ACTIVATED',
    'ALLOWLIST_REGISTERED',
    'RUN_PROPOSED',
    'RUN_APPROVED_TENANT_ADMIN',
    'RUN_APPROVED_COMPLIANCE',
    'RUN_CONSUMED',
    'CAP_RESERVED',
  ]) {
    assert.ok(codes.includes(expected), `ขาด audit ${expected}`);
  }
  assert.deepEqual([...new Set(events.map((event) => event.actorKind))].sort(), [
    'COMPLIANCE',
    'PLATFORM_OPERATOR',
    'TENANT_ADMIN',
  ]);
  for (const event of events) {
    assert.match(event.eventId, /^s2\.3\.[a-z_]+:[^:]+:[a-f0-9]{16}$/);
    assert.doesNotThrow(() => assertRedactedPayload(event));
  }

  // replay คำสั่งเดิมด้วยค่าเดิม: audit ต้องไม่งอก
  const before = events.length;
  await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2),
  );
  assert.equal((await context.audit.list(pilot.tenantId)).length, before);

  // หลักฐานแก้ย้อนหลังไม่ได้แม้เป็น application role
  await assert.rejects(
    context.asApplication(
      pilot.tenantId,
      `UPDATE dl_line_audit_events SET code = 'TAMPERED' WHERE tenant_id = '${pilot.tenantId}'`,
    ),
    /permission denied/,
  );
});
