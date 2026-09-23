/**
 * S2.2 (#364): provider-accepted Attempt และ correlated Touch บน Postgres จริง
 *
 * Authority: outcome decision #361, delivery settlement #57 และ Phase Contract #362 §8
 * ครอบ acceptance check `S2-LINE-F04` (matrix reservation/Attempt/Touch/refund) กับ
 * `S2-LINE-ID01` (dedupe/conflict ของ response Touch) รวม duplicate/race/out-of-order/cross-tenant
 *
 * ทุก write เดินผ่าน `ContactGovernanceService` ด้วย role `dcontact_app` — ไม่มี owner อื่นเขียน cg_*
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import {
  actionKey,
  contactId,
  deliveryId,
  identityId,
  outcomeRef,
  providerRequestKey,
  reservationId,
  tenantId,
  CorrelatedTouchError,
  type CorrelatedTouchErrorCode,
  type RecordCorrelatedTouchInput,
} from '@d-contact/cxa-contracts';
import { ContactGovernanceService } from './contact-governance-service.js';

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
      },
    },
  });
  const rawTenantId = randomUUID();
  const rawContactId = randomUUID();
  const rawIdentityId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);
  let currentTime = new Date('2026-09-23T09:00:00.000Z');

  t.after(async () => {
    await owner.cgReservationCommandReceipt.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgTouch.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgAttempt.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contact.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `CG touch ${suffix}`,
      slug: `cg-touch-${suffix}`,
      sipDomain: `${suffix}.cg-touch.test`,
    },
  });
  await owner.contact.create({
    data: { id: rawContactId, tenantId: rawTenantId, displayName: 'CG touch contact' },
  });
  await owner.contactIdentity.create({
    data: {
      id: rawIdentityId,
      tenantId: rawTenantId,
      contactId: rawContactId,
      type: 'EMAIL',
      value: `touch-${suffix}@example.test`,
    },
  });

  const service = new ContactGovernanceService(application, { now: () => currentTime });

  async function reservation(label: string) {
    const rawId = randomUUID();
    await owner.cgReservation.create({
      data: {
        id: rawId,
        tenantId: rawTenantId,
        contactId: rawContactId,
        identityId: rawIdentityId,
        channel: 'LINE',
        purpose: 'SERVICE_NOTIFICATION',
        source: 'JOURNEY',
        sourceId: `journey-${label}`,
        actionKey: `action-${suffix}-${label}`,
        inputHash: `hash-${suffix}-${label}`,
        expiresAt: new Date('2026-09-23T10:00:00.000Z'),
        settlementStatus: 'UNCLAIMED',
      },
    });
    return {
      reservationId: reservationId(rawId),
      actionKey: actionKey(`action-${suffix}-${label}`),
      deliveryId: deliveryId(`delivery-${suffix}-${label}`),
      providerRequestKey: providerRequestKey(randomUUID()),
      outcomeRef: outcomeRef(`accept-${suffix}-${label}`),
    };
  }

  return {
    owner,
    application,
    service,
    tenantId: tenantId(rawTenantId),
    contactId: contactId(rawContactId),
    identityId: identityId(rawIdentityId),
    reservation,
    setNow(value: string) {
      currentTime = new Date(value);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Binding = Awaited<ReturnType<Fixture['reservation']>>;

/** เดินเส้นทางจริงจนถึง acceptance: claim → barrier → settle(PROVIDER_ACCEPTED) */
async function accept(f: Fixture, binding: Binding) {
  const base = {
    tenantId: f.tenantId,
    correlationId: `correlation-${binding.deliveryId}`,
    reservationId: binding.reservationId,
    actionKey: binding.actionKey,
    deliveryId: binding.deliveryId,
  };
  await f.service.claimReservationForDelivery({
    ...base,
    contactId: f.contactId,
    identityId: f.identityId,
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    senderIdentityId: 'sender-approved',
    leaseExpiresAt: '2026-09-23T09:15:00.000Z',
  });
  await f.service.beginProviderSubmission({
    ...base,
    expectedLeaseVersion: 1,
    providerRequestKey: binding.providerRequestKey,
  });
  const settled = await f.service.settleDelivery({
    ...base,
    providerRequestKey: binding.providerRequestKey,
    outcomeRef: binding.outcomeRef,
    outcome: 'PROVIDER_ACCEPTED',
    occurredAt: '2026-09-23T09:01:00.000Z',
  });
  const attempt = await f.owner.cgAttempt.findFirstOrThrow({
    where: { tenantId: f.tenantId, outcomeRef: binding.outcomeRef },
  });
  return { settled, attemptId: attempt.id };
}

