import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import {
  actionKey as actionKeyBrand,
  cg4SubjectId,
  reservationId as reservationIdBrand,
  tenantId as tenantIdBrand,
  type Cg4AuthorizationSubject,
} from '@d-contact/cxa-contracts';
import { ContactGovernanceService } from './contact-governance-service.js';
import { stableDigest, Cg3VersionConflictError } from './cg3-persistence.js';
import { Cg4ApprovalRepository } from './cg4-approval-repository.js';
import { Cg4FoundationRepository } from './cg4-foundation-repository.js';
import {
  Cg4ExceptionLifecycleRepository,
  Cg4ExceptionScopeConflictError,
  Cg4InvalidLifecycleTransitionError,
} from './cg4-exception-lifecycle.js';
import { Cg4QuorumNotMetError, Cg4SelfApprovalError } from './cg4-authorization-engine.js';

/**
 * CG4.4 (#187): the Approved exception lifecycle wired into `authorizeAndReserve()`.
 * `NOW` is 03:00 Asia/Bangkok, inside the fixture policy's 21:00–08:00 quiet hours, so
 * every authorize below starts from a provisional QUIET_HOURS block.
 */
const DIGEST = 'a'.repeat(64);
const NOW = new Date('2026-09-15T20:00:00.000Z');
const SCOPE_KEY = 'channel:LINE|purpose:MARKETING|contactKind:*|sourceType:*';
const MAKER = 'maker-subject-1';

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
  const contact = randomUUID();
  const identity = randomUUID();
  const cg4PolicyId = randomUUID();
  const content = { allowedOperationalRuleCodes: ['QUIET_HOURS'] };
  const cg4ContentDigest = stableDigest(content);

  t.after(async () => {
    await owner.cg4ExceptionApproval.deleteMany({ where: { tenantId: tenant } });
    // revision อ้าง head ผ่าน renews_exception_id และ head อ้าง revision ผ่าน current_revision_id
    // จึงต้องตัด renewal reference ก่อน ถึงจะลบสองตารางนี้ได้
    await owner.cg4Exception.updateMany({
      where: { tenantId: tenant },
      data: { renewsExceptionId: null },
    });
    await owner.cg4ExceptionHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4Exception.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4ContactExceptionHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4Policy.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4ScopeKillSwitch.deleteMany({ where: { tenantId: tenant } });
    await owner.cgCallbackRequest.deleteMany({ where: { tenantId: tenant } });
    await owner.cgPolicy.deleteMany({ where: { tenantId: tenant } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId: tenant } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId: tenant } });
    await owner.cgCommandReceipt.deleteMany({ where: { tenantId: tenant } });
    await owner.cgContactStateHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cgReservation.updateMany({
      where: { tenantId: tenant },
      data: { authorizationDecisionId: null },
    });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId: tenant } });
    await owner.cgReservation.deleteMany({ where: { tenantId: tenant } });
    await owner.cgConsent.deleteMany({ where: { tenantId: tenant } });
    await owner.contactIdentity.deleteMany({ where: { tenantId: tenant } });
    await owner.contact.deleteMany({ where: { tenantId: tenant } });
    await owner.tenant.deleteMany({ where: { id: tenant } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenant,
      name: `CG4.4 ${tenant}`,
      slug: `cg44-${tenant}`,
      sipDomain: `${tenant}.cg44.test`,
    },
  });
  await owner.contact.create({ data: { id: contact, tenantId: tenant, displayName: 'CG4.4' } });
  await owner.contactIdentity.create({
    data: {
      id: identity,
      tenantId: tenant,
      contactId: contact,
      type: 'LINE',
      value: `line-${tenant.slice(0, 8)}`,
    },
  });
  await owner.cgConsent.create({
    data: {
      tenantId: tenant,
      contactId: contact,
      purpose: 'MARKETING',
      channel: 'LINE',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'cg4-4-integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  // CG3 policy: quiet hours ที่ CG3 เองไม่อนุญาตให้ override (overridableRules ว่าง) เพื่อพิสูจน์ว่า
  // Approved exception เป็นกลไกอิสระจาก CG3 allowlist
  await owner.cgPolicy.create({
    data: {
      id: randomUUID(),
      tenantId: tenant,
      policyId: randomUUID(),
      version: 1,
      purpose: 'MARKETING',
      channel: 'LINE',
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [
        { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' },
      ] as unknown as Prisma.InputJsonValue,
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: [] as unknown as Prisma.InputJsonValue,
      status: 'PUBLISHED',
      contentDigest: DIGEST,
      makerActorRef: 'tenant-admin-1',
      checkerActorRef: 'compliance-1',
      approvalRef: 'approval-cg4-4',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await owner.cg4Policy.create({
    data: {
      id: randomUUID(),
      tenantId: tenant,
      policyId: cg4PolicyId,
      version: 1,
      scopeKey: SCOPE_KEY,
      content,
      contentDigest: cg4ContentDigest,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      status: 'PUBLISHED',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      makerActorRef: 'tenant-admin-1',
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });

  return { owner, application, tenant, contact, identity, cg4PolicyId, cg4ContentDigest };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function subject(
  subjectIdValue: string,
  capability: 'cg.exception.approve.standard' | 'cg.exception.amend' | 'cg.exception.revoke',
  overrides: Partial<Cg4AuthorizationSubject> = {},
): Cg4AuthorizationSubject {
  return {
    subjectId: cg4SubjectId(subjectIdValue),
    tenantId: tenantIdBrand('00000000-0000-0000-0000-000000000000'),
    authenticationStrength: 'STANDARD',
    capabilities: [{ capability, scopeKey: SCOPE_KEY, source: 'DIRECT' }],
    directComplianceAuthority: true,
    emergencyAuthority: false,
    authorizationEpoch: 1,
    scopeVersion: 1,
    evaluatedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** Request -> approve -> transition to APPROVED, i.e. an exception that is live at NOW. */
async function approvedException(
  f: Fixture,
  overrides: {
    sourceId?: string;
    startsAt?: string;
    expiresAt?: string;
    expectedVersion?: number;
  } = {},
) {
  const foundation = new Cg4FoundationRepository(f.application);
  const approvals = new Cg4ApprovalRepository(f.application, { now: () => NOW });
  const lifecycle = new Cg4ExceptionLifecycleRepository(f.application, { now: () => NOW });
  const expectedVersion = overrides.expectedVersion ?? 0;

  const created = await foundation.recordException({
    tenantId: f.tenant,
    contactId: f.contact,
    identityId: f.identity,
    scopeKind: 'IDENTITY',
    channel: 'LINE',
    purpose: 'MARKETING',
    sourceType: 'JOURNEY',
    sourceId: overrides.sourceId ?? 'journey-cg44-001',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: f.cg4PolicyId,
    policyVersion: 1,
    policyContentDigest: f.cg4ContentDigest,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: overrides.startsAt ?? '2026-09-15T19:00:00.000Z',
    expiresAt: overrides.expiresAt ?? '2026-09-15T22:00:00.000Z',
    tier: 'STANDARD',
    reasonCode: 'CUSTOMER_CALLBACK',
    evidenceRef: 'evidence:cg44:1',
    actorRef: MAKER,
    occurredAt: '2026-09-15T18:00:00.000Z',
    idempotencyKey: randomUUID(),
    expectedVersion,
  });
  const row = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
    orderBy: { revision: 'desc' },
  });

  await approvals.recordExceptionApproval({
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: created.exception.revision,
    expectedContentDigest: row.requestHash,
    decision: 'APPROVE',
    evidenceRef: 'evidence:approval:1',
    makerSubjectId: MAKER,
    scopeKey: SCOPE_KEY,
    checker: subject('checker-1', 'cg.exception.approve.standard'),
    idempotencyKey: randomUUID(),
  });

  const transitioned = await lifecycle.transition({
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: created.exception.revision,
    expectedContentDigest: row.requestHash,
    action: 'APPROVE',
    reasonCode: 'QUORUM_MET',
    evidenceRef: 'evidence:approval:1',
    actor: subject('checker-1', 'cg.exception.approve.standard'),
    scopeKey: SCOPE_KEY,
    occurredAt: '2026-09-15T19:30:00.000Z',
    expectedVersion: created.aggregateVersion,
    idempotencyKey: randomUUID(),
  });

  return { created, row, transitioned, lifecycle, approvals, foundation };
}

function authorizeInput(overrides: { sourceId?: string; actionKey: string }) {
  return {
    channel: 'LINE' as const,
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: overrides.sourceId ?? 'journey-cg44-001',
    actionKey: overrides.actionKey,
    policyVersion: 1,
  };
}

test('CG4.4: approved exception ยก quiet hours ที่ CG3 ไม่อนุญาตให้ override แล้วสร้าง reservation พร้อม cg4 pins', async (t) => {
  const f = await fixture(t);
  const service = new ContactGovernanceService(f.application, { now: () => NOW });

  // ก่อนมี exception: quiet hours เป็นผลสุดท้าย
  const before = await service.authorizeAndReserve(f.tenant, {
    contactId: f.contact,
    identityId: f.identity,
    ...authorizeInput({ actionKey: 'cg44-before:1:step-001' }),
  });
  assert.equal(before.decision, 'DEFER');
  assert.equal(before.reasonCode, 'QUIET_HOURS');
  assert.equal(before.cg4, undefined);

  const { created, row } = await approvedException(f);

  const after = await service.authorizeAndReserve(f.tenant, {
    contactId: f.contact,
    identityId: f.identity,
    ...authorizeInput({ actionKey: 'cg44-after:1:step-001' }),
  });

  assert.equal(after.decision, 'ALLOW');
  assert.equal(after.reasonCode, 'POLICY_PASSED');
  assert.ok(after.reservationId);
  // exception ยก provisional block แล้วเดิน gate ต่อ ไม่ใช่ ALLOW ทันที
  const gates = after.trace.map((entry) => `${entry.gate}:${entry.outcome}`);
  assert.ok(gates.includes('TEMPORAL_POLICY:DEFER'));
  assert.ok(gates.includes('APPROVED_EXCEPTION:PASS'));
  assert.ok(gates.includes('SENDER_IDENTITY:PASS'));
  assert.equal(gates.at(-1), 'SENDER_IDENTITY:PASS');

  assert.ok(after.cg4);
  assert.equal(after.cg4.appliedExceptions.length, 1);
  assert.deepEqual(after.cg4.appliedExceptions[0], {
    seriesId: created.exception.exceptionId,
    revisionId: row.id,
    version: 1,
    contentDigest: row.requestHash,
    approvalDigest: after.cg4.appliedExceptions[0]!.approvalDigest,
    matchedRuleCode: 'QUIET_HOURS',
  });
  assert.equal(after.cg4.policy.policyVersion, 1);
  assert.equal(after.cg4.policy.policyContentDigest, f.cg4ContentDigest);

  const persisted = await f.owner.cgDecisionLog.findUniqueOrThrow({
    where: { id: after.decisionId },
  });
  assert.deepEqual(persisted.cg4, after.cg4 as never);
});

test('CG4.4: revoke ที่ commit ก่อน authorize ทำให้ exception ใช้ไม่ได้ทันที', async (t) => {
  const f = await fixture(t);
  const service = new ContactGovernanceService(f.application, { now: () => NOW });
  const { created, row, transitioned, lifecycle } = await approvedException(f);

  await lifecycle.transition({
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: created.exception.revision,
    expectedContentDigest: row.requestHash,
    action: 'REVOKE',
    reasonCode: 'COMPLIANCE_WITHDRAWN',
    evidenceRef: 'evidence:revoke:1',
    actor: subject('compliance-9', 'cg.exception.revoke'),
    scopeKey: SCOPE_KEY,
    occurredAt: '2026-09-15T19:45:00.000Z',
    expectedVersion: transitioned.aggregateVersion,
    idempotencyKey: randomUUID(),
  });

  const result = await service.authorizeAndReserve(f.tenant, {
    contactId: f.contact,
    identityId: f.identity,
    ...authorizeInput({ actionKey: 'cg44-revoked:1:step-001' }),
  });
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'QUIET_HOURS');
  assert.equal(result.cg4, undefined);
});

test('CG4.4: exception ที่ scope ไม่ตรง (source อื่น) ไม่ยก provisional block', async (t) => {
  const f = await fixture(t);
  const service = new ContactGovernanceService(f.application, { now: () => NOW });
  await approvedException(f, { sourceId: 'journey-cg44-001' });

  const result = await service.authorizeAndReserve(f.tenant, {
    contactId: f.contact,
    identityId: f.identity,
    ...authorizeInput({ actionKey: 'cg44-scope:1:step-001', sourceId: 'journey-cg44-999' }),
  });
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'QUIET_HOURS');
  assert.equal(result.cg4, undefined);
});

test('CG4.4: exception ที่ยัง active ไม่ข้าม hard gate — consent ที่ถูกเพิกถอนยัง BLOCK', async (t) => {
  const f = await fixture(t);
  await approvedException(f);
  await f.owner.cgConsent.updateMany({
    where: { tenantId: f.tenant, contactId: f.contact },
    data: { status: 'REVOKED', revokedAt: new Date('2026-09-14T00:00:00.000Z') },
  });

  const service = new ContactGovernanceService(f.application, { now: () => NOW });
  const result = await service.authorizeAndReserve(f.tenant, {
    contactId: f.contact,
    identityId: f.identity,
    ...authorizeInput({ actionKey: 'cg44-consent:1:step-001' }),
  });

  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.reasonCode, 'CONSENT_REVOKED');
  assert.equal(result.reservationId, undefined);
  assert.equal(result.cg4, undefined);
});

test('CG4.4: approve ไม่ผ่านเมื่อ quorum ยังไม่ครบ และ maker approve คำขอตัวเองไม่ได้', async (t) => {
  const f = await fixture(t);
  const foundation = new Cg4FoundationRepository(f.application);
  const lifecycle = new Cg4ExceptionLifecycleRepository(f.application, { now: () => NOW });

  const created = await foundation.recordException({
    tenantId: f.tenant,
    contactId: f.contact,
    identityId: f.identity,
    scopeKind: 'IDENTITY',
    channel: 'LINE',
    purpose: 'MARKETING',
    sourceType: 'JOURNEY',
    sourceId: 'journey-cg44-001',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: f.cg4PolicyId,
    policyVersion: 1,
    policyContentDigest: f.cg4ContentDigest,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: '2026-09-15T19:00:00.000Z',
    expiresAt: '2026-09-15T22:00:00.000Z',
    tier: 'STANDARD',
    reasonCode: 'CUSTOMER_CALLBACK',
    evidenceRef: 'evidence:cg44:1',
    actorRef: MAKER,
    occurredAt: '2026-09-15T18:00:00.000Z',
    idempotencyKey: randomUUID(),
    expectedVersion: 0,
  });
  const row = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
  });
  const transitionInput = {
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    action: 'APPROVE' as const,
    reasonCode: 'QUORUM_MET',
    evidenceRef: 'evidence:approval:1',
    scopeKey: SCOPE_KEY,
    occurredAt: '2026-09-15T19:30:00.000Z',
    expectedVersion: created.aggregateVersion,
  };

  await assert.rejects(
    lifecycle.transition({
      ...transitionInput,
      actor: subject('checker-1', 'cg.exception.approve.standard'),
      idempotencyKey: randomUUID(),
    }),
    Cg4QuorumNotMetError,
  );
  await assert.rejects(
    lifecycle.transition({
      ...transitionInput,
      actor: subject(MAKER, 'cg.exception.approve.standard'),
      idempotencyKey: randomUUID(),
    }),
    Cg4SelfApprovalError,
  );

  const head = await f.owner.cg4ExceptionHead.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
  });
  assert.equal(head.status, 'PENDING');
});

test('CG4.4: terminal state ไม่ reopen และ amend หลัง APPROVED ถูกปฏิเสธ', async (t) => {
  const f = await fixture(t);
  const { created, row, transitioned, lifecycle, foundation } = await approvedException(f);

  // APPROVED -> APPROVED ซ้ำไม่ได้
  await assert.rejects(
    lifecycle.transition({
      tenantId: f.tenant,
      exceptionId: created.exception.exceptionId,
      expectedRevision: 1,
      expectedContentDigest: row.requestHash,
      action: 'APPROVE',
      reasonCode: 'QUORUM_MET',
      evidenceRef: 'evidence:approval:2',
      actor: subject('checker-2', 'cg.exception.approve.standard'),
      scopeKey: SCOPE_KEY,
      occurredAt: '2026-09-15T19:40:00.000Z',
      expectedVersion: transitioned.aggregateVersion,
      idempotencyKey: randomUUID(),
    }),
    Cg4InvalidLifecycleTransitionError,
  );

  // approved content immutable: amend เป็น revision ใหม่ไม่ได้
  await assert.rejects(
    foundation.recordException({
      tenantId: f.tenant,
      contactId: f.contact,
      identityId: f.identity,
      scopeKind: 'IDENTITY',
      channel: 'LINE',
      purpose: 'MARKETING',
      sourceType: 'JOURNEY',
      sourceId: 'journey-cg44-001',
      allowedRuleCodes: ['QUIET_HOURS'],
      policyId: f.cg4PolicyId,
      policyVersion: 1,
      policyContentDigest: f.cg4ContentDigest,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      startsAt: '2026-09-15T19:00:00.000Z',
      expiresAt: '2026-09-15T21:00:00.000Z',
      tier: 'STANDARD',
      reasonCode: 'AMENDED',
      evidenceRef: 'evidence:amend:1',
      actorRef: MAKER,
      occurredAt: '2026-09-15T19:50:00.000Z',
      exceptionId: created.exception.exceptionId,
      idempotencyKey: randomUUID(),
      expectedVersion: transitioned.aggregateVersion,
    }),
    Cg4InvalidLifecycleTransitionError,
  );
});

test('CG4.4: overlap ที่ scope+rule+เวลาเดียวกันถูกปฏิเสธตอน approve', async (t) => {
  const f = await fixture(t);
  const { transitioned, lifecycle } = await approvedException(f);
  const foundation = new Cg4FoundationRepository(f.application);
  const approvals = new Cg4ApprovalRepository(f.application, { now: () => NOW });

  const second = await foundation.recordException({
    tenantId: f.tenant,
    contactId: f.contact,
    identityId: f.identity,
    scopeKind: 'IDENTITY',
    channel: 'LINE',
    purpose: 'MARKETING',
    sourceType: 'JOURNEY',
    sourceId: 'journey-cg44-001',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: f.cg4PolicyId,
    policyVersion: 1,
    policyContentDigest: f.cg4ContentDigest,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: '2026-09-15T20:30:00.000Z',
    expiresAt: '2026-09-15T23:00:00.000Z',
    tier: 'STANDARD',
    reasonCode: 'CUSTOMER_CALLBACK',
    evidenceRef: 'evidence:cg44:2',
    actorRef: MAKER,
    occurredAt: '2026-09-15T19:55:00.000Z',
    idempotencyKey: randomUUID(),
    expectedVersion: transitioned.aggregateVersion,
  });
  const secondRow = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: second.exception.exceptionId },
  });
  await approvals.recordExceptionApproval({
    tenantId: f.tenant,
    exceptionId: second.exception.exceptionId,
    expectedRevision: 1,
    expectedContentDigest: secondRow.requestHash,
    decision: 'APPROVE',
    evidenceRef: 'evidence:approval:2',
    makerSubjectId: MAKER,
    scopeKey: SCOPE_KEY,
    checker: subject('checker-2', 'cg.exception.approve.standard'),
    idempotencyKey: randomUUID(),
  });

  await assert.rejects(
    lifecycle.transition({
      tenantId: f.tenant,
      exceptionId: second.exception.exceptionId,
      expectedRevision: 1,
      expectedContentDigest: secondRow.requestHash,
      action: 'APPROVE',
      reasonCode: 'QUORUM_MET',
      evidenceRef: 'evidence:approval:2',
      actor: subject('checker-2', 'cg.exception.approve.standard'),
      scopeKey: SCOPE_KEY,
      occurredAt: '2026-09-15T19:58:00.000Z',
      expectedVersion: second.aggregateVersion,
      idempotencyKey: randomUUID(),
    }),
    Cg4ExceptionScopeConflictError,
  );
});

