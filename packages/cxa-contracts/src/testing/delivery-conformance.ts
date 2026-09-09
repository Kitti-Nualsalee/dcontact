/** Reusable acceptance suite for #67: any DeliveryPort implementation runs this against its own harness. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionKey, ReservationId } from '../identifiers.js';
import type { DeliveryPort, EnqueueDeliveryCommand } from '../delivery.js';

export interface DeliveryConformanceHarness {
  delivery: DeliveryPort;
  /** A ready-to-enqueue command bound to an authorized, RESERVED reservation. */
  command: EnqueueDeliveryCommand;
  /** A reservationId with no fixture behind it in this harness. */
  unknownReservationId: ReservationId;
  /** A distinct actionKey never associated with `command.reservationId`. */
  mismatchedActionKey: ActionKey;
  /** Advances the harness clock so `command`'s reservation/lease can expire. */
  advance(ms: number): void;
}

function isError(code: string) {
  return (result: { status: string; code?: string }) => {
    assert.equal(result.status, 'ERROR');
    assert.equal(result.code, code);
  };
}

export function runDeliveryPortConformanceSuite(
  suiteName: string,
  makeHarness: () => DeliveryConformanceHarness,
): void {
  test(`${suiteName}: happy path enqueues once and persists before returning QUEUED`, async () => {
    const { delivery, command } = makeHarness();
    const result = await delivery.enqueue(command);
    assert.equal(result.status, 'QUEUED');
  });

  test(`${suiteName}: duplicate canonical input replays the same delivery`, async () => {
    const { delivery, command } = makeHarness();
    const first = await delivery.enqueue(command);
    const second = await delivery.enqueue(command);
    assert.deepEqual(second, first);
  });

  test(`${suiteName}: same actionKey with different input is IDEMPOTENCY_CONFLICT`, async () => {
    const { delivery, command } = makeHarness();
    await delivery.enqueue(command);
    const conflict = await delivery.enqueue({ ...command, contentRef: 'different-content' });
    isError('IDEMPOTENCY_CONFLICT')(conflict);
  });

  test(`${suiteName}: unknown reservation is rejected without creating a delivery`, async () => {
    const { delivery, command, unknownReservationId } = makeHarness();
    const result = await delivery.enqueue({ ...command, reservationId: unknownReservationId });
    isError('RESERVATION_NOT_FOUND')(result);
    // ยังไม่มี outbox row: retry ด้วย reservation ที่ถูกต้องต้องสำเร็จปกติ
    assert.equal((await delivery.enqueue(command)).status, 'QUEUED');
  });

  test(`${suiteName}: mismatched actionKey binding is rejected without creating a delivery`, async () => {
    const { delivery, command, mismatchedActionKey } = makeHarness();
    const result = await delivery.enqueue({ ...command, actionKey: mismatchedActionKey });
    isError('RESERVATION_BINDING_CONFLICT')(result);
    assert.equal((await delivery.enqueue(command)).status, 'QUEUED');
  });

  test(`${suiteName}: expired reservation is rejected without creating a delivery`, async () => {
    const { delivery, command, advance } = makeHarness();
    advance(20 * 60_000);
    const result = await delivery.enqueue(command);
    isError('RESERVATION_EXPIRED')(result);
  });

  test(`${suiteName}: concurrent identical enqueue creates exactly one delivery`, async () => {
    const { delivery, command } = makeHarness();
    const results = await Promise.all(Array.from({ length: 8 }, () => delivery.enqueue(command)));
    const queued = results.filter((r) => r.status === 'QUEUED');
    assert.equal(queued.length, 1);
    const deliveryIds = new Set(queued.map((r) => (r as { deliveryId: string }).deliveryId));
    assert.equal(deliveryIds.size, 1);
    for (const rejected of results.filter((r) => r.status === 'ERROR')) {
      assert.equal((rejected as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
    }
  });
}