function touchInput(
  f: Fixture,
  binding: Binding,
  attemptId: string,
  overrides: Partial<RecordCorrelatedTouchInput> = {},
): RecordCorrelatedTouchInput {
  return {
    tenantId: f.tenantId,
    correlationId: `webhook-${binding.deliveryId}`,
    reservationId: binding.reservationId,
    actionKey: binding.actionKey,
    deliveryId: binding.deliveryId,
    attemptId,
    responseEvidenceRef: outcomeRef(`evidence-${binding.deliveryId}`),
    evidenceKind: 'USER_QUOTED_RESPONSE',
    occurredAt: '2026-09-23T09:30:00.000Z',
    ...overrides,
  };
}

function touchError(expected: CorrelatedTouchErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof CorrelatedTouchError, String(error));
    assert.equal(error.code, expected);
    return true;
  };
}

async function counts(f: Fixture) {
  const [attempts, touches] = await Promise.all([
    f.owner.cgAttempt.count({ where: { tenantId: f.tenantId } }),
    f.owner.cgTouch.count({ where: { tenantId: f.tenantId } }),
  ]);
  return { attempts, touches };
}

test('acceptance settle เป็น CONFIRMED+SETTLED พร้อม Attempt 1, Touch 0, refund 0', async (t) => {
  const f = await fixture(t);
  const binding = await f.reservation('accepted');
  const { settled } = await accept(f, binding);

  assert.equal(settled.state, 'CONFIRMED');
  assert.equal(settled.status, 'SETTLED');
  assert.deepEqual(await counts(f), { attempts: 1, touches: 0 });

  const row = await f.owner.cgReservation.findUniqueOrThrow({
    where: { id: binding.reservationId },
  });
  assert.equal(row.terminalOutcome, 'PROVIDER_ACCEPTED');
  assert.equal(row.terminalOutcomeRef, binding.outcomeRef);
  assert.equal(row.refundedAt, null);
  assert.equal(row.releasedAt, null);

  const attempt = await f.owner.cgAttempt.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(attempt.outcome, 'PROVIDER_ACCEPTED');
  // acceptance ไม่ใช่ delivery และไม่ใช่ read จึงไม่มี evidence ติดมากับ Attempt
  assert.equal(attempt.deliveryId, binding.deliveryId);
});

test('quoted response และ signed postback append Touch ให้ accepted Attempt เดิมโดยไม่แตะ reservation', async (t) => {
  const f = await fixture(t);
  for (const evidenceKind of ['USER_QUOTED_RESPONSE', 'SIGNED_POSTBACK'] as const) {
    f.setNow('2026-09-23T09:00:00.000Z');
    const binding = await f.reservation(`bound-${evidenceKind}`);
    const { attemptId } = await accept(f, binding);
    const before = await f.owner.cgReservation.findUniqueOrThrow({
      where: { id: binding.reservationId },
    });

    // เวลาที่ correlate ช้ากว่า settle มาก — Touch ใช้ provider timestamp ไม่ใช่เวลาที่รับ
    f.setNow('2026-09-23T11:00:00.000Z');
    const view = await f.service.recordCorrelatedTouch(
      touchInput(f, binding, attemptId, { evidenceKind }),
    );

    assert.equal(view.attemptId, attemptId);
    assert.equal(view.evidenceKind, evidenceKind);
    assert.equal(view.occurredAt, '2026-09-23T09:30:00.000Z');

    const touch = await f.owner.cgTouch.findUniqueOrThrow({ where: { id: view.touchId } });
    assert.equal(touch.attemptId, attemptId);
    assert.equal(touch.outcome, 'PROVIDER_ACCEPTED');
    assert.equal(touch.evidenceKind, evidenceKind);
    assert.equal(touch.responseEvidenceRef, `evidence-${binding.deliveryId}`);
    assert.equal(touch.outcomeRef, binding.outcomeRef);
    assert.equal(touch.contactId, f.contactId);

    const after = await f.owner.cgReservation.findUniqueOrThrow({
      where: { id: binding.reservationId },
    });
    assert.deepEqual(after, before);
    assert.equal(
      await f.owner.cgAttempt.count({ where: { tenantId: f.tenantId, id: attemptId } }),
      1,
    );
  }
});