test('CG4.4: renewal เป็น series ใหม่ที่อ้าง renewsExceptionId โดยไม่ยืดของเดิม', async (t) => {
  const f = await fixture(t);
  const { created, transitioned } = await approvedException(f);
  const foundation = new Cg4FoundationRepository(f.application);

  const renewal = await foundation.recordException({
    tenantId: f.tenant,
    contactId: f.contact,
    identityId: f.identity,
    scopeKind: 'IDENTITY',
    channel: 'LINE',
    purpose: 'MARKETING',
    sourceType: 'JOURNEY',
    sourceId: 'journey-cg44-002',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: f.cg4PolicyId,
    policyVersion: 1,
    policyContentDigest: f.cg4ContentDigest,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: '2026-09-15T22:00:00.000Z',
    expiresAt: '2026-09-16T01:00:00.000Z',
    tier: 'STANDARD',
    reasonCode: 'CUSTOMER_CALLBACK',
    evidenceRef: 'evidence:renew:1',
    actorRef: MAKER,
    occurredAt: '2026-09-15T21:00:00.000Z',
    renewsExceptionId: created.exception.exceptionId,
    idempotencyKey: randomUUID(),
    expectedVersion: transitioned.aggregateVersion,
  });

  assert.notEqual(renewal.exception.exceptionId, created.exception.exceptionId);
  const renewalRow = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: renewal.exception.exceptionId },
  });
  assert.equal(renewalRow.renewsExceptionId, created.exception.exceptionId);
  assert.equal(renewalRow.revision, 1);

  // ของเดิมยังจบที่เวลาเดิม ไม่ถูกยืด
  const originalRow = await f.owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.tenant, exceptionId: created.exception.exceptionId },
  });
  assert.equal(originalRow.expiresAt.toISOString(), '2026-09-15T22:00:00.000Z');
});

