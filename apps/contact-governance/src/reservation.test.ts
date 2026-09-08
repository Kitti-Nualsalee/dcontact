import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InvalidReservationTransitionError,
  RefundNotAllowedError,
  transitionReservation,
} from './reservation.js';

test('confirm reservation หนึ่งครั้งและคืน state เดิมเมื่อ retry', () => {
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

test('release reservation ที่รออยู่หนึ่งครั้งและคืน state เดิมเมื่อ retry', () => {
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

test('refund reservation ที่ยืนยันแล้วหนึ่งครั้งและคืน state เดิมเมื่อ retry', () => {
  const confirmed = {
    id: 'reservation-003',
    state: 'CONFIRMED' as const,
  };

  const refund = { type: 'REFUND' as const, outcome: 'DELIVERY_FAILED' as const };
  const refunded = transitionReservation(confirmed, refund);
  const retried = transitionReservation(refunded, refund);

  assert.deepEqual(refunded, {
    id: 'reservation-003',
    state: 'REFUNDED',
  });
  assert.deepEqual(retried, refunded);
});

test('ปฏิเสธ refund เมื่อ outcome ไม่ใช่การส่งล้มเหลว', () => {
  assert.throws(
    () =>
      transitionReservation(
        { id: 'reservation-005', state: 'CONFIRMED' },
        { type: 'REFUND', outcome: 'DELIVERED' },
      ),
    (error: unknown) => {
      assert.ok(error instanceof RefundNotAllowedError);
      assert.equal(error.code, 'REFUND_NOT_ALLOWED');
      return true;
    },
  );
});

test('ปฏิเสธ reservation transition ที่ย้อน state', () => {
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