test('duplicate และ race ของ evidence ref เดิมคืน snapshot เดิมและสร้าง Touch ใบเดียว', async (t) => {
  const f = await fixture(t);
  const binding = await f.reservation('duplicate');
  const { attemptId } = await accept(f, binding);

  const views = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      f.service.recordCorrelatedTouch(
        touchInput(f, binding, attemptId, { correlationId: `redelivery-${index}` }),
      ),
    ),
  );
  for (const view of views) assert.deepEqual(view, views[0]);
  assert.deepEqual(await counts(f), { attempts: 1, touches: 1 });
});

test('evidence คนละใบบน Attempt เดิม และ evidence เดิมบน Attempt อื่น เป็น conflict ที่ไม่สร้างแถว', async (t) => {
  const f = await fixture(t);
  const first = await f.reservation('conflict-first');
  const second = await f.reservation('conflict-second');
  const accepted = await accept(f, first);
  const other = await accept(f, second);
  await f.service.recordCorrelatedTouch(touchInput(f, first, accepted.attemptId));

  // Attempt เดิม + evidence ใบใหม่ = Touch ซ้ำ (unique (tenant_id, attempt_id))
  await assert.rejects(
    () =>
      f.service.recordCorrelatedTouch(
        touchInput(f, first, accepted.attemptId, {
          responseEvidenceRef: outcomeRef(`evidence-other-${first.deliveryId}`),
        }),
      ),
    touchError('TOUCH_EVIDENCE_CONFLICT'),
  );
  // evidence ใบเดิม + Attempt อื่น = webhook ใบเดียวนับสอง Touch ไม่ได้
  await assert.rejects(
    () =>
      f.service.recordCorrelatedTouch(
        touchInput(f, second, other.attemptId, {
          responseEvidenceRef: outcomeRef(`evidence-${first.deliveryId}`),
        }),
      ),
    touchError('TOUCH_EVIDENCE_CONFLICT'),
  );
  // evidence เดิม/kind ต่าง = payload ไม่ตรง ต้องไม่เงียบ
  await assert.rejects(
    () =>
      f.service.recordCorrelatedTouch(
        touchInput(f, first, accepted.attemptId, { evidenceKind: 'SIGNED_POSTBACK' }),
      ),
    touchError('TOUCH_EVIDENCE_CONFLICT'),
  );
  assert.deepEqual(await counts(f), { attempts: 2, touches: 1 });
});

test('race ของ evidence สองใบบน Attempt เดียวกันให้ผู้ชนะรายเดียวและ Touch ใบเดียว', async (t) => {
  const f = await fixture(t);
  const binding = await f.reservation('race');
  const { attemptId } = await accept(f, binding);

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, index) =>
      f.service.recordCorrelatedTouch(
        touchInput(f, binding, attemptId, {
          responseEvidenceRef: outcomeRef(`evidence-race-${index}-${binding.deliveryId}`),
        }),
      ),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results) {
    if (result.status === 'rejected') touchError('TOUCH_EVIDENCE_CONFLICT')(result.reason);
  }
  assert.deepEqual(await counts(f), { attempts: 1, touches: 1 });
});

test('response ที่มาก่อน acceptance เป็น ATTEMPT_NOT_FOUND แล้ว replay หลัง acceptance สำเร็จ', async (t) => {
  const f = await fixture(t);
  const binding = await f.reservation('out-of-order');
  const unknownAttemptId = randomUUID();

  await assert.rejects(
    () => f.service.recordCorrelatedTouch(touchInput(f, binding, unknownAttemptId)),
    touchError('ATTEMPT_NOT_FOUND'),
  );
  // id ที่ไม่ใช่ UUID ต้องเป็นคำตอบเดียวกัน ไม่ใช่ error ของ driver
  await assert.rejects(
    () => f.service.recordCorrelatedTouch(touchInput(f, binding, 'not-a-uuid')),
    touchError('ATTEMPT_NOT_FOUND'),
  );
  assert.deepEqual(await counts(f), { attempts: 0, touches: 0 });

  const { attemptId } = await accept(f, binding);
  const view = await f.service.recordCorrelatedTouch(touchInput(f, binding, attemptId));
  assert.equal(view.attemptId, attemptId);
  assert.deepEqual(await counts(f), { attempts: 1, touches: 1 });
});