test('CG4.4: transition ใช้ CAS กับ revision/contact aggregate และ idempotency key เดิมคืนผลเดิม', async (t) => {
  const f = await fixture(t);
  const { created, row, transitioned, lifecycle } = await approvedException(f);

  const revokeInput = {
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    action: 'REVOKE' as const,
    reasonCode: 'COMPLIANCE_WITHDRAWN',
    evidenceRef: 'evidence:revoke:1',
    actor: subject('compliance-9', 'cg.exception.revoke'),
    scopeKey: SCOPE_KEY,
    occurredAt: '2026-09-15T19:45:00.000Z',
    expectedVersion: transitioned.aggregateVersion,
    idempotencyKey: randomUUID(),
  };

  // contact aggregate version ที่ stale ถูกปฏิเสธ
  await assert.rejects(
    lifecycle.transition({ ...revokeInput, expectedVersion: 99, idempotencyKey: randomUUID() }),
    Cg3VersionConflictError,
  );

  const first = await lifecycle.transition(revokeInput);
  const retried = await lifecycle.transition(revokeInput);
  assert.deepEqual(retried, first);
  assert.equal(first.workflowState, 'REVOKED');
  assert.equal(first.effectiveState, 'INACTIVE');

  const outbox = await f.owner.cgEventOutbox.findMany({
    where: { tenantId: f.tenant, eventType: 'exception.changed' },
  });
  assert.equal(outbox.length, 2); // APPROVE + REVOKE
});

