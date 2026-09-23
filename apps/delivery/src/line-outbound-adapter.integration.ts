/**
 * S2.4 (#370) — LINE outbound adapter บน PostgreSQL/RLS จริงกับ provider double
 *
 * ไม่มี network I/O จริงตาม stop condition ของ #370: `FakeLineTransport` เป็น deterministic double
 * ที่สคริปต์ผลได้ทั้ง 2xx/409/4xx/5xx/timeout และนับจำนวน request ที่ถูกยิงจริง
 *
 * ครอบ `S2-LINE-F01/F02`, `ID01`, `RC01/RC02`, `OB01`
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import { LineControlPlane, type LineControlActor } from './line-control-plane.js';
import { LineOutboundAdapter, type LineSubmitCommand } from './line-outbound-adapter.js';
import {
  createLinePersistenceFixture,
  digest,
  PILOT_CHANNEL_ACCOUNT_ID,
} from './line-persistence-fixture.js';
import { lineContentDigest } from './line-push-request.js';
import { LineAuditRepository } from './line-audit-repository.js';
import type {
  LinePushRequest,
  LineProviderTransport,
  LineTransportResult,
} from './line-provider-transport.js';

/** #358 §E แยกสิทธิ์: Compliance เลื่อนขั้น, Platform Operator เปิด switch และสั่งรัน */
const OPERATOR: LineControlActor = { role: 'PLATFORM_OPERATOR', ref: 'platform-operator-1' };
const COMPLIANCE: LineControlActor = { role: 'COMPLIANCE', ref: 'compliance-1' };
const CONFIG_DIGEST = digest('config-v1');

/** provider double: บันทึกทุก request แล้วคืนผลตามสคริปต์ — ไม่มี socket, ไม่มี retry ซ่อน */
class FakeLineTransport implements LineProviderTransport {
  readonly requests: LinePushRequest[] = [];
  private readonly scripted: LineTransportResult[] = [];

  script(...results: LineTransportResult[]) {
    this.scripted.push(...results);
    return this;
  }

  async push(request: LinePushRequest): Promise<LineTransportResult> {
    this.requests.push(request);
    return (
      this.scripted.shift() ?? {
        kind: 'RESPONSE',
        response: {
          httpStatus: 200,
          requestId: `req-${this.requests.length}`,
          sentMessageIds: ['461230'],
        },
      }
    );
  }

  async verifyToken() {
    return { valid: true };
  }
  async getQuota() {
    return { type: 'limited', value: 500 };
  }
  async getConsumption() {
    return { totalUsage: 1 };
  }
  async validatePush() {
    return { valid: true };
  }
  async getWebhookEndpoint() {
    return { endpoint: null, active: false };
  }
  async testWebhookEndpoint() {
    return { success: false, statusCode: null };
  }
}

const ok = (id: string): LineTransportResult => ({
  kind: 'RESPONSE',
  response: { httpStatus: 200, requestId: id, sentMessageIds: ['461230'] },
});
const replay = (acceptedRequestId: string): LineTransportResult => ({
  kind: 'RESPONSE',
  response: {
    httpStatus: 409,
    requestId: 'req-retry',
    acceptedRequestId,
    sentMessageIds: ['461230'],
  },
});
const failure = (httpStatus: number, errorCode?: string): LineTransportResult => ({
  kind: 'RESPONSE',
  response: { httpStatus, ...(errorCode ? { errorCode } : {}) },
});
const timeout: LineTransportResult = { kind: 'NO_RESPONSE', reason: 'TIMEOUT' };

