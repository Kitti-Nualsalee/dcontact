import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  actionKey,
  commandId,
  contactId,
  enrollmentId,
  interactionId,
  journeyId,
  outcomeId,
  teamId,
  tenantId as toTenantId,
  withOwnerRequestHash,
  type EnsureCaseIntentV1,
  type J2CaseOwnerCommandV1,
} from '@d-contact/cxa-contracts';
import { CasePolicyFixtures } from './case-policy-fixtures.js';
import {
  CaseCommandHashConflictError,
  CasesEnsureCaseService,
} from './cases-ensure-case-service.js';

type EnsureCaseCommandDraft = Omit<J2CaseOwnerCommandV1, 'requestHash'>;

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const rawTenantId = randomUUID();
  const rawTeamId = randomUUID();
  const rawContactId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);

  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `J2.4 cases ${suffix}`,
      slug: `j2-4-cases-${suffix}`,
      sipDomain: `${suffix}.j2-4-cases.test`,
    },
  });
  await owner.team.create({ data: { id: rawTeamId, tenantId: rawTenantId, name: 'Collections' } });
  await owner.contact.create({
    data: { id: rawContactId, tenantId: rawTenantId, displayName: 'J2.4 contact' },
  });

  const fixtures = new CasePolicyFixtures(application);
  await fixtures.upsertCaseTypePolicy({
    tenantId: rawTenantId,
    policyRef: 'policy-collections',
    caseTypeKey: 'COLLECTIONS',
    reopenAllowed: false,
  });
  await fixtures.upsertCaseTypePolicy({
    tenantId: rawTenantId,
    policyRef: 'policy-collections-reopenable',
    caseTypeKey: 'COLLECTIONS_REOPENABLE',
    reopenAllowed: true,
  });
  await fixtures.upsertRoutingPolicy({
    tenantId: rawTenantId,
    policyRef: 'routing-collections',
    queueRef: 'queue-collections',
  });

  t.after(async () => {
    await owner.csCommandInbox.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.csCaseActivity.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.csCaseLink.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.csCase.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.csRoutingPolicy.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.csCaseTypePolicy.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contact.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.team.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  return { owner, application, rawTenantId, rawTeamId, rawContactId };
}

function commandFor(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Omit<EnsureCaseCommandDraft, 'intent'>> & { intent?: EnsureCaseIntentV1 } = {},
): J2CaseOwnerCommandV1 {
  const enrollment = randomUUID();
  const draft: EnsureCaseCommandDraft = {
    contractVersion: 1,
    commandId: commandId(randomUUID()),
    actionKey: actionKey(`${enrollment}:1:ensure-case`),
    journeyId: journeyId('journey-collections'),
    journeyVersion: 1,
    enrollmentId: enrollmentId(enrollment),
    stepId: 'ensure-case',
    sourceOutcome: {
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
      outcomeId: outcomeId(randomUUID()),
      outcomeVersion: 1,
    },
    interactionId: interactionId(randomUUID()),
    contactId: contactId(f.rawContactId),
    sourceOwnerTeamId: teamId(f.rawTeamId),
    targetOwnerTeamId: teamId(f.rawTeamId),
    commandType: 'ENSURE_CASE',
    intent: { caseTypePolicyRef: 'policy-collections', routingPolicyRef: 'routing-collections' },
    ...overrides,
  };
  return withOwnerRequestHash(toTenantId(f.rawTenantId), draft) as J2CaseOwnerCommandV1;
}

test('ไม่มี case เดิม: ENSURE_CASE สร้างเคสใหม่และตอบ CREATED', async (t) => {
  const f = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f);

  const persisted = await service.persistCommand(tenant, command);
  assert.equal(persisted.status, 'PERSISTED');

  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'CREATED');
  assert.equal(result?.category, 'BUSINESS');
  assert.equal(result?.failureClass, 'NONE');
  assert.equal(result?.ownerAggregate?.type, 'case');
  assert.equal(result?.ownerAggregate?.version, 1);

  const stored = await f.owner.csCase.findUniqueOrThrow({
    where: { id: result!.ownerAggregate!.id },
  });
  assert.equal(stored.status, 'OPEN');
  assert.equal(stored.caseTypeKey, 'COLLECTIONS');
  assert.equal(
    await f.owner.csCaseActivity.count({ where: { tenantId: f.rawTenantId, caseId: stored.id } }),
    1,
  );
});

