import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  actionKey,
  campaignId,
  commandId,
  contactId,
  enrollmentId,
  interactionId,
  journeyId,
  outcomeId,
  teamId,
  tenantId as toTenantId,
  assertOwnerRequestHash,
  withOwnerRequestHash,
  type AdmitCampaignTargetIntentV1,
  type J2DialerOwnerCommandV1,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import { CampaignFixtures } from './campaign-fixtures.js';
import { DialerAdmitCampaignTargetService } from './dialer-admit-campaign-target-service.js';
import { DialerCommandHashConflictError } from './dialer-command-inbox.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const allowAllScope: TeamContactScopeAuthorizer = {
  async authorize(input) {
    return { decision: 'ALLOW', scopeVersion: 1, evaluatedAt: input.at };
  },
};

const denyAllScope: TeamContactScopeAuthorizer = {
  async authorize(input) {
    return { decision: 'DENY', reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED', evaluatedAt: input.at };
  },
};

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const rawTenantId = randomUUID();
  const rawSourceTeamId = randomUUID();
  const rawTargetTeamId = randomUUID();
  const rawContactId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);

  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `J2.5 dialer ${suffix}`,
      slug: `j2-5-dialer-${suffix}`,
      sipDomain: `${suffix}.j2-5-dialer.test`,
    },
  });
  await owner.team.create({
    data: { id: rawSourceTeamId, tenantId: rawTenantId, name: 'Journey' },
  });
  await owner.team.create({ data: { id: rawTargetTeamId, tenantId: rawTenantId, name: 'Dialer' } });
  await owner.contact.create({
    data: { id: rawContactId, tenantId: rawTenantId, displayName: 'J2.5 contact' },
  });

  const fixtures = new CampaignFixtures(application);
  const activeCampaignId = randomUUID();
  const pausedCampaignId = randomUUID();
  const stoppedCampaignId = randomUUID();
  const completedCampaignId = randomUUID();
  await fixtures.upsertCampaign({
    tenantId: rawTenantId,
    id: activeCampaignId,
    key: 'active-campaign',
    status: 'ACTIVE',
  });
  await fixtures.upsertCampaign({
    tenantId: rawTenantId,
    id: pausedCampaignId,
    key: 'paused-campaign',
    status: 'PAUSED',
  });
  await fixtures.upsertCampaign({
    tenantId: rawTenantId,
    id: stoppedCampaignId,
    key: 'stopped-campaign',
    status: 'STOPPED',
  });
  await fixtures.upsertCampaign({
    tenantId: rawTenantId,
    id: completedCampaignId,
    key: 'completed-campaign',
    status: 'COMPLETED',
  });
  await fixtures.upsertAdmissionPolicy({ tenantId: rawTenantId, campaignId: activeCampaignId });

  t.after(async () => {
    await owner.obDialerCommandInbox.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.obCampaignTarget.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.obCampaignAdmissionPolicy.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.obCampaign.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contact.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.team.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  return {
    owner,
    application,
    rawTenantId,
    rawSourceTeamId,
    rawTargetTeamId,
    rawContactId,
    activeCampaignId,
    pausedCampaignId,
    stoppedCampaignId,
    completedCampaignId,
  };
}

type AdmitCommandDraft = Omit<
  Extract<J2DialerOwnerCommandV1, { commandType: 'ADMIT_CAMPAIGN_TARGET' }>,
  'requestHash'
>;

function commandFor(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Omit<AdmitCommandDraft, 'intent'>> & {
    intent?: AdmitCampaignTargetIntentV1;
  } = {},
): Extract<J2DialerOwnerCommandV1, { commandType: 'ADMIT_CAMPAIGN_TARGET' }> {
  const enrollment = randomUUID();
  const draft: AdmitCommandDraft = {
    contractVersion: 1,
    commandId: commandId(randomUUID()),
    actionKey: actionKey(`${enrollment}:1:admit-campaign`),
    journeyId: journeyId('journey-outbound'),
    journeyVersion: 1,
    enrollmentId: enrollmentId(enrollment),
    stepId: 'admit-campaign',
    sourceOutcome: {
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
      outcomeId: outcomeId(randomUUID()),
      outcomeVersion: 1,
    },
    interactionId: interactionId(randomUUID()),
    contactId: contactId(f.rawContactId),
    sourceOwnerTeamId: teamId(f.rawSourceTeamId),
    targetOwnerTeamId: teamId(f.rawTargetTeamId),
    commandType: 'ADMIT_CAMPAIGN_TARGET',
    intent: { campaignId: campaignId(f.activeCampaignId) },
    ...overrides,
  };
  return withOwnerRequestHash(toTenantId(f.rawTenantId), draft) as Extract<
    J2DialerOwnerCommandV1,
    { commandType: 'ADMIT_CAMPAIGN_TARGET' }
  >;
}

test('campaign active ไม่มี target เดิม: ADMIT_CAMPAIGN_TARGET สร้าง record ใหม่และตอบ ADMITTED', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f);

  const persisted = await service.persistCommand(tenant, command);
  assert.equal(persisted.status, 'PERSISTED');

  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'ADMITTED');
  assert.equal(result?.category, 'BUSINESS');
  assert.equal(result?.ownerAggregate?.type, 'campaign_target');

  const stored = await f.owner.obCampaignTarget.findUniqueOrThrow({
    where: { id: result!.ownerAggregate!.id },
  });
  assert.equal(stored.state, 'ADMITTED');
  assert.equal(stored.campaignId, f.activeCampaignId);
});