test('unquoted/time-only/ambiguous evidence kind ไม่สร้าง Touch', async (t) => {
  const f = await fixture(t);
  const binding = await f.reservation('no-evidence');
  const { attemptId } = await accept(f, binding);

  for (const evidenceKind of [
    'TIME_WINDOW',
    'UNQUOTED_RESPONSE',
    'AMBIGUOUS_RESPONSE',
    'DELIVERY_RECEIPT',
    '',
  ]) {
    await assert.rejects(
      () =>
        f.service.recordCorrelatedTouch(
          touchInput(f, binding, attemptId, {
            evidenceKind: evidenceKind as RecordCorrelatedTouchInput['evidenceKind'],
          }),
        ),
      touchError('TOUCH_EVIDENCE_KIND_UNSUPPORTED'),
    );
  }
  assert.deepEqual(await counts(f), { attempts: 1, touches: 0 });
});

test('binding ที่ไม่ตรงกับ Attempt ถูกปฏิเสธก่อนเขียน', async (t) => {
  const f = await fixture(t);
  const binding = await f.reservation('binding');
  const decoy = await f.reservation('binding-decoy');
  const { attemptId } = await accept(f, binding);

  for (const override of [
    { reservationId: decoy.reservationId },
    { deliveryId: decoy.deliveryId },
    { actionKey: decoy.actionKey },
  ]) {
    await assert.rejects(
      () => f.service.recordCorrelatedTouch(touchInput(f, binding, attemptId, override)),
      touchError('TOUCH_BINDING_CONFLICT'),
    );
  }
  assert.deepEqual(await counts(f), { attempts: 1, touches: 0 });
});

test('Attempt ที่ไม่ใช่ PROVIDER_ACCEPTED รับ Touch ไม่ได้', async (t) => {
  const f = await fixture(t);
  const binding = await f.reservation('rejected-attempt');
  const base = {
    tenantId: f.tenantId,
    correlationId: 'correlation-rejected',
    reservationId: binding.reservationId,
    actionKey: binding.actionKey,
    deliveryId: binding.deliveryId,
  };
  await f.service.claimReservationForDelivery({
    ...base,
    contactId: f.contactId,
    identityId: f.identityId,
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    senderIdentityId: 'sender-approved',
    leaseExpiresAt: '2026-09-23T09:15:00.000Z',
  });
  await f.service.beginProviderSubmission({
    ...base,
    expectedLeaseVersion: 1,
    providerRequestKey: binding.providerRequestKey,
  });
  await f.service.settleDelivery({
    ...base,
    providerRequestKey: binding.providerRequestKey,
    outcomeRef: binding.outcomeRef,
    outcome: 'PROVIDER_REJECTED',
    rejectionScope: 'RECIPIENT',
    occurredAt: '2026-09-23T09:01:00.000Z',
  });
  const attempt = await f.owner.cgAttempt.findFirstOrThrow({ where: { tenantId: f.tenantId } });

  await assert.rejects(
    () => f.service.recordCorrelatedTouch(touchInput(f, binding, attempt.id)),
    touchError('ATTEMPT_NOT_ACCEPTED'),
  );
  assert.deepEqual(await counts(f), { attempts: 1, touches: 0 });
});

test('cross-tenant attempt/evidence ถูกซ่อนเป็น ATTEMPT_NOT_FOUND และไม่รั่วข้าม tenant', async (t) => {
  const tenantA = await fixture(t);
  const tenantB = await fixture(t);
  const bindingA = await tenantA.reservation('cross-a');
  const bindingB = await tenantB.reservation('cross-b');
  const acceptedA = await accept(tenantA, bindingA);
  const acceptedB = await accept(tenantB, bindingB);

  await assert.rejects(
    () => tenantA.service.recordCorrelatedTouch(touchInput(tenantA, bindingA, acceptedB.attemptId)),
    touchError('ATTEMPT_NOT_FOUND'),
  );
  assert.deepEqual(await counts(tenantA), { attempts: 1, touches: 0 });

  // evidence ref ตัวเดียวกันใช้ได้พร้อมกันคนละ tenant — unique เป็นแบบ per-tenant
  const sharedRef = outcomeRef(`evidence-shared-${randomUUID().slice(0, 8)}`);
  await Promise.all([
    tenantA.service.recordCorrelatedTouch(
      touchInput(tenantA, bindingA, acceptedA.attemptId, { responseEvidenceRef: sharedRef }),
    ),
    tenantB.service.recordCorrelatedTouch(
      touchInput(tenantB, bindingB, acceptedB.attemptId, { responseEvidenceRef: sharedRef }),
    ),
  ]);
  assert.deepEqual(await counts(tenantA), { attempts: 1, touches: 1 });
  assert.deepEqual(await counts(tenantB), { attempts: 1, touches: 1 });
});