test('retry ด้วย actionKey/requestHash เดิมคืนผลเดิมโดยไม่สร้าง case ซ้ำ', async (t) => {
  const f = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f);

  await service.persistCommand(tenant, command);
  await service.persistCommand(tenant, command);
  await service.persistCommand(tenant, command);

  assert.equal(await f.owner.csCase.count({ where: { tenantId: f.rawTenantId } }), 1);
  assert.equal(await f.owner.csCommandInbox.count({ where: { tenantId: f.rawTenantId } }), 1);
});

test('actionKey เดิมกับ requestHash ต่างถูกปฏิเสธเป็น IDEMPOTENCY_CONFLICT', async (t) => {
  const f = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f);
  await service.persistCommand(tenant, command);

  const conflicting = withOwnerRequestHash(tenant, {
    ...command,
    intent: { ...command.intent, routingPolicyRef: 'routing-different' },
  }) as J2CaseOwnerCommandV1;
  assert.notEqual(
    conflicting.requestHash,
    command.requestHash,
    'fixture ต้องผลิต hash ต่างกันจริง',
  );
  await assert.rejects(
    () => service.persistCommand(tenant, conflicting),
    (error: unknown) => {
      assert.ok(error instanceof CaseCommandHashConflictError);
      return true;
    },
  );
});

test('มี case OPEN เดิมของ contact/case type เดียวกัน: ตอบ LINKED และเพิ่ม activity', async (t) => {
  const f = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);

  const firstCommand = commandFor(f);
  await service.persistCommand(tenant, firstCommand);
  const first = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: firstCommand.actionKey,
    requestHash: firstCommand.requestHash,
  });
  const originalCaseId = first!.ownerAggregate!.id;

  const second = commandFor(f);
  await service.persistCommand(tenant, second);
  const secondResult = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: second.actionKey,
    requestHash: second.requestHash,
  });
  assert.equal(secondResult?.status, 'LINKED');
  assert.equal(secondResult?.ownerAggregate?.id, originalCaseId);
  assert.equal(secondResult?.ownerAggregate?.version, 2);
  assert.equal(
    await f.owner.csCaseActivity.count({
      where: { tenantId: f.rawTenantId, caseId: originalCaseId },
    }),
    2,
  );
});

test('case RESOLVED กับ reopen policy อนุญาต: ตอบ REOPENED และนับ reopenCount', async (t) => {
  const f = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f, {
    intent: {
      caseTypePolicyRef: 'policy-collections-reopenable',
      routingPolicyRef: 'routing-collections',
    },
  });
  await service.persistCommand(tenant, command);
  const created = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  await f.owner.csCase.update({
    where: { id: created!.ownerAggregate!.id },
    data: { status: 'RESOLVED', resolvedAt: new Date() },
  });

  const reopenCommand = commandFor(f, {
    intent: {
      caseTypePolicyRef: 'policy-collections-reopenable',
      routingPolicyRef: 'routing-collections',
    },
  });
  await service.persistCommand(tenant, reopenCommand);
  const reopened = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: reopenCommand.actionKey,
    requestHash: reopenCommand.requestHash,
  });
  assert.equal(reopened?.status, 'REOPENED');
  assert.equal(reopened?.ownerAggregate?.id, created!.ownerAggregate!.id);

  const stored = await f.owner.csCase.findUniqueOrThrow({
    where: { id: created!.ownerAggregate!.id },
  });
  assert.equal(stored.status, 'OPEN');
  assert.equal(stored.reopenCount, 1);
  assert.equal(stored.resolvedAt, null);
});

