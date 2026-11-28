/**
 * #1067 — Journey round one end to end over the real broker, without a browser:
 *
 *   author + review + publish a journey "disposition FOLLOW_UP_REQUIRED -> follow-up case"
 *   -> the Agent records the disposition (wrap-up) -> outbox -> dc.interaction.events
 *   -> Journey worker (receipt, enrollment, owner command) -> dc.case.commands
 *   -> Cases worker (case for the target team) -> dc.case.events -> Journey result
 *   -> the run shows up in the results of the journey with the case id
 *
 * It also proves: another disposition creates no case, and re-publishing the same outcome fact creates no
 * second case.
 *
 * Needs the dev broker (`pnpm infra:up`) and a migrated database with RLS applied:
 *   DATABASE_URL (owner role, for the fixture) and APPLICATION_DATABASE_URL (dcontact_app, for everything else)
 * The Journey and Cases workers are started here as child processes with their own consumer groups and are
 * stopped at the end. Every row belongs to a tenant created by this run.
 *
 * run: pnpm --filter @d-contact/api trial:journey-round-one
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AgentCases } from '@d-contact/cases';
import {
  contactId as toContactId,
  customerSnapshotVersion,
  membershipRevision,
  segmentDefinitionVersion,
  segmentEntryId,
  segmentId,
} from '@d-contact/cxa-contracts';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer, IamTeamSegmentScopeRepository } from '@d-contact/iam';
import {
  JourneyTemplateRepository,
  importJourneyDefinition,
  type JourneyDefinitionContent,
} from '@d-contact/journey';
import { saveAgentWrapup } from '../src/agent-wrapup-v1.js';
import { startInteractionOutcomeWorker } from '../src/interaction-outcome-outbox.js';

const repositoryRoot = resolve(__dirname, '../../..');
const ownerUrl = process.env.DATABASE_URL;
const applicationUrl = process.env.APPLICATION_DATABASE_URL;
if (!ownerUrl || !applicationUrl)
  throw new Error('DATABASE_URL and APPLICATION_DATABASE_URL are required');

const run = randomUUID().slice(0, 8);
const groups = {
  JOURNEY_CONSUMER_GROUP_ID: `dcontact-journey-events-trial-${run}`,
  JOURNEY_OUTCOME_CONSUMER_GROUP_ID: `dcontact-journey-outcomes-trial-${run}`,
  JOURNEY_OWNER_RESULT_CONSUMER_GROUP_ID: `dcontact-journey-owner-results-trial-${run}`,
  JOURNEY_GOVERNANCE_CONSUMER_GROUP_ID: `dcontact-journey-cg3-trial-${run}`,
  CASES_OWNER_COMMAND_CONSUMER_GROUP_ID: `dcontact-cases-owner-commands-trial-${run}`,
};
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const application = new PrismaClient({ datasources: { db: { url: applicationUrl } } });
const children: ChildProcess[] = [];
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const step = (text: string) => process.stdout.write(`# ${text}\n`);

function startWorker(name: 'journey' | 'cases'): void {
  const child = spawn('pnpm', ['--filter', `@d-contact/${name}`, 'exec', 'tsx', 'src/main.ts'], {
    cwd: repositoryRoot,
    env: { ...process.env, ...groups, DATABASE_URL: applicationUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let tail = '';
  const capture = (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-4_000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.once('exit', (code) => {
    if (!stopping) process.stderr.write(`${name} worker stopped (exit ${code})\n${tail}\n`);
  });
  children.push(child);
}

let stopping = false;
async function stopWorkers(): Promise<void> {
  stopping = true;
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await wait(1_500);
}

async function consumerGroupReady(groupId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        resolve(repositoryRoot, 'infra/docker/docker-compose.dev.yml'),
        'exec',
        '-T',
        'redpanda',
        'rpk',
        'group',
        'describe',
        groupId,
      ],
      { encoding: 'utf8' },
    );
    if (result.status === 0 && /STATE\s+Stable/.test(result.stdout)) return;
    await wait(500);
  }
  throw new Error(`consumer group is not ready: ${groupId}`);
}

async function until<T>(what: string, read: () => Promise<T | undefined | null | false>) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await read();
    if (value) return value;
    await wait(500);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function fixture() {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const queueId = randomUUID();
  const contactId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Journey trial ${run}`,
      slug: `journey-trial-${run}`,
      sipDomain: `${run}.journey-trial.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Customer Care' } });
  await owner.queue.create({
    data: { id: queueId, tenantId, teamId, name: 'Voice', voiceWrapupPolicy: 'VOICE_NOTE_V1' },
  });
  const user = async (role: 'AGENT' | 'SUPERVISOR' | 'ADMIN') => {
    const id = randomUUID();
    await owner.user.create({
      data: {
        id,
        tenantId,
        teamId: role === 'ADMIN' ? null : teamId,
        role,
        displayName: role,
        email: `${id}@test.invalid`,
        passwordHash: 'unused',
      },
    });
    return id;
  };
  const agentId = await user('AGENT');
  const makerId = await user('ADMIN');
  const reviewerId = await user('SUPERVISOR');
  await owner.agentStateLog.create({ data: { tenantId, userId: agentId, state: 'AVAILABLE' } });
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'Trial customer' } });

  // authoring rollout and permissions are managed outside the application role
  await owner.jrAuthoringRolloutState.create({
    data: {
      tenantId,
      stage: 'INTERNAL_SYNTHETIC',
      canvasWriteEnabled: true,
      publishUiEnabled: true,
      updatedByRef: 'journey-trial',
      evidenceRef: 'journey-trial',
    },
  });
  const grants: Array<[string, string[]]> = [
    [makerId, ['journey.read', 'journey.edit', 'journey.publish']],
    [reviewerId, ['journey.read', 'journey.review']],
  ];
  for (const [subjectId, capabilities] of grants) {
    await owner.iamAuthoringSubject.create({
      data: { tenantId, subjectId, authenticationStrength: 'STANDARD' },
    });
    for (const capability of capabilities)
      await owner.iamAuthoringCapabilityGrant.create({
        data: {
          tenantId,
          subjectId,
          capability,
          scopeKind: 'TENANT',
          scopeId: tenantId,
          grantedByRef: 'journey-trial',
        },
      });
  }
  await owner.csCaseTypePolicy.create({
    data: { tenantId, policyRef: 'follow-up', caseTypeKey: 'FOLLOW_UP' },
  });
  await owner.csRoutingPolicy.create({
    data: { tenantId, policyRef: 'follow-up', queueRef: 'follow-up' },
  });

  // the team may WORK on this customer: grant on a segment the customer is a member of
  const scope = new IamTeamSegmentScopeRepository(application);
  await scope.grant({
    tenantId,
    teamId,
    segmentId: 'trial-customers',
    permission: 'WORK',
    correlationId: 'journey-trial',
  });
  const at = new Date().toISOString();
  await scope.applyMembershipChange({
    tenantId,
    eventId: `journey-trial-${run}`,
    occurredAt: at,
    consumerGroup: 'journey-trial',
    payload: {
      contractVersion: 1,
      contactId: toContactId(contactId),
      segmentId: segmentId('trial-customers'),
      membershipRevision: membershipRevision(1),
      changeKind: 'ENTERED',
      entryId: segmentEntryId(`journey-trial-${run}`),
      segmentDefinitionVersion: segmentDefinitionVersion(1),
      snapshotVersion: customerSnapshotVersion(1),
      evaluatedAt: at,
      stateDigest: 'a'.repeat(64),
    },
  });

  const work = () =>
    owner.interaction.create({
      data: {
        tenantId,
        agentId,
        queueId,
        contactId,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'WRAPUP',
      },
    });
  return { tenantId, teamId, contactId, agentId, makerId, reviewerId, work };
}

async function publishJourney(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const repository = new JourneyTemplateRepository(application, {
    authorization: new IamJourneyAuthoringAuthorizer(),
    evaluator: new DcExprEvaluator(),
    flags: { canvasWrite: true, publishUi: true },
  });
  const context = (subjectId: string) => ({
    tenantId: f.tenantId,
    actor: { subjectId, correlationId: `journey-trial-${randomUUID()}` },
    idempotencyKey: `journey-trial-${randomUUID()}`,
  });
  const definition: JourneyDefinitionContent = {
    name: 'Follow-up case after a call',
    ownerTeamId: f.teamId,
    purpose: 'SERVICE',
    senderIdentityId: 'sender-trial',
    trigger: {
      kind: 'INTERACTION_OUTCOME',
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
      outcomeCode: 'FOLLOW_UP_REQUIRED',
      coalescingPolicy: 'PER_LOGICAL_OUTCOME',
    },
    graph: {
      entryStepId: 'ensure-case',
      steps: [
        {
          id: 'ensure-case',
          type: 'ENSURE_CASE',
          caseTypeId: 'follow-up',
          routingIntentRef: 'follow-up',
          targetOwnerTeamId: f.teamId,
          next: 'exit-case',
          onReject: 'exit-rejected',
        },
        { id: 'exit-case', type: 'EXIT', reason: 'CASE_ENSURED' },
        { id: 'exit-rejected', type: 'EXIT', reason: 'CASE_REJECTED' },
      ],
    },
    goal: { kind: 'EVENT', eventType: 'case.resolved' },
    exitRules: [{ kind: 'GOAL' }],
    maxDurationDays: 3,
  } as JourneyDefinitionContent;

  const created = await repository.createJourneyDraft(context(f.makerId), {
    ownerTeamId: f.teamId,
    document: importJourneyDefinition(definition),
  });
  const state = await repository.getJourneyAuthoringState(
    f.tenantId,
    context(f.makerId).actor,
    created.journeyId,
  );
  const compiled = await repository.compileJourneyDraft(f.tenantId, context(f.makerId).actor, {
    journeyId: created.journeyId,
    draftRevision: state.head.currentDraftRevision,
    draftDigest: state.head.currentDraftDigest,
  });
  assert.ok(compiled.artifact, `the journey does not compile: ${JSON.stringify(compiled)}`);
  const binding = {
    journeyId: created.journeyId,
    draftRevision: state.head.currentDraftRevision,
    draftDigest: state.head.currentDraftDigest,
    compileDigest: compiled.artifact.compileDigest,
    referenceDigest: compiled.artifact.referenceDigest,
    capabilityDigest: compiled.artifact.capabilityDigest,
    baseHeadVersion: state.head.version,
    baseHeadDigest: null,
  };
  const review = await repository.submitJourneyReview(context(f.makerId), binding);
  // maker-checker: the maker cannot approve their own candidate
  await assert.rejects(
    repository.decideJourneyReview(context(f.makerId), {
      journeyId: created.journeyId,
      reviewId: review.reviewId,
      expectedReviewState: 'IN_REVIEW',
      decision: 'APPROVE',
      reasonCode: 'APPROVED',
      evidenceRef: 'journey-trial',
    }),
  );
  await repository.decideJourneyReview(context(f.reviewerId), {
    journeyId: created.journeyId,
    reviewId: review.reviewId,
    expectedReviewState: 'IN_REVIEW',
    decision: 'APPROVE',
    reasonCode: 'APPROVED',
    evidenceRef: 'journey-trial',
  });
  const published = await repository.publishJourneyDraft(context(f.makerId), {
    ...binding,
    reviewId: review.reviewId,
    expectedHeadVersion: state.head.version,
  });
  step(`journey published: ${created.journeyId} version ${published.version}`);
  return created.journeyId;
}

async function main(): Promise<void> {
  const f = await fixture();
  step(`tenant ${f.tenantId}`);
  const journeyId = await publishJourney(f);

  startWorker('journey');
  startWorker('cases');
  await Promise.all([
    consumerGroupReady(groups.JOURNEY_OUTCOME_CONSUMER_GROUP_ID),
    consumerGroupReady(groups.JOURNEY_OWNER_RESULT_CONSUMER_GROUP_ID),
    consumerGroupReady(groups.CASES_OWNER_COMMAND_CONSUMER_GROUP_ID),
  ]);
  step('Journey and Cases workers are consuming');
  const relay = startInteractionOutcomeWorker({
    database: application,
    env: { ...process.env, INTERACTION_OUTCOME_EVENTS: 'on' },
    log: () => undefined,
  });
  assert.ok(relay);

  const actor = { tenantId: f.tenantId, userId: f.agentId };
  const wrapUp = async (disposition: string) => {
    const work = await f.work();
    await saveAgentWrapup(
      application,
      actor,
      work.id,
      { commandId: randomUUID(), disposition, note: 'trial' },
      { emitOutcome: true },
    );
    return work.id;
  };

  const assisted = await wrapUp('CUSTOMER_ASSISTED');
  const followUp = await wrapUp('FOLLOW_UP_REQUIRED');
  step(`the Agent recorded CUSTOMER_ASSISTED (${assisted}) and FOLLOW_UP_REQUIRED (${followUp})`);

  const repository = new JourneyTemplateRepository(application, {
    authorization: new IamJourneyAuthoringAuthorizer(),
    evaluator: new DcExprEvaluator(),
    flags: { canvasWrite: true, publishUi: true },
  });
  const viewer = { subjectId: f.makerId, correlationId: 'journey-trial-view' };
  const runs = () => repository.listJourneyRuns(f.tenantId, viewer, { journeyId });
  const done = await until('the run is acknowledged by Cases', async () => {
    const page = await runs();
    return page.items.length === 1 && page.items[0]!.actions[0]?.state === 'ACKNOWLEDGED'
      ? page.items[0]
      : undefined;
  });
  assert.equal(done.trigger?.outcomeCode, 'FOLLOW_UP_REQUIRED');
  assert.equal(done.trigger?.interactionId, followUp);
  assert.equal(done.contactId, f.contactId);
  const caseId = done.actions[0]!.ownerAggregateId;
  assert.ok(caseId);
  step(`results of the journey: 1 run, ENSURE_CASE acknowledged, case ${caseId}`);

  // both outcome facts were consumed; only the matching disposition enrolled
  await until('both receipts are applied', async () => {
    const receipts = await owner.jrOutcomeReceipt.findMany({ where: { tenantId: f.tenantId } });
    return receipts.length === 2 && receipts.every((receipt) => receipt.state === 'APPLIED');
  });
  const cases = await owner.csCase.findMany({ where: { tenantId: f.tenantId } });
  assert.equal(cases.length, 1);
  assert.equal(cases[0]!.id, caseId);
  assert.equal(cases[0]!.contactId, f.contactId);
  assert.equal(cases[0]!.teamId, f.teamId);
  const activity = await owner.csCaseActivity.findMany({ where: { tenantId: f.tenantId } });
  assert.deepEqual(
    activity.map((row) => [row.kind, row.interactionId]),
    [['CREATED', followUp]],
  );
  step('exactly one case, for the customer and the original work; the other disposition made none');

  // the target team sees the case in its own case list
  const teamCases = await new AgentCases(application).list(actor);
  assert.deepEqual(
    teamCases.items.map((item) => item.id),
    [caseId],
  );
  step('the Agent of the target team sees the case in the team case list');

  // replay: the relay publishes the same outcome fact again (same eventId) -> nothing new
  await owner.interactionOutcomeOutbox.updateMany({
    where: { tenantId: f.tenantId },
    data: { state: 'PENDING', sentAt: null },
  });
  await until('the outcome facts are published again', async () => {
    const pending = await owner.interactionOutcomeOutbox.count({
      where: { tenantId: f.tenantId, state: 'PENDING' },
    });
    return pending === 0;
  });
  await wait(5_000);
  assert.equal(await owner.jrOutcomeReceipt.count({ where: { tenantId: f.tenantId } }), 2);
  assert.equal(await owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await owner.csCase.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await owner.csCaseActivity.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal((await runs()).items.length, 1);
  step('replay of the same outcome facts: still one receipt each, one run, one case');

  await relay.stop();
  process.stdout.write('JOURNEY_ROUND_ONE_TRIAL_PASSED\n');
}

void (async () => {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await stopWorkers();
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  }
})();
