import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  contactId,
  deliveryId,
  identityId,
  outcomeRef,
  reservationId,
  tenantId,
  ReservationBindingError,
  ReservationNotFoundError,
} from '@d-contact/cxa-contracts';
import {
  AttemptTouchRepository,
  type RecordAttemptTouchInput,
} from './attempt-touch-repository.js';

async function fixture(t: TestContext, withIdentity = true) {
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
  const rawIdentityId = withIdentity ? randomUUID() : undefined;
  const rawReservationId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);

  t.after(async () => {
    await owner.cgTouch.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgAttempt.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgReservation.updateMany({
      where: { tenantId: rawTenantId },
      data: { authorizationDecisionId: null },
    });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contact.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `CG facts ${suffix}`,
      slug: `cg-facts-${suffix}`,
      sipDomain: `${suffix}.cg-facts.test`,
    },
  });
  await owner.contact.create({
    data: { id: rawContactId, tenantId: rawTenantId, displayName: 'CG fact contact' },
  });
  if (rawIdentityId) {
    await owner.contactIdentity.create({
      data: {
        id: rawIdentityId,
        tenantId: rawTenantId,
        contactId: rawContactId,
        type: 'EMAIL',
        value: `cg-${suffix}@example.test`,
      },
    });
  }
  await owner.cgReservation.create({
    data: {
      id: rawReservationId,
      tenantId: rawTenantId,
      contactId: rawContactId,
      identityId: rawIdentityId,
      channel: 'EMAIL',
      purpose: 'MARKETING',
      source: 'JOURNEY',
      sourceId: 'journey-c1-1',
      actionKey: `action-${suffix}`,
      inputHash: `hash-${suffix}`,
      expiresAt: new Date('2026-09-10T10:00:00.000Z'),
    },
  });

  return {
    owner,
    application,
    tenantId: tenantId(rawTenantId),
    contactId: contactId(rawContactId),
    identityId: rawIdentityId ? identityId(rawIdentityId) : undefined,
    reservationId: reservationId(rawReservationId),
  };
}

function input(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<RecordAttemptTouchInput> = {},
): RecordAttemptTouchInput {
  return {
    tenantId: f.tenantId,
    reservationId: f.reservationId,
    deliveryId: deliveryId('delivery-c1-1'),
    outcomeRef: outcomeRef('outcome-c1-1'),
    contactId: f.contactId,
    ...(f.identityId ? { identityId: f.identityId } : {}),
    channel: 'EMAIL',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    outcome: 'DELIVERED',
    occurredAt: '2026-09-10T09:00:00.000Z',
    correlationId: 'correlation-c1-1',
    causationId: 'delivery-outcome-c1-1',
    countsAsSuccessfulTouch: true,
    ...overrides,
  };
}

test('บันทึก canonical Attempt และ Successful Touch ใน transaction เดียวและ query ตาม tenant/contact/time', async (t) => {
  const f = await fixture(t);
  const ids = [randomUUID(), randomUUID()];
  const repository = new AttemptTouchRepository(f.application, {
    id: () => ids.shift() ?? randomUUID(),
  });

  const snapshot = await repository.record(input(f));
  assert.equal(snapshot.attempt.outcome, 'DELIVERED');
  assert.equal(snapshot.touch?.outcomeRef, snapshot.attempt.outcomeRef);

  const history = await repository.history({
    tenantId: f.tenantId,
    contactId: f.contactId,
    from: '2026-09-10T08:59:59.000Z',
    to: '2026-09-10T09:00:01.000Z',
  });
  assert.deepEqual(history.attempts, [snapshot.attempt]);
  assert.deepEqual(history.touches, [snapshot.touch]);
});

test('duplicate และ race ของ outcome เดิมคืน snapshot เดิมโดยไม่สร้าง Attempt/Touch ซ้ำ', async (t) => {
  const f = await fixture(t);
  const repository = new AttemptTouchRepository(f.application);

  const snapshots = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      repository.record(input(f, { correlationId: `retry-correlation-${index}` })),
    ),
  );
  for (const snapshot of snapshots) assert.deepEqual(snapshot, snapshots[0]);
  assert.equal(await f.owner.cgAttempt.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.cgTouch.count({ where: { tenantId: f.tenantId } }), 1);
});

test('outcomeRef เดิมกับ canonical binding/outcome อื่นคืน IDEMPOTENCY_CONFLICT และไม่เพิ่ม fact', async (t) => {
  const f = await fixture(t);
  const repository = new AttemptTouchRepository(f.application);
  await repository.record(input(f));

  for (const changed of [
    { deliveryId: deliveryId('delivery-conflict') },
    { outcome: 'DELIVERY_FAILED' as const },
    { countsAsSuccessfulTouch: false },
  ]) {
    await assert.rejects(
      () => repository.record(input(f, changed)),
      (error: unknown) => {
        assert.ok(error instanceof ReservationBindingError);
        assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
        return true;
      },
    );
  }
  assert.equal(await f.owner.cgAttempt.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.cgTouch.count({ where: { tenantId: f.tenantId } }), 1);
});

test('cross-tenant reservation/contact ID swap ถูกซ่อนเป็น RESERVATION_NOT_FOUND', async (t) => {
  const tenantA = await fixture(t);
  const tenantB = await fixture(t);
  const repository = new AttemptTouchRepository(tenantA.application);

  await assert.rejects(
    () =>
      repository.record(
        input(tenantA, {
          reservationId: tenantB.reservationId,
          contactId: tenantB.contactId,
          identityId: tenantB.identityId,
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ReservationNotFoundError);
      assert.equal(error.code, 'RESERVATION_NOT_FOUND');
      return true;
    },
  );
  assert.equal(await tenantA.owner.cgAttempt.count({ where: { tenantId: tenantA.tenantId } }), 0);
  assert.equal(await tenantB.owner.cgAttempt.count({ where: { tenantId: tenantB.tenantId } }), 0);
});

test('outcomeRef เดียวกันแยก tenant ได้ และ reader รองรับ row ที่ไม่มี optional legacy fields/touch', async (t) => {
  const tenantA = await fixture(t, false);
  const tenantB = await fixture(t, false);
  const repositoryA = new AttemptTouchRepository(tenantA.application);
  const repositoryB = new AttemptTouchRepository(tenantB.application);

  const withoutOptionalFields = {
    identityId: undefined,
    causationId: undefined,
    countsAsSuccessfulTouch: false,
  };
  await Promise.all([
    repositoryA.record(input(tenantA, withoutOptionalFields)),
    repositoryB.record(input(tenantB, withoutOptionalFields)),
  ]);

  const history = await repositoryA.history({
    tenantId: tenantA.tenantId,
    contactId: tenantA.contactId,
  });
  assert.equal(history.attempts.length, 1);
  assert.equal(history.attempts[0]?.identityId, undefined);
  assert.equal(history.attempts[0]?.causationId, undefined);
  assert.deepEqual(history.touches, []);
  assert.equal(await tenantB.owner.cgAttempt.count({ where: { tenantId: tenantB.tenantId } }), 1);
});