test('case RESOLVED กับ reopen policy ไม่อนุญาต: เปิดเคสใหม่แทนการบังคับ reopen', async (t) => {
  const f = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f);
  await service.persistCommand(tenant, command);
  const created = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  await f.owner.csCase.update({
    where: { id: created!.ownerAggregate!.id },
    data: { status: 'RESOLVED', resolvedAt: new Date() },
  });

  const nextCommand = commandFor(f);
  await service.persistCommand(tenant, nextCommand);
  const next = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: nextCommand.actionKey,
    requestHash: nextCommand.requestHash,
  });
  assert.equal(next?.status, 'CREATED');
  assert.notEqual(next?.ownerAggregate?.id, created!.ownerAggregate!.id);

  const stillResolved = await f.owner.csCase.findUniqueOrThrow({
    where: { id: created!.ownerAggregate!.id },
  });
  assert.equal(stillResolved.status, 'RESOLVED', 'ห้าม reopen เงียบ ๆ เมื่อ policy ไม่อนุญาต');
});

test('case CLOSED เดิม: เปิดเคสใหม่พร้อมเชื่อม RELATED กับเคสเดิม', async (t) => {
  const f = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f);
  await service.persistCommand(tenant, command);
  const created = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  await f.owner.csCase.update({
    where: { id: created!.ownerAggregate!.id },
    data: { status: 'CLOSED', closedAt: new Date() },
  });

  const nextCommand = commandFor(f);
  await service.persistCommand(tenant, nextCommand);
  const next = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: nextCommand.actionKey,
    requestHash: nextCommand.requestHash,
  });
  assert.equal(next?.status, 'CREATED');
  const newCaseId = next!.ownerAggregate!.id;
  assert.notEqual(newCaseId, created!.ownerAggregate!.id);

  const link = await f.owner.csCaseLink.findFirstOrThrow({
    where: { tenantId: f.rawTenantId, caseId: newCaseId },
  });
  assert.equal(link.relatedCaseId, created!.ownerAggregate!.id);
  assert.equal(link.kind, 'RELATED');
});

test('contact ข้าม tenant ถูกปฏิเสธเป็น REJECTED โดยไม่เปิดเผย existence', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f, { contactId: contactId(other.rawContactId) });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.code, 'CONTACT_NOT_FOUND');
  assert.equal(result?.category, 'TERMINAL');
  assert.equal(result?.ownerAggregate, undefined);
  assert.equal(await f.owner.csCase.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('targetOwnerTeamId ข้าม tenant ถูกปฏิเสธเป็น REJECTED', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f, { targetOwnerTeamId: teamId(other.rawTeamId) });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.code, 'TEAM_SEGMENT_NOT_ALLOWED');
});

test('caseTypePolicyRef ที่ไม่มีอยู่จริงถูกปฏิเสธเป็น OWNER_REJECTED', async (t) => {
  const f = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f, {
    intent: { caseTypePolicyRef: 'no-such-policy', routingPolicyRef: 'routing-collections' },
  });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.code, 'OWNER_REJECTED');
  assert.equal(result?.reasonCode, 'CASE_TYPE_POLICY_NOT_FOUND');
});

test('queryAction ที่ไม่มี actionKey นี้คืน undefined', async (t) => {
  const f = await fixture(t);
  const service = new CasesEnsureCaseService(f.application);
  const tenant = toTenantId(f.rawTenantId);

  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: actionKey('ไม่มีจริง:1:ensure-case'),
    requestHash: 'a'.repeat(64),
  });
  assert.equal(result, undefined);
});

test('tenant คนละใบไม่เห็น case ของกันและกัน', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const service = new CasesEnsureCaseService(a.application);
  const otherService = new CasesEnsureCaseService(b.application);
  const command = commandFor(a);
  await service.persistCommand(toTenantId(a.rawTenantId), command);

  const otherView = await otherService.queryAction(toTenantId(b.rawTenantId), {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(otherView, undefined);
});
