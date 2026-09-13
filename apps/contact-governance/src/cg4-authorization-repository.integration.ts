import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { cg4SubjectId, tenantId, type Cg4AuthorizationSubject } from '@d-contact/cxa-contracts';
import { Cg4ApprovalRepository } from './cg4-approval-repository.js';
import {
  Cg4DelegationNotAllowedError,
  Cg4DuplicateCheckerError,
  Cg4QuorumNotMetError,
  Cg4SelfApprovalError,
  assertCg4QuorumMet,
} from './cg4-authorization-engine.js';
import { Cg4DelegationRepository } from './cg4-delegation-repository.js';
import {
  Cg4FoundationRepository,
  type RecordCg4ExceptionInput,
} from './cg4-foundation-repository.js';
import {
  Cg3IdempotencyConflictError,
  Cg3VersionConflictError,
  stableDigest,
} from './cg3-persistence.js';

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
  const contactId = randomUUID();
  const identityId = randomUUID();
  const policyId = randomUUID();
  const suffix = tenant.slice(0, 8);
  const content = { allowedOperationalRuleCodes: ['QUIET_HOURS', 'MIN_GAP'] };
  const contentDigest = stableDigest(content);

  t.after(async () => {
    await owner.cg4Delegation.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyApproval.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4ExceptionApproval.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4ExceptionHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4Exception.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4ContactExceptionHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cgCommandReceipt.deleteMany({ where: { tenantId: tenant } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId: tenant } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4Policy.deleteMany({ where: { tenantId: tenant } });
    await owner.contactIdentity.deleteMany({ where: { tenantId: tenant } });
    await owner.contact.deleteMany({ where: { tenantId: tenant } });
    await owner.tenant.deleteMany({ where: { id: tenant } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenant,
      name: `CG4.3 ${suffix}`,
      slug: `cg4-3-${suffix}`,
      sipDomain: `${suffix}.cg43.test`,
    },
  });
  await owner.contact.create({ data: { id: contactId, tenantId: tenant } });
  await owner.contactIdentity.create({
    data: { id: identityId, tenantId: tenant, contactId, type: 'LINE', value: `line-${suffix}` },
  });
  await owner.cg4Policy.create({
    data: {
      id: randomUUID(),
      tenantId: tenant,
      policyId,
      version: 1,
      scopeKey: 'channel:LINE|purpose:SERVICE_NOTIFICATION|contactKind:*|sourceType:*',
      content,
      contentDigest,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      status: 'PUBLISHED',
      effectiveFrom: new Date('2026-09-13T00:00:00.000Z'),
      makerActorRef: 'actor:maker:opaque',
      publishedAt: new Date('2026-09-13T00:00:00.000Z'),
    },
  });
  return { owner, application, tenant, contactId, identityId, policyId, contentDigest };
}

function exceptionCommand(
  f: Awaited<ReturnType<typeof fixture>>,
  makerSubjectId: string,
  overrides: Partial<RecordCg4ExceptionInput> = {},
): RecordCg4ExceptionInput {
  return {
    tenantId: f.tenant,
    contactId: f.contactId,
    identityId: f.identityId,
    scopeKind: 'IDENTITY',
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    sourceType: 'DIALER',
    sourceId: 'source:opaque:1',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: f.policyId,
    policyVersion: 1,
    policyContentDigest: f.contentDigest,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: '2026-09-13T01:00:00.000Z',
    expiresAt: '2026-09-13T02:00:00.000Z',
    tier: 'STANDARD',
    reasonCode: 'CUSTOMER_CALLBACK',
    evidenceRef: 'evidence:opaque:1',
    actorRef: makerSubjectId,
    occurredAt: '2026-09-13T00:30:00.000Z',
    idempotencyKey: randomUUID(),
    expectedVersion: 0,
    ...overrides,
  };
}

function subject(
  overrides: Partial<Omit<Cg4AuthorizationSubject, 'subjectId'>> & { subjectId: string },
): Cg4AuthorizationSubject {
  const { subjectId: rawSubjectId, ...rest } = overrides;
  return {
    tenantId: tenantId('00000000-0000-0000-0000-000000000000'),
    authenticationStrength: 'STANDARD',
    capabilities: [],
    directComplianceAuthority: false,
    emergencyAuthority: false,
    authorizationEpoch: 1,
    scopeVersion: 1,
    evaluatedAt: new Date().toISOString(),
    ...rest,
    subjectId: cg4SubjectId(rawSubjectId),
  };
}

const SCOPE = 'tenant:t|team:compliance';

function checker(
  subjectId: string,
  capability:
    | 'cg.exception.approve.standard'
    | 'cg.exception.approve.high'
    | 'cg.policy.publish'
    | 'cg.policy.publish.relaxation',
  overrides: Partial<Cg4AuthorizationSubject> = {},
): Cg4AuthorizationSubject {
  return subject({
    subjectId,
    capabilities: [{ capability, scopeKey: SCOPE, source: 'DIRECT' }],
    ...overrides,
  });
}

test('CG4.3 exception approval: STANDARD ผ่านด้วย checker อิสระ 1 คนที่ต่างจาก maker', async (t) => {
  const f = await fixture(t);
  const foundation = new Cg4FoundationRepository(f.application);
  const approvals = new Cg4ApprovalRepository(f.application);
  const maker = 'maker-1';

  const created = await foundation.recordException(exceptionCommand(f, maker));
  const exceptionRow = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
  });
  const result = await approvals.recordExceptionApproval({
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: created.exception.revision,
    expectedContentDigest: exceptionRow.requestHash,
    decision: 'APPROVE',
    evidenceRef: 'evidence:approval:1',
    makerSubjectId: maker,
    scopeKey: SCOPE,
    checker: checker('checker-1', 'cg.exception.approve.standard'),
    idempotencyKey: randomUUID(),
  });

  assert.equal(result.quorum.status, 'MET');
  assert.equal(result.quorum.current, 1);
  assert.doesNotThrow(() => assertCg4QuorumMet(result.quorum));
  assert.equal(
    await f.owner.cg4ExceptionApproval.count({
      where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
    }),
    1,
  );
});