// ── CG4.8 (#191): contact stream และ re-authorization ของ downstream ─────────────

async function contactStreamVersion(f: Fixture): Promise<number> {
  const head = await f.owner.cgContactStateHead.findUnique({
    where: { tenantId_contactId: { tenantId: f.tenant, contactId: f.contact } },
  });
  return head?.aggregateVersion ?? 0;
}

async function reservedAction(f: Fixture, service: ContactGovernanceService, actionKey: string) {
  const authorized = await service.authorizeAndReserve(f.tenant, {
    contactId: f.contact,
    identityId: f.identity,
    ...authorizeInput({ actionKey }),
  });
  assert.equal(authorized.decision, 'ALLOW');
  assert.ok(authorized.reservationId);
  return async (
    overrides: Partial<Parameters<ContactGovernanceService['revalidateAuthorizedAction']>[0]> = {},
  ) =>
    service.revalidateAuthorizedAction({
      tenantId: tenantIdBrand(f.tenant),
      reservationId: reservationIdBrand(authorized.reservationId!),
      actionKey: actionKeyBrand(actionKey),
      correlationId: 'cg48-revalidate',
      sourceAggregateType: 'CONTACT',
      sourceAggregateId: f.contact,
      sourceAggregateVersion: await contactStreamVersion(f),
      sourceContract: 'CG4',
      sourceEventType: 'exception.changed',
      ...overrides,
    });
}

