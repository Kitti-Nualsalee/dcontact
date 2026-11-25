/**
 * J2.8 (#136) — proves ACK_UNKNOWN escalation and bounded reconciliation deadlines
 *
 * What must be true: always ask the owner first (no blind retry), retries have a ceiling, and at the ceiling
 * it must hand over to a person through audit, not loop forever or go silent
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  actionKey as toActionKey,
  campaignId,
  commandId as toCommandId,
  contactId,
  enrollmentId as toEnrollmentId,
  interactionId,
  journeyId,
  outcomeId,
  teamId,
  tenantId as toTenantId,
  withOwnerRequestHash,
  type J2OwnerResultPayloadV1,
} from '@d-contact/cxa-contracts';
import { JourneyOwnerAckEscalator } from './journey-owner-ack-escalator.js';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneyOwnerResultReconciler } from './journey-owner-result-reconciler.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const REQUEST_HASH = 'e'.repeat(64);

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const enrollmentId = randomUUID();

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.8 ack ${tenantId.slice(0, 8)}`,
      slug: `j2-8-ack-${tenantId.slice(0, 8)}`,
      sipDomain: `${tenantId.slice(0, 8)}.j2-8-ack.test`,
    },
  });

  t.after(async () => {
    await owner.jrRecoveryAudit.deleteMany({ where: { tenantId } });
    await owner.jrOwnerResultInbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const repository = new JourneyOwnerActionRepository(application);

  /** an action dispatched `agoMs` ago */
  async function dispatchedAgo(agoMs: number) {
    const actionKey = `ack-action-${randomUUID()}`;
    const commandId = randomUUID();
    await repository.ensureAction({
      tenantId,
      actionKey,
      enrollmentId,
      kind: 'ENSURE_CASE',
      requestHash: REQUEST_HASH,
      correlationId: commandId,
      commandId,
      commandPayload: { placeholder: true },
    });
    await repository.markCommandDispatched(tenantId, commandId);
    await owner.jrOwnerAction.updateMany({
      where: { tenantId, actionKey },
      data: { dispatchedAt: new Date(Date.now() - agoMs) },
    });
    return { actionKey, commandId };
  }

  /** a port that never returns a result = a completely silent owner */
  const silentPort = {
    async persistCommand() {
      throw new Error('should not be called in the escalation path');
    },
    async queryAction(): Promise<J2OwnerResultPayloadV1 | undefined> {
      return undefined;
    },
  };

  return { owner, application, tenantId, repository, dispatchedAgo, silentPort };
}

function escalator(
  f: Awaited<ReturnType<typeof fixture>>,
  port: unknown,
  options: { maxAttempts?: number } = {},
) {
  return new JourneyOwnerAckEscalator(
    f.application,
    new JourneyOwnerResultReconciler(f.application, port as never, port as never),
    { ackDeadlineMs: 1_000, maxAttempts: options.maxAttempts ?? 3 },
  );
}

test('an action not yet past the deadline must not be touched', async (t) => {
  const f = await fixture(t);
  const { actionKey } = await f.dispatchedAgo(0);

  assert.equal(await escalator(f, f.silentPort).escalateNext(f.tenantId), undefined);

  const untouched = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(untouched.state, 'DISPATCHED');
  assert.equal(untouched.attempts, 0);
});

test('past the deadline with the owner still silent -> ACK_UNKNOWN with an attempt counted', async (t) => {
  const f = await fixture(t);
  const { actionKey } = await f.dispatchedAgo(5_000);

  assert.equal(await escalator(f, f.silentPort).escalateNext(f.tenantId), 'WAITING');

  const moved = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(moved.state, 'ACK_UNKNOWN');
  assert.equal(moved.attempts, 1);
  // the ceiling is not reached yet, so no audit is recorded
  assert.equal(await f.owner.jrRecoveryAudit.count({ where: { tenantId: f.tenantId } }), 0);
});

