/**
 * S2.2 (#364): matrix Attempt/Touch/refund ของ Governance แบบ pure — ไม่มี database
 *
 * Authority: outcome decision #361 §B/§D และ Phase Contract #362 §8
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { lineNormalizedOutcome, lineProviderSettlement } from '@d-contact/cxa-contracts';
import { defaultSettlementPolicy, type TerminalDeliveryOutcome } from './reservation-runtime.js';

test('acceptance ของ provider = Attempt 1, Touch 0, refund 0', () => {
  assert.deepEqual(defaultSettlementPolicy({ outcome: 'PROVIDER_ACCEPTED' }), {
    countsAsAttempt: true,
    countsAsSuccessfulTouch: false,
    refundOnFailure: false,
  });
});

test('recipient rejection นับ Attempt ส่วน operational rejection ไม่นับ', () => {
  assert.equal(
    defaultSettlementPolicy({ outcome: 'PROVIDER_REJECTED', rejectionScope: 'RECIPIENT' })
      .countsAsAttempt,
    true,
  );
  assert.equal(
    defaultSettlementPolicy({ outcome: 'PROVIDER_REJECTED', rejectionScope: 'OPERATIONAL' })
      .countsAsAttempt,
    false,
  );
  // channel ของ S1 ไม่มี vocabulary นี้ — ไม่ระบุ scope ต้องคงพฤติกรรมเดิมคือ Attempt 1
  assert.equal(defaultSettlementPolicy({ outcome: 'PROVIDER_REJECTED' }).countsAsAttempt, true);
});

test('สัญญา S1 ของ DELIVERED/DELIVERY_FAILED ไม่เปลี่ยน', () => {
  assert.deepEqual(defaultSettlementPolicy({ outcome: 'DELIVERED' }), {
    countsAsAttempt: true,
    countsAsSuccessfulTouch: true,
    refundOnFailure: false,
  });
  assert.deepEqual(defaultSettlementPolicy({ outcome: 'DELIVERY_FAILED' }), {
    countsAsAttempt: true,
    countsAsSuccessfulTouch: false,
    refundOnFailure: true,
  });
});

test('มีแต่ DELIVERED เท่านั้นที่เป็น Touch และมีแต่ DELIVERY_FAILED เท่านั้นที่ refund', () => {
  const outcomes: TerminalDeliveryOutcome[] = [
    'PROVIDER_ACCEPTED',
    'PROVIDER_REJECTED',
    'DELIVERED',
    'DELIVERY_FAILED',
  ];
  for (const outcome of outcomes) {
    const decision = defaultSettlementPolicy({ outcome, rejectionScope: 'RECIPIENT' });
    assert.equal(decision.countsAsSuccessfulTouch, outcome === 'DELIVERED', outcome);
    assert.equal(decision.refundOnFailure, outcome === 'DELIVERY_FAILED', outcome);
  }
});

test('mapping ของ LINE เข้ากันได้กับ policy กลาง: acceptance/rejection ให้คำตอบชุดเดียวกัน', () => {
  const pairs = [
    ['LINE_ACCEPTED', undefined],
    ['LINE_ACCEPTED_REPLAY', undefined],
    ['LINE_REQUEST_REJECTED', 'RECIPIENT'],
    ['LINE_REQUEST_REJECTED', 'OPERATIONAL'],
    ['LINE_AUTH_INVALID', 'OPERATIONAL'],
    ['LINE_RATE_LIMITED', 'OPERATIONAL'],
    ['LINE_MONTHLY_QUOTA_EXHAUSTED', 'OPERATIONAL'],
  ] as const;
  for (const [code, scope] of pairs) {
    const outcome = lineNormalizedOutcome(code);
    assert.notEqual(outcome, 'UNKNOWN_RECONCILING', code);
    assert.deepEqual(
      { ...lineProviderSettlement(code, scope) },
      defaultSettlementPolicy({
        outcome: outcome as TerminalDeliveryOutcome,
        ...(scope ? { rejectionScope: scope } : {}),
      }),
      `${code}/${scope ?? 'no-scope'}`,
    );
  }
});
