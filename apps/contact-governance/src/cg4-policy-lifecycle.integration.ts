import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import {
  cg4SubjectId,
  tenantId as tenantIdBrand,
  type Cg4AuthorizationSubject,
  type Cg4Capability,
} from '@d-contact/cxa-contracts';
import { Cg3VersionConflictError } from './cg3-persistence.js';
import { Cg4ApprovalRepository } from './cg4-approval-repository.js';
import { Cg4QuorumNotMetError } from './cg4-authorization-engine.js';
import { buildCg4PolicyScopeKey, compileCg4Policy } from './cg4-policy-compiler.js';
import type { Cg4PolicyFixturePack } from './cg4-policy-fixtures.js';
import { Cg4PolicyLifecycleError, Cg4PolicyLifecycleRepository } from './cg4-policy-lifecycle.js';

/**
 * CG4.5 (#188): the policy studio runtime against a real database — draft/test/submit,
 * quorum-bound approval, atomic immediate and scheduled publish, rollback-as-new-version
 * and the scoped kill switch. Everything here runs through the application role, so the
 * RLS policies and the immutability trigger are part of what is being asserted.
 */

const NOW = new Date('2026-01-05T03:00:00.000Z');
const PINNED_TIME = '2026-01-05T00:00:00.000Z';
const PINNED_ZONE = 'Asia/Bangkok';
const SCOPE_KEY = buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' });
const MAKER = 'policy-maker-1';

const TENANT_PACK: Cg4PolicyFixturePack = {
  packId: 'TENANT_SYNTHETIC',
  suiteVersion: 'TENANT_SYNTHETIC_V1',
  checks: [
    {
      id: 'tenant:quiet-hours-local-clock',
      kind: 'QUIET_HOURS_FOLLOW_LOCAL_CLOCK',
      timezone: PINNED_ZONE,
      fromInstant: PINNED_TIME,
      probeHours: 24,
      stepMinutes: 60,
    },
  ],
};

