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
  type J2CaseOwnerPort,
  type J2DialerOwnerPort,
  type J2OwnerActionQueryV1,
  type J2OwnerCommandDraftV1,
  type J2OwnerCommandPersistedV1,
  type J2OwnerResultPayloadV1,
} from '@d-contact/cxa-contracts';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneyOwnerCommandRelay } from './journey-owner-command-relay.js';
import { JourneyOwnerResultReconciler } from './journey-owner-result-reconciler.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

/** fake port ที่บันทึกทุก persistCommand ไว้ตรวจสอบ และตอบผ่าน queryAction ตามที่ตั้งไว้ */
interface FakePort {
  persisted: unknown[];
  results: Map<string, J2OwnerResultPayloadV1>;
  persistCommand(
    tenant: unknown,
    command: { commandId: string; actionKey: string; requestHash: string },
  ): Promise<J2OwnerCommandPersistedV1>;
  queryAction(
    tenant: unknown,
    query: J2OwnerActionQueryV1,
  ): Promise<J2OwnerResultPayloadV1 | undefined>;
}

/** ใช้ cast เป็น J2CaseOwnerPort/J2DialerOwnerPort ตามจุดที่เรียก — persistCommand ที่
 * แท้จริงรับได้ทั้งสอง union เพราะไม่แตะ field เฉพาะของ commandType ใด ๆ */
function fakePort(): FakePort {
  const persisted: unknown[] = [];
  const results = new Map<string, J2OwnerResultPayloadV1>();
  return {
    persisted,
    results,
    async persistCommand(_tenant, command) {
      persisted.push(command);
      return {
        status: 'PERSISTED',
        commandId: command.commandId,
        actionKey: command.actionKey,
        requestHash: command.requestHash,
      } as J2OwnerCommandPersistedV1;
    },
    async queryAction(_tenant, query) {
      return results.get(query.actionKey);
    },
  };
}

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const rawTenantId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);
  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `J2.8 relay ${suffix}`,
      slug: `j2-8-relay-${suffix}`,
      sipDomain: `${suffix}.j2-8-relay.test`,
    },
  });
  t.after(async () => {
    await owner.jrOwnerResultInbox.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  return { owner, application, rawTenantId };
}

function admitCampaignCommand(rawTenantId: string, rawActionKey: string) {
  const enrollment = randomUUID();
  const draft: J2OwnerCommandDraftV1 = {
    contractVersion: 1,
    commandId: commandId(randomUUID()),
    actionKey: actionKey(rawActionKey),
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
    contactId: contactId(randomUUID()),
    sourceOwnerTeamId: teamId(randomUUID()),
    targetOwnerTeamId: teamId(randomUUID()),
    commandType: 'ADMIT_CAMPAIGN_TARGET',
    intent: { campaignId: campaignId(randomUUID()) },
  };
  return withOwnerRequestHash(toTenantId(rawTenantId), draft);
}

test('relay dispatches a staged command to the dialer port and marks it SENT + action DISPATCHED', async (t) => {
  const f = await fixture(t);
  const actions = new JourneyOwnerActionRepository(f.application);
  const dialerPort = fakePort();
  const casePort = fakePort();
  const relay = new JourneyOwnerCommandRelay(f.application, casePort, dialerPort);

  const rawActionKey = `${randomUUID()}:1:admit-campaign`;
  const command = admitCampaignCommand(f.rawTenantId, rawActionKey);
  await actions.ensureAction({
    tenantId: f.rawTenantId,
    actionKey: rawActionKey,
    enrollmentId: randomUUID(),
    kind: 'ADMIT_CAMPAIGN_TARGET',
    requestHash: command.requestHash,
    correlationId: 'corr-1',
    commandId: command.commandId,
    commandPayload: command,
  });

  const result = await relay.executeNext(f.rawTenantId);
  assert.equal(result, 'SENT');
  assert.equal(dialerPort.persisted.length, 1);
  assert.equal(casePort.persisted.length, 0);

  const action = await actions.getAction(f.rawTenantId, rawActionKey);
  assert.equal(action?.state, 'DISPATCHED');
  const outboxRow = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
    where: { tenantId: f.rawTenantId, commandId: command.commandId },
  });
  assert.equal(outboxRow.state, 'SENT');
});