test('retry ด้วย actionKey/requestHash เดิมคืนผลเดิมโดยไม่สร้าง target ซ้ำ', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f);

  await service.persistCommand(tenant, command);
  await service.persistCommand(tenant, command);
  await service.persistCommand(tenant, command);

  assert.equal(await f.owner.obCampaignTarget.count({ where: { tenantId: f.rawTenantId } }), 1);
  assert.equal(await f.owner.obDialerCommandInbox.count({ where: { tenantId: f.rawTenantId } }), 1);
});

test('actionKey เดิมกับ requestHash ต่างถูกปฏิเสธเป็น IDEMPOTENCY_CONFLICT', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f);
  await service.persistCommand(tenant, command);

  const conflicting = withOwnerRequestHash(tenant, {
    ...command,
    intent: { campaignId: campaignId(f.pausedCampaignId) },
  }) as Extract<J2DialerOwnerCommandV1, { commandType: 'ADMIT_CAMPAIGN_TARGET' }>;
  assert.notEqual(conflicting.requestHash, command.requestHash);
  await assert.rejects(
    () => service.persistCommand(tenant, conflicting),
    (error: unknown) => {
      assert.ok(error instanceof DialerCommandHashConflictError);
      return true;
    },
  );
});

test('target เดิมของ (campaign, contact) เดียวกัน: ตอบ ALREADY_ADMITTED โดยไม่สร้างแถวใหม่', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);

  const first = commandFor(f);
  await service.persistCommand(tenant, first);
  const firstResult = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: first.actionKey,
    requestHash: first.requestHash,
  });

  const second = commandFor(f);
  await service.persistCommand(tenant, second);
  const secondResult = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: second.actionKey,
    requestHash: second.requestHash,
  });
  assert.equal(secondResult?.status, 'ALREADY_ADMITTED');
  assert.equal(secondResult?.ownerAggregate?.id, firstResult?.ownerAggregate?.id);
  assert.equal(await f.owner.obCampaignTarget.count({ where: { tenantId: f.rawTenantId } }), 1);
});

test('campaign paused: admission สำเร็จแต่ target เป็น DEFERRED ภายใน ขณะที่ผลรายงานยังเป็น ADMITTED', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f, { intent: { campaignId: campaignId(f.pausedCampaignId) } });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(
    result?.status,
    'ADMITTED',
    'Journey สนใจแค่ admit สำเร็จหรือไม่ ไม่ใช่ pacing ภายใน',
  );

  const stored = await f.owner.obCampaignTarget.findUniqueOrThrow({
    where: { id: result!.ownerAggregate!.id },
  });
  assert.equal(stored.state, 'DEFERRED');
});

