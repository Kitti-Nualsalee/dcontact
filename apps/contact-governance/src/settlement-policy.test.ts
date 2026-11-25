/**
 * S2.2 (#364): the Governance Attempt/Touch/refund matrix as pure functions, with no database
 *
 * Authority: outcome decision #361 §B/§D and Phase Contract #362 §8
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { lineNormalizedOutcome, lineProviderSettlement } from '@d-contact/cxa-contracts';
import { defaultSettlementPolicy, type TerminalDeliveryOutcome } from './reservation-runtime.js';

test('a provider acceptance = Attempt 1, Touch 0, refund 0', () => {
  assert.deepEqual(defaultSettlementPolicy({ outcome: 'PROVIDER_ACCEPTED' }), {
    countsAsAttempt: true,
    countsAsSuccessfulTouch: false,
    refundOnFailure: false,
  });
});

test('a recipient rejection counts an Attempt while an operational rejection does not', () => {
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
  // the S1 channels have no such vocabulary: with no scope the original behavior must stay, which is Attempt 1
  assert.equal(defaultSettlementPolicy({ outcome: 'PROVIDER_REJECTED' }).countsAsAttempt, true);
});

test('the S1 contract of DELIVERED/DELIVERY_FAILED does not change', () => {
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

test('only DELIVERED is a Touch and only DELIVERY_FAILED is a refund', () => {
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

test('the LINE mapping is compatible with the shared policy: acceptance/rejection give the same answers', () => {
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
