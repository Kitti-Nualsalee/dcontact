import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { c360ActivityCoverage, parseC360ActivityEvidence } from './profile-activity.js';

test('coverage requires tenant-bound immutable evidence and clips gaps per operation', () => {
  const tenantId = randomUUID();
  const from = '2026-10-01T00:00:00.000000Z';
  const to = '2026-10-02T00:00:00.000000Z';
  const window = { from, to };
  const type = 'PROFILE_UPDATED' as const;
  const read = (partial: boolean, evidenceRef = 'ev_approved-test') =>
    parseC360ActivityEvidence(
      JSON.stringify({
        version: 'c360-activity-v1',
        entries: [
          {
            tenantId,
            from: '2026-09-30T07:00:00+07:00',
            to: partial ? '2026-10-01T12:00:00Z' : '2026-10-03T00:00:00Z',
            types: [type],
            sourceVersion: 'release-test',
            evidenceRef,
          },
        ],
      }),
    ).get(tenantId) ?? [];

  assert.equal(c360ActivityCoverage(window, [type], [], false).status, 'UNKNOWN');
  const partial = c360ActivityCoverage(window, [type], read(true), false);
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.intervals[0]?.from, from);
  assert.equal(partial.gaps[0]?.from, '2026-10-01T12:00:00.000000Z');
  const known = c360ActivityCoverage(window, [type], read(false), false);
  assert.equal(known.status, 'KNOWN');
  assert.equal(known.intervals[0]?.to, to);
  assert.equal(
    c360ActivityCoverage(window, [type, 'TAG_CREATED'], read(false), false).status,
    'PARTIAL',
  );
  assert.equal(c360ActivityCoverage(window, [type], read(false), true).status, 'UNKNOWN');
  assert.deepEqual(read(false, '/private/file'), []);
});
