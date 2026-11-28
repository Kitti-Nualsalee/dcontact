import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateContactPolicy } from './contact-policy.js';

test('a hard restriction blocks contact even when consent is still in effect', () => {
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

test('an ambiguous identity must REVIEW before evaluating policy', () => {
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

test('an identity that cannot be resolved must REVIEW before evaluating policy', () => {
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

test('an identity not yet imported as a contact point beyond the retry window must REVIEW with its own reason', () => {
  assert.deepEqual(
    evaluateContactPolicy({ policyVersion: 4, identityResolution: 'IDENTITY_MAPPING_PENDING' }),
    {
      decision: 'REVIEW',
      reasonCode: 'IDENTITY_MAPPING_PENDING',
      policyVersion: 4,
      trace: [{ gate: 'IDENTITY', outcome: 'REVIEW', reasonCode: 'IDENTITY_MAPPING_PENDING' }],
    },
  );
});

test('an identity that resolves with consent in effect can create a reservation', () => {
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

test('a revoked consent blocks contact without evaluating the ALLOW path', () => {
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

test('an expired consent blocks contact fail-closed', () => {
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

test('having no consent blocks promotional contact fail-closed', () => {
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

test('#1065 a policy that does not require consent lets work without a consent record continue, naming its lawful basis', () => {
  const result = evaluateContactPolicy({
    policyVersion: 4,
    identityResolution: 'RESOLVED',
    consentWaiver: { requirement: 'NOT_REQUIRED', lawfulBasis: 'CONTRACT' },
  });

  assert.deepEqual(result, {
    decision: 'ALLOW',
    reasonCode: 'POLICY_PASSED',
    policyVersion: 4,
    trace: [
      { gate: 'IDENTITY', outcome: 'PASS' },
      { gate: 'HARD_RESTRICTION', outcome: 'PASS' },
      {
        gate: 'CONSENT',
        outcome: 'ALLOW',
        reasonCode: 'CONSENT_NOT_REQUIRED',
        lawfulBasis: 'CONTRACT',
      },
    ],
  });
});

test('#1065 consent the customer revoked or that expired still blocks under a policy that does not require consent', () => {
  for (const status of ['REVOKED', 'EXPIRED'] as const) {
    const result = evaluateContactPolicy({
      policyVersion: 4,
      identityResolution: 'RESOLVED',
      consent: { status, lawfulBasis: 'CONSENT' },
      consentWaiver: { requirement: 'NOT_REQUIRED', lawfulBasis: 'CONTRACT' },
    });
    assert.equal(result.decision, 'BLOCK');
    assert.equal(result.reasonCode, `CONSENT_${status}`);
  }
});

test('#1065 a hard restriction still blocks under a policy that does not require consent', () => {
  const result = evaluateContactPolicy({
    policyVersion: 4,
    identityResolution: 'RESOLVED',
    activeRestriction: { type: 'DNC', reasonCode: 'DNC_GLOBAL', overridable: false },
    consentWaiver: { requirement: 'NOT_REQUIRED', lawfulBasis: 'CONTRACT' },
  });
  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.reasonCode, 'DNC_GLOBAL');
});
