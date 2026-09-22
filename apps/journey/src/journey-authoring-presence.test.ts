import assert from 'node:assert/strict';
import test from 'node:test';
import { JourneyPresenceRegistry } from './journey-authoring-presence.js';

test('presence เป็น advisory: หมด TTL แล้วหาย, แยก tenant และไม่มี API ใดให้สิทธิ์หรือ lock', () => {
  let now = new Date('2026-09-22T00:00:00.000Z');
  const presence = new JourneyPresenceRegistry(() => now);
  presence.heartbeat('tenant-a', 'journey-1', {
    subjectId: 'author',
    sessionId: 's1',
    baseRevision: 3,
  });
  presence.heartbeat('tenant-a', 'journey-1', {
    subjectId: 'reviewer',
    sessionId: 's2',
    baseRevision: 3,
  });
  assert.deepEqual(
    presence.list('tenant-a', 'journey-1').map((entry) => entry.sessionId),
    ['s1', 's2'],
  );
  assert.deepEqual(presence.list('tenant-b', 'journey-1'), []);

  // heartbeat ทุก 20 วินาทียังอยู่; ขาด heartbeat เกิน 60 วินาทีหายไปเอง
  now = new Date(now.getTime() + JourneyPresenceRegistry.heartbeatSeconds * 1_000);
  presence.heartbeat('tenant-a', 'journey-1', {
    subjectId: 'author',
    sessionId: 's1',
    baseRevision: 4,
  });
  now = new Date(now.getTime() + (JourneyPresenceRegistry.ttlSeconds - 1) * 1_000);
  assert.deepEqual(
    presence.list('tenant-a', 'journey-1').map((entry) => entry.sessionId),
    ['s1'],
  );

  presence.leave('tenant-a', 'journey-1', 's1');
  assert.deepEqual(presence.list('tenant-a', 'journey-1'), []);
  // registry ไม่มี method ของ lock/authorize — correctness อยู่ที่ CAS ของ draft เท่านั้น
  assert.deepEqual(Object.getOwnPropertyNames(JourneyPresenceRegistry.prototype).sort(), [
    'constructor',
    'heartbeat',
    'leave',
    'list',
  ]);
});