function content(overrides: Record<string, unknown> = {}) {
  return {
    timezoneFallback: PINNED_ZONE,
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '22:00', endLocal: '06:00' }],
    callbackMode: 'NO_OVERRIDE',
    overridableRules: [],
    allowedOperationalRuleCodes: [],
    holidays: [],
    ...overrides,
  };
}

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
      },
    },
  });
  const tenant = randomUUID();

  t.after(async () => {
    await owner.cg4PolicyApproval.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyTestArtifact.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyActivationJob.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyScopeHead.deleteMany({ where: { tenantId: tenant } });
    // supersedesId/rollbackOfId point at each other within the table as a DAG, and the immutability trigger forbids
    // cutting the reference before deleting, so delete layer by layer starting from leaves nobody references
    for (;;) {
      const rows = await owner.cg4Policy.findMany({
        where: { tenantId: tenant },
        select: { id: true, supersedesId: true, rollbackOfId: true },
      });
      if (rows.length === 0) break;
      const referenced = new Set(
        rows
          .flatMap((row) => [row.supersedesId, row.rollbackOfId])
          .filter((id): id is string => id !== null),
      );
      const leaves = rows.filter((row) => !referenced.has(row.id)).map((row) => row.id);
      if (leaves.length === 0) break;
      await owner.cg4Policy.deleteMany({ where: { id: { in: leaves } } });
    }
    await owner.cg4ScopeKillSwitch.deleteMany({ where: { tenantId: tenant } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId: tenant } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId: tenant } });
    await owner.cgCommandReceipt.deleteMany({ where: { tenantId: tenant } });
    await owner.tenant.deleteMany({ where: { id: tenant } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenant,
      name: `CG4.5 ${tenant}`,
      slug: `cg45-${tenant}`,
      sipDomain: `${tenant}.cg45.test`,
    },
  });

  return {
    owner,
    application,
    tenant,
    repository: new Cg4PolicyLifecycleRepository(application, { now: () => NOW }),
    approvals: new Cg4ApprovalRepository(application, { now: () => NOW }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function subject(
  subjectIdValue: string,
  capabilities: Cg4Capability[],
  overrides: Partial<Cg4AuthorizationSubject> = {},
): Cg4AuthorizationSubject {
  return {
    subjectId: cg4SubjectId(subjectIdValue),
    tenantId: tenantIdBrand('00000000-0000-0000-0000-000000000000'),
    authenticationStrength: 'STANDARD',
    capabilities: capabilities.map((capability) => ({
      capability,
      scopeKey: SCOPE_KEY,
      source: 'DIRECT' as const,
    })),
    directComplianceAuthority: true,
    emergencyAuthority: false,
    authorizationEpoch: 1,
    scopeVersion: 1,
    evaluatedAt: NOW.toISOString(),
    ...overrides,
  };
}

const maker = () => subject(MAKER, ['cg.policy.draft', 'cg.policy.rollback']);

function command(overrides: Record<string, unknown> = {}) {
  return {
    actor: maker(),
    evidenceRef: 'evidence:cg45',
    occurredAt: NOW.toISOString(),
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

/** draft -> test -> submit -> approve, leaving a candidate ready to publish. */
async function approvedCandidate(
  f: Fixture,
  options: {
    policyId?: string;
    content?: Record<string, unknown>;
    activateAt?: string;
    checkers?: string[];
  } = {},
) {
  const draft = await f.repository.createDraft({
    tenantId: f.tenant,
    ...(options.policyId ? { policyId: options.policyId } : {}),
    scopeKey: SCOPE_KEY,
    content: options.content ?? content(),
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    ...command(),
  });

  const tested = await f.repository.runTests({
    tenantId: f.tenant,
    policyId: draft.policyId,
    version: draft.version,
    expectedContentDigest: draft.contentDigest,
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
    ...command(),
  });
  assert.equal(tested.preview.tests.outcome, 'PASS');

  await f.repository.submit({
    tenantId: f.tenant,
    policyId: draft.policyId,
    version: draft.version,
    expectedDraftRevision: draft.draftRevision,
    expectedContentDigest: draft.contentDigest,
    expectedTestArtifactDigest: tested.preview.artifactDigest,
    ...command(),
  });

  const diffClass = tested.preview.diffClass;
  const requiredCapability =
    diffClass === 'RELAXATION' ? 'cg.policy.publish.relaxation' : 'cg.policy.publish';
  for (const checker of options.checkers ?? ['checker-1']) {
    await f.approvals.recordPolicyApproval({
      tenantId: f.tenant,
      policyId: draft.policyId,
      expectedVersion: draft.version,
      expectedContentDigest: draft.contentDigest,
      diffClass,
      decision: 'APPROVE',
      evidenceRef: `evidence:approval:${checker}`,
      makerSubjectId: MAKER,
      scopeKey: SCOPE_KEY,
      checker: subject(checker, [requiredCapability]),
      idempotencyKey: randomUUID(),
    });
  }

  const head = await f.repository.preview({
    tenantId: f.tenant,
    policyId: draft.policyId,
    version: draft.version,
    expectedContentDigest: draft.contentDigest,
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
  });

  const approved = await f.repository.finalizeApproval({
    tenantId: f.tenant,
    policyId: draft.policyId,
    version: draft.version,
    expectedContentDigest: draft.contentDigest,
    expectedTestArtifactDigest: tested.preview.artifactDigest,
    expectedDiffClass: diffClass,
    expectedScopeHeadVersion: head.baseHeadVersion,
    expectedScopeHeadDigest: head.baseHeadDigest,
    activateAt: options.activateAt ?? NOW.toISOString(),
    ...command({ actor: subject('finalizer-1', ['cg.policy.draft']) }),
  });
  assert.equal(approved.lifecycleState, 'APPROVED');

  const row = await f.owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.tenant, policyId: draft.policyId, version: draft.version },
  });
  return {
    draft,
    testArtifactDigest: tested.preview.artifactDigest,
    approvalDigest: row.approvalDigest as string,
    headVersion: head.baseHeadVersion,
    headDigest: head.baseHeadDigest,
    diffClass,
  };
}

async function publish(f: Fixture, candidate: Awaited<ReturnType<typeof approvedCandidate>>) {
  return f.repository.publish({
    tenantId: f.tenant,
    policyId: candidate.draft.policyId,
    version: candidate.draft.version,
    expectedContentDigest: candidate.draft.contentDigest,
    expectedTestArtifactDigest: candidate.testArtifactDigest,
    expectedApprovalDigest: candidate.approvalDigest,
    expectedScopeHeadVersion: candidate.headVersion,
    expectedScopeHeadDigest: candidate.headDigest,
    ...command({ actor: subject('publisher-1', ['cg.policy.publish']) }),
  });
}

test('an immediate publish moves the head atomically and supersedes the original version while closing the interval', async (t) => {
  const f = await fixture(t);
  const first = await publish(f, await approvedCandidate(f));
  assert.equal(first.lifecycleState, 'ACTIVE');
  assert.equal(first.headVersion, 1);

  const second = await publish(
    f,
    await approvedCandidate(f, {
      policyId: first.policyId,
      content: content({
        quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '06:00' }],
      }),
    }),
  );
  assert.equal(second.version, 2);
  assert.equal(second.headVersion, 2);

  const rows = await f.owner.cg4Policy.findMany({
    where: { tenantId: f.tenant },
    orderBy: { version: 'asc' },
  });
  assert.deepEqual(
    rows.map((row) => row.status),
    ['SUPERSEDED', 'ACTIVE'],
  );
  assert.equal(rows[0]?.effectiveTo?.toISOString(), NOW.toISOString());
  assert.equal(rows[1]?.supersedesId, rows[0]?.id);

  const head = await f.owner.cg4PolicyScopeHead.findFirstOrThrow({
    where: { tenantId: f.tenant, scopeKey: SCOPE_KEY },
  });
  assert.equal(head.headPolicyVersion, 2);
  assert.equal(head.headDigest, second.headDigest);
  assert.equal(head.nextActivationAt, null);

  const events = await f.owner.cgEventOutbox.findMany({
    where: { tenantId: f.tenant, eventType: 'policy.changed' },
    orderBy: { aggregateVersion: 'asc' },
  });
  assert.equal(events.length, 2);
  assert.equal((events[1]?.payload as Record<string, unknown>).state, 'ACTIVE');
  assert.equal((events[1]?.payload as Record<string, unknown>).restrictiveness, 'TIGHTENING');
});

