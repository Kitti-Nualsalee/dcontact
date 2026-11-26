import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accessRows,
  grantableTeams,
  hasGrant,
  remainingPermission,
  SEGMENT_LABEL_KEYS,
  SYSTEM_SEGMENTS,
  validRevokeReason,
} from './customer-access/model.js';

const teams = [
  { id: 't-b', name: 'Service Team', isActive: true },
  { id: 't-a', name: 'Sales Team', isActive: true },
  { id: 't-off', name: 'Old Team', isActive: false },
];

test('#915: grant rows use the team name, sorted by name then WORK before VIEW; unknown teams last', () => {
  const rows = accessRows(
    [
      { grantId: 'g1', teamId: 't-b', segmentId: 'system:vip', permission: 'VIEW', updatedAt: '' },
      { grantId: 'g2', teamId: 'gone', segmentId: 'system:vip', permission: 'WORK', updatedAt: '' },
      { grantId: 'g3', teamId: 't-b', segmentId: 'system:vip', permission: 'WORK', updatedAt: '' },
      { grantId: 'g4', teamId: 't-a', segmentId: 'system:all-customers', updatedAt: '' },
    ],
    teams,
  );
  assert.deepEqual(
    rows.map((row) => [row.grantId, row.teamName, row.permission]),
    [
      ['g4', 'Sales Team', 'VIEW'],
      ['g3', 'Service Team', 'WORK'],
      ['g1', 'Service Team', 'VIEW'],
      ['g2', null, 'WORK'],
    ],
  );
  assert.equal(rows[3]!.teamActive, false);
});

test('#915: can grant only to active teams, and a duplicate grant is prevented before sending', () => {
  assert.deepEqual(
    grantableTeams(teams).map((team) => team.id),
    ['t-a', 't-b'],
  );
  const rows = accessRows(
    [
      {
        grantId: 'g',
        teamId: 't-a',
        segmentId: SYSTEM_SEGMENTS[0],
        permission: 'WORK',
        updatedAt: '',
      },
    ],
    teams,
  );
  assert.equal(
    hasGrant(rows, { teamId: 't-a', segmentId: SYSTEM_SEGMENTS[0], permission: 'WORK' }),
    true,
  );
  assert.equal(
    hasGrant(rows, { teamId: 't-a', segmentId: SYSTEM_SEGMENTS[0], permission: 'VIEW' }),
    false,
  );
});

test('#915: revoke reason is 3–120 characters after trimming whitespace', () => {
  assert.equal(validRevokeReason('  ab '), false);
  assert.equal(validRevokeReason('Moved team'), true);
  assert.equal(validRevokeReason('x'.repeat(121)), false);
});

test('#915: the label of a system segment has no `:`, which i18next uses to separate namespaces', () => {
  for (const id of SYSTEM_SEGMENTS) assert.doesNotMatch(SEGMENT_LABEL_KEYS[id], /:/);
});

test('#915: after revoking one kind, report the other kind that remains on the same team+segment', () => {
  const rows = accessRows(
    [
      { grantId: 'w', teamId: 't-a', segmentId: 'system:vip', permission: 'WORK', updatedAt: '' },
      { grantId: 'v', teamId: 't-a', segmentId: 'system:vip', permission: 'VIEW', updatedAt: '' },
      { grantId: 'o', teamId: 't-b', segmentId: 'system:vip', permission: 'VIEW', updatedAt: '' },
      {
        grantId: 'x',
        teamId: 't-a',
        segmentId: 'system:all-customers',
        permission: 'VIEW',
        updatedAt: '',
      },
    ],
    teams,
  );
  const byId = (id: string) => rows.find((row) => row.grantId === id)!;
  assert.equal(remainingPermission(rows, byId('w')), 'VIEW');
  assert.equal(remainingPermission(rows, byId('v')), 'WORK');
  assert.equal(remainingPermission(rows, byId('o')), undefined);
  assert.equal(remainingPermission(rows, byId('x')), undefined);
});
