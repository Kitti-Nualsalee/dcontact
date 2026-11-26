import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@d-contact/db';
import { digest } from './tenant-voice-catalog.js';
import { normalizePeopleCreate, peopleCreateDigest } from './tenant-people-input.js';
import {
  collectPeopleIdentityEvidence,
  PEOPLE_STEPS,
  type PeopleIdentityEvidenceSource,
} from './tenant-people-identity-evidence.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const actorId = '44444444-4444-4444-8444-444444444444';
const commandId = '55555555-5555-4555-8555-555555555555';
const attempt = '66666666-6666-4666-8666-666666666666';
const disableId = '77777777-7777-4777-8777-777777777777';
const ref = (seed: string) => seed.repeat(64).slice(0, 64);
const request = {
  displayName: 'Agent One',
  email: 'agent.one@example.test',
  role: 'AGENT',
  teamId: '88888888-8888-4888-8888-888888888888',
  extension: '1001',
};
const payloadDigest = digest([
  tenantId,
  actorId,
  peopleCreateDigest(normalizePeopleCreate({ ...request, commandId })),
]);

function fixture() {
  const rows = {
    operations: [
      {
        operationId,
        userId,
        actorId,
        commandId,
        correlationId: '99999999-9999-4999-8999-999999999999',
        payloadDigest,
        payload: { ...request, infrastructure: { node: 'n1' } } as Record<string, unknown>,
      },
    ],
    steps: PEOPLE_STEPS.map((step, index) => ({
      operationId,
      step,
      outcome: 'SUCCEEDED',
      receiptRef: ref(String(index)),
    })),
    dispatches: [
      {
        operationId,
        userId,
        generation: 1,
        providerAttemptRef: attempt,
        fencingToken: '1',
        leaseOwner: 'worker-1',
        outcome: 'SENT' as string | null,
        receiptRef: ref('a') as string | null,
      },
    ],
    preparations: [
      {
        operationId,
        userId,
        generation: 2,
        providerAttemptRef: '12121212-1212-4212-8212-121212121212',
        fencingToken: '2',
        leaseOwner: 'worker-2',
        intentRef: ref('b') as string | null,
        notBeforeEpoch: '1700000000' as string | null,
      },
    ],
    bindingEnabled: true,
    accountChanges: [
      {
        operationId: '13131313-1313-4313-8313-131313131313',
        kind: 'UPDATE_PROFILE' as 'UPDATE_PROFILE' | 'ENABLE_ACCOUNT',
        userId,
        identityId: userId,
        role: 'AGENT' as const,
        payloadDigest: ref('f'),
        fencingToken: '3',
        displayName: 'New name' as string | null,
        attempted: true,
        outcome: 'SUCCEEDED' as string | null,
        receiptRef: ref('9') as string | null,
      },
    ],
    disables: [
      {
        operationId: disableId,
        userId,
        identityId: userId,
        role: 'AGENT' as const,
        payloadDigest: ref('d'),
        fencingToken: '2',
        attempted: true,
        outcome: 'SUCCEEDED' as string | null,
        receiptRef: ref('e') as string | null,
      },
    ],
  };
  const statements: string[] = [];
  const transaction = {
    $executeRawUnsafe: async (sql: string) => {
      statements.push(sql);
      return 0;
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      statements.push(sql);
      if (sql.includes('FROM tenant_people_worker_bindings'))
        return [{ enabled: rows.bindingEnabled }];
      if (sql.includes('FROM tenant_people_invitation_preparations')) return rows.preparations;
      if (sql.includes('FROM tenant_people_operations')) return rows.operations;
      if (sql.includes('FROM tenant_people_step_receipts')) return rows.steps;
      if (sql.includes('FROM tenant_people_invitation_dispatches')) return rows.dispatches;
      if (sql.includes('tenant_people_account_change_receipts')) return rows.accountChanges;
      if (sql.includes('FROM tenant_people_disables')) return rows.disables;
      throw new Error(`unexpected ${sql}`);
    },
  };
  const database = {
    $transaction: async (
      work: (tx: typeof transaction) => Promise<unknown>,
      options?: { isolationLevel?: string },
    ) => {
      statements.push(`ISOLATION ${options?.isolationLevel}`);
      return work(transaction);
    },
  } as unknown as PrismaClient;
  const provider = {
    readiness: {
      version: 1,
      ready: true,
      tenantId,
      invitationReady: true,
      disableReady: true,
    } as Record<string, unknown> | null,
    steps: new Map<string, { outcome: string; receiptRef?: string }>(
      PEOPLE_STEPS.map((step, index) => [
        step,
        { outcome: 'SUCCEEDED', receiptRef: ref(String(index)) },
      ]),
    ),
    invitation: { outcome: 'SENT', receiptRef: ref('a') } as {
      outcome: string;
      receiptRef?: string;
    },
    disable: { outcome: 'SUCCEEDED', receiptRef: ref('e') } as {
      outcome: string;
      receiptRef?: string;
    },
    account: { outcome: 'SUCCEEDED', receiptRef: ref('9') } as {
      outcome: string;
      receiptRef?: string;
    },
    preparation: {
      outcome: 'INTENT',
      intentRef: ref('b'),
      notBeforeEpoch: 1700000000,
      serverEpoch: 1700000001,
      clockReached: true,
    } as Record<string, unknown>,
    failures: 0,
  };
  const seen: Record<string, unknown[]> = { step: [], invitation: [], disable: [], account: [] };
  const source: PeopleIdentityEvidenceSource = {
    tenantId,
    issuer: 'https://uat.example.test/auth/realms/dcontact',
    clientId: `dcontact-tenant-people-${tenantId}`,
    clientSecret: 'secret-value',
    readReadiness: async () => provider.readiness,
    readStep: async (claim) => {
      seen.step!.push(claim);
      return (provider.steps.get(claim.step) ?? { outcome: 'UNKNOWN' }) as never;
    },
    readInvitation: async (value) => {
      seen.invitation!.push(value);
      return provider.invitation as never;
    },
    readPreparation: async () => provider.preparation as never,
    readDisable: async (value) => {
      seen.disable!.push(value);
      return provider.disable as never;
    },
    readAccountChange: async (value) => {
      seen.account!.push(value);
      return provider.account as never;
    },
    requestFailures: () => provider.failures,
  };
  return { rows, provider, source, database, statements, seen };
}

