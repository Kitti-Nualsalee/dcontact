import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LINE_PILOT_CAPS,
  LINE_PROVIDER_OUTCOME_CLASS,
  lineNormalizedOutcome,
  lineProviderSettlement,
} from '@d-contact/cxa-contracts';
import { classifyLineResponse } from './line-provider-transport.js';
import {
  LINE_RETRY_WINDOW_MS,
  buildLineCanonicalRequest,
  deriveLineRetryKey,
  isLineRetryKey,
  lineBackoffMs,
  lineRetryWindowExpired,
  resolveLineFixture,
  LineFixtureUnknownError,
} from './line-push-request.js';

const accepted = (overrides = {}) => ({
  kind: 'RESPONSE' as const,
  response: { httpStatus: 200, requestId: 'req-1', sentMessageIds: ['461230'], ...overrides },
});

test('S2-LINE-F01 ตาราง #357 §3: 2xx และ 409+accepted id เท่านั้นที่เป็น accepted', () => {
  assert.deepEqual(classifyLineResponse(accepted()), {
    outcomeCode: 'LINE_ACCEPTED',
    accepted: true,
    reconcile: false,
  });
  assert.deepEqual(
    classifyLineResponse({
      kind: 'RESPONSE',
      response: { httpStatus: 409, requestId: 'req-2', acceptedRequestId: 'req-1' },
    }),
    { outcomeCode: 'LINE_ACCEPTED_REPLAY', accepted: true, reconcile: false },
  );
  // 2xx ที่ไม่มี sentMessages ผิด contract — ห้ามเดาว่าส่งสำเร็จ
  assert.deepEqual(classifyLineResponse(accepted({ sentMessageIds: undefined })), {
    outcomeCode: 'LINE_RESPONSE_INVALID',
    accepted: false,
    reconcile: true,
  });
  // 409 ที่ไม่มี accepted request id ก็เช่นกัน
  assert.equal(
    classifyLineResponse({ kind: 'RESPONSE', response: { httpStatus: 409 } }).outcomeCode,
    'LINE_RESPONSE_INVALID',
  );
});

test('S2-LINE-F01 4xx เป็น terminal และแยก scope ถูกต้อง ส่วน 5xx/timeout เป็น unknown', () => {
  const cases: Array<[number, string, string | undefined, boolean]> = [
    [400, 'LINE_REQUEST_REJECTED', 'RECIPIENT', false],
    [404, 'LINE_REQUEST_REJECTED', 'RECIPIENT', false],
    [401, 'LINE_AUTH_INVALID', 'OPERATIONAL', false],
    [403, 'LINE_AUTH_INVALID', 'OPERATIONAL', false],
    [429, 'LINE_RATE_LIMITED', 'OPERATIONAL', false],
    [500, 'LINE_PROVIDER_UNAVAILABLE', undefined, true],
    [503, 'LINE_PROVIDER_UNAVAILABLE', undefined, true],
  ];
  for (const [httpStatus, outcomeCode, rejectionScope, reconcile] of cases) {
    const classification = classifyLineResponse({ kind: 'RESPONSE', response: { httpStatus } });
    assert.deepEqual(
      [classification.outcomeCode, classification.rejectionScope, classification.reconcile],
      [outcomeCode, rejectionScope, reconcile],
      `HTTP ${httpStatus}`,
    );
    assert.equal(classification.accepted, false);
  }
  assert.equal(
    classifyLineResponse({
      kind: 'RESPONSE',
      response: { httpStatus: 429, errorCode: 'MONTHLY_QUOTA_EXHAUSTED' },
    }).outcomeCode,
    'LINE_MONTHLY_QUOTA_EXHAUSTED',
  );
  for (const reason of ['TIMEOUT', 'NETWORK'] as const) {
    const classification = classifyLineResponse({ kind: 'NO_RESPONSE', reason });
    assert.deepEqual(
      [classification.outcomeCode, classification.accepted, classification.reconcile],
      ['LINE_UNKNOWN_OUTCOME', false, true],
      reason,
    );
  }
});