test('CG4.3 exception approval: HIGH ต้องการ checker 2 คนที่ต่างกันและอย่างน้อยหนึ่งคนถือ direct Compliance', async (t) => {
  const f = await fixture(t);
  const foundation = new Cg4FoundationRepository(f.application);
  const approvals = new Cg4ApprovalRepository(f.application);
  const maker = 'maker-1';

  const created = await foundation.recordException(
    exceptionCommand(f, maker, { tier: 'HIGH', allowedRuleCodes: ['MIN_GAP'] }),
  );
  const exceptionRow = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
  });

  const first = await approvals.recordExceptionApproval({
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: created.exception.revision,
    expectedContentDigest: exceptionRow.requestHash,
    decision: 'APPROVE',
    evidenceRef: 'evidence:approval:1',
    makerSubjectId: maker,
    scopeKey: SCOPE,
    checker: checker('checker-1', 'cg.exception.approve.high'),
    idempotencyKey: randomUUID(),
  });
  assert.equal(first.quorum.status, 'PENDING');
  assert.equal(first.quorum.current, 1);

  const second = await approvals.recordExceptionApproval({
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: created.exception.revision,
    expectedContentDigest: exceptionRow.requestHash,
    decision: 'APPROVE',
    evidenceRef: 'evidence:approval:2',
    makerSubjectId: maker,
    scopeKey: SCOPE,
    checker: checker('checker-2', 'cg.exception.approve.high', { directComplianceAuthority: true }),
    idempotencyKey: randomUUID(),
  });
  assert.equal(second.quorum.status, 'MET');
  assert.equal(second.quorum.current, 2);
});

test('CG4.3 exception approval: maker approve คำขอของตัวเองถูกปฏิเสธ (self-approval)', async (t) => {
  const f = await fixture(t);
  const foundation = new Cg4FoundationRepository(f.application);
  const approvals = new Cg4ApprovalRepository(f.application);
  const maker = 'maker-self';

  const created = await foundation.recordException(exceptionCommand(f, maker));
  const exceptionRow = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
  });

  await assert.rejects(
    approvals.recordExceptionApproval({
      tenantId: f.tenant,
      exceptionId: created.exception.exceptionId,
      expectedRevision: created.exception.revision,
      expectedContentDigest: exceptionRow.requestHash,
      decision: 'APPROVE',
      evidenceRef: 'evidence:approval:1',
      makerSubjectId: maker,
      scopeKey: SCOPE,
      checker: checker(maker, 'cg.exception.approve.standard'),
      idempotencyKey: randomUUID(),
    }),
    Cg4SelfApprovalError,
  );
});

