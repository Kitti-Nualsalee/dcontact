/**
 * S2.1 (#365) acceptance: persistence foundation ของ LINE provider บน Postgres จริงด้วย
 * application role (RLS ทำงาน) — ไม่มี network, SDK, credential value หรือ PII ใน fixture
 *
 * ครอบคลุม: composite binding, uniqueness/idempotency, append-only, race-safe primitives,
 * two-tenant ID/binding swap แบบ generic และ mixed-version guard ของ worker เดิม
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  actionKey,
  contactId,
  reservationId,
  tenantId,
  type ContactGovernancePort,
} from '@d-contact/cxa-contracts';
import { DeliveryTestAdapter } from './delivery-test-adapter.js';
import {
  createLinePersistenceFixture,
  digest,
  PILOT_CHANNEL_ACCOUNT_ID,
  type LinePersistenceFixture,
} from './line-persistence-fixture.js';
import {
  LineBindingRejectedError,
  LineIdempotencyConflictError,
} from './line-repository-support.js';

async function fixture(t: TestContext): Promise<LinePersistenceFixture> {
  const context = await createLinePersistenceFixture();
  t.after(() => context.dispose());
  return context;
}

const T0 = new Date('2026-09-22T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** error ที่ DB โยนกลับมาต้องไม่มี ID ของ tenant อื่นหลุดออกไป */
async function rejectsGenerically(work: Promise<unknown>, ...secrets: string[]) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof LineBindingRejectedError, String(error));
    for (const secret of secrets) assert.ok(!error.message.includes(secret));
    return true;
  });
}

// ── Provider attempt receipts ────────────────────────────────────────────────

test('attempt receipt: replay เดิมคืนแถวเดิม, input ต่างเป็น conflict และได้ผลแล้วห้ามต่อ', async (t) => {
  const context = await fixture(t);
  const delivery = await context.seedDelivery(context.tenantA);
  const base = {
    tenantId: context.tenantA,
    deliveryId: delivery.deliveryId,
    providerRequestKey: delivery.providerRequestKey,
    providerPayloadDigest: digest('canonical-payload'),
  };

  const unknown = {
    ...base,
    id: randomUUID(),
    attemptNo: 1,
    startedAt: at(1),
    finishedAt: at(2),
    outcomeCode: 'LINE_UNKNOWN_OUTCOME' as const,
  };
  const first = await context.attempts.record(unknown);
  assert.equal(first.outcomeClass, 'RETRYABLE_UNKNOWN');
  assert.equal((await context.attempts.record({ ...unknown, id: randomUUID() })).id, first.id);
  await assert.rejects(
    context.attempts.record({ ...unknown, id: randomUUID(), httpStatus: 503 }),
    LineIdempotencyConflictError,
  );

  const accepted = await context.attempts.record({
    ...base,
    id: randomUUID(),
    attemptNo: 2,
    startedAt: at(3),
    finishedAt: at(3),
    httpStatus: 409,
    outcomeCode: 'LINE_ACCEPTED_REPLAY',
    lineRequestId: 'req-2',
    lineAcceptedRequestId: 'req-accepted-1',
    sentMessageIds: ['461230966842064897'],
  });
  assert.equal(accepted.outcomeClass, 'ACCEPTED');

  await assert.rejects(
    context.attempts.record({
      ...base,
      id: randomUUID(),
      attemptNo: 3,
      startedAt: at(4),
      finishedAt: at(4),
      outcomeCode: 'LINE_UNKNOWN_OUTCOME',
    }),
    /DL_LINE_ATTEMPT_AFTER_OUTCOME/,
  );
  assert.deepEqual(
    (await context.attempts.listForDelivery(context.tenantA, delivery.deliveryId)).map(
      (row) => row.attemptNo,
    ),
    [1, 2],
  );
});

test('attempt receipt: ผูก providerRequestKey เดิมและ LINE outbox เท่านั้น, เรียงต่อกัน, จบใน 24 ชม.', async (t) => {
  const context = await fixture(t);
  const delivery = await context.seedDelivery(context.tenantA);
  const testDelivery = await context.seedDelivery(context.tenantA, 'TEST_ADAPTER');
  const attempt = (overrides: Record<string, unknown>) => ({
    id: randomUUID(),
    tenantId: context.tenantA,
    deliveryId: delivery.deliveryId,
    providerRequestKey: delivery.providerRequestKey,
    attemptNo: 1,
    providerPayloadDigest: digest('payload'),
    startedAt: at(0),
    finishedAt: at(0),
    outcomeCode: 'LINE_PROVIDER_UNAVAILABLE' as const,
    httpStatus: 500,
    ...overrides,
  });

  // key ใหม่ = binding ไม่ตรงกับ outbox → generic rejection ไม่ใช่ receipt ใหม่
  await rejectsGenerically(context.attempts.record(attempt({ providerRequestKey: randomUUID() })));
  await rejectsGenerically(
    context.attempts.record(
      attempt({
        deliveryId: testDelivery.deliveryId,
        providerRequestKey: testDelivery.providerRequestKey,
      }),
    ),
  );
  await assert.rejects(
    context.attempts.record(attempt({ attemptNo: 2 })),
    /DL_LINE_ATTEMPT_SEQUENCE/,
  );
  // BEFORE INSERT trigger ทำงานก่อน CHECK จึงอาจชนข้อใดข้อหนึ่งก่อน — ทั้งคู่ปฏิเสธ attempt ที่ 5
  await assert.rejects(
    context.attempts.record(attempt({ attemptNo: 5 })),
    /DL_LINE_ATTEMPT_SEQUENCE|attempt_no_check/,
  );

  await context.attempts.record(attempt({}));
  await assert.rejects(
    context.attempts.record(
      attempt({ attemptNo: 2, startedAt: at(24 * 60), finishedAt: at(24 * 60) }),
    ),
    /DL_LINE_RETRY_WINDOW_EXPIRED/,
  );
  await context.attempts.record(
    attempt({ attemptNo: 2, startedAt: at(24 * 60 - 1), finishedAt: at(24 * 60 - 1) }),
  );
  // quarantine หลัง window เป็นการปิดงาน ไม่ใช่ HTTP retry จึงบันทึกได้
  const expired = await context.attempts.record(
    attempt({
      attemptNo: 3,
      startedAt: at(24 * 60 + 5),
      finishedAt: at(24 * 60 + 5),
      httpStatus: undefined,
      outcomeCode: 'LINE_RETRY_WINDOW_EXPIRED',
    }),
  );
  assert.equal(expired.outcomeClass, 'QUARANTINED');
});

