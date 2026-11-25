import assert from 'node:assert/strict';
import test from 'node:test';
import { JourneyPresenceRegistry } from './journey-authoring-presence.js';

test('presence is advisory: it disappears after the TTL, is isolated per tenant, and no API grants permission or a lock', () => {
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

  // a heartbeat every 20 seconds stays alive; missing heartbeats for over 60 seconds expires on its own
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
  // the registry has no lock/authorize method — correctness lives only in the draft CAS
  assert.deepEqual(Object.getOwnPropertyNames(JourneyPresenceRegistry.prototype).sort(), [
    'constructor',
    'heartbeat',
    'leave',
    'list',
  ]);
});
