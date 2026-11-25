import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeLocalTimeWindows,
  stableDigest,
  validateCgEventPayloadV1,
  validateCgScope,
} from './cg3-persistence.js';

test('normalizing local-time windows and the digest give stable results from the same semantic data', () => {
  const normalized = normalizeLocalTimeWindows([
    { daysOfWeek: [5, 1, 5], startLocal: '09:00', endLocal: '17:30' },
  ]);

  assert.deepEqual(normalized, [{ daysOfWeek: [1, 5], startLocal: '09:00', endLocal: '17:30' }]);
  assert.equal(
    stableDigest({ windows: normalized, timezone: 'Asia/Bangkok' }),
    stableDigest({ timezone: 'Asia/Bangkok', windows: normalized }),
  );
});

test('rejects local-time windows that overlap after normalizing across midnight', () => {
  assert.throws(
    () =>
      normalizeLocalTimeWindows([
        { daysOfWeek: [1], startLocal: '22:00', endLocal: '02:00' },
        { daysOfWeek: [2], startLocal: '01:00', endLocal: '03:00' },
      ]),
    /overlap/,
  );
});

test('validates scope and event payload from JSON at the boundary and normalizes optional values', () => {
  const scope = validateCgScope({ channel: 'LINE', purpose: ' SERVICE_NOTIFICATION ' });
  assert.deepEqual(scope, {
    identityId: null,
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    contactKind: null,
  });

  assert.deepEqual(
    validateCgEventPayloadV1({
      contractVersion: 1,
      mutationId: 'mutation-1',
      subjectVersion: 2,
      affectedScope: scope,
      effectiveAt: '2026-09-11T02:00:00.000Z',
      stateDigest: 'a'.repeat(64),
    }),
    {
      contractVersion: 1,
      mutationId: 'mutation-1',
      subjectVersion: 2,
      affectedScope: scope,
      effectiveAt: '2026-09-11T02:00:00.000Z',
      stateDigest: 'a'.repeat(64),
    },
  );
});

test('rejects JSON scope/payload with an invalid channel, version or digest', () => {
  assert.throws(() => validateCgScope({ channel: 'SMS' }), /channel/);
  assert.throws(
    () =>
      validateCgEventPayloadV1({
        contractVersion: 1,
        mutationId: 'mutation-1',
        subjectVersion: 0,
        affectedScope: {},
        effectiveAt: 'not-an-instant',
        stateDigest: 'unsafe',
      }),
    /subjectVersion/,
  );
  assert.throws(
    () =>
      validateCgEventPayloadV1({
        contractVersion: 1,
        subjectVersion: 1,
        affectedScope: {},
        effectiveAt: '2026-09-11T02:00:00.000Z',
        stateDigest: 'a'.repeat(64),
      }),
    /mutationId/,
  );
  assert.throws(
    () =>
      validateCgEventPayloadV1({
        contractVersion: 1,
        mutationId: 'mutation-1',
        subjectVersion: 1,
        affectedScope: {},
        effectiveAt: '2026-09-11T02:00:00.000Z',
        stateDigest: 'a'.repeat(64),
        rawContact: 'must not travel with the event',
      }),
    /unknown field: rawContact/,
  );
});