test('CG4.8: exception event ต่อ version ของ contact stream จาก CG3 ส่วน CAS ของ exception command ยังแยก', async (t) => {
  const f = await fixture(t);
  await f.owner.cgContactStateHead.create({
    data: {
      tenantId: f.tenant,
      contactId: f.contact,
      aggregateVersion: 5,
      currentDigest: 'c'.repeat(64),
    },
  });
  const { created, transitioned } = await approvedException(f);
  assert.equal(created.aggregateVersion, 1);
  assert.equal(transitioned.aggregateVersion, 2);

  const events = await f.owner.cgEventOutbox.findMany({
    where: { tenantId: f.tenant, aggregateType: 'CONTACT', aggregateId: f.contact },
    orderBy: { aggregateVersion: 'asc' },
  });
  assert.deepEqual(
    events.map((event) => [event.eventType, event.aggregateVersion]),
    [
      ['exception.recorded', 6],
      ['exception.changed', 7],
    ],
  );
  assert.equal(await contactStreamVersion(f), 7);
  const head = await f.owner.cgContactStateHead.findUniqueOrThrow({
    where: { tenantId_contactId: { tenantId: f.tenant, contactId: f.contact } },
  });
  assert.equal(head.currentDigest, 'c'.repeat(64));
});

test('CG4.8: re-authorization เห็น approved exception ชุดเดียวกับ authorize และ revoke ทำให้งานเดิมไม่ผ่าน', async (t) => {
  const f = await fixture(t);
  const service = new ContactGovernanceService(f.application, { now: () => NOW });
  const { created, row, transitioned, lifecycle } = await approvedException(f);
  const revalidate = await reservedAction(f, service, 'cg48-revalidate:1:step-001');

  // เดิม revalidation ไม่ส่ง source/activeExceptions จึงให้ DEFER ทั้งที่ exception ยัง active
  const before = await revalidate();
  assert.equal(before.decision, 'ALLOW');

  await lifecycle.transition({
    tenantId: f.tenant,
    exceptionId: created.exception.exceptionId,
    expectedRevision: created.exception.revision,
    expectedContentDigest: row.requestHash,
    action: 'REVOKE',
    reasonCode: 'COMPLIANCE_WITHDRAWN',
    evidenceRef: 'evidence:revoke:cg48',
    actor: subject('compliance-9', 'cg.exception.revoke'),
    scopeKey: SCOPE_KEY,
    occurredAt: '2026-09-15T19:45:00.000Z',
    expectedVersion: transitioned.aggregateVersion,
    idempotencyKey: randomUUID(),
  });
  const after = await revalidate();
  assert.equal(after.decision, 'DEFER');
  assert.equal(after.reasonCode, 'QUIET_HOURS');

  // event ที่ version ใหม่กว่า canonical ยังตามไม่ทันต้อง REVIEW ไม่ใช่ผลเก่า
  const stale = await revalidate({ sourceAggregateVersion: (await contactStreamVersion(f)) + 1 });
  assert.equal(stale.reasonCode, 'GOVERNANCE_VERSION_STALE');
});

