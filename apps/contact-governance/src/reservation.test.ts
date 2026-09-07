import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidReservationTransitionError, transitionReservation } from './reservation.js';

test('confirm reservation once and return the same state on retry', () => {
  const reserved = {
    id: 'reservation-001',
    state: 'RESERVED' as const,
  };

  const confirmed = transitionReservation(reserved, 'CONFIRM');
  const retried = transitionReservation(confirmed, 'CONFIRM');

  assert.deepEqual(confirmed, {
    id: 'reservation-001',
    state: 'CONFIRMED',
  });
  assert.deepEqual(retried, confirmed);
});

test('release a pending reservation once and return the same state on retry', () => {
  const reserved = {
    id: 'reservation-002',
    state: 'RESERVED' as const,
  };

  const released = transitionReservation(reserved, 'RELEASE');
  const retried = transitionReservation(released, 'RELEASE');

  assert.deepEqual(released, {
    id: 'reservation-002',
    state: 'RELEASED',
  });
  assert.deepEqual(retried, released);
});

test('refund a confirmed reservation once and return the same state on retry', () => {
  const confirmed = {
    id: 'reservation-003',
    state: 'CONFIRMED' as const,
  };

  const refunded = transitionReservation(confirmed, 'REFUND');
  const retried = transitionReservation(refunded, 'REFUND');

  assert.deepEqual(refunded, {
    id: 'reservation-003',
    state: 'REFUNDED',
  });
  assert.deepEqual(retried, refunded);
});

test('reject a backward reservation transition', () => {
  assert.throws(
    () =>
      transitionReservation(
        {
          id: 'reservation-004',
          state: 'RELEASED',
        },
        'CONFIRM',
      ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidReservationTransitionError);
      assert.equal(error.code, 'INVALID_RESERVATION_TRANSITION');
      return true;
    },
  );
});