test('a repeated publish with the same idempotency key returns the original result and does not move the head', async (t) => {
  const f = await fixture(t);
  const candidate = await approvedCandidate(f);
  const key = randomUUID();
  const request = {
    tenantId: f.tenant,
    policyId: candidate.draft.policyId,
    version: candidate.draft.version,
    expectedContentDigest: candidate.draft.contentDigest,
    expectedTestArtifactDigest: candidate.testArtifactDigest,
    expectedApprovalDigest: candidate.approvalDigest,
    expectedScopeHeadVersion: candidate.headVersion,
    expectedScopeHeadDigest: candidate.headDigest,
    actor: subject('publisher-1', ['cg.policy.publish']),
    evidenceRef: 'evidence:cg45',
    occurredAt: NOW.toISOString(),
    idempotencyKey: key,
  };
  const first = await f.repository.publish(request);
  const replay = await f.repository.publish(request);
  assert.deepEqual(replay, first);
  assert.equal(
    await f.owner.cgEventOutbox.count({
      where: { tenantId: f.tenant, eventType: 'policy.changed' },
    }),
    1,
  );
});

test('a head that moved after approve makes the publish rejected with POLICY_HEAD_CONFLICT', async (t) => {
  const f = await fixture(t);
  const stale = await approvedCandidate(f);
  // another candidate publishes first, so the base head of the stale one no longer matches
  await publish(f, await approvedCandidate(f));

  await assert.rejects(
    publish(f, stale),
    (error: unknown) =>
      error instanceof Cg4PolicyLifecycleError && error.code === 'POLICY_HEAD_CONFLICT',
  );
});

test('a relaxation needs two checkers and one of them is a direct Compliance', async (t) => {
  const f = await fixture(t);
  const relaxing = { content: content({ allowedOperationalRuleCodes: ['QUIET_HOURS'] }) };
  await assert.rejects(
    approvedCandidate(f, { ...relaxing, checkers: ['checker-1'] }),
    (error: unknown) => error instanceof Cg4QuorumNotMetError,
  );

  const f2 = await fixture(t);
  const candidate = await approvedCandidate(f2, {
    ...relaxing,
    checkers: ['checker-1', 'checker-2'],
  });
  assert.equal(candidate.diffClass, 'RELAXATION');
  const published = await publish(f2, candidate);
  assert.equal(published.lifecycleState, 'ACTIVE');
});