test('#868 identity evidence: every kind of receipt matching is CONSISTENT and read-only', async () => {
  const { source, database, statements, seen } = fixture();
  const evidence = await collectPeopleIdentityEvidence(database, [source]);
  assert.equal(evidence.status, 'CONSISTENT');
  assert.equal(evidence.rollbackCertified, false);
  const [tenant] = evidence.tenants;
  assert.deepEqual(tenant?.counts, {
    operations: 1,
    steps: 5,
    invitations: 1,
    preparations: 1,
    disables: 1,
    accountChanges: 1,
  });
  assert.ok(statements.includes('ISOLATION RepeatableRead'));
  assert.equal(tenant?.clientSecretSha256.length, 64);
  assert.doesNotMatch(JSON.stringify(evidence), /secret-value|agent\.one/);
  assert.ok(statements.includes('SET TRANSACTION READ ONLY'));
  const claim = seen.step![0] as Record<string, unknown>;
  assert.equal(claim.payloadDigest, payloadDigest);
  assert.equal(claim.reconcileOnly, true);
  const invitation = seen.invitation![0] as Record<string, unknown>;
  assert.deepEqual(
    [
      invitation.generation,
      invitation.providerAttemptRef,
      invitation.fencingToken,
      invitation.leaseOwner,
    ],
    [1, attempt, '1', 'worker-1'],
  );
  assert.equal((seen.disable![0] as Record<string, unknown>).reconcileOnly, true);
});

