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

test('unresolved identity requires review before policy evaluation', () => {
  const result = evaluateContactPolicy({
    policyVersion: 4,
    identityResolution: 'NOT_FOUND',
  });

  assert.deepEqual(result, {
    decision: 'REVIEW',
    reasonCode: 'IDENTITY_NOT_FOUND',
    policyVersion: 4,
    trace: [{ gate: 'IDENTITY', outcome: 'REVIEW', reasonCode: 'IDENTITY_NOT_FOUND' }],
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

test('revoked consent blocks contact without evaluating an allow path', () => {
  const result = evaluateContactPolicy({
    policyVersion: 11,
    identityResolution: 'RESOLVED',
    consent: {
      status: 'REVOKED',
      lawfulBasis: 'CONSENT',
    },
  });

  assert.deepEqual(result, {
    decision: 'BLOCK',
    reasonCode: 'CONSENT_REVOKED',
    policyVersion: 11,
    trace: [
      { gate: 'IDENTITY', outcome: 'PASS' },
      { gate: 'HARD_RESTRICTION', outcome: 'PASS' },
      { gate: 'CONSENT', outcome: 'BLOCK', reasonCode: 'CONSENT_REVOKED' },
    ],
  });
});

test('expired consent blocks contact fail-closed', () => {
  const result = evaluateContactPolicy({
    policyVersion: 12,
    identityResolution: 'RESOLVED',
    consent: {
      status: 'EXPIRED',
      lawfulBasis: 'CONSENT',
    },
  });

  assert.deepEqual(result, {
    decision: 'BLOCK',
    reasonCode: 'CONSENT_EXPIRED',
    policyVersion: 12,
    trace: [
      { gate: 'IDENTITY', outcome: 'PASS' },
      { gate: 'HARD_RESTRICTION', outcome: 'PASS' },
      { gate: 'CONSENT', outcome: 'BLOCK', reasonCode: 'CONSENT_EXPIRED' },
    ],
  });
});

test('missing consent blocks promotional contact fail-closed', () => {
  const result = evaluateContactPolicy({
    policyVersion: 13,
    identityResolution: 'RESOLVED',
  });

  assert.deepEqual(result, {
    decision: 'BLOCK',
    reasonCode: 'CONSENT_REQUIRED',
    policyVersion: 13,
    trace: [
      { gate: 'IDENTITY', outcome: 'PASS' },
      { gate: 'HARD_RESTRICTION', outcome: 'PASS' },
      { gate: 'CONSENT', outcome: 'BLOCK', reasonCode: 'CONSENT_REQUIRED' },
    ],
  });
});