test('a draft edited after running tests makes the artifact stale and the submit fails', async (t) => {
  const f = await fixture(t);
  const draft = await f.repository.createDraft({
    tenantId: f.tenant,
    scopeKey: SCOPE_KEY,
    content: content(),
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    ...command(),
  });
  const tested = await f.repository.runTests({
    tenantId: f.tenant,
    policyId: draft.policyId,
    version: draft.version,
    expectedContentDigest: draft.contentDigest,
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
    ...command(),
  });
  const amended = await f.repository.amendDraft({
    tenantId: f.tenant,
    policyId: draft.policyId,
    version: draft.version,
    expectedDraftRevision: draft.draftRevision,
    content: content({ callbackMode: 'SCOPED_OVERRIDE' }),
    ...command(),
  });
  assert.equal(amended.draftRevision, 2);
  assert.notEqual(amended.contentDigest, draft.contentDigest);

  await assert.rejects(
    f.repository.submit({
      tenantId: f.tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedDraftRevision: amended.draftRevision,
      expectedContentDigest: amended.contentDigest,
      expectedTestArtifactDigest: tested.preview.artifactDigest,
      ...command(),
    }),
    (error: unknown) =>
      error instanceof Cg4PolicyLifecycleError && error.code === 'POLICY_TESTS_REQUIRED',
  );
});

test('an amend with an old draftRevision is a version conflict, and content cannot be edited after submit', async (t) => {
  const f = await fixture(t);
  const draft = await f.repository.createDraft({
    tenantId: f.tenant,
    scopeKey: SCOPE_KEY,
    content: content(),
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    ...command(),
  });
  await f.repository.amendDraft({
    tenantId: f.tenant,
    policyId: draft.policyId,
    version: draft.version,
    expectedDraftRevision: 1,
    content: content({ callbackMode: 'SCOPED_OVERRIDE' }),
    ...command(),
  });
  await assert.rejects(
    f.repository.amendDraft({
      tenantId: f.tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedDraftRevision: 1,
      content: content({ callbackMode: 'TIME_POLICY_OVERRIDE' }),
      ...command(),
    }),
    (error: unknown) => error instanceof Cg3VersionConflictError,
  );
});

test('a scheduled publish creates a durable job, then activates on time without moving the head before then', async (t) => {
  const f = await fixture(t);
  await publish(f, await approvedCandidate(f));

  const later = '2026-01-05T09:00:00.000Z';
  const scheduled = await publish(
    f,
    await approvedCandidate(f, {
      content: content({
        quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '20:00', endLocal: '06:00' }],
      }),
      activateAt: later,
    }),
  );
  assert.equal(scheduled.lifecycleState, 'SCHEDULED');

  const head = await f.owner.cg4PolicyScopeHead.findFirstOrThrow({
    where: { tenantId: f.tenant, scopeKey: SCOPE_KEY },
  });
  assert.equal(
    head.headPolicyVersion,
    1,
    'the head must still point at the original version until the time comes',
  );
  assert.equal(head.nextActivationAt?.toISOString(), later);

  const job = await f.owner.cg4PolicyActivationJob.findFirstOrThrow({
    where: { tenantId: f.tenant, scopeKey: SCOPE_KEY },
  });
  assert.equal(job.state, 'PENDING');
  assert.equal(job.scheduledFor.toISOString(), later);

  await assert.rejects(
    f.repository.activateDue({
      tenantId: f.tenant,
      policyId: scheduled.policyId,
      version: scheduled.version,
      leaseOwner: 'worker-1',
      occurredAt: NOW.toISOString(),
      idempotencyKey: randomUUID(),
    }),
    (error: unknown) =>
      error instanceof Cg4PolicyLifecycleError && error.code === 'POLICY_ACTIVATION_CONFLICT',
  );

  const activated = await f.repository.activateDue({
    tenantId: f.tenant,
    policyId: scheduled.policyId,
    version: scheduled.version,
    leaseOwner: 'worker-1',
    occurredAt: later,
    idempotencyKey: randomUUID(),
  });
  assert.equal(activated.lifecycleState, 'ACTIVE');

  const afterHead = await f.owner.cg4PolicyScopeHead.findFirstOrThrow({
    where: { tenantId: f.tenant, scopeKey: SCOPE_KEY },
  });
  assert.equal(afterHead.headPolicyVersion, scheduled.version);
  assert.equal(afterHead.nextActivationAt, null);
  assert.equal(
    (await f.owner.cg4PolicyActivationJob.findFirstOrThrow({ where: { id: job.id } })).state,
    'COMPLETE',
  );
});