test('late correlated Touch ไม่ทำให้ replay ของ settle เดิมกลายเป็น conflict', async (t) => {
  const f = await fixture(t);
  const binding = await f.reservation('late-touch');
  const { settled, attemptId } = await accept(f, binding);
  await f.service.recordCorrelatedTouch(touchInput(f, binding, attemptId));

  const base = {
    tenantId: f.tenantId,
    correlationId: 'correlation-replay',
    reservationId: binding.reservationId,
    actionKey: binding.actionKey,
    deliveryId: binding.deliveryId,
    providerRequestKey: binding.providerRequestKey,
    outcomeRef: binding.outcomeRef,
    occurredAt: '2026-09-23T09:01:00.000Z',
  };
  const replayed = await f.service.settleDelivery({ ...base, outcome: 'PROVIDER_ACCEPTED' });
  assert.deepEqual(replayed, settled);

  // terminal ใบแรกชนะ: outcome ใบหลังไม่ย้อน state และไม่เพิ่ม fact
  const late = await f.service.settleDelivery({
    ...base,
    outcomeRef: outcomeRef(`late-${binding.deliveryId}`),
    outcome: 'DELIVERY_FAILED',
    occurredAt: '2026-09-23T09:40:00.000Z',
  });
  assert.equal(late.state, 'CONFIRMED');
  assert.equal(late.status, 'SETTLED');
  assert.deepEqual(await counts(f), { attempts: 1, touches: 1 });
});

test('trigger ของ DB ปฏิเสธ Touch ที่สร้างนอก Governance write path', async (t) => {
  const f = await fixture(t);
  const binding = await f.reservation('db-guard');
  const { attemptId } = await accept(f, binding);

  const insert = (values: Partial<Prisma.CgTouchUncheckedCreateInput>) =>
    f.owner.cgTouch.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenantId,
        attemptId,
        reservationId: binding.reservationId,
        deliveryId: binding.deliveryId,
        outcomeRef: `raw-${binding.deliveryId}`,
        contactId: f.contactId,
        channel: 'LINE',
        purpose: 'SERVICE_NOTIFICATION',
        source: 'JOURNEY',
        outcome: 'PROVIDER_ACCEPTED',
        occurredAt: new Date('2026-09-23T09:30:00.000Z'),
        correlationId: 'raw-write',
        ...values,
      },
    });

  // Touch บน accepted Attempt ที่ไม่มีหลักฐาน = time-window inference ที่ DB ต้องกัน
  await assert.rejects(
    () => insert({ outcome: 'PROVIDER_ACCEPTED' }),
    /cg_touches_provider_accepted_evidence_check/,
  );
  // outcome ที่ไม่ตรงกับ Attempt ทำให้ Touch อ้างเรื่องอื่นได้
  await assert.rejects(() => insert({ outcome: 'DELIVERED' }), /CG_TOUCH_OUTCOME_MISMATCH/);
  assert.deepEqual(await counts(f), { attempts: 1, touches: 0 });

  // evidence เกาะ Attempt ที่ไม่ใช่ acceptance ไม่ได้ แม้ outcome จะตรงกับ Attempt นั้น
  const rejectedAttemptId = randomUUID();
  const rejected = await f.reservation('db-guard-rejected');
  await f.owner.cgAttempt.create({
    data: {
      id: rejectedAttemptId,
      tenantId: f.tenantId,
      reservationId: rejected.reservationId,
      deliveryId: rejected.deliveryId,
      outcomeRef: rejected.outcomeRef,
      contactId: f.contactId,
      channel: 'LINE',
      purpose: 'SERVICE_NOTIFICATION',
      source: 'JOURNEY',
      outcome: 'PROVIDER_REJECTED',
      occurredAt: new Date('2026-09-23T09:01:00.000Z'),
      correlationId: 'raw-write',
    },
  });
  await assert.rejects(
    () =>
      insert({
        attemptId: rejectedAttemptId,
        reservationId: rejected.reservationId,
        deliveryId: rejected.deliveryId,
        outcome: 'PROVIDER_REJECTED',
        evidenceKind: 'USER_QUOTED_RESPONSE',
        responseEvidenceRef: `raw-evidence-${rejected.deliveryId}`,
      }),
    /CG_TOUCH_EVIDENCE_ATTEMPT_MISMATCH/,
  );
  assert.deepEqual(await counts(f), { attempts: 2, touches: 0 });
});