test('attempt receipt: class/rejection/acceptance evidence ถูกตรวจทั้งใน contract และ DB', async (t) => {
  const context = await fixture(t);
  const delivery = await context.seedDelivery(context.tenantA);
  const base = {
    id: randomUUID(),
    tenantId: context.tenantA,
    deliveryId: delivery.deliveryId,
    providerRequestKey: delivery.providerRequestKey,
    attemptNo: 1,
    providerPayloadDigest: digest('payload'),
    startedAt: at(0),
    finishedAt: at(0),
  };
  await assert.rejects(
    context.attempts.record({
      ...base,
      outcomeCode: 'LINE_AUTH_INVALID',
      rejectionScope: 'RECIPIENT',
      httpStatus: 401,
    }),
    /LINE_AUTH_INVALID/,
  );
  // 2xx ที่ไม่มี x-line-request-id ไม่ใช่หลักฐาน acceptance
  await assert.rejects(
    context.attempts.record({ ...base, outcomeCode: 'LINE_ACCEPTED', httpStatus: 200 }),
    /acceptance_check/,
  );
  // caller ที่ข้าม repository แล้วยัด class เองก็ยังผ่าน CHECK ไม่ได้
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `INSERT INTO dl_provider_submission_attempts (id, tenant_id, delivery_id, provider_request_key, attempt_no, provider_payload_digest, started_at, finished_at, outcome_code, outcome_class)
       VALUES ('${randomUUID()}', '${context.tenantA}', '${delivery.deliveryId}', '${delivery.providerRequestKey}', 1, '${digest('x')}', now(), now(), 'LINE_UNKNOWN_OUTCOME', 'ACCEPTED')`,
    ),
    /class_check/,
  );
  const recipientReject = await context.attempts.record({
    ...base,
    outcomeCode: 'LINE_REQUEST_REJECTED',
    rejectionScope: 'RECIPIENT',
    httpStatus: 400,
    lineRequestId: 'req-reject',
  });
  assert.equal(recipientReject.rejectionScope, 'RECIPIENT');
});

test('attempt receipt และ audit เป็น append-only สำหรับ application role', async (t) => {
  const context = await fixture(t);
  const delivery = await context.seedDelivery(context.tenantA);
  const receipt = await context.attempts.record({
    id: randomUUID(),
    tenantId: context.tenantA,
    deliveryId: delivery.deliveryId,
    providerRequestKey: delivery.providerRequestKey,
    attemptNo: 1,
    providerPayloadDigest: digest('payload'),
    startedAt: at(0),
    finishedAt: at(0),
    outcomeCode: 'LINE_UNKNOWN_OUTCOME',
  });
  const event = await context.audit.append({
    id: randomUUID(),
    tenantId: context.tenantA,
    eventId: `provider-attempt:${receipt.id}`,
    category: 'PROVIDER',
    code: 'LINE_UNKNOWN_OUTCOME',
    actorKind: 'SYSTEM',
    actorRef: 'line-outbound-worker',
    deliveryId: delivery.deliveryId,
    occurredAt: at(0),
  });

  for (const sql of [
    `UPDATE dl_provider_submission_attempts SET http_status = 200 WHERE id = '${receipt.id}'`,
    `DELETE FROM dl_provider_submission_attempts WHERE id = '${receipt.id}'`,
    `UPDATE dl_line_audit_events SET code = 'TAMPERED' WHERE id = '${event.id}'`,
    `DELETE FROM dl_line_audit_events WHERE id = '${event.id}'`,
  ]) {
    await assert.rejects(context.asApplication(context.tenantA, sql), /permission denied/, sql);
  }
  // owner ที่มีสิทธิ์ UPDATE ก็ยังชน trigger — หลักฐานแก้ย้อนหลังไม่ได้ทั้งสองชั้น
  await assert.rejects(
    context.owner.$executeRawUnsafe(
      `UPDATE dl_provider_submission_attempts SET http_status = 200 WHERE id = '${receipt.id}'`,
    ),
    /DL_LINE_APPEND_ONLY/,
  );

  assert.equal(
    (
      await context.audit.append({
        id: randomUUID(),
        tenantId: context.tenantA,
        eventId: `provider-attempt:${receipt.id}`,
        category: 'PROVIDER',
        code: 'LINE_UNKNOWN_OUTCOME',
        actorKind: 'SYSTEM',
        actorRef: 'line-outbound-worker',
        deliveryId: delivery.deliveryId,
        occurredAt: at(0),
      })
    ).id,
    event.id,
  );
  await assert.rejects(
    context.audit.append({
      id: randomUUID(),
      tenantId: context.tenantA,
      eventId: `provider-attempt:${receipt.id}`,
      category: 'PROVIDER',
      code: 'LINE_ACCEPTED',
      actorKind: 'SYSTEM',
      actorRef: 'line-outbound-worker',
      occurredAt: at(0),
    }),
    LineIdempotencyConflictError,
  );
});