test('CG4.3 exception approval: checker เดิม approve ซ้ำถูกปฏิเสธทั้งใน application และที่ DB unique constraint', async (t) => {
  const f = await fixture(t);
  const foundation = new Cg4FoundationRepository(f.application);
  const approvals = new Cg4ApprovalRepository(f.application);
  const maker = 'maker-1';

  const created = await foundation.recordException(
    exceptionCommand(f, maker, { tier: 'HIGH', allowedRuleCodes: ['MIN_GAP'] }),
  );
  const exceptionRow = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
  });

  await approvals.recordExceptionApproval({
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: created.exception.revision,
    expectedContentDigest: exceptionRow.requestHash,
    decision: 'APPROVE',
    evidenceRef: 'evidence:approval:1',
    makerSubjectId: maker,
    scopeKey: SCOPE,
    checker: checker('checker-1', 'cg.exception.approve.high'),
    idempotencyKey: randomUUID(),
  });

  await assert.rejects(
    approvals.recordExceptionApproval({
      tenantId: f.tenant,
      exceptionId: created.exception.exceptionId,
      expectedRevision: created.exception.revision,
      expectedContentDigest: exceptionRow.requestHash,
      decision: 'APPROVE',
      evidenceRef: 'evidence:approval:2',
      makerSubjectId: maker,
      scopeKey: SCOPE,
      checker: checker('checker-1', 'cg.exception.approve.high'),
      idempotencyKey: randomUUID(),
    }),
    Cg4DuplicateCheckerError,
  );

  await assert.rejects(
    f.owner.cg4ExceptionApproval.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenant,
        exceptionId: created.exception.exceptionId,
        exceptionRevision: created.exception.revision,
        decision: 'APPROVED',
        approverRef: 'checker-1',
        evidenceRef: 'evidence:bypass',
        decidedAt: new Date(),
        capability: 'cg.exception.approve.high',
        capabilitySource: 'DIRECT',
        directCompliance: false,
        emergencyAuthority: false,
        authorizationEpoch: 1,
        scopeVersion: 1,
      },
    }),
    /Unique constraint/,
  );
});

test('CG4.3 exception approval: idempotency key เดิมคืนผลเดิมโดยไม่สร้าง approval แถวใหม่', async (t) => {
  const f = await fixture(t);
  const foundation = new Cg4FoundationRepository(f.application);
  const approvals = new Cg4ApprovalRepository(f.application);
  const maker = 'maker-1';

  const created = await foundation.recordException(exceptionCommand(f, maker));
  const exceptionRow = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
  });
  const idempotencyKey = randomUUID();
  const input = {
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: created.exception.revision,
    expectedContentDigest: exceptionRow.requestHash,
    decision: 'APPROVE' as const,
    evidenceRef: 'evidence:approval:1',
    makerSubjectId: maker,
    scopeKey: SCOPE,
    checker: checker('checker-1', 'cg.exception.approve.standard'),
    idempotencyKey,
  };

  const first = await approvals.recordExceptionApproval(input);
  const retried = await approvals.recordExceptionApproval(input);
  assert.deepEqual(retried, first);
  assert.equal(
    await f.owner.cg4ExceptionApproval.count({
      where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
    }),
    1,
  );

  await assert.rejects(
    approvals.recordExceptionApproval({
      ...input,
      idempotencyKey,
      evidenceRef: 'evidence:different',
    }),
    Cg3IdempotencyConflictError,
  );
});

test('CG4.3 exception approval: CAS ปฏิเสธเมื่อ expectedRevision หรือ expectedContentDigest ไม่ตรง', async (t) => {
  const f = await fixture(t);
  const foundation = new Cg4FoundationRepository(f.application);
  const approvals = new Cg4ApprovalRepository(f.application);
  const maker = 'maker-1';

  const created = await foundation.recordException(exceptionCommand(f, maker));

  await assert.rejects(
    approvals.recordExceptionApproval({
      tenantId: f.tenant,
      exceptionId: created.exception.exceptionId,
      expectedRevision: created.exception.revision + 1,
      expectedContentDigest: 'a'.repeat(64),
      decision: 'APPROVE',
      evidenceRef: 'evidence:approval:1',
      makerSubjectId: maker,
      scopeKey: SCOPE,
      checker: checker('checker-1', 'cg.exception.approve.standard'),
      idempotencyKey: randomUUID(),
    }),
    Cg3VersionConflictError,
  );
});