test('#868 identity evidence: a difference between application and provider is INCONSISTENT', async (t) => {
  const cases: [string, (value: ReturnType<typeof fixture>) => void, string][] = [
    [
      'a different step receipt ref',
      (f) => f.provider.steps.set('TENANT_ROLE', { outcome: 'SUCCEEDED', receiptRef: ref('f') }),
      'RECEIPT_MISMATCH',
    ],
    [
      'the provider has a receipt that the application does not',
      (f) => {
        f.rows.steps = f.rows.steps.filter((row) => row.step !== 'VERIFY_PROVISIONED');
      },
      'UNRECORDED_PROVIDER_RECEIPT',
    ],
    [
      'the application has a receipt but the provider cannot be read',
      (f) => f.provider.steps.set('CREATE_IDENTITY', { outcome: 'UNKNOWN' }),
      'PROVIDER_UNREADABLE',
    ],
    [
      'invitation dispatch has no receipt on either side',
      (f) => {
        f.rows.dispatches[0]!.outcome = null;
        f.rows.dispatches[0]!.receiptRef = null;
        f.provider.invitation = { outcome: 'UNKNOWN' };
      },
      'PROVIDER_UNREADABLE',
    ],
    [
      'a different invitation outcome',
      (f) => (f.provider.invitation = { outcome: 'FAILED', receiptRef: ref('a') }),
      'RECEIPT_MISMATCH',
    ],
    [
      'disable attempted but the application has no receipt',
      (f) => {
        f.rows.disables[0]!.outcome = null;
        f.rows.disables[0]!.receiptRef = null;
      },
      'UNRECORDED_PROVIDER_RECEIPT',
    ],
    [
      'the worker binding is disabled so RLS hides every row',
      (f) => {
        f.rows.bindingEnabled = false;
        f.rows.operations = [];
        f.rows.steps = [];
        f.rows.dispatches = [];
        f.rows.preparations = [];
        f.rows.disables = [];
      },
      'WORKER_BINDING_DISABLED',
    ],
    [
      'Keycloak has a resend intent but the application has no proof',
      (f) => {
        f.rows.preparations[0]!.intentRef = null;
        f.rows.preparations[0]!.notBeforeEpoch = null;
      },
      'UNRECORDED_PROVIDER_RECEIPT',
    ],
    [
      'the resend intent fence differs',
      (f) => (f.provider.preparation = { ...f.provider.preparation, notBeforeEpoch: 1700000009 }),
      'RECEIPT_MISMATCH',
    ],
    [
      'the provider answers UNKNOWN with a reasonCode even though the application has no receipt',
      (f) => {
        f.rows.steps = f.rows.steps.filter((row) => row.step !== 'VERIFY_MAPPING');
        f.provider.steps.set('VERIFY_MAPPING', {
          outcome: 'UNKNOWN',
          reasonCode: 'IDENTITY_MAPPING_CONFLICT',
        } as never);
      },
      'PROVIDER_UNREADABLE',
    ],
    [
      'the operation payload was edited',
      (f) => {
        f.rows.operations[0]!.payload = { ...request, displayName: 'Changed' };
      },
      'PAYLOAD_CORRUPTED',
    ],
  ];
  for (const [name, mutate, reason] of cases)
    await t.test(name, async () => {
      const value = fixture();
      mutate(value);
      const evidence = await collectPeopleIdentityEvidence(value.database, [value.source]);
      assert.equal(evidence.status, 'INCONSISTENT');
      assert.ok(
        evidence.tenants[0]?.mismatches.some((item) => item.reason === reason),
        JSON.stringify(evidence.tenants[0]?.mismatches),
      );
    });
});

test('#868 identity evidence: a wrong readiness or a failed HTTP makes it INCONSISTENT even without a mismatch', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => (f.provider.readiness = null),
    (f: ReturnType<typeof fixture>) =>
      (f.provider.readiness = { version: 2, ready: true, tenantId }),
    (f: ReturnType<typeof fixture>) => (f.provider.failures = 1),
    (f: ReturnType<typeof fixture>) => {
      f.source.requiredReadiness = ['invitationReady'];
      f.provider.readiness = { ...f.provider.readiness, invitationReady: false };
    },
  ]) {
    const value = fixture();
    mutate(value);
    const evidence = await collectPeopleIdentityEvidence(value.database, [value.source]);
    assert.equal(evidence.status, 'INCONSISTENT');
    assert.deepEqual(evidence.tenants[0]?.mismatches, []);
  }
  await assert.rejects(
    collectPeopleIdentityEvidence(fixture().database, []),
    /PEOPLE_BINDINGS_REQUIRED/,
  );
});

