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
      if (sql.includes('FROM tenant_people_operations')) return rows.operations;
      if (sql.includes('FROM tenant_people_step_receipts')) return rows.steps;
      if (sql.includes('FROM tenant_people_invitation_dispatches')) return rows.dispatches;
      if (sql.includes('FROM tenant_people_disables')) return rows.disables;
      throw new Error(`unexpected ${sql}`);
    },
  };
  const database = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
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
    failures: 0,
  };
  const seen: Record<string, unknown[]> = { step: [], invitation: [], disable: [] };
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
    readDisable: async (value) => {
      seen.disable!.push(value);
      return provider.disable as never;
    },
    requestFailures: () => provider.failures,
  };
  return { rows, provider, source, database, statements, seen };
}

test('#868 identity evidence: receipt ทุกชนิดตรงกันเป็น CONSISTENT และอ่านแบบ read-only', async () => {
  const { source, database, statements, seen } = fixture();
  const evidence = await collectPeopleIdentityEvidence(database, [source]);
  assert.equal(evidence.status, 'CONSISTENT');
  assert.equal(evidence.rollbackCertified, false);
  const [tenant] = evidence.tenants;
  assert.deepEqual(tenant?.counts, { operations: 1, steps: 5, invitations: 1, disables: 1 });
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

test('#868 identity evidence: ความต่างระหว่าง application กับ provider เป็น INCONSISTENT', async (t) => {
  const cases: [string, (value: ReturnType<typeof fixture>) => void, string][] = [
    [
      'step receipt ref ต่าง',
      (f) => f.provider.steps.set('TENANT_ROLE', { outcome: 'SUCCEEDED', receiptRef: ref('f') }),
      'RECEIPT_MISMATCH',
    ],
    [
      'provider มี receipt ที่ application ไม่มี',
      (f) => {
        f.rows.steps = f.rows.steps.filter((row) => row.step !== 'VERIFY_PROVISIONED');
      },
      'UNRECORDED_PROVIDER_RECEIPT',
    ],
    [
      'application มี receipt แต่ provider อ่านไม่ได้',
      (f) => f.provider.steps.set('CREATE_IDENTITY', { outcome: 'UNKNOWN' }),
      'PROVIDER_UNREADABLE',
    ],
    [
      'invitation dispatch ไม่มี receipt ทั้งสองฝั่ง',
      (f) => {
        f.rows.dispatches[0]!.outcome = null;
        f.rows.dispatches[0]!.receiptRef = null;
        f.provider.invitation = { outcome: 'UNKNOWN' };
      },
      'PROVIDER_UNREADABLE',
    ],
    [
      'invitation outcome ต่าง',
      (f) => (f.provider.invitation = { outcome: 'FAILED', receiptRef: ref('a') }),
      'RECEIPT_MISMATCH',
    ],
    [
      'disable attempted แต่ application ไม่มี receipt',
      (f) => {
        f.rows.disables[0]!.outcome = null;
        f.rows.disables[0]!.receiptRef = null;
      },
      'UNRECORDED_PROVIDER_RECEIPT',
    ],
    [
      'payload ของ operation ถูกแก้',
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

test('#868 identity evidence: readiness ผิดหรือ HTTP ล้มทำให้ INCONSISTENT แม้ไม่มี mismatch', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => (f.provider.readiness = null),
    (f: ReturnType<typeof fixture>) =>
      (f.provider.readiness = { version: 2, ready: true, tenantId }),
    (f: ReturnType<typeof fixture>) => (f.provider.failures = 1),
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

test('#868 identity evidence: disable ที่ยังไม่ attempted และไม่มี receipt ไม่ถูกอ่านจาก provider', async () => {
  const value = fixture();
  value.rows.disables[0]!.attempted = false;
  value.rows.disables[0]!.outcome = null;
  const evidence = await collectPeopleIdentityEvidence(value.database, [value.source]);
  assert.equal(evidence.status, 'CONSISTENT');
  assert.equal(evidence.tenants[0]?.counts.disables, 0);
  assert.equal(value.seen.disable!.length, 0);
});
