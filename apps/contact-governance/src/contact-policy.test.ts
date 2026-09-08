import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateContactPolicy } from './contact-policy.js';

test('hard restriction ปิดกั้นการติดต่อแม้ consent ยังมีผล', () => {
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

test('identity ที่กำกวมต้อง REVIEW ก่อนประเมิน policy', () => {
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

test('identity ที่ resolve ไม่ได้ต้อง REVIEW ก่อนประเมิน policy', () => {
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

test('identity ที่ resolve ได้พร้อม consent ที่มีผลสามารถสร้าง reservation', () => {
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

test('consent ที่ถูกเพิกถอนปิดกั้นการติดต่อโดยไม่ประเมินทาง ALLOW', () => {
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

test('consent ที่หมดอายุปิดกั้นการติดต่อแบบ fail-closed', () => {
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

test('การไม่มี consent ปิดกั้น promotional contact แบบ fail-closed', () => {
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
