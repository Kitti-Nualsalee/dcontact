import assert from 'node:assert/strict';
import test from 'node:test';
import { cg5BucketStart, cg5MetricKeysForEvent } from './cg5-event-metrics-consumer.js';

test('CG5.3 map state-change event ทุกชนิดไปยัง event-fed metric ที่เกี่ยวข้อง', () => {
  assert.deepEqual(cg5MetricKeysForEvent('preference.changed'), ['cg.restriction', 'cg.audit']);
  assert.deepEqual(cg5MetricKeysForEvent('restriction.changed'), ['cg.restriction', 'cg.audit']);
  assert.deepEqual(cg5MetricKeysForEvent('consent.changed'), ['cg.consent', 'cg.audit']);
  assert.deepEqual(cg5MetricKeysForEvent('exception.changed'), ['cg.exception', 'cg.audit']);
  assert.deepEqual(cg5MetricKeysForEvent('policy.changed'), ['cg.policy.health', 'cg.audit']);
  assert.deepEqual(cg5MetricKeysForEvent('governance.kill-switch.changed'), [
    'cg.policy.health',
    'cg.audit',
  ]);
  assert.deepEqual(cg5MetricKeysForEvent('unknown.changed'), []);
});

test('CG5.3 bucket time ถูก truncate แบบ UTC สำหรับทุก granularity', () => {
  const input = new Date('2026-09-19T10:07:23.456Z');
  assert.equal(cg5BucketStart(input, 'FIVE_MIN').toISOString(), '2026-09-19T10:05:00.000Z');
  assert.equal(cg5BucketStart(input, 'HOUR').toISOString(), '2026-09-19T10:00:00.000Z');
  assert.equal(cg5BucketStart(input, 'DAY').toISOString(), '2026-09-19T00:00:00.000Z');
});