// ── Rollout gate ─────────────────────────────────────────────────────────────

test('gate: สร้างพร้อมกันได้แถวเดียว, CAS, เลื่อนทีละขั้น และ kill latch ชนะทุก state', async (t) => {
  const context = await fixture(t);
  const scope = context.scope(context.tenantA);
  const created = await Promise.all(
    Array.from({ length: 5 }, () => context.control.ensureGate(randomUUID(), scope)),
  );
  assert.equal(new Set(created.map((gate) => gate.id)).size, 1);
  const gate = created[0];
  assert.equal(gate.businessState, 'DISABLED');

  const dryRun = await context.control.compareAndSetGate(context.tenantA, gate.id, 1, {
    businessState: 'DRY_RUN',
  });
  assert.equal(dryRun?.version, 2);
  assert.equal(
    await context.control.compareAndSetGate(context.tenantA, gate.id, 1, {
      technicalSwitchOn: true,
    }),
    null,
    'version เก่าต้องไม่เขียนทับ',
  );
  await assert.rejects(
    context.control.compareAndSetGate(context.tenantA, gate.id, 2, {
      businessState: 'CAPPED_PILOT',
    }),
    /DL_LINE_GATE_STEP/,
  );
  await assert.rejects(
    context.control.compareAndSetGate(context.tenantA, gate.id, 2, {
      businessState: 'PROVIDER_CONFORMANCE',
    }),
    /config_check/,
    'ออกจาก DRY_RUN ต้องมี config digest',
  );
  const conformance = await context.control.compareAndSetGate(context.tenantA, gate.id, 2, {
    businessState: 'PROVIDER_CONFORMANCE',
    configDigest: digest('config-v1'),
    technicalSwitchOn: true,
  });
  assert.equal(conformance?.businessState, 'PROVIDER_CONFORMANCE');

  const killed = await context.control.killGate(context.tenantA, gate.id, 'AUTH_FAILURE', at(5));
  assert.equal(killed.killed, true);
  assert.equal(killed.technicalSwitchOn, false, 'kill ต้องปิด switch ในแถวเดียวกัน');
  const again = await context.control.killGate(context.tenantA, gate.id, 'OPERATOR_KILL', at(6));
  assert.equal(again.killReason, 'AUTH_FAILURE', 'kill ซ้ำไม่เขียนทับเหตุผลเดิม');
  assert.equal(again.version, killed.version);

  await assert.rejects(
    context.control.compareAndSetGate(context.tenantA, gate.id, killed.version, {
      businessState: 'CAPPED_PILOT',
    }),
    /DL_LINE_GATE_KILLED_ADVANCE/,
  );
  await assert.rejects(
    context.control.compareAndSetGate(context.tenantA, gate.id, killed.version, {
      technicalSwitchOn: true,
    }),
    /kill_check/,
  );
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `UPDATE dl_line_scope_gates SET killed = false, kill_reason = NULL, killed_at = NULL, version = version + 1 WHERE id = '${gate.id}'`,
    ),
    /DL_LINE_GATE_KILL_CLEAR_REF/,
  );
  const cleared = await context.control.clearGateKill(
    context.tenantA,
    gate.id,
    killed.version,
    'approval:kill-clear:0001',
  );
  assert.equal(cleared?.killed, false);
  assert.equal(cleared?.businessState, 'DISABLED');
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `DELETE FROM dl_line_scope_gates WHERE id = '${gate.id}'`,
    ),
    /permission denied/,
  );
});

// ── Run authorization ────────────────────────────────────────────────────────