test('CG4.3 policy approval: tightening/neutral quorum ผ่านด้วย independent Compliance checker 1 คน', async (t) => {
  const f = await fixture(t);
  const approvals = new Cg4ApprovalRepository(f.application);

  const tightening = await approvals.recordPolicyApproval({
    tenantId: f.tenant,
    policyId: f.policyId,
    expectedVersion: 1,
    expectedContentDigest: f.contentDigest,
    diffClass: 'TIGHTENING',
    decision: 'APPROVE',
    evidenceRef: 'evidence:policy:1',
    makerSubjectId: 'policy-maker-1',
    scopeKey: SCOPE,
    checker: checker('policy-checker-1', 'cg.policy.publish', { directComplianceAuthority: true }),
    idempotencyKey: randomUUID(),
  });
  assert.equal(tightening.quorum.status, 'MET');
});

test('CG4.3 policy approval: relaxation ต้องการ checker 2 คนที่ต่างกันและอย่างน้อยหนึ่งคนถือ direct Compliance', async (t) => {
  const f = await fixture(t);
  const approvals = new Cg4ApprovalRepository(f.application);
  const maker = 'policy-maker-1';

  const relaxationFirst = await approvals.recordPolicyApproval({
    tenantId: f.tenant,
    policyId: f.policyId,
    expectedVersion: 1,
    expectedContentDigest: f.contentDigest,
    diffClass: 'RELAXATION',
    decision: 'APPROVE',
    evidenceRef: 'evidence:policy:1',
    makerSubjectId: maker,
    scopeKey: SCOPE,
    checker: checker('policy-checker-1', 'cg.policy.publish.relaxation', {
      directComplianceAuthority: true,
    }),
    idempotencyKey: randomUUID(),
  });
  assert.equal(relaxationFirst.quorum.status, 'PENDING');

  const relaxationSecond = await approvals.recordPolicyApproval({
    tenantId: f.tenant,
    policyId: f.policyId,
    expectedVersion: 1,
    expectedContentDigest: f.contentDigest,
    diffClass: 'RELAXATION',
    decision: 'APPROVE',
    evidenceRef: 'evidence:policy:2',
    makerSubjectId: maker,
    scopeKey: SCOPE,
    checker: checker('policy-checker-2', 'cg.policy.publish.relaxation'),
    idempotencyKey: randomUUID(),
  });
  assert.equal(relaxationSecond.quorum.status, 'MET');
});

test('CG4.3 delegation: grant สำเร็จ, retry ด้วย idempotency key เดิมคืนผลเดิม, capability นอกชุด delegable ถูกปฏิเสธที่ DB ด้วย', async (t) => {
  const f = await fixture(t);
  const delegations = new Cg4DelegationRepository(f.application);

  const idempotencyKey = randomUUID();
  const input = {
    tenantId: f.tenant,
    delegatorSubjectId: 'delegator-1',
    delegateSubjectId: 'delegate-1',
    delegatorHoldsCapabilityDirectly: true,
    delegateIsServicePrincipal: false,
    capability: 'cg.exception.request' as const,
    scopeKey: SCOPE,
    grantVersion: 1,
    startsAt: '2026-09-13T00:00:00.000Z',
    expiresAt: '2026-09-13T04:00:00.000Z',
    idempotencyKey,
  };
  const granted = await delegations.grant(input);
  const retried = await delegations.grant(input);
  assert.deepEqual(retried, granted);
  assert.equal(await f.owner.cg4Delegation.count({ where: { tenantId: f.tenant } }), 1);

  await assert.rejects(
    delegations.grant({ ...input, idempotencyKey, scopeKey: 'a-different-scope' }),
    Cg3IdempotencyConflictError,
  );

  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenant, (transaction) =>
      transaction.cg4Delegation.create({
        data: {
          id: randomUUID(),
          tenantId: f.tenant,
          delegatorSubjectId: 'delegator-2',
          delegateSubjectId: 'delegate-2',
          capability: 'cg.exception.approve.high',
          scopeKey: SCOPE,
          grantVersion: 1,
          startsAt: new Date('2026-09-13T00:00:00.000Z'),
          expiresAt: new Date('2026-09-13T04:00:00.000Z'),
        },
      }),
    ),
    /violates check constraint/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenant, (transaction) =>
      transaction.cg4Delegation.create({
        data: {
          id: randomUUID(),
          tenantId: f.tenant,
          delegatorSubjectId: 'same-subject',
          delegateSubjectId: 'same-subject',
          capability: 'cg.exception.request',
          scopeKey: SCOPE,
          grantVersion: 1,
          startsAt: new Date('2026-09-13T00:00:00.000Z'),
          expiresAt: new Date('2026-09-13T04:00:00.000Z'),
        },
      }),
    ),
    /violates check constraint/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenant, (transaction) =>
      transaction.cg4Delegation.create({
        data: {
          id: randomUUID(),
          tenantId: f.tenant,
          delegatorSubjectId: 'delegator-3',
          delegateSubjectId: 'delegate-3',
          capability: 'cg.exception.request',
          scopeKey: SCOPE,
          grantVersion: 1,
          startsAt: new Date('2026-09-13T00:00:00.000Z'),
          expiresAt: new Date('2026-09-13T09:00:00.000Z'),
        },
      }),
    ),
    /violates check constraint/,
  );
});

