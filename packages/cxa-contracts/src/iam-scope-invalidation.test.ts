import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTeamSegmentScopeChangedEnvelope, teamId, tenantId } from './index.js';

const event = {
  schemaVersion: 2,
  eventKind: 'CANONICAL',
  eventId: 'scope-event-1',
  type: 'team.segment-scope.changed',
  tenantId: tenantId('tenant-1'),
  occurredAt: '2099-01-01T00:00:00.000Z',
  correlationId: 'scope-correlation-1',
  orderingKey: 'team-1',
  aggregateType: 'iam_team_scope',
  aggregateId: 'team-1',
  aggregateVersion: 3,
  payload: {
    contractVersion: 1,
    teamId: teamId('team-1'),
    grantId: 'grant-1',
    scopeVersion: 3,
    kind: 'REVOKED',
  },
} as const;

test('IAM scope event ยึด team ordering และ scope version เดียวกันทั้ง envelope/payload', () => {
  assert.deepEqual(assertTeamSegmentScopeChangedEnvelope(event), event);
  assert.throws(
    () => assertTeamSegmentScopeChangedEnvelope({ ...event, orderingKey: 'other-team' }),
    /closed contract/,
  );
  assert.throws(
    () =>
      assertTeamSegmentScopeChangedEnvelope({
        ...event,
        payload: { ...event.payload, kind: 'UNKNOWN' },
      }),
    /closed contract/,
  );
});
