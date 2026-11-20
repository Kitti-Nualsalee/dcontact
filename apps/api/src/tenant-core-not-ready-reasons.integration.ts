import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import { coreFixture } from './tenant-core-test-fixtures.js';

/** #936 รายการเหตุผล Not Ready ผ่าน Core Settings บนฐานจริง — สิทธิ์, tenant isolation, revision และการลบ */
const PATH = 'tenant/core-settings/not-ready-reasons';
type Reason = { code: string; labelTh: string; labelEn: string; isActive: boolean; inUse: boolean };
type Snapshot = { id: string; revision: string; reasons: Reason[] };

const DEFAULTS = ['BREAK', 'LUNCH', 'MEETING', 'TRAINING', 'COACHING', 'BACK_OFFICE', 'PERSONAL'];
type ErrorBody = {
  fieldErrors?: Record<string, string>;
  currentRevision?: string;
  blockers?: { kind: string; count: number }[];
};
const errorOf = (response: { body: unknown }) => (response.body as { error: ErrorBody }).error;
const draft = ({ code, labelTh, labelEn, isActive }: Reason) => ({
  code,
  labelTh,
  labelEn,
  isActive,
});

async function read(f: Awaited<ReturnType<typeof coreFixture>>, token = 'admin') {
  const response = await f.request(PATH, token);
  return {
    status: response.status,
    snapshot: (response.body as unknown as { notReadyReasons: Snapshot }).notReadyReasons,
    body: response.body,
  };
}

test('tenant ใหม่ได้เหตุผลตั้งต้น 7 ข้อ revision 1 — Admin และ Supervisor อ่านได้ Agent ไม่ได้', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const admin = await read(f);
  assert.equal(admin.status, 200);
  assert.equal(admin.snapshot.id, f.tenantId);
  assert.equal(admin.snapshot.revision, '1');
  assert.deepEqual(
    admin.snapshot.reasons.map((r) => r.code),
    DEFAULTS,
  );
  assert.deepEqual(admin.snapshot.reasons[0], {
    code: 'BREAK',
    labelTh: 'พักสั้น',
    labelEn: 'Break',
    isActive: true,
    inUse: false,
  });
  assert.equal((await read(f, 'supervisor')).status, 200);
  assert.equal((await read(f, 'agent')).status, 403);

  const capabilities = async (token: string) =>
    (
      (await f.request('tenant/core-settings/capabilities', token)).body as unknown as {
        notReadyReasons: { read: boolean; write: boolean };
      }
    ).notReadyReasons;
  assert.deepEqual(await capabilities('admin'), { read: true, write: true });
  assert.deepEqual(await capabilities('supervisor'), { read: true, write: false });
});

test('Admin แก้ทั้งรายการ: เปลี่ยนชื่อ เรียงใหม่ ปิด เพิ่ม และลบ — replay ได้ผลเดิม, no-op ไม่เพิ่ม revision, revision เก่าถูกปฏิเสธ', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const before = (await read(f)).snapshot;
  const [breakReason, lunch, meeting, ...rest] = before.reasons.map(draft);
  const reasons = [
    { ...lunch!, labelTh: 'พักกลางวัน' },
    breakReason!,
    { ...meeting!, isActive: false },
    ...rest.filter((r) => r.code !== 'PERSONAL'),
    { labelTh: 'ตรวจคุณภาพ', labelEn: 'Quality check', isActive: true },
  ];
  const body = { commandId: randomUUID(), expectedRevision: '1', reasons };
  const changed = await f.request(PATH, 'admin', body, 'PUT');
  assert.equal(changed.status, 200);
  assert.equal(changed.body.command.outcome, 'APPLIED');
  assert.equal(changed.body.command.committedRevision, '2');
  assert.deepEqual(await f.request(PATH, 'admin', body, 'PUT').then((r) => r.body), changed.body);

  const after = (await read(f)).snapshot;
  assert.equal(after.revision, '2');
  assert.deepEqual(
    after.reasons.map((r) => [r.code, r.labelTh, r.isActive]),
    [
      ['LUNCH', 'พักกลางวัน', true],
      ['BREAK', 'พักสั้น', true],
      ['MEETING', 'ประชุม', false],
      ['TRAINING', 'อบรม', true],
      ['COACHING', 'โค้ช/ประเมิน', true],
      ['BACK_OFFICE', 'งานหลังบ้าน', true],
      ['QUALITY_CHECK', 'ตรวจคุณภาพ', true],
    ],
  );

  const noOp = await f.request(
    PATH,
    'admin',
    { commandId: randomUUID(), expectedRevision: '2', reasons: after.reasons.map(draft) },
    'PUT',
  );
  assert.equal(noOp.body.command.outcome, 'NO_OP');
  assert.equal(noOp.body.command.committedRevision, '2');

  const stale = await f.request(PATH, 'admin', { ...body, commandId: randomUUID() }, 'PUT');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  assert.equal(errorOf(stale).currentRevision, '2');

  // audit ของ Core Settings เก็บก่อน/หลังของทั้งรายการ
  const audit = await withTenantDatabaseTransaction(f.owner, f.tenantId, (tx) =>
    tx.tenantCoreConfigAudit.findFirstOrThrow({
      where: { tenantId: f.tenantId, resourceType: 'NOT_READY_REASONS' },
    }),
  );
  assert.equal(audit.action, 'NOT_READY_REASONS_UPDATE');
  assert.equal(audit.beforeRevision, 1n);
  assert.equal(audit.afterRevision, 2n);
});