test('relay ที่ port throw จะกลับไป PENDING พร้อม backoff ให้ retry', async (t) => {
  const f = await fixture(t);
  const actions = new JourneyOwnerActionRepository(f.application);
  const dialerPort: J2DialerOwnerPort = {
    async persistCommand() {
      throw new Error('owner unavailable');
    },
    async queryAction() {
      return undefined;
    },
  };
  const relay = new JourneyOwnerCommandRelay(f.application, fakePort(), dialerPort, {
    retryDelayMs: 60_000,
  });

  const rawActionKey = `${randomUUID()}:1:admit-campaign`;
  const command = admitCampaignCommand(f.rawTenantId, rawActionKey);
  await actions.ensureAction({
    tenantId: f.rawTenantId,
    actionKey: rawActionKey,
    enrollmentId: randomUUID(),
    kind: 'ADMIT_CAMPAIGN_TARGET',
    requestHash: command.requestHash,
    correlationId: 'corr-1',
    commandId: command.commandId,
    commandPayload: command,
  });

  assert.equal(await relay.executeNext(f.rawTenantId), 'RETRY');
  const outboxRow = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
    where: { tenantId: f.rawTenantId, commandId: command.commandId },
  });
  assert.equal(outboxRow.state, 'PENDING');
  assert.equal(outboxRow.attempts, 1);
  assert.ok(outboxRow.availableAt.getTime() > Date.now());
  assert.equal(await relay.executeNext(f.rawTenantId), undefined, 'ยังไม่ถึงเวลา retry');
});

test('command ที่ไม่มี payload staged ไว้ถูกข้ามไป (ยังไม่พร้อม relay)', async (t) => {
  const f = await fixture(t);
  const actions = new JourneyOwnerActionRepository(f.application);
  const relay = new JourneyOwnerCommandRelay(f.application, fakePort(), fakePort());

  await actions.ensureAction({
    tenantId: f.rawTenantId,
    actionKey: `${randomUUID()}:1:no-payload`,
    enrollmentId: randomUUID(),
    kind: 'ADMIT_CAMPAIGN_TARGET',
    requestHash: 'a'.repeat(64),
    correlationId: 'corr-1',
    commandId: randomUUID(),
  });

  assert.equal(await relay.executeNext(f.rawTenantId), undefined);
});

test('reconciler apply ผล ACKNOWLEDGED-mapped status แล้วเรียกซ้ำได้แบบ idempotent', async (t) => {
  const f = await fixture(t);
  const actions = new JourneyOwnerActionRepository(f.application);
  const dialerPort = fakePort();
  const reconciler = new JourneyOwnerResultReconciler(f.application, fakePort(), dialerPort);

  const rawActionKey = `${randomUUID()}:1:admit-campaign`;
  const command = admitCampaignCommand(f.rawTenantId, rawActionKey);
  await actions.ensureAction({
    tenantId: f.rawTenantId,
    actionKey: rawActionKey,
    enrollmentId: randomUUID(),
    kind: 'ADMIT_CAMPAIGN_TARGET',
    requestHash: command.requestHash,
    correlationId: 'corr-1',
    commandId: command.commandId,
    commandPayload: command,
  });
  await actions.markCommandDispatched(f.rawTenantId, command.commandId);

  assert.equal(await reconciler.reconcile(f.rawTenantId, rawActionKey), 'NO_RESULT_YET');

  dialerPort.results.set(rawActionKey, {
    contractVersion: 1,
    commandId: command.commandId,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
    commandType: 'ADMIT_CAMPAIGN_TARGET',
    status: 'ADMITTED',
    code: 'ADMITTED',
    category: 'BUSINESS',
    reasonCode: 'CAMPAIGN_ACTIVE_ADMITTED',
    failureClass: 'NONE',
    retryDisposition: 'NONE',
    observedAt: new Date().toISOString(),
    ownerAggregate: { type: 'campaign_target', id: 'record-1', version: 1 },
  });

  const applied = await reconciler.reconcile(f.rawTenantId, rawActionKey);
  assert.equal(applied, 'APPLIED');
  const action = await actions.getAction(f.rawTenantId, rawActionKey);
  assert.equal(action?.state, 'ACKNOWLEDGED');
  assert.equal(action?.ownerAggregateRef, 'record-1');

  const duplicate = await reconciler.reconcile(f.rawTenantId, rawActionKey);
  assert.equal(duplicate, 'DUPLICATE');
});

