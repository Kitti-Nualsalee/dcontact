/**
 * A1.8 (#413) บน Postgres จริง: เหตุการณ์ของ First admin ลง Action history ด้วย actor `FIRST_ADMIN`
 * (Keycloak จำลองด้วย response shape เดียวกับ Keycloak 26 — ของจริงอยู่ใน keycloak-provisioning.boundary)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { FirstAdminActivityReconciler } from './first-admin-activity.js';
import { createPlatformFixture, OPERATOR } from './platform-fixture.js';

const EMAIL = 'first.admin@example.test';

async function setup(t: TestContext) {
  const f = await createPlatformFixture();
  t.after(() => f.dispose());
  const key = `idem-${randomUUID()}`;
  const accepted = await f.repository().accept({
    idempotencyKey: key,
    input: f.input(),
    plan: f.plan,
    actor: OPERATOR,
    correlationId: `corr-${key}`,
  });
  f.track(accepted.tenantId);
  const userId = randomUUID();
  const invitation = await f.platform.pfInvitation.create({
    data: {
      id: randomUUID(),
      requestId: accepted.requestId,
      tenantId: accepted.tenantId,
      generation: 1,
      keycloakUserId: userId,
      recipientHash: 'c'.repeat(64),
      lifespanSeconds: 259200,
      requestedByKind: 'SYSTEM',
      requestedBy: 'fixture',
      createdAt: new Date(Date.now() - 60_000),
    },
  });
  await f.platform.pfInvitation.update({
    where: { id: invitation.id },
    data: {
      state: 'SENT',
      sentAt: new Date(Date.now() - 50_000),
      expiresAt: new Date(Date.now() + 259_150_000),
      revision: { increment: 1 },
    },
  });
  const keycloak = {
    user: {
      emailVerified: false,
      requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
    },
    events: [] as Record<string, unknown>[],
    calls: [] as string[],
    async admin(method: string, path: string) {
      this.calls.push(`${method} ${path.split('?')[0]}`);
      if (path.startsWith('/users/')) return { status: 200, body: this.user, location: null };
      return { status: 200, body: this.events, location: null };
    },
  };
  let clock = new Date();
  const reconciler = new FirstAdminActivityReconciler(f.platform, keycloak as never, {
    intervalMs: 60_000,
    now: () => clock,
    scope: () => [accepted.tenantId],
  });
  const timeline = () =>
    f.owner.pfActionHistory.findMany({
      where: { requestId: accepted.requestId, actorKind: 'FIRST_ADMIN' },
      orderBy: { occurredAt: 'asc' },
    });
  return {
    f,
    accepted,
    userId,
    keycloak,
    reconciler,
    timeline,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const at = (seconds: number) => Date.parse('2026-09-25T04:20:00Z') + seconds * 1000;

test('บันทึกเหตุการณ์ตามลำดับเวลา, ไม่ซ้ำเมื่อ reconcile ซ้ำ และหยุดตามหลัง ACTIVATED', async (t) => {
  const s = await setup(t);
  // ยังไม่ทำอะไร: ไม่มีเหตุการณ์ และไม่ถูกตรวจซ้ำก่อนครบ interval
  assert.deepEqual(await s.reconciler.runOnce(), {
    kind: 'FIRST_ADMIN_SYNCED',
    requestId: s.accepted.requestId,
    tenantId: s.accepted.tenantId,
    recorded: 0,
    code: 'PENDING_ACTIVATION',
  });
  assert.deepEqual(await s.reconciler.runOnce(), { kind: 'IDLE' });

  // ทำ TOTP + password แล้ว (details มี username = email ซึ่งต้องไม่ถูกเก็บ)
  const details = { username: EMAIL, auth_method: 'openid-connect' };
  s.keycloak.events = [
    { time: at(3), type: 'UPDATE_PASSWORD', details: { ...details, credential_type: 'password' } },
    {
      time: at(3),
      type: 'UPDATE_CREDENTIAL',
      details: { ...details, credential_type: 'password' },
    },
    { time: at(1), type: 'UPDATE_TOTP', details: { ...details, credential_type: 'otp' } },
    { time: at(1), type: 'UPDATE_CREDENTIAL', details: { ...details, credential_type: 'otp' } },
  ];
  s.advance(60_000);
  assert.equal(((await s.reconciler.runOnce()) as { recorded: number }).recorded, 2);

  // ยืนยันอีเมลจนครบ → ACTIVATED ที่เวลาของเหตุการณ์ล่าสุด
  s.keycloak.events.push({
    time: at(4),
    type: 'CUSTOM_REQUIRED_ACTION',
    details: { ...details, custom_required_action: 'VERIFY_EMAIL' },
  });
  s.keycloak.user = { emailVerified: true, requiredActions: [] };
  s.advance(60_000);
  const synced = await s.reconciler.runOnce();
  assert.deepEqual(
    [(synced as { recorded: number }).recorded, (synced as { code: string }).code],
    [2, 'ACTIVATED'],
  );
  const rows = await s.timeline();
  assert.deepEqual(
    rows.map((row) => [row.action, row.occurredAt.getTime()]),
    [
      ['FIRST_ADMIN_TOTP_ENROLLED', at(1)],
      ['FIRST_ADMIN_PASSWORD_SET', at(3)],
      ['FIRST_ADMIN_EMAIL_VERIFIED', at(4)],
      ['FIRST_ADMIN_ACTIVATED', at(4)],
    ],
  );
  assert.ok(rows.every((row) => row.actorSubject === s.userId && row.outcome === 'SUCCEEDED'));
  assert.equal(JSON.stringify(rows).includes(EMAIL), false);

  // ACTIVATED แล้ว = ไม่อยู่ในรายการตรวจอีก; reconcile ซ้ำ (เช่น worker อื่น) ไม่เพิ่มแถว
  s.advance(120_000);
  assert.deepEqual(await s.reconciler.runOnce(), { kind: 'IDLE' });
  const other = new FirstAdminActivityReconciler(s.f.platform, s.keycloak as never, {
    now: () => new Date(),
    scope: () => [s.accepted.tenantId],
  });
  assert.deepEqual(await other.runOnce(), { kind: 'IDLE' });
  assert.equal((await s.timeline()).length, 4);
});

test('worker สองตัว reconcile พร้อมกันไม่ทำให้ timeline ซ้ำ', async (t) => {
  const s = await setup(t);
  s.keycloak.user = { emailVerified: true, requiredActions: [] };
  s.keycloak.events = [
    { time: at(1), type: 'UPDATE_TOTP' },
    { time: at(2), type: 'UPDATE_PASSWORD' },
    { time: at(3), type: 'VERIFY_EMAIL' },
  ];
  const workers = [0, 1].map(
    () =>
      new FirstAdminActivityReconciler(s.f.platform, s.keycloak as never, {
        scope: () => [s.accepted.tenantId],
      }),
  );
  const results = await Promise.all(workers.map((worker) => worker.runOnce()));
  const recorded = results.map((result) => (result as { recorded?: number }).recorded ?? 0);
  assert.equal(
    recorded.reduce((sum, n) => sum + n, 0),
    4,
  );
  assert.equal((await s.timeline()).length, 4);
});