test('campaign stopped/completed ถูกปฏิเสธเป็น REJECTED', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);

  for (const targetCampaignId of [f.stoppedCampaignId, f.completedCampaignId]) {
    const command = commandFor(f, { intent: { campaignId: campaignId(targetCampaignId) } });
    await service.persistCommand(tenant, command);
    const result = await service.queryAction(tenant, {
      contractVersion: 1,
      actionKey: command.actionKey,
      requestHash: command.requestHash,
    });
    assert.equal(result?.status, 'REJECTED');
    assert.equal(result?.code, 'OWNER_REJECTED');
    assert.equal(result?.ownerAggregate, undefined);
  }
  assert.equal(await f.owner.obCampaignTarget.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('campaignId ที่ไม่มีอยู่จริงถูกปฏิเสธเป็น OWNER_REJECTED', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f, { intent: { campaignId: campaignId(randomUUID()) } });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.reasonCode, 'CAMPAIGN_BINDING_INVALID');
});

test('contact เดิมใน campaign อื่นถูกปฏิเสธเมื่อ policy ไม่อนุญาต cross-campaign duplicate', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);

  const first = commandFor(f, { intent: { campaignId: campaignId(f.activeCampaignId) } });
  await service.persistCommand(tenant, first);

  // pausedCampaignId ไม่มี admission policy fixture ของตัวเอง — default
  // allowCrossCampaignDuplicate=false ต้องปฏิเสธ contact ที่ admit ไปแล้วใน campaign อื่น
  const second = commandFor(f, { intent: { campaignId: campaignId(f.pausedCampaignId) } });
  await service.persistCommand(tenant, second);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: second.actionKey,
    requestHash: second.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.reasonCode, 'DUPLICATE_CONTACT_CROSS_CAMPAIGN');
});

test('contact ข้าม tenant ถูกปฏิเสธโดยไม่เปิดเผย existence', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
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
  assert.equal(await f.owner.obCampaignTarget.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('team ข้าม tenant ถูกปฏิเสธเป็น TEAM_SEGMENT_NOT_ALLOWED', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f, { targetOwnerTeamId: teamId(other.rawTargetTeamId) });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.code, 'TEAM_SEGMENT_NOT_ALLOWED');
});