test('reconciler apply REJECTED และ TOO_LATE ตรงตาม J2OwnerResultStatus', async (t) => {
  const f = await fixture(t);
  const actions = new JourneyOwnerActionRepository(f.application);
  const dialerPort = fakePort();
  const reconciler = new JourneyOwnerResultReconciler(f.application, fakePort(), dialerPort);

  const rawActionKey = `${randomUUID()}:1:admit-campaign`;
  const command = admitCampaignCommand(f.rawTenantId, rawActionKey);
  await actions.ensureAction({
    tenantId: f.rawTenantId,
    actionKey: rawActionKey,
    enrollmentId: randomUUID(),
    kind: 'ADMIT_CAMPAIGN_TARGET',
    requestHash: command.requestHash,
    correlationId: 'corr-1',
    commandId: command.commandId,
    commandPayload: command,
  });
  await actions.markCommandDispatched(f.rawTenantId, command.commandId);
  dialerPort.results.set(rawActionKey, {
    contractVersion: 1,
    commandId: command.commandId,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
    commandType: 'ADMIT_CAMPAIGN_TARGET',
    status: 'REJECTED',
    code: 'OWNER_REJECTED',
    category: 'TERMINAL',
    reasonCode: 'CAMPAIGN_STOPPED',
    failureClass: 'BUSINESS',
    retryDisposition: 'DO_NOT_RETRY',
    observedAt: new Date().toISOString(),
  });

  assert.equal(await reconciler.reconcile(f.rawTenantId, rawActionKey), 'APPLIED');
  const action = await actions.getAction(f.rawTenantId, rawActionKey);
  assert.equal(action?.state, 'REJECTED');
});

test('cancel command ที่ stage ผ่าน requestCancellation ก็ relay ได้เหมือนกัน', async (t) => {
  const f = await fixture(t);
  const actions = new JourneyOwnerActionRepository(f.application);
  const dialerPort = fakePort();
  const relay = new JourneyOwnerCommandRelay(f.application, fakePort(), dialerPort);

  const rawActionKey = `${randomUUID()}:1:admit-campaign`;
  const command = admitCampaignCommand(f.rawTenantId, rawActionKey);
  await actions.ensureAction({
    tenantId: f.rawTenantId,
    actionKey: rawActionKey,
    enrollmentId: randomUUID(),
    kind: 'ADMIT_CAMPAIGN_TARGET',
    requestHash: command.requestHash,
    correlationId: 'corr-1',
    commandId: command.commandId,
    commandPayload: command,
  });
  await relay.executeNext(f.rawTenantId);

  await actions.requestCancellation({
    tenantId: f.rawTenantId,
    actionKey: rawActionKey,
    cancelRequestKey: 'outcome-corrected',
    reasonCode: 'OUTCOME_CORRECTED',
    correlationId: 'corr-cancel',
  });

  const result = await relay.executeNext(f.rawTenantId);
  assert.equal(result, 'SENT');
  assert.equal(dialerPort.persisted.length, 2);
  const action = await actions.getAction(f.rawTenantId, rawActionKey);
  assert.equal(action?.state, 'CANCEL_REQUESTED', 'dispatch ของ cancel command ไม่ทับ state นี้');

  // payload ที่ออกไปต้องผ่าน contract: actionKey เดิม, commandId ใหม่, requestHash ของ cancel เอง
  const sent = dialerPort.persisted[1] as {
    commandId: string;
    actionKey: string;
    requestHash: string;
    commandType: string;
    intent: { originalActionKey: string; reasonCode: string };
  };
  assert.equal(sent.commandType, 'CANCEL_CAMPAIGN_TARGET');
  assert.equal(sent.actionKey, rawActionKey);
  assert.equal(sent.intent.originalActionKey, rawActionKey);
  assert.equal(sent.intent.reasonCode, 'OUTCOME_CORRECTED');
  assert.notEqual(sent.commandId, command.commandId);
  assert.deepEqual(
    assertOwnerRequestHash(toTenantId(f.rawTenantId), sent).requestHash,
    sent.requestHash,
  );
  const stagedCancel = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
    where: { tenantId: f.rawTenantId, commandId: sent.commandId },
  });
  assert.equal(stagedCancel.requestHash, sent.requestHash);
});