async function setup(t: TestContext, options: { now?: () => Date } = {}) {
  const fixture = await createLinePersistenceFixture();
  t.after(() => fixture.dispose());

  const control = new LineControlPlane({
    control: fixture.control,
    audit: new LineAuditRepository(fixture.application),
  });
  const governance = new ContactGovernanceService(fixture.application);
  const transport = new FakeLineTransport();

  /** เปิด gate ให้ถึง CAPPED_PILOT ตามลำดับที่ #358 บังคับ (ข้ามขั้นไม่ได้) */
  const openGate = async (tenantId: string) => {
    let gate = await fixture.control.findGate(fixture.scope(tenantId));
    for (const state of ['DRY_RUN', 'PROVIDER_CONFORMANCE', 'CAPPED_PILOT'] as const) {
      const advanced = await control.advanceState(
        COMPLIANCE,
        gate!,
        state,
        CONFIG_DIGEST,
        new Date(),
      );
      assert.equal(advanced.status, 'APPLIED', `advance ไป ${state}`);
      gate = advanced.status === 'APPLIED' ? advanced.value : gate;
    }
    const switched = await control.setTechnicalSwitch(OPERATOR, gate!, true, new Date());
    assert.equal(switched.status, 'APPLIED');
  };

  const prepare = async (tenantId: string, label = `run-${randomUUID().slice(0, 8)}`) => {
    const run = await fixture.seedApprovedRun(tenantId, label, {
      contentDigest: lineContentDigest('fixture:service-notification/v1'),
      proposedAt: options.now ? options.now() : new Date(),
    });
    await openGate(tenantId);
    // credential ต้องถูก verify + activate ก่อน PUSH (#358 §G) — fixture สร้างไว้เป็น CANDIDATE
    const activated = await control.verifyAndActivateCredential(
      OPERATOR,
      tenantId,
      run.credential.id,
      { channelAccountId: PILOT_CHANNEL_ACCOUNT_ID, verifiedAt: new Date() },
      new Date(),
    );
    assert.equal(activated.status, 'APPLIED', JSON.stringify(activated));
    const delivery = await fixture.seedDelivery(
      tenantId,
      'LINE_MESSAGING_API',
      options.now ? options.now() : new Date(),
    );
    const command: LineSubmitCommand = {
      tenantId,
      deliveryId: delivery.deliveryId,
      scope: fixture.scope(tenantId),
      runAuthorizationId: run.run.id,
      recipientFingerprint: digest(`recipient-${label}`),
      recipientProtectedRef: run.allowlist.recipientProtectedRef,
      correlationId: `corr-${delivery.deliveryId}`,
      // observedAt ต้องเป็นนาฬิกาเดียวกับ adapter ไม่งั้น advisory เป็น STALE (#358 §A)
      quota: {
        type: 'limited',
        targetLimit: 500,
        totalUsage: 1,
        observedAt: options.now ? options.now() : new Date(),
      },
    };
    return { run, delivery, command };
  };

  const adapter = new LineOutboundAdapter({
    database: fixture.application,
    governance,
    control,
    transport,
    recipients: {
      resolve: async () => ({ userId: `U${'e'.repeat(32)}` }),
    },
    credentials: {
      resolve: async () => ({ accessToken: 'synthetic-channel-access-token' }),
    },
    actor: OPERATOR,
    configDigest: CONFIG_DIGEST,
    ...(options.now ? { now: options.now } : {}),
  });

  return { fixture, control, transport, adapter, prepare };
}

const outboxOf = (f: Awaited<ReturnType<typeof setup>>, tenantId: string, deliveryId: string) =>
  f.fixture.owner.dlOutboxEntry.findFirstOrThrow({ where: { tenantId, deliveryId } });

