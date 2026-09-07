import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateContactPolicy } from './index.js';

test('hard restriction blocks contact even when consent is still valid', () => {
  const result = evaluateContactPolicy({
    policyVersion: 7,
    identityResolution: 'RESOLVED',
    activeRestriction: {
      type: 'DNC',
      reasonCode: 'DNC_GLOBAL',
      overridable: false,
    },
    consent: {
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
    },
  });

  assert.deepEqual(result, {
    decision: 'BLOCK',
    reasonCode: 'DNC_GLOBAL',
    policyVersion: 7,
    trace: [
      { gate: 'IDENTITY', outcome: 'PASS' },
      { gate: 'HARD_RESTRICTION', outcome: 'BLOCK', reasonCode: 'DNC_GLOBAL' },
    ],
  });
});

test('ambiguous identity requires review before policy evaluation', () => {
  const result = evaluateContactPolicy({
    policyVersion: 3,
    identityResolution: 'AMBIGUOUS',
  });

  assert.deepEqual(result, {
    decision: 'REVIEW',
    reasonCode: 'IDENTITY_AMBIGUOUS',
    policyVersion: 3,
    trace: [{ gate: 'IDENTITY', outcome: 'REVIEW', reasonCode: 'IDENTITY_AMBIGUOUS' }],
  });
});

test('resolved identity with valid consent is eligible for reservation', () => {
  const result = evaluateContactPolicy({
    policyVersion: 9,
    identityResolution: 'RESOLVED',
    consent: {
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
    },
  });

  assert.deepEqual(result, {
    decision: 'ALLOW',
    reasonCode: 'POLICY_PASSED',
    policyVersion: 9,
    trace: [
      { gate: 'IDENTITY', outcome: 'PASS' },
      { gate: 'HARD_RESTRICTION', outcome: 'PASS' },
      { gate: 'CONSENT', outcome: 'ALLOW', reasonCode: 'POLICY_PASSED' },
    ],
  });
});