test('#868 identity evidence: a preparation that already has a dispatch is compared through the dispatch and does not re-read the intent', async () => {
  const value = fixture();
  value.rows.dispatches.push({
    ...value.rows.dispatches[0]!,
    generation: 2,
    providerAttemptRef: value.rows.preparations[0]!.providerAttemptRef,
  });
  value.provider.preparation = { outcome: 'UNKNOWN' };
  value.provider.invitation = { ...value.provider.invitation, notBeforeEpoch: 1700000000 } as never;
  const evidence = await collectPeopleIdentityEvidence(value.database, [value.source]);
  assert.equal(evidence.status, 'CONSISTENT', JSON.stringify(evidence.tenants[0]?.mismatches));
  assert.equal(evidence.tenants[0]?.counts.preparations, 1);
  assert.equal(evidence.tenants[0]?.counts.invitations, 2);

  // a not-before that was actually sent differs from the proof, or no proof, must not pass
  value.provider.invitation = { ...value.provider.invitation, notBeforeEpoch: 1700000009 } as never;
  const drifted = await collectPeopleIdentityEvidence(value.database, [value.source]);
  assert.deepEqual(
    drifted.tenants[0]?.mismatches.map((item) => [item.kind, item.reason]),
    [['PREPARATION', 'RECEIPT_MISMATCH']],
  );
  value.provider.invitation = { ...value.provider.invitation, notBeforeEpoch: 1700000000 } as never;
  value.rows.preparations[0]!.intentRef = null;
  value.rows.preparations[0]!.notBeforeEpoch = null;
  const missing = await collectPeopleIdentityEvidence(value.database, [value.source]);
  assert.equal(missing.status, 'INCONSISTENT');
  assert.deepEqual(
    missing.tenants[0]?.mismatches.map((item) => [item.kind, item.reason]),
    [['PREPARATION', 'RECEIPT_MISMATCH']],
  );
});

test('#868 identity evidence: a disable that is not attempted and has no receipt is not read from the provider', async () => {
  const value = fixture();
  value.rows.disables[0]!.attempted = false;
  value.rows.disables[0]!.outcome = null;
  const evidence = await collectPeopleIdentityEvidence(value.database, [value.source]);
  assert.equal(evidence.status, 'CONSISTENT');
  assert.equal(evidence.tenants[0]?.counts.disables, 0);
  assert.equal(value.seen.disable!.length, 0);
});

test('#998 identity evidence: compares the receipt of rename/re-enable, reads GET only, and catches a mismatching result', async () => {
  const value = fixture();
  let evidence = await collectPeopleIdentityEvidence(value.database, [value.source]);
  assert.equal(evidence.status, 'CONSISTENT');
  const attempt = value.seen.account![0] as Record<string, unknown>;
  assert.equal(attempt.step, 'UPDATE_PROFILE');
  assert.equal(attempt.displayName, 'New name');
  assert.equal(attempt.reconcileOnly, true);
  assert.doesNotMatch(JSON.stringify(evidence), /New name/);
  // Keycloak has a receipt but the app does not (e.g. a rename was superseded by a disable after Keycloak had renamed)
  value.rows.accountChanges[0]!.outcome = null;
  value.rows.accountChanges[0]!.receiptRef = null;
  evidence = await collectPeopleIdentityEvidence(value.database, [value.source]);
  assert.equal(evidence.status, 'INCONSISTENT');
  assert.equal(evidence.tenants[0]?.mismatches[0]?.kind, 'ACCOUNT_CHANGE');
  assert.equal(evidence.tenants[0]?.mismatches[0]?.reason, 'UNRECORDED_PROVIDER_RECEIPT');
  // no reader but an attempted command = unreadable, not consistency
  const missing = fixture();
  delete missing.source.readAccountChange;
  evidence = await collectPeopleIdentityEvidence(missing.database, [missing.source]);
  assert.equal(evidence.tenants[0]?.mismatches[0]?.reason, 'PROVIDER_UNREADABLE');
  // re-enable sends no name, and a command that is not attempted is not read
  const enable = fixture();
  enable.rows.accountChanges[0]!.kind = 'ENABLE_ACCOUNT';
  enable.rows.accountChanges[0]!.displayName = null;
  evidence = await collectPeopleIdentityEvidence(enable.database, [enable.source]);
  assert.equal((enable.seen.account![0] as Record<string, unknown>).displayName, null);
  enable.rows.accountChanges[0]!.attempted = false;
  enable.rows.accountChanges[0]!.outcome = null;
  evidence = await collectPeopleIdentityEvidence(enable.database, [enable.source]);
  assert.equal(evidence.tenants[0]?.counts.accountChanges, 0);
});