test('S2-LINE-F01 2xx ทำให้ accepted: receipt ครบ, outbox SETTLED และ Attempt 1 ที่ Governance', async (t) => {
  const f = await setup(t);
  const { command, delivery } = await f.prepare(f.fixture.tenantA);
  f.transport.script(ok('req-1'));

  const result = await f.adapter.submit(command);
  assert.deepEqual(
    [result.status, result.status === 'ACCEPTED' ? result.outcomeCode : JSON.stringify(result)],
    ['ACCEPTED', 'LINE_ACCEPTED'],
  );
  assert.equal(f.transport.requests.length, 1);
  // retry key ที่ยิงออกไปคือค่าที่ persist ไว้ตั้งแต่ enqueue
  assert.equal(f.transport.requests[0]!.retryKey, delivery.providerRequestKey);

  const entry = await outboxOf(f, f.fixture.tenantA, command.deliveryId);
  assert.deepEqual([entry.state, entry.outcome], ['SETTLED', 'PROVIDER_ACCEPTED']);

  const receipts = await f.fixture.owner.dlProviderSubmissionAttempt.findMany({
    where: { tenantId: f.fixture.tenantA, deliveryId: command.deliveryId },
  });
  assert.equal(receipts.length, 1);
  assert.deepEqual(
    [receipts[0]!.attemptNo, receipts[0]!.outcomeCode, receipts[0]!.httpStatus],
    [1, 'LINE_ACCEPTED', 200],
  );
  assert.deepEqual(receipts[0]!.sentMessageIds, ['461230']);
  // Governance เขียน Attempt PROVIDER_ACCEPTED หนึ่งใบ ไม่มี Touch
  const attempts = await f.fixture.owner.cgAttempt.findMany({
    where: { tenantId: f.fixture.tenantA, deliveryId: command.deliveryId },
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.outcome, 'PROVIDER_ACCEPTED');
  assert.equal(await f.fixture.owner.cgTouch.count({ where: { tenantId: f.fixture.tenantA } }), 0);
  // evidence ไม่มี recipient/token/เนื้อหา
  const serialized = JSON.stringify(receipts);
  assert.ok(!serialized.includes('U') || !/U[e]{32}/.test(serialized));
  assert.ok(!serialized.includes('synthetic-channel-access-token'));
});

test('S2-LINE-ID01 409 + accepted request id เป็น replay ที่ไม่ยิงซ้ำและไม่สร้าง Attempt ที่สอง', async (t) => {
  const f = await setup(t);
  const { command } = await f.prepare(f.fixture.tenantA);
  f.transport.script(timeout, replay('req-first'));

  const first = await f.adapter.submit(command);
  assert.equal(first.status, 'RECONCILING');
  const second = await f.adapter.reconcile(command);
  assert.deepEqual(
    [second.status, second.status === 'ACCEPTED' ? second.outcomeCode : ''],
    ['ACCEPTED', 'LINE_ACCEPTED_REPLAY'],
  );

  // retry ใช้ key เดิมและ payload เดิมทุก byte
  assert.equal(f.transport.requests.length, 2);
  assert.equal(f.transport.requests[0]!.retryKey, f.transport.requests[1]!.retryKey);
  assert.deepEqual(f.transport.requests[0]!.messages, f.transport.requests[1]!.messages);
  assert.equal(f.transport.requests[0]!.to, f.transport.requests[1]!.to);

  const receipts = await f.fixture.owner.dlProviderSubmissionAttempt.findMany({
    where: { tenantId: f.fixture.tenantA, deliveryId: command.deliveryId },
    orderBy: { attemptNo: 'asc' },
  });
  assert.deepEqual(
    receipts.map((receipt) => [receipt.attemptNo, receipt.outcomeCode]),
    [
      [1, 'LINE_UNKNOWN_OUTCOME'],
      [2, 'LINE_ACCEPTED_REPLAY'],
    ],
  );
  assert.equal(receipts[1]!.lineAcceptedRequestId, 'req-first');
  const attempts = await f.fixture.owner.cgAttempt.findMany({
    where: { tenantId: f.fixture.tenantA, deliveryId: command.deliveryId },
  });
  assert.equal(attempts.length, 1, 'acceptance ครั้งเดียวแม้ผ่าน reconciliation');
});

test('S2-LINE-RC01 แถวที่ผ่าน barrier แล้วห้าม submit ซ้ำ — ทำได้แค่ reconcile', async (t) => {
  const f = await setup(t);
  const { command } = await f.prepare(f.fixture.tenantA);
  f.transport.script(timeout);

  await f.adapter.submit(command);
  const entry = await outboxOf(f, f.fixture.tenantA, command.deliveryId);
  assert.equal(entry.state, 'RECONCILING');

  // เรียก submit ซ้ำหลัง restart: ต้องไม่ยิง request ใหม่แบบ blind resend
  f.transport.script(ok('req-2'));
  const again = await f.adapter.submit(command);
  assert.equal(again.status, 'ACCEPTED');
  assert.equal(f.transport.requests.length, 2);
  assert.equal(f.transport.requests[1]!.retryKey, f.transport.requests[0]!.retryKey);
});

test('S2-LINE-F02 4xx recipient นับ Attempt ส่วน 401 เป็น operational และดึง kill switch', async (t) => {
  const f = await setup(t);
  const recipientCase = await f.prepare(f.fixture.tenantA);
  f.transport.script(failure(400));
  const rejected = await f.adapter.submit(recipientCase.command);
  assert.deepEqual(
    [rejected.status, rejected.status === 'REJECTED' ? rejected.rejectionScope : ''],
    ['REJECTED', 'RECIPIENT'],
  );
  const attempts = await f.fixture.owner.cgAttempt.findMany({
    where: { tenantId: f.fixture.tenantA, deliveryId: recipientCase.command.deliveryId },
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.outcome, 'PROVIDER_REJECTED');

  const authCase = await f.prepare(f.fixture.tenantB, 'auth-run');
  f.transport.script(failure(401));
  const auth = await f.adapter.submit(authCase.command);
  assert.deepEqual(
    [auth.status, auth.status === 'REJECTED' ? auth.rejectionScope : ''],
    ['REJECTED', 'OPERATIONAL'],
  );
  const gate = await f.fixture.owner.dlLineScopeGate.findFirstOrThrow({
    where: { tenantId: f.fixture.tenantB },
  });
  assert.equal(gate.killed, true, '401 ต้องดึง kill switch ของบัญชี');
});

test('S2-LINE-RC02 เลย retry window แล้ว quarantine โดยไม่ยิงซ้ำและไม่ mint key ใหม่', async (t) => {
  // Governance ใช้นาฬิกาจริง จึงต้องเริ่มจากเวลาปัจจุบันแล้วเลื่อนไปข้างหน้าเกิน retry window
  const base = new Date();
  let now = base;
  const f = await setup(t, { now: () => now });
  const { command } = await f.prepare(f.fixture.tenantA);
  f.transport.script(timeout);

  const first = await f.adapter.submit(command);
  assert.equal(first.status, 'RECONCILING', JSON.stringify(first));
  assert.equal(f.transport.requests.length, 1);
  const afterFirst = await outboxOf(f, f.fixture.tenantA, command.deliveryId);
  assert.equal(afterFirst.state, 'RECONCILING', `state หลัง submit = ${afterFirst.state}`);

  now = new Date(base.getTime() + 23.5 * 60 * 60 * 1000);
  const expired = await f.adapter.reconcile(command);
  assert.deepEqual(
    [expired.status, expired.status === 'QUARANTINED' ? expired.outcomeCode : ''],
    ['QUARANTINED', 'LINE_RETRY_WINDOW_EXPIRED'],
  );
  assert.equal(f.transport.requests.length, 1, 'หมด window แล้วห้ามยิงเพิ่ม');
  const gate = await f.fixture.owner.dlLineScopeGate.findFirstOrThrow({
    where: { tenantId: f.fixture.tenantA },
  });
  assert.equal(gate.killed, true);
  // reservation ยังไม่ terminal — sweeper ห้าม release
  const reservation = await f.fixture.owner.cgReservation.findFirstOrThrow({
    where: { tenantId: f.fixture.tenantA, deliveryId: command.deliveryId },
  });
  assert.notEqual(reservation.settlementStatus, 'RELEASED');
});

test('S2-LINE-OB01 lifecycle events เป็น PII-safe และเรียงตาม state ที่เกิดจริง', async (t) => {
  const f = await setup(t);
  const { command } = await f.prepare(f.fixture.tenantA);
  f.transport.script(ok('req-1'));
  await f.adapter.submit(command);

  const events = await f.fixture.owner.dlLineEventOutboxEntry.findMany({
    where: { tenantId: f.fixture.tenantA, eventType: 'delivery.line.lifecycle.v1' },
    orderBy: { createdAt: 'asc' },
  });
  assert.deepEqual(
    events.map((event) => (event.payload as { state: string }).state),
    ['PRE_BARRIER', 'POST_BARRIER', 'ACCEPTED', 'SETTLED'],
  );
  const serialized = JSON.stringify(events);
  assert.ok(!/U[e]{32}/.test(serialized), 'ห้ามมี recipient ใน event');
  assert.ok(!serialized.includes('synthetic-channel-access-token'));
  assert.ok(!serialized.includes('แจ้งเตือน'), 'ห้ามมีเนื้อหาข้อความ');
});

test('S2-LINE-TI01 gate ของอีก tenant ไม่ให้สิทธิ์ และ cap ของ tenant หนึ่งไม่กระทบอีกราย', async (t) => {
  const f = await setup(t);
  const a = await f.prepare(f.fixture.tenantA);
  const b = await f.prepare(f.fixture.tenantB, 'tenant-b-run');

  // ใช้ run ของ tenant A กับ delivery ของ tenant B ต้องถูกปฏิเสธ
  const crossed = await f.adapter.submit({ ...b.command, runAuthorizationId: a.run.run.id });
  assert.equal(crossed.status, 'DENIED');
  assert.equal(f.transport.requests.length, 0, 'ถูกปฏิเสธก่อนแตะ transport');

  f.transport.script(ok('req-a'), ok('req-b'));
  assert.equal((await f.adapter.submit(a.command)).status, 'ACCEPTED');
  assert.equal((await f.adapter.submit(b.command)).status, 'ACCEPTED');
});