test('the owner was asked and has a real result -> apply immediately without a retry', async (t) => {
  const f = await fixture(t);
  const { actionKey, commandId } = await f.dispatchedAgo(5_000);

  const answeringPort = {
    async persistCommand() {
      throw new Error('should not be called');
    },
    async queryAction(): Promise<J2OwnerResultPayloadV1> {
      return {
        contractVersion: 1,
        commandId,
        actionKey,
        requestHash: REQUEST_HASH,
        commandType: 'ENSURE_CASE',
        status: 'CREATED',
        code: 'CREATED',
        category: 'BUSINESS',
        reasonCode: 'CREATED',
        failureClass: 'NONE',
        retryDisposition: 'NONE',
        observedAt: new Date().toISOString(),
        ownerAggregate: { type: 'case', id: randomUUID(), version: 1 },
      } as J2OwnerResultPayloadV1;
    },
  };

  assert.equal(await escalator(f, answeringPort).escalateNext(f.tenantId), 'RECONCILED');

  const applied = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(applied.state, 'ACKNOWLEDGED');
});

test('at the retry ceiling audit is recorded and it stops chasing on its own (bounded)', async (t) => {
  const f = await fixture(t);
  const { actionKey } = await f.dispatchedAgo(5_000);
  const runner = escalator(f, f.silentPort, { maxAttempts: 3 });

  assert.equal(await runner.escalateNext(f.tenantId), 'WAITING');
  assert.equal(await runner.escalateNext(f.tenantId), 'WAITING');
  assert.equal(await runner.escalateNext(f.tenantId), 'ESCALATED');

  const audit = await f.owner.jrRecoveryAudit.findFirstOrThrow({
    where: { tenantId: f.tenantId, targetRef: actionKey },
  });
  assert.equal(audit.reasonCode, 'ACK_UNKNOWN_DEADLINE_EXCEEDED');
  assert.equal(audit.operation, 'RECONCILE');

  // once the ceiling is reached it must not be picked up again — no looping calls to the owner
  assert.equal(await runner.escalateNext(f.tenantId), undefined);
  const final = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(final.attempts, 3);
  assert.equal(final.state, 'ACK_UNKNOWN');
});

test('an escalated action can still receive a late result (ACK_UNKNOWN is an open state)', async (t) => {
  const f = await fixture(t);
  const { actionKey, commandId } = await f.dispatchedAgo(5_000);
  const runner = escalator(f, f.silentPort, { maxAttempts: 1 });

  assert.equal(await runner.escalateNext(f.tenantId), 'ESCALATED');

  const applied = await f.repository.applyResult({
    tenantId: f.tenantId,
    commandId,
    actionKey,
    resultKind: 'ACKNOWLEDGED',
    resultHash: 'f'.repeat(64),
    correlationId: commandId,
  });

  assert.equal(applied.outcome, 'APPLIED');
  assert.equal(applied.action.state, 'ACKNOWLEDGED');
});

test('different tenants do not escalate each other', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  await f.dispatchedAgo(5_000);
  const theirs = await other.dispatchedAgo(5_000);

  assert.equal(await escalator(f, f.silentPort).escalateNext(f.tenantId), 'WAITING');

  const untouched = await other.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: other.tenantId, actionKey: theirs.actionKey },
  });
  assert.equal(untouched.state, 'DISPATCHED');
});