test('S2-LINE-F02 acceptance = Attempt 1 / Touch 0 / refund 0 และ operational rejection ไม่นับ Attempt', () => {
  assert.deepEqual(lineProviderSettlement('LINE_ACCEPTED'), {
    countsAsAttempt: true,
    countsAsSuccessfulTouch: false,
    refundOnFailure: false,
  });
  assert.deepEqual(lineProviderSettlement('LINE_ACCEPTED_REPLAY'), {
    countsAsAttempt: true,
    countsAsSuccessfulTouch: false,
    refundOnFailure: false,
  });
  assert.equal(lineProviderSettlement('LINE_REQUEST_REJECTED', 'RECIPIENT').countsAsAttempt, true);
  assert.equal(lineProviderSettlement('LINE_AUTH_INVALID', 'OPERATIONAL').countsAsAttempt, false);
  assert.equal(lineProviderSettlement('LINE_RATE_LIMITED', 'OPERATIONAL').countsAsAttempt, false);
  // unknown ยังไม่ terminal จึงไม่แปลงเป็น failure
  assert.equal(lineNormalizedOutcome('LINE_UNKNOWN_OUTCOME'), 'UNKNOWN_RECONCILING');
  assert.equal(lineNormalizedOutcome('LINE_RETRY_WINDOW_EXPIRED'), 'UNKNOWN_RECONCILING');
  assert.equal(LINE_PROVIDER_OUTCOME_CLASS.LINE_RETRY_WINDOW_EXPIRED, 'QUARANTINED');
});

test('S2-LINE-ID01 retry key เป็น hex UUID ที่ deterministic ต่อ delivery เดิม', () => {
  const key = deriveLineRetryKey('tenant-a', 'dlv-1');
  assert.ok(isLineRetryKey(key), key);
  assert.equal(key, deriveLineRetryKey('tenant-a', 'dlv-1'), 'restart แล้วต้องได้ค่าเดิม');
  assert.notEqual(key, deriveLineRetryKey('tenant-a', 'dlv-2'));
  assert.notEqual(key, deriveLineRetryKey('tenant-b', 'dlv-1'));
  assert.ok(!isLineRetryKey('line-prq_abc'), 'key รูปแบบเก่าใช้กับ LINE ไม่ได้');
});

test('S2-LINE-ID01 canonical payload ผูกกับ fixture + ผู้รับ และไม่มี userId ใน digest input', () => {
  const a = buildLineCanonicalRequest({
    contentRef: 'fixture:service-notification/v1',
    recipientFingerprint: 'a'.repeat(64),
  });
  const again = buildLineCanonicalRequest({
    contentRef: 'fixture:service-notification/v1',
    recipientFingerprint: 'a'.repeat(64),
  });
  const other = buildLineCanonicalRequest({
    contentRef: 'fixture:service-notification/v1',
    recipientFingerprint: 'b'.repeat(64),
  });
  assert.equal(a.providerPayloadDigest, again.providerPayloadDigest);
  assert.notEqual(a.providerPayloadDigest, other.providerPayloadDigest);
  assert.equal(a.fixtureVersion, resolveLineFixture('fixture:service-notification/v1').version);
  assert.throws(
    () =>
      buildLineCanonicalRequest({ contentRef: 'free-text', recipientFingerprint: 'c'.repeat(64) }),
    LineFixtureUnknownError,
  );
});

test('S2-LINE-RC01 backoff มีเพดานและ window ปิดก่อน 24 ชั่วโมงของ LINE', () => {
  const delays = [1, 2, 3, 4].map((attemptNo) => lineBackoffMs(attemptNo));
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000]);
  assert.equal(lineBackoffMs(20), 15 * 60_000, 'ต้องมีเพดานเพราะทุก retry นับ rate limit');
  assert.ok(LINE_RETRY_WINDOW_MS < 24 * 60 * 60 * 1000, 'ต้องหยุดก่อนเส้น 24 ชม. ของ LINE');

  const first = new Date('2026-09-23T00:00:00.000Z');
  assert.equal(lineRetryWindowExpired(first, new Date('2026-09-23T22:00:00.000Z')), false);
  assert.equal(lineRetryWindowExpired(first, new Date('2026-09-23T23:30:00.000Z')), true);
  assert.equal(LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery, 4);
});