test('run authorization: approval ครบสอง role, consume ได้ครั้งเดียวเมื่อแข่งกัน และ proposal แก้ไม่ได้', async (t) => {
  const context = await fixture(t);
  const { run, proposedAt } = await context.seedApprovedRun(context.tenantA);
  assert.equal(run.state, 'APPROVED');
  const deliveries = await Promise.all(
    Array.from({ length: 5 }, () => context.seedDelivery(context.tenantA)),
  );

  const results = await Promise.all(
    deliveries.map((delivery) =>
      context.control.consumeRun(context.tenantA, run.id, delivery.deliveryId, at(1)),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'CONSUMED').length, 1);
  assert.deepEqual(
    results.filter((result) => result.status === 'DENIED').map((result) => result.code),
    Array(4).fill('RUN_AUTHORIZATION_CONSUMED'),
  );

  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `UPDATE dl_line_run_authorizations SET state = 'APPROVED', consumed_at = NULL, consumed_delivery_id = NULL WHERE id = '${run.id}'`,
    ),
    /DL_LINE_RUN_CLOSED/,
  );

  const second = await context.seedApprovedRun(context.tenantA, 'second');
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `UPDATE dl_line_run_authorizations SET config_digest = '${digest('other')}' WHERE id = '${second.run.id}'`,
    ),
    /DL_LINE_RUN_PINNED/,
  );
  const expired = await context.control.consumeRun(
    context.tenantA,
    second.run.id,
    deliveries[1]!.deliveryId,
    new Date(proposedAt.getTime() + 31 * 60_000),
  );
  assert.deepEqual(expired, { status: 'DENIED', code: 'RUN_AUTHORIZATION_EXPIRED' });
  // delivery ที่ consume authorization ใบหนึ่งไปแล้ว consume ใบที่สองไม่ได้
  const winner = results.findIndex((result) => result.status === 'CONSUMED');
  await assert.rejects(
    context.control.consumeRun(
      context.tenantA,
      second.run.id,
      deliveries[winner]!.deliveryId,
      at(2),
    ),
    LineIdempotencyConflictError,
  );
});

test('run authorization: TTL เกิน 30 นาทีหรือ cap เกิน profile ถูกปฏิเสธที่ DB', async (t) => {
  const context = await fixture(t);
  const { gate, allowlist, credential } = await context.seedApprovedRun(context.tenantA);
  const proposal = {
    id: randomUUID(),
    tenantId: context.tenantA,
    gateId: gate.id,
    allowlistEntryId: allowlist.id,
    credentialRefId: credential.id,
    credentialVersion: credential.version,
    proposalDigest: digest(randomUUID()),
    configDigest: digest('config-v1'),
    capLogicalDeliveries: 1,
    capProviderAttempts: 4,
    proposedBy: 'platform-operator-1',
    proposedAt: T0,
    expiresAt: at(30),
  };
  await assert.rejects(
    context.control.proposeRun({ ...proposal, expiresAt: at(31) }),
    /caps_check/,
  );
  await assert.rejects(
    context.control.proposeRun({ ...proposal, capLogicalDeliveries: 2 }),
    /caps_check/,
  );
  await assert.rejects(
    context.control.proposeRun({ ...proposal, capProviderAttempts: 5 }),
    /caps_check/,
  );
  const created = await context.control.proposeRun(proposal);
  assert.equal(
    (await context.control.proposeRun({ ...proposal, id: randomUUID() })).id,
    created.id,
  );
  // approval role เดิมซ้ำไม่นับเป็น approval ที่สอง
  await context.control.approveRun(context.tenantA, created.id, 'TENANT_ADMIN', 'admin-1', T0);
  assert.equal(
    await context.control.approveRun(context.tenantA, created.id, 'TENANT_ADMIN', 'admin-2', T0),
    null,
  );
  assert.equal(
    (await context.control.consumeRun(context.tenantA, created.id, 'unused', at(1))).status,
    'DENIED',
  );
});

// ── Cap ledger ───────────────────────────────────────────────────────────────

test('cap ledger: จองพร้อมกันเกิน limit ไม่ได้, kill ปิดการจองใหม่ และ COMMITTED คืนไม่ได้', async (t) => {
  const context = await fixture(t);
  const { gate, run, allowlist } = await context.seedApprovedRun(context.tenantA);
  const deliveries = await Promise.all(
    Array.from({ length: 6 }, () => context.seedDelivery(context.tenantA)),
  );
  const reserve = (deliveryId: string, recipient = allowlist.recipientFingerprint) =>
    context.control.reserveCap({
      id: randomUUID(),
      tenantId: context.tenantA,
      gateId: gate.id,
      runAuthorizationId: run.id,
      deliveryId,
      capKind: 'LOGICAL_DELIVERY',
      recipientFingerprint: recipient,
      reservedAt: at(1),
      limits: [
        {
          code: 'SUBMISSION_WINDOW_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: 3,
          since: at(-24 * 60),
        },
        {
          code: 'CONTACT_WINDOW_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: 1,
          sameRecipient: true,
          since: at(-24 * 60),
        },
      ],
    });

  const racing = await Promise.all(deliveries.slice(0, 4).map((d) => reserve(d.deliveryId)));
  assert.equal(racing.filter((result) => result.status === 'RESERVED').length, 1);
  assert.ok(
    racing.every(
      (result) => result.status === 'RESERVED' || result.code === 'CONTACT_WINDOW_CAP_EXCEEDED',
    ),
  );
  const winner = racing.findIndex((result) => result.status === 'RESERVED');
  const replay = await reserve(deliveries[winner]!.deliveryId);
  assert.equal(replay.status === 'RESERVED' && replay.replay, true);

  // recipient อื่นยังจองได้จนชน cap รวมของวัน (3)
  assert.equal((await reserve(deliveries[4]!.deliveryId, digest('r2'))).status, 'RESERVED');
  assert.equal(
    await context.control.settleCap(
      context.tenantA,
      deliveries[winner]!.deliveryId,
      'LOGICAL_DELIVERY',
      0,
      'COMMITTED',
      at(2),
    ),
    true,
  );
  assert.equal(
    await context.control.settleCap(
      context.tenantA,
      deliveries[winner]!.deliveryId,
      'LOGICAL_DELIVERY',
      0,
      'RELEASED',
      at(3),
    ),
    false,
    'ข้าม barrier แล้วคืนหน่วยไม่ได้',
  );

  await context.control.killGate(context.tenantA, gate.id, 'CAP_ACCOUNTING_INCONSISTENCY', at(4));
  assert.deepEqual(await reserve(deliveries[5]!.deliveryId, digest('r3')), {
    status: 'DENIED',
    code: 'LINE_GATE_KILLED',
  });
});