test('a single scope can have only one pending scheduled candidate', async (t) => {
  const f = await fixture(t);
  await publish(f, await approvedCandidate(f));
  await publish(
    f,
    await approvedCandidate(f, {
      content: content({
        quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '20:00', endLocal: '06:00' }],
      }),
      activateAt: '2026-01-05T09:00:00.000Z',
    }),
  );
  await assert.rejects(
    publish(
      f,
      await approvedCandidate(f, {
        content: content({
          quietHours: [
            { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '19:00', endLocal: '06:00' },
          ],
        }),
        activateAt: '2026-01-05T10:00:00.000Z',
      }),
    ),
    (error: unknown) =>
      error instanceof Cg4PolicyLifecycleError && error.code === 'SCHEDULE_CONFLICT',
  );
});

test('a scope that is ambiguous with an active scope at the same specificity cannot create a new series', async (t) => {
  const f = await fixture(t);
  await publish(f, await approvedCandidate(f));
  // SCOPE_KEY binds channel+purpose; the other binds channel+contactKind, which has equal specificity
  await assert.rejects(
    f.repository.createDraft({
      tenantId: f.tenant,
      scopeKey: buildCg4PolicyScopeKey({ channel: 'VOICE', contactKind: 'PERSON' }),
      content: content(),
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      ...command({
        actor: subject(MAKER, ['cg.policy.draft'], {
          capabilities: [
            {
              capability: 'cg.policy.draft',
              scopeKey: buildCg4PolicyScopeKey({ channel: 'VOICE', contactKind: 'PERSON' }),
              source: 'DIRECT',
            },
          ],
        }),
      }),
    }),
    (error: unknown) =>
      error instanceof Cg4PolicyLifecycleError && error.code === 'POLICY_SCOPE_AMBIGUOUS',
  );
});

test('a rollback creates a new version from the original content and does not revive the old row', async (t) => {
  const f = await fixture(t);
  const first = await publish(f, await approvedCandidate(f));
  const firstRow = await f.owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.tenant, policyId: first.policyId, version: 1 },
  });
  await publish(
    f,
    await approvedCandidate(f, {
      policyId: first.policyId,
      content: content({
        quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '06:00' }],
      }),
    }),
  );

  const rolled = await f.repository.rollback({
    tenantId: f.tenant,
    policyId: first.policyId,
    sourceVersion: 1,
    expectedSourceContentDigest: firstRow.contentDigest,
    reasonCode: 'INCIDENT_ROLLBACK',
    ...command(),
  });
  assert.equal(rolled.version, 3);
  assert.equal(rolled.lifecycleState, 'DRAFT');
  assert.equal(rolled.contentDigest, firstRow.contentDigest);

  const rolledRow = await f.owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.tenant, policyId: first.policyId, version: 3 },
  });
  assert.equal(rolledRow.rollbackOfId, firstRow.id);
  // version 1 remains SUPERSEDED as before: no pointer flip
  assert.equal(
    (await f.owner.cg4Policy.findFirstOrThrow({ where: { id: firstRow.id } })).status,
    'SUPERSEDED',
  );

  // a rollback that makes things looser than the current active needs two checkers like any other relaxation
  const tested = await f.repository.runTests({
    tenantId: f.tenant,
    policyId: first.policyId,
    version: 3,
    expectedContentDigest: rolled.contentDigest,
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
    ...command(),
  });
  assert.equal(tested.preview.diffClass, 'RELAXATION');
});