test('กติกา: ปิดทุกเหตุผลไม่ได้, ชื่อซ้ำไม่ได้, code ที่ไม่มีอยู่ไม่ได้ — ไม่เพิ่ม revision', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const reasons = (await read(f)).snapshot.reasons.map(draft);
  const put = (next: unknown[]) =>
    f.request(
      PATH,
      'admin',
      { commandId: randomUUID(), expectedRevision: '1', reasons: next },
      'PUT',
    );

  const allOff = await put(reasons.map((r) => ({ ...r, isActive: false })));
  assert.equal(allOff.status, 422);
  assert.equal(
    errorOf(allOff).fieldErrors?.reasons,
    'core.validation.notReadyReasonActiveRequired',
  );

  const duplicate = await put([
    ...reasons,
    { labelTh: 'พักสั้น', labelEn: 'Short break', isActive: true },
  ]);
  assert.equal(duplicate.status, 422);
  assert.equal(
    errorOf(duplicate).fieldErrors?.['reasons.7.labelTh'],
    'core.validation.notReadyReasonDuplicate',
  );

  const unknown = await put([
    ...reasons,
    { code: 'GHOST', labelTh: 'ผี', labelEn: 'Ghost', isActive: true },
  ]);
  assert.equal(unknown.status, 422);
  assert.equal(
    errorOf(unknown).fieldErrors?.['reasons.7.code'],
    'core.validation.notReadyReasonUnknown',
  );

  assert.equal((await read(f)).snapshot.revision, '1');
});

test('เหตุผลที่เคยถูกใช้แล้วลบไม่ได้ ปิดได้เท่านั้น — ฐานข้อมูลกันการลบตรงด้วย', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  await withTenantDatabaseTransaction(
    f.owner,
    f.tenantId,
    (tx) =>
      tx.$executeRaw`UPDATE tenant_not_ready_reasons SET first_used_at = now()
      WHERE tenant_id = ${f.tenantId}::uuid AND code = 'BREAK'`,
  );
  const reasons = (await read(f)).snapshot.reasons;
  assert.equal(reasons.find((r) => r.code === 'BREAK')?.inUse, true);

  const removed = await f.request(
    PATH,
    'admin',
    {
      commandId: randomUUID(),
      expectedRevision: '1',
      reasons: reasons.filter((r) => r.code !== 'BREAK').map(draft),
    },
    'PUT',
  );
  assert.equal(removed.status, 409);
  assert.equal(removed.body.error.code, 'NOT_READY_REASON_IN_USE');
  assert.deepEqual(errorOf(removed).blockers, [{ kind: 'BREAK', count: 1 }]);

  const disabled = await f.request(
    PATH,
    'admin',
    {
      commandId: randomUUID(),
      expectedRevision: '1',
      reasons: reasons.map((r) =>
        r.code === 'BREAK' ? { ...draft(r), isActive: false } : draft(r),
      ),
    },
    'PUT',
  );
  assert.equal(disabled.status, 200);

  await assert.rejects(
    withTenantDatabaseTransaction(
      f.owner,
      f.tenantId,
      (tx) =>
        tx.$executeRaw`DELETE FROM tenant_not_ready_reasons WHERE tenant_id = ${f.tenantId}::uuid AND code = 'BREAK'`,
    ),
    /NOT_READY_REASON_IN_USE/,
  );
});

test('สิทธิ์และ tenant isolation: Supervisor แก้ไม่ได้, Admin ของ tenant อื่นเห็นและแก้ได้เฉพาะของตัวเอง', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const reasons = (await read(f)).snapshot.reasons.map(draft);
  const body = (next: unknown[]) => ({
    commandId: randomUUID(),
    expectedRevision: '1',
    reasons: next,
  });

  const supervisor = await f.request(PATH, 'supervisor', body(reasons.slice(1)), 'PUT');
  assert.equal(supervisor.status, 403);

  const foreign = await read(f, 'foreign');
  assert.equal(foreign.status, 200);
  assert.equal(foreign.snapshot.id, f.otherTenantId);
  const foreignChange = await f.request(
    PATH,
    'foreign',
    body(
      [{ ...foreign.snapshot.reasons[0]!, labelTh: 'พักของอีก tenant' }]
        .map(draft)
        .concat(foreign.snapshot.reasons.slice(1).map(draft)),
    ),
    'PUT',
  );
  assert.equal(foreignChange.status, 200);

  const mine = (await read(f)).snapshot;
  assert.equal(mine.revision, '1');
  assert.equal(mine.reasons[0]?.labelTh, 'พักสั้น');
  const rows = await withTenantDatabaseTransaction(
    f.db,
    f.tenantId,
    (tx) =>
      tx.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM tenant_not_ready_reasons WHERE tenant_id <> ${f.tenantId}::uuid`,
  );
  assert.equal(rows[0]?.n, 0n);
});