/** a Dialer action that already left and asked for cancel `agoMs` ago — the cancel command has its own hash */
async function cancelRequestedAgo(f: Awaited<ReturnType<typeof fixture>>, agoMs: number) {
  const enrollment = randomUUID();
  const actionKey = `${enrollment}:1:admit-campaign`;
  const command = withOwnerRequestHash(toTenantId(f.tenantId), {
    contractVersion: 1,
    commandId: toCommandId(randomUUID()),
    actionKey: toActionKey(actionKey),
    journeyId: journeyId(randomUUID()),
    journeyVersion: 1,
    enrollmentId: toEnrollmentId(enrollment),
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
    intent: { campaignId: campaignId('campaign-collections') },
  });
  await f.repository.ensureAction({
    tenantId: f.tenantId,
    actionKey,
    enrollmentId: enrollment,
    kind: 'ADMIT_CAMPAIGN_TARGET',
    requestHash: command.requestHash,
    correlationId: command.commandId,
    commandId: command.commandId,
    commandPayload: command,
  });
  await f.repository.markCommandDispatched(f.tenantId, command.commandId);
  // the ACK_UNKNOWN phase of the original command already used up the quota — cancel must start counting afresh
  await f.owner.jrOwnerAction.updateMany({
    where: { tenantId: f.tenantId, actionKey },
    data: { attempts: 2 },
  });
  await f.repository.requestCancellation({
    tenantId: f.tenantId,
    actionKey,
    cancelRequestKey: 'corrected',
    correlationId: 'corr-cancel',
  });
  await f.owner.jrOwnerAction.updateMany({
    where: { tenantId: f.tenantId, actionKey },
    data: { cancelRequestedAt: new Date(Date.now() - agoMs) },
  });
  const cancel = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey, NOT: { commandId: command.commandId } },
  });
  return { actionKey, command, cancel };
}

test('a CANCEL_REQUESTED the owner has not confirmed is asked with the requestHash of the cancel and has its own ceiling', async (t) => {
  const f = await fixture(t);
  const { actionKey, cancel } = await cancelRequestedAgo(f, 5_000);
  const queries: string[] = [];
  const recordingPort = {
    ...f.silentPort,
    async queryAction(_tenant: unknown, query: { requestHash: string }) {
      queries.push(query.requestHash);
      return undefined;
    },
  };
  const escalate = escalator(f, recordingPort, { maxAttempts: 2 });

  assert.equal(await escalate.escalateNext(f.tenantId), 'WAITING');
  assert.equal(await escalate.escalateNext(f.tenantId), 'ESCALATED');
  assert.equal(
    await escalate.escalateNext(f.tenantId),
    undefined,
    'must not be picked up again at the ceiling',
  );

  assert.deepEqual(queries, [cancel.requestHash, cancel.requestHash]);
  const action = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(
    action.state,
    'CANCEL_REQUESTED',
    'an unconfirmed cancel must not be converted to ACK_UNKNOWN',
  );
  assert.equal(action.attempts, 2);
  const audit = await f.owner.jrRecoveryAudit.findFirstOrThrow({
    where: { tenantId: f.tenantId, targetRef: actionKey },
  });
  assert.equal(audit.reasonCode, 'CANCEL_UNCONFIRMED_DEADLINE_EXCEEDED');
});

test('the owner confirms the cancel result when asked -> apply as CANCELLED', async (t) => {
  const f = await fixture(t);
  const { actionKey, cancel } = await cancelRequestedAgo(f, 5_000);
  const answeringPort = {
    ...f.silentPort,
    async queryAction(
      _tenant: unknown,
      query: { actionKey: string; requestHash: string },
    ): Promise<J2OwnerResultPayloadV1 | undefined> {
      if (query.requestHash !== cancel.requestHash) return undefined;
      return {
        contractVersion: 1,
        commandId: cancel.commandId,
        actionKey: query.actionKey,
        requestHash: cancel.requestHash,
        commandType: 'CANCEL_CAMPAIGN_TARGET',
        status: 'CANCELLED',
        code: 'CANCELLED',
        category: 'BUSINESS',
        reasonCode: 'CAMPAIGN_TARGET_CANCELLED',
        failureClass: 'NONE',
        retryDisposition: 'NONE',
        observedAt: new Date().toISOString(),
        ownerAggregate: { type: 'campaign_target', id: randomUUID(), version: 2 },
      } as J2OwnerResultPayloadV1;
    },
  };

  assert.equal(await escalator(f, answeringPort).escalateNext(f.tenantId), 'RECONCILED');
  const action = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(action.state, 'CANCELLED');
});