test('a kill switch can be opened immediately, blocks a relaxation publish, and clearing needs approval from someone else', async (t) => {
  const f = await fixture(t);
  await publish(f, await approvedCandidate(f));

  const activated = await f.repository.killSwitch({
    tenantId: f.tenant,
    scopeKey: SCOPE_KEY,
    action: 'ACTIVATE',
    reasonCode: 'INCIDENT',
    ...command({ actor: subject('operator-1', ['cg.policy.publish']) }),
  });
  assert.equal(activated.state, 'ACTIVE');

  // CG4.8 (#191): re-opening while still ACTIVE does not change the canonical state, so no new event is emitted
  const reactivated = await f.repository.killSwitch({
    tenantId: f.tenant,
    scopeKey: SCOPE_KEY,
    action: 'ACTIVATE',
    reasonCode: 'INCIDENT_REPEATED',
    ...command({ actor: subject('operator-3', ['cg.policy.publish']) }),
  });
  assert.equal(reactivated.killSwitchId, activated.killSwitchId);

  const relaxing = await approvedCandidate(f, {
    content: content({ allowedOperationalRuleCodes: ['QUIET_HOURS'] }),
    checkers: ['checker-1', 'checker-2'],
  });
  await assert.rejects(
    publish(f, relaxing),
    (error: unknown) =>
      error instanceof Cg4PolicyLifecycleError && error.code === 'GOVERNANCE_KILL_SWITCH_ACTIVE',
  );

  await assert.rejects(
    f.repository.killSwitch({
      tenantId: f.tenant,
      scopeKey: SCOPE_KEY,
      action: 'CLEAR',
      reasonCode: 'INCIDENT_RESOLVED',
      ...command({ actor: subject('operator-2', ['cg.policy.publish.relaxation']) }),
    }),
    (error: unknown) =>
      error instanceof Cg4PolicyLifecycleError && error.code === 'APPROVAL_REQUIRED',
  );

  await assert.rejects(
    f.repository.killSwitch({
      tenantId: f.tenant,
      scopeKey: SCOPE_KEY,
      action: 'CLEAR',
      reasonCode: 'INCIDENT_RESOLVED',
      clearApprovalRef: 'approval:clear:1',
      ...command({ actor: subject('operator-1', ['cg.policy.publish.relaxation']) }),
    }),
    (error: unknown) =>
      error instanceof Cg4PolicyLifecycleError && error.code === 'APPROVAL_REQUIRED',
  );

  const cleared = await f.repository.killSwitch({
    tenantId: f.tenant,
    scopeKey: SCOPE_KEY,
    action: 'CLEAR',
    reasonCode: 'INCIDENT_RESOLVED',
    clearApprovalRef: 'approval:clear:1',
    ...command({ actor: subject('operator-2', ['cg.policy.publish.relaxation']) }),
  });
  assert.equal(cleared.state, 'CLEARED');
  assert.equal(cleared.killSwitchId, activated.killSwitchId);

  // CG4.8 (#191): ACTIVE(1) -> CLEARED(2) on the kill switch aggregate; a fixed version would be quarantined by every
  // consumer as a hash conflict
  const killEvents = await f.owner.cgEventOutbox.findMany({
    where: { tenantId: f.tenant, eventType: 'governance.kill-switch.changed' },
    orderBy: { aggregateVersion: 'asc' },
  });
  assert.deepEqual(
    killEvents.map((event) => [
      event.aggregateId,
      event.aggregateVersion,
      (event.payload as { state: string }).state,
    ]),
    [
      [activated.killSwitchId, 1, 'ACTIVE'],
      [activated.killSwitchId, 2, 'CLEARED'],
    ],
  );
  const affectedScope = (killEvents[0]!.payload as { affectedScope: Record<string, string> })
    .affectedScope;
  assert.equal(affectedScope.channel, 'VOICE');
  assert.equal(affectedScope.purpose, 'SERVICE_NOTIFICATION');
});

test('the database enforces that an active head per scope can have only one version', async (t) => {
  const f = await fixture(t);
  const published = await publish(f, await approvedCandidate(f));
  const row = await f.owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.tenant, policyId: published.policyId, version: 1 },
  });
  await assert.rejects(
    f.owner.cg4Policy.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenant,
        policyId: randomUUID(),
        version: 1,
        scopeKey: SCOPE_KEY,
        content: compileCg4Policy({ content: content(), version: 1 })
          .content as unknown as Prisma.InputJsonValue,
        contentDigest: row.contentDigest,
        registryVersion: 'CG4_RULE_REGISTRY_V1',
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        makerActorRef: MAKER,
      },
    }),
  );
});

test('a trigger forbids editing the content of a version that is already ACTIVE', async (t) => {
  const f = await fixture(t);
  const published = await publish(f, await approvedCandidate(f));
  await assert.rejects(
    f.owner.cg4Policy.update({
      where: { id: published.policyVersionId },
      data: { contentDigest: 'c'.repeat(64) },
    }),
  );
});
