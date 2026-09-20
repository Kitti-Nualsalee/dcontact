import assert from 'node:assert/strict';
import test from 'node:test';
import {
  externalDecisionView,
  externalEtag,
  externalPolicyView,
  setConditionalEtag,
} from './contact-governance-external-read-api.js';

test('external decision summary redact reference และไม่เผย trace/reservation', () => {
  const decision = {
    decisionId: '11111111-1111-4111-8111-111111111111',
    decision: 'BLOCK',
    reasonCode: 'PREFERENCE_BLOCKED',
    policyVersion: 3,
    gate: 'PREFERENCE',
    trace: [{ identityId: 'identity-raw' }],
    reservationId: 'reservation-raw',
    exceptionRef: 'case://restricted/42',
    decidedAt: '2026-09-20T00:00:00.000Z',
  };
  const summary = externalDecisionView(decision, 'SUMMARY');
  assert.deepEqual(summary.exceptionRef, {
    redacted: true,
    digest: (summary.exceptionRef as { digest: string }).digest,
  });
  assert.match((summary.exceptionRef as { digest: string }).digest, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(summary), /identity-raw|reservation-raw|case:\/\/restricted/);
  assert.equal('trace' in summary, false);
  assert.equal('reservationId' in summary, false);

  const evidence = externalDecisionView(decision, 'EVIDENCE');
  assert.equal(evidence.exceptionRef, 'case://restricted/42');
});

test('external policy view ตัด maker/checker/approval reference ออกเสมอ', () => {
  const view = externalPolicyView({
    policyId: 'sales',
    version: 3,
    status: 'PUBLISHED',
    effectiveFrom: '2026-09-20T00:00:00.000Z',
    makerActorRef: 'operator-raw',
    checkerActorRef: 'checker-raw',
    approvalRef: 'ticket-raw',
  } as never);
  assert.deepEqual(view, {
    policyId: 'sales',
    version: 3,
    status: 'PUBLISHED',
    effectiveFrom: '2026-09-20T00:00:00.000Z',
  });
});

test('external ETag stable และ If-None-Match ที่ตรงกันได้ 304', () => {
  const view = { aggregateVersion: 7, preference: { decision: 'BLOCK' } };
  const etag = externalEtag('effective-preference', view);
  assert.equal(etag, externalEtag('effective-preference', view));
  const response = {
    headers: new Map(),
    statusCode: 200,
    setHeader(key: string, value: string) {
      this.headers.set(key, value);
    },
  };
  const cached = setConditionalEtag(
    { headers: { 'if-none-match': etag } } as never,
    response as never,
    etag,
  );
  assert.equal(cached, true);
  assert.equal(response.statusCode, 304);
  assert.equal(response.headers.get('ETag'), etag);
});