test('CG4.3 delegation: application layer ปฏิเสธ self-delegation และ capability ที่มอบหมายไม่ได้ก่อนแตะ DB', async (t) => {
  const f = await fixture(t);
  const delegations = new Cg4DelegationRepository(f.application);

  await assert.rejects(
    delegations.grant({
      tenantId: f.tenant,
      delegatorSubjectId: 'same',
      delegateSubjectId: 'same',
      delegatorHoldsCapabilityDirectly: true,
      delegateIsServicePrincipal: false,
      capability: 'cg.exception.request',
      scopeKey: SCOPE,
      grantVersion: 1,
      startsAt: '2026-09-13T00:00:00.000Z',
      expiresAt: '2026-09-13T04:00:00.000Z',
      idempotencyKey: randomUUID(),
    }),
    Cg4DelegationNotAllowedError,
  );
  await assert.rejects(
    delegations.grant({
      tenantId: f.tenant,
      delegatorSubjectId: 'delegator-1',
      delegateSubjectId: 'delegate-1',
      delegatorHoldsCapabilityDirectly: true,
      delegateIsServicePrincipal: false,
      capability: 'cg.exception.approve.high',
      scopeKey: SCOPE,
      grantVersion: 1,
      startsAt: '2026-09-13T00:00:00.000Z',
      expiresAt: '2026-09-13T04:00:00.000Z',
      idempotencyKey: randomUUID(),
    }),
    Cg4DelegationNotAllowedError,
  );
  assert.equal(await f.owner.cg4Delegation.count({ where: { tenantId: f.tenant } }), 0);
});

test('CG4.3 exception approval: checker ที่ถือ capability ผ่าน delegation ใช้ approve HIGH ไม่ได้ (fail closed)', async (t) => {
  const f = await fixture(t);
  const foundation = new Cg4FoundationRepository(f.application);
  const approvals = new Cg4ApprovalRepository(f.application);
  const maker = 'maker-1';

  const created = await foundation.recordException(
    exceptionCommand(f, maker, { tier: 'HIGH', allowedRuleCodes: ['MIN_GAP'] }),
  );
  const exceptionRow = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
  });

  const delegatedChecker = subject({
    subjectId: 'delegated-checker',
    capabilities: [
      { capability: 'cg.exception.approve.high', scopeKey: SCOPE, source: 'DELEGATED' },
    ],
  });

  await assert.rejects(
    approvals.recordExceptionApproval({
      tenantId: f.tenant,
      exceptionId: created.exception.exceptionId,
      expectedRevision: created.exception.revision,
      expectedContentDigest: exceptionRow.requestHash,
      decision: 'APPROVE',
      evidenceRef: 'evidence:approval:1',
      makerSubjectId: maker,
      scopeKey: SCOPE,
      checker: delegatedChecker,
      idempotencyKey: randomUUID(),
    }),
    Cg4DelegationNotAllowedError,
  );
});