test('WORK scope ที่ IAM ปฏิเสธทำให้ admission fail closed', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, denyAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = commandFor(f);

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.reasonCode, 'WORK_SCOPE_DENIED');
  assert.equal(await f.owner.obCampaignTarget.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('tenant คนละใบไม่เห็น campaign target ของกันและกัน', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(a.application, allowAllScope);
  const otherService = new DialerAdmitCampaignTargetService(b.application, allowAllScope);
  const command = commandFor(a);
  await service.persistCommand(toTenantId(a.rawTenantId), command);

  const otherView = await otherService.queryAction(toTenantId(b.rawTenantId), {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(otherView, undefined);
});

/** J2.1 contract: actionKey เดิมของ admit, commandId ใหม่ — supersede เพิ่ม superseding outcome */
function targetCancelFor(
  f: Awaited<ReturnType<typeof fixture>>,
  admit: Extract<J2DialerOwnerCommandV1, { commandType: 'ADMIT_CAMPAIGN_TARGET' }>,
  supersede = false,
): J2DialerOwnerCommandV1 {
  const { requestHash: _hash, commandType: _type, intent: _intent, ...common } = admit;
  const draft = supersede
    ? {
        ...common,
        commandId: commandId(randomUUID()),
        commandType: 'SUPERSEDE_CAMPAIGN_TARGET' as const,
        intent: {
          originalActionKey: admit.actionKey,
          reasonCode: 'OUTCOME_CORRECTED',
          supersedingOutcome: {
            outcomeType: 'INTERACTION_DISPOSITION_RECORDED' as const,
            outcomeId: outcomeId(randomUUID()),
            outcomeVersion: 2,
          },
        },
      }
    : {
        ...common,
        commandId: commandId(randomUUID()),
        commandType: 'CANCEL_CAMPAIGN_TARGET' as const,
        intent: { originalActionKey: admit.actionKey, reasonCode: 'OUTCOME_CORRECTED' },
      };
  return assertOwnerRequestHash(
    toTenantId(f.rawTenantId),
    withOwnerRequestHash(toTenantId(f.rawTenantId), draft),
  ) as J2DialerOwnerCommandV1;
}

async function resultOf(
  service: DialerAdmitCampaignTargetService,
  f: Awaited<ReturnType<typeof fixture>>,
  command: J2DialerOwnerCommandV1,
) {
  return service.queryAction(toTenantId(f.rawTenantId), {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
}

test('CANCEL_CAMPAIGN_TARGET ยกเลิก target ที่ยังไม่ถึง originate barrier และ retry ได้ผลเดิม', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const admit = commandFor(f);
  await service.persistCommand(tenant, admit);

  const cancel = targetCancelFor(f, admit);
  await service.persistCommand(tenant, cancel);
  await service.persistCommand(tenant, cancel);

  const result = await resultOf(service, f, cancel);
  assert.equal(result?.commandType, 'CANCEL_CAMPAIGN_TARGET');
  assert.equal(result?.status, 'CANCELLED');
  assert.equal(result?.ownerAggregate?.type, 'campaign_target');
  assert.equal((await resultOf(service, f, admit))?.status, 'ADMITTED');

  const target = await f.owner.obCampaignTarget.findUniqueOrThrow({
    where: { id: result!.ownerAggregate!.id },
  });
  assert.equal(target.state, 'CANCELLED');
  assert.equal(target.cancelReasonCode, 'OUTCOME_CORRECTED');
  assert.equal(target.version, result!.ownerAggregate!.version);
  assert.equal(await f.owner.obDialerCommandInbox.count({ where: { tenantId: f.rawTenantId } }), 2);
});

test('SUPERSEDE_CAMPAIGN_TARGET บันทึก superseding outcome linkage', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const admit = commandFor(f);
  await service.persistCommand(tenant, admit);
  const supersede = targetCancelFor(f, admit, true);

  await service.persistCommand(tenant, supersede);
  const result = await resultOf(service, f, supersede);
  assert.equal(result?.status, 'SUPERSEDED');
  const target = await f.owner.obCampaignTarget.findUniqueOrThrow({
    where: { id: result!.ownerAggregate!.id },
  });
  assert.equal(target.state, 'SUPERSEDED');
  assert.equal(target.supersedingOutcomeVersion, 2);
});

test('target ที่ originate barrier claim แล้วตอบ TOO_LATE และไม่ย้อน state', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const admit = commandFor(f);
  await service.persistCommand(tenant, admit);
  const admitted = await resultOf(service, f, admit);
  await f.owner.obCampaignTarget.update({
    where: { id: admitted!.ownerAggregate!.id },
    data: { state: 'ORIGINATING', version: { increment: 1 } },
  });

  const cancel = targetCancelFor(f, admit);
  await service.persistCommand(tenant, cancel);
  const result = await resultOf(service, f, cancel);
  assert.equal(result?.status, 'TOO_LATE');
  assert.equal(result?.code, 'ACTION_TOO_LATE');
  const target = await f.owner.obCampaignTarget.findUniqueOrThrow({
    where: { id: admitted!.ownerAggregate!.id },
  });
  assert.equal(target.state, 'ORIGINATING');
});

test('cancel ไม่ถูกขวางด้วย scope ที่ถูกถอน แต่ต้อง bind กับ contact ของ target เดิม', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const tenant = toTenantId(f.rawTenantId);
  const admit = commandFor(f);
  await new DialerAdmitCampaignTargetService(f.application, allowAllScope).persistCommand(
    tenant,
    admit,
  );
  const denying = new DialerAdmitCampaignTargetService(f.application, denyAllScope);

  const { requestHash: _hash, ...cancelDraft } = {
    ...targetCancelFor(f, admit),
    contactId: contactId(other.rawContactId),
  };
  const mismatched = withOwnerRequestHash(tenant, cancelDraft as never) as J2DialerOwnerCommandV1;
  await denying.persistCommand(tenant, mismatched);
  const rejected = await resultOf(denying, f, mismatched);
  assert.equal(rejected?.status, 'REJECTED');
  assert.equal(rejected?.code, 'BINDING_MISMATCH');

  const cancel = targetCancelFor(f, admit);
  await denying.persistCommand(tenant, cancel);
  assert.equal((await resultOf(denying, f, cancel))?.status, 'CANCELLED');
});

test('cancel ที่ไม่มี admit ต้นเรื่องถูกปฏิเสธเป็น ORIGINAL_ACTION_NOT_FOUND', async (t) => {
  const f = await fixture(t);
  const service = new DialerAdmitCampaignTargetService(f.application, allowAllScope);
  const cancel = targetCancelFor(f, commandFor(f));

  await service.persistCommand(toTenantId(f.rawTenantId), cancel);
  const result = await resultOf(service, f, cancel);
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.reasonCode, 'ORIGINAL_ACTION_NOT_FOUND');
});