test('CG4.8: re-authorization คืน REVIEW เมื่อ kill switch ครอบ scope และไม่สนใจ kill switch ของ channel อื่น', async (t) => {
  const f = await fixture(t);
  const service = new ContactGovernanceService(f.application, { now: () => NOW });
  await approvedException(f);
  const revalidate = await reservedAction(f, service, 'cg48-kill:1:step-001');
  const killSwitch = (scopeKey: string) =>
    f.owner.cg4ScopeKillSwitch.create({
      data: {
        tenantId: f.tenant,
        scopeKey,
        state: 'ACTIVE',
        reasonCode: 'INCIDENT',
        evidenceRef: 'evidence:kill:cg48',
        activatedByRef: 'operator-synthetic',
        activatedAt: NOW,
      },
    });

  await killSwitch('channel=VOICE|contactKind=*|purpose=*|sourceType=*');
  assert.equal((await revalidate()).decision, 'ALLOW');

  const lineKill = await killSwitch(
    'channel=LINE|contactKind=*|purpose=MARKETING|sourceType=JOURNEY',
  );
  const held = await revalidate();
  assert.deepEqual([held.decision, held.reasonCode], ['REVIEW', 'GOVERNANCE_KILL_SWITCH_ACTIVE']);

  // kill switch event จริงไม่ถูกเทียบกับ CG3 policy version จึงไม่เป็น stale
  const viaKillEvent = await revalidate({
    sourceAggregateType: 'POLICY',
    sourceAggregateId: lineKill.id,
    sourceAggregateVersion: 1,
    sourceEventType: 'governance.kill-switch.changed',
  });
  assert.equal(viaKillEvent.reasonCode, 'GOVERNANCE_KILL_SWITCH_ACTIVE');

  const unknownKill = await revalidate({
    sourceAggregateType: 'POLICY',
    sourceAggregateId: randomUUID(),
    sourceAggregateVersion: 1,
    sourceEventType: 'governance.kill-switch.changed',
  });
  assert.equal(unknownKill.reasonCode, 'GOVERNANCE_STATE_UNAVAILABLE');

  const cg4PolicyWithoutHead = await revalidate({
    sourceAggregateType: 'POLICY',
    sourceAggregateId: f.cg4PolicyId,
    sourceAggregateVersion: 1,
    sourceEventType: 'policy.changed',
    sourceScopeKey: 'channel=LINE|contactKind=*|purpose=MARKETING|sourceType=*',
  });
  assert.equal(cg4PolicyWithoutHead.reasonCode, 'GOVERNANCE_VERSION_STALE');
});
