import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contactId,
  identityId,
  segmentId,
  teamId,
  tenantId,
  type CustomerContextReader,
  type CustomerContextResolution,
  type TeamContactScopeAuthorizer,
} from './index.js';

function assertNever(value: never): never {
  throw new Error(`unexpected resolution: ${JSON.stringify(value)}`);
}

function describeResolution(resolution: CustomerContextResolution): string {
  switch (resolution.status) {
    case 'RESOLVED':
      return resolution.contactId;
    case 'AMBIGUOUS':
      return resolution.reasonCode;
    case 'NOT_FOUND':
      return resolution.reasonCode;
    default:
      return assertNever(resolution);
  }
}

test('resolved customer context contains canonical IDs and no input contact reference', async () => {
  const sourceReference = { kind: 'EMAIL' as const, value: 'customer@example.test' };
  const reader: CustomerContextReader = {
    async resolveCurrentContext() {
      return {
        status: 'RESOLVED',
        contactId: contactId('contact-a'),
        identityId: identityId('identity-a'),
        segmentMemberships: [
          {
            segmentId: segmentId('LOND'),
            membershipVersion: 4,
            effectiveFrom: '2026-09-08T00:00:00.000Z',
          },
        ],
        snapshotVersion: 9,
        evaluatedAt: '2026-09-08T00:00:00.000Z',
      };
    },
  };

  const result = await reader.resolveCurrentContext({
    tenantId: tenantId('tenant-a'),
    contactRef: sourceReference,
    at: '2026-09-08T00:00:00.000Z',
  });

  assert.equal(describeResolution(result), 'contact-a');
  assert.equal(JSON.stringify(result).includes(sourceReference.value), false);
});

test('two-tenant fixtures fail closed for context and team scope swaps', async () => {
  const tenantA = tenantId('tenant-a');
  const tenantB = tenantId('tenant-b');
  const contactA = contactId('contact-a');

  const reader: CustomerContextReader = {
    async resolveCurrentContext(input) {
      return input.tenantId === tenantA
        ? {
            status: 'RESOLVED',
            contactId: contactA,
            segmentMemberships: [],
            snapshotVersion: 1,
            evaluatedAt: input.at,
          }
        : { status: 'NOT_FOUND', reasonCode: 'IDENTITY_NOT_FOUND' };
    },
  };
  const authorizer: TeamContactScopeAuthorizer = {
    async authorize(input) {
      return input.tenantId === tenantA && input.contactId === contactA
        ? { decision: 'ALLOW', scopeVersion: 3, evaluatedAt: input.at }
        : {
            decision: 'DENY',
            reasonCode: 'CONTACT_NOT_FOUND',
            evaluatedAt: input.at,
          };
    },
  };

  const missing = await reader.resolveCurrentContext({
    tenantId: tenantB,
    contactRef: { kind: 'CRM_ID', value: 'external-cif-a' },
    at: '2026-09-08T00:00:00.000Z',
  });
  const denied = await authorizer.authorize({
    tenantId: tenantB,
    teamId: teamId('team-a'),
    contactId: contactA,
    permission: 'CONTACT',
    at: '2026-09-08T00:00:00.000Z',
  });

  assert.deepEqual(missing, { status: 'NOT_FOUND', reasonCode: 'IDENTITY_NOT_FOUND' });
  assert.deepEqual(denied, {
    decision: 'DENY',
    reasonCode: 'CONTACT_NOT_FOUND',
    evaluatedAt: '2026-09-08T00:00:00.000Z',
  });
});

test('scope denial retains authorization semantics instead of a governance block', async () => {
  const authorizer: TeamContactScopeAuthorizer = {
    async authorize(input) {
      return {
        decision: 'DENY',
        reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED',
        evaluatedAt: input.at,
      };
    },
  };

  const decision = await authorizer.authorize({
    tenantId: tenantId('tenant-a'),
    teamId: teamId('team-d'),
    contactId: contactId('contact-lond-a'),
    permission: 'CONTACT',
    at: '2026-09-08T00:00:00.000Z',
  });

  assert.equal(decision.decision, 'DENY');
  if (decision.decision === 'DENY') {
    assert.equal(decision.reasonCode, 'TEAM_SEGMENT_NOT_ALLOWED');
  }
});

test('redacted contract log fixture keeps every contact reference out of serialized results', () => {
  const rawReferences = ['+66812345678', 'customer@example.test', 'line-user-123', 'crm-cif-456'];
  const resolutions: readonly CustomerContextResolution[] = [
    {
      status: 'RESOLVED',
      contactId: contactId('contact-a'),
      identityId: identityId('identity-a'),
      segmentMemberships: [
        {
          segmentId: segmentId('LOND'),
          membershipVersion: 4,
          effectiveFrom: '2026-09-08T00:00:00.000Z',
        },
      ],
      snapshotVersion: 9,
      evaluatedAt: '2026-09-08T00:00:00.000Z',
    },
    { status: 'AMBIGUOUS', reasonCode: 'IDENTITY_AMBIGUOUS' },
    { status: 'NOT_FOUND', reasonCode: 'IDENTITY_NOT_FOUND' },
  ];
  const logFixture = {
    resolutions,
    scopeDecision: {
      decision: 'DENY' as const,
      reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED' as const,
      evaluatedAt: '2026-09-08T00:00:00.000Z',
    },
  };

  const serialized = JSON.stringify(logFixture);

  for (const rawReference of rawReferences) {
    assert.equal(serialized.includes(rawReference), false);
  }
  assert.deepEqual(JSON.parse(serialized), {
    resolutions: [
      {
        status: 'RESOLVED',
        contactId: 'contact-a',
        identityId: 'identity-a',
        segmentMemberships: [
          {
            segmentId: 'LOND',
            membershipVersion: 4,
            effectiveFrom: '2026-09-08T00:00:00.000Z',
          },
        ],
        snapshotVersion: 9,
        evaluatedAt: '2026-09-08T00:00:00.000Z',
      },
      { status: 'AMBIGUOUS', reasonCode: 'IDENTITY_AMBIGUOUS' },
      { status: 'NOT_FOUND', reasonCode: 'IDENTITY_NOT_FOUND' },
    ],
    scopeDecision: {
      decision: 'DENY',
      reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED',
      evaluatedAt: '2026-09-08T00:00:00.000Z',
    },
  });
});