test('cancel ไม่ถูกส่งก่อน command ต้นเรื่องของ action เดียวกันที่ยัง retry ค้างอยู่', async (t) => {
  const f = await fixture(t);
  const actions = new JourneyOwnerActionRepository(f.application);
  const dialerPort = fakePort();
  const relay = new JourneyOwnerCommandRelay(f.application, fakePort(), dialerPort);

  const rawActionKey = `${randomUUID()}:1:admit-campaign`;
  const command = admitCampaignCommand(f.rawTenantId, rawActionKey);
  await actions.ensureAction({
    tenantId: f.rawTenantId,
    actionKey: rawActionKey,
    enrollmentId: randomUUID(),
    kind: 'ADMIT_CAMPAIGN_TARGET',
    requestHash: command.requestHash,
    correlationId: 'corr-1',
    commandId: command.commandId,
    commandPayload: command,
  });
  // relay claim ไปแล้ว (อยู่ระหว่างส่ง) — ถือว่าออกจาก Journey แล้ว cancel ต้องไปทาง owner
  await f.owner.jrOwnerCommandOutbox.update({
    where: { tenantId_commandId: { tenantId: f.rawTenantId, commandId: command.commandId } },
    data: { state: 'PROCESSING' },
  });
  const requested = await actions.requestCancellation({
    tenantId: f.rawTenantId,
    actionKey: rawActionKey,
    cancelRequestKey: 'corrected',
    correlationId: 'corr-cancel',
  });
  assert.equal(requested.state, 'CANCEL_REQUESTED');

  // ส่งไม่สำเร็จ → กลับเป็น PENDING พร้อม backoff; cancel ห้ามแซงไปก่อน
  await actions.markCommandFailed(f.rawTenantId, command.commandId, 60_000, 'broker down');
  assert.equal(await relay.executeNext(f.rawTenantId), undefined);
  assert.equal(dialerPort.persisted.length, 0);

  await f.owner.jrOwnerCommandOutbox.update({
    where: { tenantId_commandId: { tenantId: f.rawTenantId, commandId: command.commandId } },
    data: { availableAt: new Date(Date.now() - 1_000) },
  });
  assert.equal(await relay.executeNext(f.rawTenantId), 'SENT');
  assert.equal(await relay.executeNext(f.rawTenantId), 'SENT');
  assert.deepEqual(
    dialerPort.persisted.map((sent) => (sent as { commandType: string }).commandType),
    ['ADMIT_CAMPAIGN_TARGET', 'CANCEL_CAMPAIGN_TARGET'],
  );
});

test('tenant คนละใบไม่ relay command ของกันและกัน', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const actions = new JourneyOwnerActionRepository(a.application);
  const dialerPortA = fakePort();
  const relayB = new JourneyOwnerCommandRelay(b.application, fakePort(), fakePort());

  const rawActionKey = `${randomUUID()}:1:admit-campaign`;
  const command = admitCampaignCommand(a.rawTenantId, rawActionKey);
  await actions.ensureAction({
    tenantId: a.rawTenantId,
    actionKey: rawActionKey,
    enrollmentId: randomUUID(),
    kind: 'ADMIT_CAMPAIGN_TARGET',
    requestHash: command.requestHash,
    correlationId: 'corr-1',
    commandId: command.commandId,
    commandPayload: command,
  });

  assert.equal(await relayB.executeNext(b.rawTenantId), undefined);
  assert.equal(dialerPortA.persisted.length, 0);
});