// ── Credential reference ─────────────────────────────────────────────────────

test('credential ref: เก็บแค่ reference, v2.1 ≤ 30 วัน, long-lived ต้องมี exception และ rotation atomic', async (t) => {
  const context = await fixture(t);
  const credential = (overrides: Record<string, unknown>) => ({
    id: randomUUID(),
    tenantId: context.tenantA,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1' as const,
    version: 1,
    keychainService: 'd-contact.line.2007056595',
    keychainAccount: 'channel-access-token',
    fingerprint: digest(randomUUID()),
    issuedAt: T0,
    expiresAt: new Date(T0.getTime() + 30 * 24 * 3600_000),
    ...overrides,
  });
  await assert.rejects(
    context.control.registerCredentialRef(
      credential({ expiresAt: new Date(T0.getTime() + 31 * 24 * 3600_000) }),
    ),
    /kind_check/,
  );
  await assert.rejects(
    context.control.registerCredentialRef(
      credential({ credentialKind: 'CHANNEL_ACCESS_TOKEN_LONG_LIVED', expiresAt: undefined }),
    ),
    /kind_check/,
  );
  // ค่าที่ไม่ใช่ชื่อ reference (มีช่องว่าง/สัญลักษณ์แบบ secret) เข้าช่อง reference ไม่ได้
  await assert.rejects(
    context.control.registerCredentialRef(
      credential({ keychainService: 'value with spaces/and=padding==' }),
    ),
    /values_check/,
  );

  const v1 = await context.control.registerCredentialRef(credential({}));
  const v2 = await context.control.registerCredentialRef(credential({ version: 2 }));
  assert.equal(
    (await context.control.activateCredentialRef(context.tenantA, v1.id, T0, T0))?.status,
    'ACTIVE',
  );
  const rotated = await context.control.activateCredentialRef(context.tenantA, v2.id, at(1), at(1));
  assert.equal(rotated?.status, 'ACTIVE');
  const active = await context.owner.dlLineCredentialRef.findMany({
    where: { tenantId: context.tenantA, status: 'ACTIVE' },
  });
  assert.deepEqual(
    active.map((row) => row.version),
    [2],
  );
  assert.equal(await context.control.revokeCredentialRef(context.tenantA, v1.id, at(2)), true);
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `UPDATE dl_line_credential_refs SET status = 'ACTIVE' WHERE id = '${v1.id}'`,
    ),
    /DL_LINE_CREDENTIAL_REVOKED/,
  );

  const columns = await context.owner.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'dl_line_credential_refs'`,
  );
  assert.ok(
    columns.every(
      ({ column_name }) => !/^(secret|token|value|access_token|channel_secret)$/.test(column_name),
    ),
    'ต้องไม่มีคอลัมน์สำหรับ secret value',
  );
});

// ── Webhook inbox + Touch correlation ────────────────────────────────────────

test('webhook inbox: batch atomic, duplicate no-op, hash ต่าง quarantine + audit, claim ไม่ทับกัน', async (t) => {
  const context = await fixture(t);
  const event = (webhookEventId: string, overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    webhookEventId,
    payloadHash: digest(`payload-${webhookEventId}`),
    eventType: 'message',
    deliveryMode: 'active' as const,
    isRedelivery: false,
    providerTimestamp: T0,
    protectedPayloadRef: `prot:webhook:${randomUUID()}`,
    ...overrides,
  });
  const batch = (events: ReturnType<typeof event>[]) =>
    context.webhooks.acceptBatch({
      tenantId: context.tenantA,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      receivedAt: at(0),
      events,
    });

  assert.deepEqual(await batch([]), []);
  // event ที่สองผิด (payload ref เป็น LINE user ID) → ทั้ง request ไม่มีแถวใดเลย
  await assert.rejects(
    batch([
      event('01J0ATOMICA'),
      event('01J0ATOMICB', { protectedPayloadRef: `raw:U${'a'.repeat(32)}` }),
    ]),
    /values_check/,
  );
  assert.equal(
    await context.owner.dlLineWebhookInboxEntry.count({ where: { tenantId: context.tenantA } }),
    0,
  );

  const first = await batch([
    event('01J0EVENT1'),
    event('01J0EVENT2', { eventType: 'futureType' }),
  ]);
  assert.deepEqual(
    first.map((row) => row.code),
    ['WEBHOOK_ACCEPTED', 'WEBHOOK_ACCEPTED'],
  );
  const redelivered = await batch([event('01J0EVENT1', { isRedelivery: true })]);
  assert.equal(redelivered[0]?.code, 'WEBHOOK_DUPLICATE');
  assert.equal(redelivered[0]?.inboxEntryId, first[0]?.inboxEntryId);

  const conflict = await batch([event('01J0EVENT2', { payloadHash: digest('tampered') })]);
  assert.equal(conflict[0]?.code, 'WEBHOOK_IDEMPOTENCY_CONFLICT');
  const quarantined = await context.owner.dlLineWebhookInboxEntry.findFirstOrThrow({
    where: { id: first[1]!.inboxEntryId },
  });
  assert.equal(quarantined.state, 'QUARANTINED');
  assert.equal(quarantined.payloadHash, digest('payload-01J0EVENT2'), 'ห้ามเขียนทับ payload เดิม');
  assert.equal((await context.audit.list(context.tenantA, 'WEBHOOK')).length, 1);

  await batch([event('01J0EVENT3'), event('01J0EVENT4')]);
  const [workerA, workerB] = await Promise.all([
    context.webhooks.claim(context.tenantA, 'worker-a', at(1), 60_000, 2),
    context.webhooks.claim(context.tenantA, 'worker-b', at(1), 60_000, 2),
  ]);
  const claimed = [...workerA, ...workerB].map((row) => row.id);
  assert.equal(claimed.length, new Set(claimed).size, 'worker สองตัวต้องไม่หยิบ event เดียวกัน');
  assert.equal(claimed.length, 3);

  const mine = workerA[0] ?? workerB[0]!;
  const owner = workerA[0] ? 'worker-a' : 'worker-b';
  assert.equal(await context.webhooks.complete(context.tenantA, mine.id, 'worker-z', at(2)), false);
  assert.equal(await context.webhooks.complete(context.tenantA, mine.id, owner, at(2)), true);
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `UPDATE dl_line_webhook_inbox SET state = 'PENDING', completed_at = NULL, outcome_code = NULL WHERE id = '${mine.id}'`,
    ),
    /DL_LINE_INBOX_TERMINAL/,
  );
  // lease หมด = worker ตาย → worker อื่นหยิบต่อได้หลัง restart
  const recovered = await context.webhooks.claim(context.tenantA, 'worker-c', at(5), 60_000, 10);
  assert.equal(recovered.length, 2);
  assert.ok(recovered.every((row) => row.attempts === 2));
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `DELETE FROM dl_line_webhook_inbox WHERE id = '${mine.id}'`,
    ),
    /permission denied/,
  );
});

test('touch correlation: redelivery replay, bind ครั้งเดียวต่อ Attempt และ cg_touches มี evidence ref แบบ unique', async (t) => {
  const context = await fixture(t);
  const delivery = await context.seedDelivery(context.tenantA);
  const attemptId = await context.seedAcceptedAttempt(delivery);
  const [inboxA, inboxB] = await context.webhooks.acceptBatch({
    tenantId: context.tenantA,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    receivedAt: at(2),
    events: ['01J0QUOTE1', '01J0QUOTE2'].map((webhookEventId) => ({
      id: randomUUID(),
      webhookEventId,
      payloadHash: digest(webhookEventId),
      eventType: 'message',
      deliveryMode: 'active' as const,
      isRedelivery: false,
      providerTimestamp: at(2),
      protectedPayloadRef: `prot:webhook:${randomUUID()}`,
    })),
  });
  const open = (inboxEntryId: string, ref: string) =>
    context.webhooks.openCorrelation({
      id: randomUUID(),
      tenantId: context.tenantA,
      inboxEntryId,
      evidenceKind: 'USER_QUOTED_RESPONSE',
      responseEvidenceRef: ref,
      quotedMessageId: '461230966842064897',
      providerTimestamp: at(2),
      windowExpiresAt: at(24 * 60),
    });

  const first = await open(inboxA!.inboxEntryId, `rsp:${PILOT_CHANNEL_ACCOUNT_ID}:01J0QUOTE1`);
  assert.equal((await open(inboxA!.inboxEntryId, first.responseEvidenceRef)).id, first.id);
  await assert.rejects(open(inboxA!.inboxEntryId, `rsp:U${'b'.repeat(32)}`), /values_check/);
  const second = await open(inboxB!.inboxEntryId, `rsp:${PILOT_CHANNEL_ACCOUNT_ID}:01J0QUOTE2`);

  const bound = await context.webhooks.bindCorrelation(
    context.tenantA,
    first.id,
    delivery.deliveryId,
    attemptId,
    at(3),
  );
  assert.equal(bound?.state, 'BOUND');
  await assert.rejects(
    context.webhooks.bindCorrelation(
      context.tenantA,
      second.id,
      delivery.deliveryId,
      attemptId,
      at(3),
    ),
    LineIdempotencyConflictError,
    'Attempt หนึ่งมี Touch ได้ครั้งเดียว',
  );
  assert.equal(
    await context.webhooks.quarantineCorrelation(
      context.tenantA,
      second.id,
      'USER_RESPONSE_UNBOUND',
      at(4),
    ),
    true,
  );
  assert.equal(
    await context.webhooks.bindCorrelation(
      context.tenantA,
      first.id,
      delivery.deliveryId,
      attemptId,
      at(5),
    ),
    null,
    'BOUND แล้ว resolve ซ้ำไม่ได้',
  );

  // Governance-owned additive columns: evidence ต้องมาคู่กันและ ref ใช้ได้ครั้งเดียวต่อ tenant
  const touch = {
    tenantId: context.tenantA,
    attemptId,
    reservationId: delivery.reservationId,
    deliveryId: delivery.deliveryId,
    outcomeRef: `ocr_touch_${randomUUID()}`,
    contactId: (await context.owner.cgAttempt.findFirstOrThrow({ where: { id: attemptId } }))
      .contactId,
    channel: 'LINE' as const,
    purpose: 'SERVICE_NOTIFICATION',
    source: 'JOURNEY',
    outcome: 'PROVIDER_ACCEPTED' as const,
    occurredAt: at(3),
    correlationId: 'corr-touch',
  };
  await assert.rejects(
    context.owner.cgTouch.create({ data: { ...touch, evidenceKind: 'USER_QUOTED_RESPONSE' } }),
    /cg_touches_response_evidence_check/,
  );
  await context.owner.cgTouch.create({
    data: {
      ...touch,
      evidenceKind: 'USER_QUOTED_RESPONSE',
      responseEvidenceRef: first.responseEvidenceRef,
    },
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

test('two-tenant: ID/binding ของ tenant อื่นถูกปฏิเสธแบบ generic และมองไม่เห็นข้ามกัน', async (t) => {
  const context = await fixture(t);
  const deliveryA = await context.seedDelivery(context.tenantA);
  const attemptA = await context.seedAcceptedAttempt(deliveryA);
  const runA = await context.seedApprovedRun(context.tenantA);
  const runB = await context.seedApprovedRun(context.tenantB);
  const deliveryB = await context.seedDelivery(context.tenantB);

  // tenant B ใช้ delivery/key ของ A
  await rejectsGenerically(
    context.attempts.record({
      id: randomUUID(),
      tenantId: context.tenantB,
      deliveryId: deliveryA.deliveryId,
      providerRequestKey: deliveryA.providerRequestKey,
      attemptNo: 1,
      providerPayloadDigest: digest('payload'),
      startedAt: at(0),
      finishedAt: at(0),
      outcomeCode: 'LINE_UNKNOWN_OUTCOME',
    }),
    deliveryA.deliveryId,
    context.tenantA,
  );
  // tenant B จอง cap บน gate/run ของ A
  await rejectsGenerically(
    context.control.reserveCap({
      id: randomUUID(),
      tenantId: context.tenantB,
      gateId: runA.gate.id,
      runAuthorizationId: runA.run.id,
      deliveryId: deliveryB.deliveryId,
      capKind: 'LOGICAL_DELIVERY',
      recipientFingerprint: digest('r'),
      reservedAt: at(0),
      limits: [],
    }),
    runA.gate.id,
  );
  // tenant B ผูก run ของตัวเองกับ gate ของ A (binding swap ภายใน row)
  await rejectsGenerically(
    context.control.reserveCap({
      id: randomUUID(),
      tenantId: context.tenantB,
      gateId: runB.gate.id,
      runAuthorizationId: runA.run.id,
      deliveryId: deliveryB.deliveryId,
      capKind: 'LOGICAL_DELIVERY',
      recipientFingerprint: digest('r'),
      reservedAt: at(0),
      limits: [],
    }),
    runA.run.id,
  );
  // tenant B consume authorization ของ A / ผูก delivery ของ A
  assert.deepEqual(
    await context.control.consumeRun(context.tenantB, runA.run.id, deliveryB.deliveryId, at(1)),
    { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' },
  );
  await rejectsGenerically(
    context.control.consumeRun(context.tenantB, runB.run.id, deliveryA.deliveryId, at(1)),
    deliveryA.deliveryId,
  );
  // allowlist ของ B ที่อ้าง gate ของ A
  await rejectsGenerically(
    context.control.addAllowlistEntry({
      id: randomUUID(),
      ...context.scope(context.tenantB),
      gateId: runA.gate.id,
      recipientFingerprint: digest('r'),
      recipientProtectedRef: `prot:recipient:${randomUUID()}`,
      contentRef: 'fixture:service-notification/v1',
      contentDigest: digest('content-v1'),
      configDigest: digest('config-v1'),
      validFrom: T0,
      validUntil: at(60),
      approvalAuditRef: 'audit:allowlist:swap',
    }),
  );
  // correlation ของ B ผูก Attempt/delivery ของ A
  const [inboxB] = await context.webhooks.acceptBatch({
    tenantId: context.tenantB,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    receivedAt: at(2),
    events: [
      {
        id: randomUUID(),
        webhookEventId: '01J0SWAP01',
        payloadHash: digest('swap'),
        eventType: 'message',
        deliveryMode: 'active',
        isRedelivery: false,
        providerTimestamp: at(2),
        protectedPayloadRef: `prot:webhook:${randomUUID()}`,
      },
    ],
  });
  const correlationB = await context.webhooks.openCorrelation({
    id: randomUUID(),
    tenantId: context.tenantB,
    inboxEntryId: inboxB!.inboxEntryId,
    evidenceKind: 'USER_QUOTED_RESPONSE',
    responseEvidenceRef: `rsp:${PILOT_CHANNEL_ACCOUNT_ID}:01J0SWAP01`,
    quotedMessageId: '461230966842064897',
    providerTimestamp: at(2),
    windowExpiresAt: at(60),
  });
  await rejectsGenerically(
    context.webhooks.bindCorrelation(
      context.tenantB,
      correlationB.id,
      deliveryB.deliveryId,
      attemptA,
      at(3),
    ),
    attemptA,
  );

  // RLS: B มองไม่เห็นแถวของ A และ update ข้าม tenant ไม่โดนแถวใด
  assert.equal(
    await context.lineOutbox.findByDeliveryId(context.tenantB, deliveryA.deliveryId),
    null,
  );
  assert.equal(
    await context.control.findGate(context.scope(context.tenantB)).then((g) => g?.id),
    runB.gate.id,
  );
  assert.equal(
    await context.asApplication(
      context.tenantB,
      `UPDATE dl_line_scope_gates SET technical_switch_on = true, version = version + 1 WHERE id = '${runA.gate.id}'`,
    ),
    0,
  );
  assert.equal(
    await context.control
      .killGate(context.tenantA, runA.gate.id, 'OPERATOR_KILL', at(1))
      .then((g) => g.killed),
    true,
  );
  await rejectsGenerically(
    context.control.killGate(context.tenantB, runA.gate.id, 'OPERATOR_KILL', at(1)),
  );
});

// ── Mixed-version / S1 compatibility ─────────────────────────────────────────

test('mixed-version: worker TEST_ADAPTER ไม่เห็น/ไม่ reconcile แถว LINE และไม่ replay actionKey ของ LINE', async (t) => {
  const context = await fixture(t);
  const line = await context.seedDelivery(context.tenantA);
  const legacy = await context.seedDelivery(context.tenantA, 'TEST_ADAPTER');
  await context.owner.dlOutboxEntry.updateMany({
    where: { tenantId: context.tenantA },
    data: { state: 'SUBMITTING' },
  });

  assert.equal(await context.testOutbox.findByDeliveryId(context.tenantA, line.deliveryId), null);
  assert.equal(
    (await context.lineOutbox.findByDeliveryId(context.tenantA, line.deliveryId))?.adapter,
    'LINE_MESSAGING_API',
  );
  const reconcilable = await context.testOutbox.findReconcilable(context.tenantA, at(24 * 60));
  assert.deepEqual(
    reconcilable.map((row) => row.deliveryId),
    [legacy.deliveryId],
  );
  assert.equal(
    await context.testOutbox.advance(context.tenantA, line.deliveryId, ['SUBMITTING'], {
      state: 'SETTLED',
    }),
    null,
    'worker เดิมเลื่อน state ของแถว LINE ไม่ได้',
  );

  // governance ห้ามถูกเรียก: actionKey ของ LINE ต้องจบที่ conflict ก่อน claim
  const governance = new Proxy({} as ContactGovernancePort, {
    get() {
      throw new Error('ห้ามแตะ Governance เมื่อ actionKey เป็นของ adapter อื่น');
    },
  });
  const adapter = new DeliveryTestAdapter(context.application, governance);
  const lineRow = await context.owner.dlOutboxEntry.findFirstOrThrow({
    where: { deliveryId: line.deliveryId },
  });
  const result = await adapter.enqueue({
    tenantId: tenantId(context.tenantA),
    source: 'JOURNEY',
    actionKey: actionKey(line.actionKey),
    reservationId: reservationId(line.reservationId),
    channel: 'LINE',
    contactId: contactId(lineRow.contactId),
    contentRef: 'fixture:service-notification/v1',
    correlationId: 'corr-mixed',
    purpose: 'SERVICE_NOTIFICATION',
    senderIdentityId: lineRow.senderIdentityId,
    leaseExpiresAt: at(10).toISOString(),
  });
  assert.deepEqual(result, { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' });
});

test('outbox: แถว LINE ต้องเป็น channel LINE + UUID key, ห้าม DELIVERED และ identity แก้ไม่ได้ทุก adapter', async (t) => {
  const context = await fixture(t);
  const line = await context.seedDelivery(context.tenantA);
  const legacy = await context.seedDelivery(context.tenantA, 'TEST_ADAPTER');

  await assert.rejects(
    context.owner.dlOutboxEntry.updateMany({
      where: { deliveryId: line.deliveryId },
      data: { state: 'SETTLED', outcome: 'DELIVERED', outcomeRef: `ocr_${randomUUID()}` },
    }),
    /dl_outbox_entries_line_binding_check/,
  );
  await context.owner.dlOutboxEntry.updateMany({
    where: { deliveryId: line.deliveryId },
    data: { state: 'SETTLED', outcome: 'PROVIDER_ACCEPTED', outcomeRef: `ocr_${randomUUID()}` },
  });
  for (const deliveryId of [line.deliveryId, legacy.deliveryId]) {
    await assert.rejects(
      context.owner.dlOutboxEntry.updateMany({
        where: { deliveryId },
        data: { providerRequestKey: randomUUID() },
      }),
      /DL_OUTBOX_IDENTITY_IMMUTABLE/,
    );
  }
  await assert.rejects(
    context.owner.$executeRawUnsafe(
      `INSERT INTO dl_outbox_entries (id, tenant_id, action_key, reservation_id, delivery_id, provider_request_key, adapter, channel, contact_id, purpose, source, sender_identity_id, content_ref, input_hash, lease_version, lease_expires_at, correlation_id, updated_at)
       SELECT gen_random_uuid(), tenant_id, action_key || '-k', reservation_id, delivery_id || '-k', 'pk_not_a_uuid', 'LINE_MESSAGING_API', 'LINE', contact_id, purpose, source, sender_identity_id, content_ref, input_hash, 1, now(), 'corr', now()
       FROM dl_outbox_entries WHERE delivery_id = '${legacy.deliveryId}'`,
    ),
    /dl_outbox_entries_line_binding_check/,
  );
});
