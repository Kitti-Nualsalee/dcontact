/**
 * S2.1 (#365) acceptance: persistence foundation of the LINE provider on real Postgres with the
 * application role (RLS in effect) — no network, SDK, credential value or PII in the fixture
 *
 * Covers: composite binding, uniqueness/idempotency, append-only, race-safe primitives,
 * generic two-tenant ID/binding swap, and the mixed-version guard of the existing worker
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  actionKey,
  contactId,
  reservationId,
  tenantId,
  type ContactGovernancePort,
} from '@d-contact/cxa-contracts';
import { DeliveryTestAdapter } from './delivery-test-adapter.js';
import {
  createLinePersistenceFixture,
  digest,
  PILOT_CHANNEL_ACCOUNT_ID,
  type LinePersistenceFixture,
} from './line-persistence-fixture.js';
import {
  LineBindingRejectedError,
  LineIdempotencyConflictError,
} from './line-repository-support.js';

async function fixture(t: TestContext): Promise<LinePersistenceFixture> {
  const context = await createLinePersistenceFixture();
  t.after(() => context.dispose());
  return context;
}

const T0 = new Date('2026-09-22T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** An error the DB throws back must not leak the ID of another tenant */
async function rejectsGenerically(work: Promise<unknown>, ...secrets: string[]) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof LineBindingRejectedError, String(error));
    for (const secret of secrets) assert.ok(!error.message.includes(secret));
    return true;
  });
}

// ── Provider attempt receipts ────────────────────────────────────────────────

test('attempt receipt: the same replay returns the same row, different input is a conflict, and once a result exists no continuing', async (t) => {
  const context = await fixture(t);
  const delivery = await context.seedDelivery(context.tenantA);
  const base = {
    tenantId: context.tenantA,
    deliveryId: delivery.deliveryId,
    providerRequestKey: delivery.providerRequestKey,
    providerPayloadDigest: digest('canonical-payload'),
  };

  const unknown = {
    ...base,
    id: randomUUID(),
    attemptNo: 1,
    startedAt: at(1),
    finishedAt: at(2),
    outcomeCode: 'LINE_UNKNOWN_OUTCOME' as const,
  };
  const first = await context.attempts.record(unknown);
  assert.equal(first.outcomeClass, 'RETRYABLE_UNKNOWN');
  assert.equal((await context.attempts.record({ ...unknown, id: randomUUID() })).id, first.id);
  await assert.rejects(
    context.attempts.record({ ...unknown, id: randomUUID(), httpStatus: 503 }),
    LineIdempotencyConflictError,
  );

  const accepted = await context.attempts.record({
    ...base,
    id: randomUUID(),
    attemptNo: 2,
    startedAt: at(3),
    finishedAt: at(3),
    httpStatus: 409,
    outcomeCode: 'LINE_ACCEPTED_REPLAY',
    lineRequestId: 'req-2',
    lineAcceptedRequestId: 'req-accepted-1',
    sentMessageIds: ['461230966842064897'],
  });
  assert.equal(accepted.outcomeClass, 'ACCEPTED');

  await assert.rejects(
    context.attempts.record({
      ...base,
      id: randomUUID(),
      attemptNo: 3,
      startedAt: at(4),
      finishedAt: at(4),
      outcomeCode: 'LINE_UNKNOWN_OUTCOME',
    }),
    /DL_LINE_ATTEMPT_AFTER_OUTCOME/,
  );
  assert.deepEqual(
    (await context.attempts.listForDelivery(context.tenantA, delivery.deliveryId)).map(
      (row) => row.attemptNo,
    ),
    [1, 2],
  );
});

test('attempt receipt: binds only the original providerRequestKey and the LINE outbox, sequential, ends within 24 hours', async (t) => {
  const context = await fixture(t);
  const delivery = await context.seedDelivery(context.tenantA);
  const testDelivery = await context.seedDelivery(context.tenantA, 'TEST_ADAPTER');
  const attempt = (overrides: Record<string, unknown>) => ({
    id: randomUUID(),
    tenantId: context.tenantA,
    deliveryId: delivery.deliveryId,
    providerRequestKey: delivery.providerRequestKey,
    attemptNo: 1,
    providerPayloadDigest: digest('payload'),
    startedAt: at(0),
    finishedAt: at(0),
    outcomeCode: 'LINE_PROVIDER_UNAVAILABLE' as const,
    httpStatus: 500,
    ...overrides,
  });

  // a new key = the binding does not match the outbox → generic rejection, not a new receipt
  await rejectsGenerically(context.attempts.record(attempt({ providerRequestKey: randomUUID() })));
  await rejectsGenerically(
    context.attempts.record(
      attempt({
        deliveryId: testDelivery.deliveryId,
        providerRequestKey: testDelivery.providerRequestKey,
      }),
    ),
  );
  await assert.rejects(
    context.attempts.record(attempt({ attemptNo: 2 })),
    /DL_LINE_ATTEMPT_SEQUENCE/,
  );
  // The BEFORE INSERT trigger runs before the CHECK so it may hit either one first — both reject the 5th attempt
  await assert.rejects(
    context.attempts.record(attempt({ attemptNo: 5 })),
    /DL_LINE_ATTEMPT_SEQUENCE|attempt_no_check/,
  );

  await context.attempts.record(attempt({}));
  await assert.rejects(
    context.attempts.record(
      attempt({ attemptNo: 2, startedAt: at(24 * 60), finishedAt: at(24 * 60) }),
    ),
    /DL_LINE_RETRY_WINDOW_EXPIRED/,
  );
  await context.attempts.record(
    attempt({ attemptNo: 2, startedAt: at(24 * 60 - 1), finishedAt: at(24 * 60 - 1) }),
  );
  // quarantine after the window is closing the job, not an HTTP retry, so it can be recorded
  const expired = await context.attempts.record(
    attempt({
      attemptNo: 3,
      startedAt: at(24 * 60 + 5),
      finishedAt: at(24 * 60 + 5),
      httpStatus: undefined,
      outcomeCode: 'LINE_RETRY_WINDOW_EXPIRED',
    }),
  );
  assert.equal(expired.outcomeClass, 'QUARANTINED');
});

test('attempt receipt: class/rejection/acceptance evidence is checked in both the contract and the DB', async (t) => {
  const context = await fixture(t);
  const delivery = await context.seedDelivery(context.tenantA);
  const base = {
    id: randomUUID(),
    tenantId: context.tenantA,
    deliveryId: delivery.deliveryId,
    providerRequestKey: delivery.providerRequestKey,
    attemptNo: 1,
    providerPayloadDigest: digest('payload'),
    startedAt: at(0),
    finishedAt: at(0),
  };
  await assert.rejects(
    context.attempts.record({
      ...base,
      outcomeCode: 'LINE_AUTH_INVALID',
      rejectionScope: 'RECIPIENT',
      httpStatus: 401,
    }),
    /LINE_AUTH_INVALID/,
  );
  // a 2xx without x-line-request-id is not acceptance evidence
  await assert.rejects(
    context.attempts.record({ ...base, outcomeCode: 'LINE_ACCEPTED', httpStatus: 200 }),
    /acceptance_check/,
  );
  // a caller that bypasses the repository and stuffs in a class itself still cannot pass the CHECK
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `INSERT INTO dl_provider_submission_attempts (id, tenant_id, delivery_id, provider_request_key, attempt_no, provider_payload_digest, started_at, finished_at, outcome_code, outcome_class)
       VALUES ('${randomUUID()}', '${context.tenantA}', '${delivery.deliveryId}', '${delivery.providerRequestKey}', 1, '${digest('x')}', now(), now(), 'LINE_UNKNOWN_OUTCOME', 'ACCEPTED')`,
    ),
    /class_check/,
  );
  const recipientReject = await context.attempts.record({
    ...base,
    outcomeCode: 'LINE_REQUEST_REJECTED',
    rejectionScope: 'RECIPIENT',
    httpStatus: 400,
    lineRequestId: 'req-reject',
  });
  assert.equal(recipientReject.rejectionScope, 'RECIPIENT');
});

test('attempt receipt and audit are append-only for the application role', async (t) => {
  const context = await fixture(t);
  const delivery = await context.seedDelivery(context.tenantA);
  const receipt = await context.attempts.record({
    id: randomUUID(),
    tenantId: context.tenantA,
    deliveryId: delivery.deliveryId,
    providerRequestKey: delivery.providerRequestKey,
    attemptNo: 1,
    providerPayloadDigest: digest('payload'),
    startedAt: at(0),
    finishedAt: at(0),
    outcomeCode: 'LINE_UNKNOWN_OUTCOME',
  });
  const event = await context.audit.append({
    id: randomUUID(),
    tenantId: context.tenantA,
    eventId: `provider-attempt:${receipt.id}`,
    category: 'PROVIDER',
    code: 'LINE_UNKNOWN_OUTCOME',
    actorKind: 'SYSTEM',
    actorRef: 'line-outbound-worker',
    deliveryId: delivery.deliveryId,
    occurredAt: at(0),
  });

  for (const sql of [
    `UPDATE dl_provider_submission_attempts SET http_status = 200 WHERE id = '${receipt.id}'`,
    `DELETE FROM dl_provider_submission_attempts WHERE id = '${receipt.id}'`,
    `UPDATE dl_line_audit_events SET code = 'TAMPERED' WHERE id = '${event.id}'`,
    `DELETE FROM dl_line_audit_events WHERE id = '${event.id}'`,
  ]) {
    await assert.rejects(context.asApplication(context.tenantA, sql), /permission denied/, sql);
  }
  // even an owner with UPDATE privilege still hits the trigger — evidence cannot be edited retroactively, in both layers
  await assert.rejects(
    context.owner.$executeRawUnsafe(
      `UPDATE dl_provider_submission_attempts SET http_status = 200 WHERE id = '${receipt.id}'`,
    ),
    /DL_LINE_APPEND_ONLY/,
  );

  assert.equal(
    (
      await context.audit.append({
        id: randomUUID(),
        tenantId: context.tenantA,
        eventId: `provider-attempt:${receipt.id}`,
        category: 'PROVIDER',
        code: 'LINE_UNKNOWN_OUTCOME',
        actorKind: 'SYSTEM',
        actorRef: 'line-outbound-worker',
        deliveryId: delivery.deliveryId,
        occurredAt: at(0),
      })
    ).id,
    event.id,
  );
  await assert.rejects(
    context.audit.append({
      id: randomUUID(),
      tenantId: context.tenantA,
      eventId: `provider-attempt:${receipt.id}`,
      category: 'PROVIDER',
      code: 'LINE_ACCEPTED',
      actorKind: 'SYSTEM',
      actorRef: 'line-outbound-worker',
      occurredAt: at(0),
    }),
    LineIdempotencyConflictError,
  );
});

// ── Rollout gate ─────────────────────────────────────────────────────────────

test('gate: concurrent creation yields one row, CAS, one-step promotion, and the kill latch beats every state', async (t) => {
  const context = await fixture(t);
  const scope = context.scope(context.tenantA);
  const created = await Promise.all(
    Array.from({ length: 5 }, () => context.control.ensureGate(randomUUID(), scope)),
  );
  assert.equal(new Set(created.map((gate) => gate.id)).size, 1);
  const gate = created[0];
  assert.equal(gate.businessState, 'DISABLED');

  const dryRun = await context.control.compareAndSetGate(context.tenantA, gate.id, 1, {
    businessState: 'DRY_RUN',
  });
  assert.equal(dryRun?.version, 2);
  assert.equal(
    await context.control.compareAndSetGate(context.tenantA, gate.id, 1, {
      technicalSwitchOn: true,
    }),
    null,
    'an old version must not overwrite',
  );
  await assert.rejects(
    context.control.compareAndSetGate(context.tenantA, gate.id, 2, {
      businessState: 'CAPPED_PILOT',
    }),
    /DL_LINE_GATE_STEP/,
  );
  await assert.rejects(
    context.control.compareAndSetGate(context.tenantA, gate.id, 2, {
      businessState: 'PROVIDER_CONFORMANCE',
    }),
    /config_check/,
    'leaving DRY_RUN needs a config digest',
  );
  const conformance = await context.control.compareAndSetGate(context.tenantA, gate.id, 2, {
    businessState: 'PROVIDER_CONFORMANCE',
    configDigest: digest('config-v1'),
    technicalSwitchOn: true,
  });
  assert.equal(conformance?.businessState, 'PROVIDER_CONFORMANCE');

  const killed = await context.control.killGate(context.tenantA, gate.id, 'AUTH_FAILURE', at(5));
  assert.equal(killed.killed, true);
  assert.equal(killed.technicalSwitchOn, false, 'kill must turn off the switch in the same row');
  const again = await context.control.killGate(context.tenantA, gate.id, 'OPERATOR_KILL', at(6));
  assert.equal(
    again.killReason,
    'AUTH_FAILURE',
    'a repeated kill does not overwrite the original reason',
  );
  assert.equal(again.version, killed.version);

  await assert.rejects(
    context.control.compareAndSetGate(context.tenantA, gate.id, killed.version, {
      businessState: 'CAPPED_PILOT',
    }),
    /DL_LINE_GATE_KILLED_ADVANCE/,
  );
  await assert.rejects(
    context.control.compareAndSetGate(context.tenantA, gate.id, killed.version, {
      technicalSwitchOn: true,
    }),
    /kill_check/,
  );
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `UPDATE dl_line_scope_gates SET killed = false, kill_reason = NULL, killed_at = NULL, version = version + 1 WHERE id = '${gate.id}'`,
    ),
    /DL_LINE_GATE_KILL_CLEAR_REF/,
  );
  const cleared = await context.control.clearGateKill(
    context.tenantA,
    gate.id,
    killed.version,
    'approval:kill-clear:0001',
  );
  assert.equal(cleared?.killed, false);
  assert.equal(cleared?.businessState, 'DISABLED');
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `DELETE FROM dl_line_scope_gates WHERE id = '${gate.id}'`,
    ),
    /permission denied/,
  );
});

// ── Run authorization ────────────────────────────────────────────────────────

test('run authorization: full approval of two roles, consume works once under a race, and a proposal cannot be edited', async (t) => {
  const context = await fixture(t);
  const { run, proposedAt } = await context.seedApprovedRun(context.tenantA);
  assert.equal(run.state, 'APPROVED');
  const deliveries = await Promise.all(
    Array.from({ length: 5 }, () => context.seedDelivery(context.tenantA)),
  );

  const results = await Promise.all(
    deliveries.map((delivery) =>
      context.control.consumeRun(context.tenantA, run.id, delivery.deliveryId, at(1)),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'CONSUMED').length, 1);
  assert.deepEqual(
    results.filter((result) => result.status === 'DENIED').map((result) => result.code),
    Array(4).fill('RUN_AUTHORIZATION_CONSUMED'),
  );

  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `UPDATE dl_line_run_authorizations SET state = 'APPROVED', consumed_at = NULL, consumed_delivery_id = NULL WHERE id = '${run.id}'`,
    ),
    /DL_LINE_RUN_CLOSED/,
  );

  const second = await context.seedApprovedRun(context.tenantA, 'second');
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `UPDATE dl_line_run_authorizations SET config_digest = '${digest('other')}' WHERE id = '${second.run.id}'`,
    ),
    /DL_LINE_RUN_PINNED/,
  );
  const expired = await context.control.consumeRun(
    context.tenantA,
    second.run.id,
    deliveries[1]!.deliveryId,
    new Date(proposedAt.getTime() + 31 * 60_000),
  );
  assert.deepEqual(expired, { status: 'DENIED', code: 'RUN_AUTHORIZATION_EXPIRED' });
  // a delivery that already consumed one authorization cannot consume a second
  const winner = results.findIndex((result) => result.status === 'CONSUMED');
  await assert.rejects(
    context.control.consumeRun(
      context.tenantA,
      second.run.id,
      deliveries[winner]!.deliveryId,
      at(2),
    ),
    LineIdempotencyConflictError,
  );
});

test('run authorization: a TTL over 30 minutes or a cap over the profile is rejected at the DB', async (t) => {
  const context = await fixture(t);
  const { gate, allowlist, credential } = await context.seedApprovedRun(context.tenantA);
  const proposal = {
    id: randomUUID(),
    tenantId: context.tenantA,
    gateId: gate.id,
    allowlistEntryId: allowlist.id,
    credentialRefId: credential.id,
    credentialVersion: credential.version,
    proposalDigest: digest(randomUUID()),
    configDigest: digest('config-v1'),
    capLogicalDeliveries: 1,
    capProviderAttempts: 4,
    proposedBy: 'platform-operator-1',
    proposedAt: T0,
    expiresAt: at(30),
  };
  await assert.rejects(
    context.control.proposeRun({ ...proposal, expiresAt: at(31) }),
    /caps_check/,
  );
  await assert.rejects(
    context.control.proposeRun({ ...proposal, capLogicalDeliveries: 2 }),
    /caps_check/,
  );
  await assert.rejects(
    context.control.proposeRun({ ...proposal, capProviderAttempts: 5 }),
    /caps_check/,
  );
  const created = await context.control.proposeRun(proposal);
  assert.equal(
    (await context.control.proposeRun({ ...proposal, id: randomUUID() })).id,
    created.id,
  );
  // repeating the same approval role does not count as a second approval
  await context.control.approveRun(context.tenantA, created.id, 'TENANT_ADMIN', 'admin-1', T0);
  assert.equal(
    await context.control.approveRun(context.tenantA, created.id, 'TENANT_ADMIN', 'admin-2', T0),
    null,
  );
  assert.equal(
    (await context.control.consumeRun(context.tenantA, created.id, 'unused', at(1))).status,
    'DENIED',
  );
});

// ── Cap ledger ───────────────────────────────────────────────────────────────

test('cap ledger: concurrent reservations cannot exceed the limit, kill closes new reservations, and COMMITTED cannot be returned', async (t) => {
  const context = await fixture(t);
  const { gate, run, allowlist } = await context.seedApprovedRun(context.tenantA);
  const deliveries = await Promise.all(
    Array.from({ length: 6 }, () => context.seedDelivery(context.tenantA)),
  );
  const reserve = (deliveryId: string, recipient = allowlist.recipientFingerprint) =>
    context.control.reserveCap({
      id: randomUUID(),
      tenantId: context.tenantA,
      gateId: gate.id,
      runAuthorizationId: run.id,
      deliveryId,
      capKind: 'LOGICAL_DELIVERY',
      recipientFingerprint: recipient,
      reservedAt: at(1),
      limits: [
        {
          code: 'SUBMISSION_WINDOW_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: 3,
          since: at(-24 * 60),
        },
        {
          code: 'CONTACT_WINDOW_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: 1,
          sameRecipient: true,
          since: at(-24 * 60),
        },
      ],
    });

  const racing = await Promise.all(deliveries.slice(0, 4).map((d) => reserve(d.deliveryId)));
  assert.equal(racing.filter((result) => result.status === 'RESERVED').length, 1);
  assert.ok(
    racing.every(
      (result) => result.status === 'RESERVED' || result.code === 'CONTACT_WINDOW_CAP_EXCEEDED',
    ),
  );
  const winner = racing.findIndex((result) => result.status === 'RESERVED');
  const replay = await reserve(deliveries[winner]!.deliveryId);
  assert.equal(replay.status === 'RESERVED' && replay.replay, true);

  // another recipient can still reserve until hitting the combined daily cap (3)
  assert.equal((await reserve(deliveries[4]!.deliveryId, digest('r2'))).status, 'RESERVED');
  assert.equal(
    await context.control.settleCap(
      context.tenantA,
      deliveries[winner]!.deliveryId,
      'LOGICAL_DELIVERY',
      0,
      'COMMITTED',
      at(2),
    ),
    true,
  );
  assert.equal(
    await context.control.settleCap(
      context.tenantA,
      deliveries[winner]!.deliveryId,
      'LOGICAL_DELIVERY',
      0,
      'RELEASED',
      at(3),
    ),
    false,
    'once the barrier is crossed the unit cannot be returned',
  );

  await context.control.killGate(context.tenantA, gate.id, 'CAP_ACCOUNTING_INCONSISTENCY', at(4));
  assert.deepEqual(await reserve(deliveries[5]!.deliveryId, digest('r3')), {
    status: 'DENIED',
    code: 'LINE_GATE_KILLED',
  });
});

// ── Credential reference ─────────────────────────────────────────────────────

test('credential ref: keeps only a reference, v2.1 ≤ 30 days, long-lived needs an exception, and rotation is atomic', async (t) => {
  const context = await fixture(t);
  const credential = (overrides: Record<string, unknown>) => ({
    id: randomUUID(),
    tenantId: context.tenantA,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1' as const,
    version: 1,
    keychainService: 'd-contact.line.2007056595',
    keychainAccount: 'channel-access-token',
    fingerprint: digest(randomUUID()),
    issuedAt: T0,
    expiresAt: new Date(T0.getTime() + 30 * 24 * 3600_000),
    ...overrides,
  });
  await assert.rejects(
    context.control.registerCredentialRef(
      credential({ expiresAt: new Date(T0.getTime() + 31 * 24 * 3600_000) }),
    ),
    /kind_check/,
  );
  await assert.rejects(
    context.control.registerCredentialRef(
      credential({ credentialKind: 'CHANNEL_ACCESS_TOKEN_LONG_LIVED', expiresAt: undefined }),
    ),
    /kind_check/,
  );
  // a value that is not a reference name (has whitespace/secret-like symbols) cannot enter the reference column
  await assert.rejects(
    context.control.registerCredentialRef(
      credential({ keychainService: 'value with spaces/and=padding==' }),
    ),
    /values_check/,
  );

  const v1 = await context.control.registerCredentialRef(credential({}));
  const v2 = await context.control.registerCredentialRef(credential({ version: 2 }));
  assert.equal(
    (await context.control.activateCredentialRef(context.tenantA, v1.id, T0, T0))?.status,
    'ACTIVE',
  );
  const rotated = await context.control.activateCredentialRef(context.tenantA, v2.id, at(1), at(1));
  assert.equal(rotated?.status, 'ACTIVE');
  const active = await context.owner.dlLineCredentialRef.findMany({
    where: { tenantId: context.tenantA, status: 'ACTIVE' },
  });
  assert.deepEqual(
    active.map((row) => row.version),
    [2],
  );
  assert.equal(await context.control.revokeCredentialRef(context.tenantA, v1.id, at(2)), true);
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `UPDATE dl_line_credential_refs SET status = 'ACTIVE' WHERE id = '${v1.id}'`,
    ),
    /DL_LINE_CREDENTIAL_REVOKED/,
  );

  const columns = await context.owner.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'dl_line_credential_refs'`,
  );
  assert.ok(
    columns.every(
      ({ column_name }) => !/^(secret|token|value|access_token|channel_secret)$/.test(column_name),
    ),
    'there must be no column for a secret value',
  );
});

// ── Webhook inbox + Touch correlation ────────────────────────────────────────

test('webhook inbox: atomic batch, duplicate no-op, a different hash quarantines + audits, claims do not overlap', async (t) => {
  const context = await fixture(t);
  const event = (webhookEventId: string, overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    webhookEventId,
    payloadHash: digest(`payload-${webhookEventId}`),
    eventType: 'message',
    deliveryMode: 'active' as const,
    isRedelivery: false,
    providerTimestamp: T0,
    protectedPayloadRef: `prot:webhook:${randomUUID()}`,
    ...overrides,
  });
  const batch = (events: ReturnType<typeof event>[]) =>
    context.webhooks.acceptBatch({
      tenantId: context.tenantA,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      receivedAt: at(0),
      events,
    });

  assert.deepEqual(await batch([]), []);
  // the second event is bad (payload ref is a LINE user ID) → the whole request has no row at all
  await assert.rejects(
    batch([
      event('01J0ATOMICA'),
      event('01J0ATOMICB', { protectedPayloadRef: `raw:U${'a'.repeat(32)}` }),
    ]),
    /values_check/,
  );
  assert.equal(
    await context.owner.dlLineWebhookInboxEntry.count({ where: { tenantId: context.tenantA } }),
    0,
  );

  const first = await batch([
    event('01J0EVENT1'),
    event('01J0EVENT2', { eventType: 'futureType' }),
  ]);
  assert.deepEqual(
    first.map((row) => row.code),
    ['WEBHOOK_ACCEPTED', 'WEBHOOK_ACCEPTED'],
  );
  const redelivered = await batch([event('01J0EVENT1', { isRedelivery: true })]);
  assert.equal(redelivered[0]?.code, 'WEBHOOK_DUPLICATE');
  assert.equal(redelivered[0]?.inboxEntryId, first[0]?.inboxEntryId);

  const conflict = await batch([event('01J0EVENT2', { payloadHash: digest('tampered') })]);
  assert.equal(conflict[0]?.code, 'WEBHOOK_IDEMPOTENCY_CONFLICT');
  const quarantined = await context.owner.dlLineWebhookInboxEntry.findFirstOrThrow({
    where: { id: first[1]!.inboxEntryId },
  });
  assert.equal(quarantined.state, 'QUARANTINED');
  assert.equal(
    quarantined.payloadHash,
    digest('payload-01J0EVENT2'),
    'must not overwrite the original payload',
  );
  assert.equal((await context.audit.list(context.tenantA, 'WEBHOOK')).length, 1);

  await batch([event('01J0EVENT3'), event('01J0EVENT4')]);
  const [workerA, workerB] = await Promise.all([
    context.webhooks.claim(context.tenantA, 'worker-a', at(1), 60_000, 2),
    context.webhooks.claim(context.tenantA, 'worker-b', at(1), 60_000, 2),
  ]);
  const claimed = [...workerA, ...workerB].map((row) => row.id);
  assert.equal(claimed.length, new Set(claimed).size, 'two workers must not pick the same event');
  assert.equal(claimed.length, 3);

  const mine = workerA[0] ?? workerB[0]!;
  const owner = workerA[0] ? 'worker-a' : 'worker-b';
  assert.equal(await context.webhooks.complete(context.tenantA, mine.id, 'worker-z', at(2)), false);
  assert.equal(await context.webhooks.complete(context.tenantA, mine.id, owner, at(2)), true);
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `UPDATE dl_line_webhook_inbox SET state = 'PENDING', completed_at = NULL, outcome_code = NULL WHERE id = '${mine.id}'`,
    ),
    /DL_LINE_INBOX_TERMINAL/,
  );
  // lease expired = the worker died → another worker can take over after restart
  const recovered = await context.webhooks.claim(context.tenantA, 'worker-c', at(5), 60_000, 10);
  assert.equal(recovered.length, 2);
  assert.ok(recovered.every((row) => row.attempts === 2));
  await assert.rejects(
    context.asApplication(
      context.tenantA,
      `DELETE FROM dl_line_webhook_inbox WHERE id = '${mine.id}'`,
    ),
    /permission denied/,
  );
});

test('touch correlation: redelivery replay, bind once per Attempt, and cg_touches has a unique evidence ref', async (t) => {
  const context = await fixture(t);
  const delivery = await context.seedDelivery(context.tenantA);
  const attemptId = await context.seedAcceptedAttempt(delivery);
  const [inboxA, inboxB] = await context.webhooks.acceptBatch({
    tenantId: context.tenantA,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    receivedAt: at(2),
    events: ['01J0QUOTE1', '01J0QUOTE2'].map((webhookEventId) => ({
      id: randomUUID(),
      webhookEventId,
      payloadHash: digest(webhookEventId),
      eventType: 'message',
      deliveryMode: 'active' as const,
      isRedelivery: false,
      providerTimestamp: at(2),
      protectedPayloadRef: `prot:webhook:${randomUUID()}`,
    })),
  });
  const open = (inboxEntryId: string, ref: string) =>
    context.webhooks.openCorrelation({
      id: randomUUID(),
      tenantId: context.tenantA,
      inboxEntryId,
      evidenceKind: 'USER_QUOTED_RESPONSE',
      responseEvidenceRef: ref,
      quotedMessageId: '461230966842064897',
      providerTimestamp: at(2),
      windowExpiresAt: at(24 * 60),
    });

  const first = await open(inboxA!.inboxEntryId, `rsp:${PILOT_CHANNEL_ACCOUNT_ID}:01J0QUOTE1`);
  assert.equal((await open(inboxA!.inboxEntryId, first.responseEvidenceRef)).id, first.id);
  await assert.rejects(open(inboxA!.inboxEntryId, `rsp:U${'b'.repeat(32)}`), /values_check/);
  const second = await open(inboxB!.inboxEntryId, `rsp:${PILOT_CHANNEL_ACCOUNT_ID}:01J0QUOTE2`);

  const bound = await context.webhooks.bindCorrelation(
    context.tenantA,
    first.id,
    delivery.deliveryId,
    attemptId,
    at(3),
  );
  assert.equal(bound?.state, 'BOUND');
  await assert.rejects(
    context.webhooks.bindCorrelation(
      context.tenantA,
      second.id,
      delivery.deliveryId,
      attemptId,
      at(3),
    ),
    LineIdempotencyConflictError,
    'one Attempt can have a Touch only once',
  );
  assert.equal(
    await context.webhooks.quarantineCorrelation(
      context.tenantA,
      second.id,
      'USER_RESPONSE_UNBOUND',
      at(4),
    ),
    true,
  );
  assert.equal(
    await context.webhooks.bindCorrelation(
      context.tenantA,
      first.id,
      delivery.deliveryId,
      attemptId,
      at(5),
    ),
    null,
    'once BOUND it cannot be resolved again',
  );

  // Governance-owned additive columns: evidence must come as a pair and the ref can be used once per tenant
  const touch = {
    tenantId: context.tenantA,
    attemptId,
    reservationId: delivery.reservationId,
    deliveryId: delivery.deliveryId,
    outcomeRef: `ocr_touch_${randomUUID()}`,
    contactId: (await context.owner.cgAttempt.findFirstOrThrow({ where: { id: attemptId } }))
      .contactId,
    channel: 'LINE' as const,
    purpose: 'SERVICE_NOTIFICATION',
    source: 'JOURNEY',
    outcome: 'PROVIDER_ACCEPTED' as const,
    occurredAt: at(3),
    correlationId: 'corr-touch',
  };
  await assert.rejects(
    context.owner.cgTouch.create({ data: { ...touch, evidenceKind: 'USER_QUOTED_RESPONSE' } }),
    /cg_touches_response_evidence_check/,
  );
  await context.owner.cgTouch.create({
    data: {
      ...touch,
      evidenceKind: 'USER_QUOTED_RESPONSE',
      responseEvidenceRef: first.responseEvidenceRef,
    },
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

test('two-tenant: the ID/binding of another tenant is rejected generically and invisible across tenants', async (t) => {
  const context = await fixture(t);
  const deliveryA = await context.seedDelivery(context.tenantA);
  const attemptA = await context.seedAcceptedAttempt(deliveryA);
  const runA = await context.seedApprovedRun(context.tenantA);
  const runB = await context.seedApprovedRun(context.tenantB);
  const deliveryB = await context.seedDelivery(context.tenantB);

  // tenant B uses A's delivery/key
  await rejectsGenerically(
    context.attempts.record({
      id: randomUUID(),
      tenantId: context.tenantB,
      deliveryId: deliveryA.deliveryId,
      providerRequestKey: deliveryA.providerRequestKey,
      attemptNo: 1,
      providerPayloadDigest: digest('payload'),
      startedAt: at(0),
      finishedAt: at(0),
      outcomeCode: 'LINE_UNKNOWN_OUTCOME',
    }),
    deliveryA.deliveryId,
    context.tenantA,
  );
  // tenant B reserves a cap on A's gate/run
  await rejectsGenerically(
    context.control.reserveCap({
      id: randomUUID(),
      tenantId: context.tenantB,
      gateId: runA.gate.id,
      runAuthorizationId: runA.run.id,
      deliveryId: deliveryB.deliveryId,
      capKind: 'LOGICAL_DELIVERY',
      recipientFingerprint: digest('r'),
      reservedAt: at(0),
      limits: [],
    }),
    runA.gate.id,
  );
  // tenant B binds its own run to A's gate (binding swap within a row)
  await rejectsGenerically(
    context.control.reserveCap({
      id: randomUUID(),
      tenantId: context.tenantB,
      gateId: runB.gate.id,
      runAuthorizationId: runA.run.id,
      deliveryId: deliveryB.deliveryId,
      capKind: 'LOGICAL_DELIVERY',
      recipientFingerprint: digest('r'),
      reservedAt: at(0),
      limits: [],
    }),
    runA.run.id,
  );
  // tenant B consumes A's authorization / binds A's delivery
  assert.deepEqual(
    await context.control.consumeRun(context.tenantB, runA.run.id, deliveryB.deliveryId, at(1)),
    { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' },
  );
  await rejectsGenerically(
    context.control.consumeRun(context.tenantB, runB.run.id, deliveryA.deliveryId, at(1)),
    deliveryA.deliveryId,
  );
  // B's allowlist that references A's gate
  await rejectsGenerically(
    context.control.addAllowlistEntry({
      id: randomUUID(),
      ...context.scope(context.tenantB),
      gateId: runA.gate.id,
      recipientFingerprint: digest('r'),
      recipientProtectedRef: `prot:recipient:${randomUUID()}`,
      contentRef: 'fixture:service-notification/v1',
      contentDigest: digest('content-v1'),
      configDigest: digest('config-v1'),
      validFrom: T0,
      validUntil: at(60),
      approvalAuditRef: 'audit:allowlist:swap',
    }),
  );
  // B's correlation binds A's Attempt/delivery
  const [inboxB] = await context.webhooks.acceptBatch({
    tenantId: context.tenantB,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    receivedAt: at(2),
    events: [
      {
        id: randomUUID(),
        webhookEventId: '01J0SWAP01',
        payloadHash: digest('swap'),
        eventType: 'message',
        deliveryMode: 'active',
        isRedelivery: false,
        providerTimestamp: at(2),
        protectedPayloadRef: `prot:webhook:${randomUUID()}`,
      },
    ],
  });
  const correlationB = await context.webhooks.openCorrelation({
    id: randomUUID(),
    tenantId: context.tenantB,
    inboxEntryId: inboxB!.inboxEntryId,
    evidenceKind: 'USER_QUOTED_RESPONSE',
    responseEvidenceRef: `rsp:${PILOT_CHANNEL_ACCOUNT_ID}:01J0SWAP01`,
    quotedMessageId: '461230966842064897',
    providerTimestamp: at(2),
    windowExpiresAt: at(60),
  });
  await rejectsGenerically(
    context.webhooks.bindCorrelation(
      context.tenantB,
      correlationB.id,
      deliveryB.deliveryId,
      attemptA,
      at(3),
    ),
    attemptA,
  );

  // RLS: B cannot see A's rows and a cross-tenant update hits no row
  assert.equal(
    await context.lineOutbox.findByDeliveryId(context.tenantB, deliveryA.deliveryId),
    null,
  );
  assert.equal(
    await context.control.findGate(context.scope(context.tenantB)).then((g) => g?.id),
    runB.gate.id,
  );
  assert.equal(
    await context.asApplication(
      context.tenantB,
      `UPDATE dl_line_scope_gates SET technical_switch_on = true, version = version + 1 WHERE id = '${runA.gate.id}'`,
    ),
    0,
  );
  assert.equal(
    await context.control
      .killGate(context.tenantA, runA.gate.id, 'OPERATOR_KILL', at(1))
      .then((g) => g.killed),
    true,
  );
  await rejectsGenerically(
    context.control.killGate(context.tenantB, runA.gate.id, 'OPERATOR_KILL', at(1)),
  );
});

// ── Mixed-version / S1 compatibility ─────────────────────────────────────────

test('mixed-version: the TEST_ADAPTER worker neither sees nor reconciles LINE rows and does not replay a LINE actionKey', async (t) => {
  const context = await fixture(t);
  const line = await context.seedDelivery(context.tenantA);
  const legacy = await context.seedDelivery(context.tenantA, 'TEST_ADAPTER');
  await context.owner.dlOutboxEntry.updateMany({
    where: { tenantId: context.tenantA },
    data: { state: 'SUBMITTING' },
  });

  assert.equal(await context.testOutbox.findByDeliveryId(context.tenantA, line.deliveryId), null);
  assert.equal(
    (await context.lineOutbox.findByDeliveryId(context.tenantA, line.deliveryId))?.adapter,
    'LINE_MESSAGING_API',
  );
  const reconcilable = await context.testOutbox.findReconcilable(context.tenantA, at(24 * 60));
  assert.deepEqual(
    reconcilable.map((row) => row.deliveryId),
    [legacy.deliveryId],
  );
  assert.equal(
    await context.testOutbox.advance(context.tenantA, line.deliveryId, ['SUBMITTING'], {
      state: 'SETTLED',
    }),
    null,
    'the existing worker cannot advance the state of a LINE row',
  );

  // governance must not be called: a LINE actionKey must end at conflict before claim
  const governance = new Proxy({} as ContactGovernancePort, {
    get() {
      throw new Error('must not touch Governance when the actionKey belongs to another adapter');
    },
  });
  const adapter = new DeliveryTestAdapter(context.application, governance);
  const lineRow = await context.owner.dlOutboxEntry.findFirstOrThrow({
    where: { deliveryId: line.deliveryId },
  });
  const result = await adapter.enqueue({
    tenantId: tenantId(context.tenantA),
    source: 'JOURNEY',
    actionKey: actionKey(line.actionKey),
    reservationId: reservationId(line.reservationId),
    channel: 'LINE',
    contactId: contactId(lineRow.contactId),
    contentRef: 'fixture:service-notification/v1',
    correlationId: 'corr-mixed',
    purpose: 'SERVICE_NOTIFICATION',
    senderIdentityId: lineRow.senderIdentityId,
    leaseExpiresAt: at(10).toISOString(),
  });
  assert.deepEqual(result, { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' });
});

test('outbox: a LINE row must be channel LINE + a UUID key, DELIVERED is forbidden, and identity cannot be edited by any adapter', async (t) => {
  const context = await fixture(t);
  const line = await context.seedDelivery(context.tenantA);
  const legacy = await context.seedDelivery(context.tenantA, 'TEST_ADAPTER');

  await assert.rejects(
    context.owner.dlOutboxEntry.updateMany({
      where: { deliveryId: line.deliveryId },
      data: { state: 'SETTLED', outcome: 'DELIVERED', outcomeRef: `ocr_${randomUUID()}` },
    }),
    /dl_outbox_entries_line_binding_check/,
  );
  await context.owner.dlOutboxEntry.updateMany({
    where: { deliveryId: line.deliveryId },
    data: { state: 'SETTLED', outcome: 'PROVIDER_ACCEPTED', outcomeRef: `ocr_${randomUUID()}` },
  });
  for (const deliveryId of [line.deliveryId, legacy.deliveryId]) {
    await assert.rejects(
      context.owner.dlOutboxEntry.updateMany({
        where: { deliveryId },
        data: { providerRequestKey: randomUUID() },
      }),
      /DL_OUTBOX_IDENTITY_IMMUTABLE/,
    );
  }
  await assert.rejects(
    context.owner.$executeRawUnsafe(
      `INSERT INTO dl_outbox_entries (id, tenant_id, action_key, reservation_id, delivery_id, provider_request_key, adapter, channel, contact_id, purpose, source, sender_identity_id, content_ref, input_hash, lease_version, lease_expires_at, correlation_id, updated_at)
       SELECT gen_random_uuid(), tenant_id, action_key || '-k', reservation_id, delivery_id || '-k', 'pk_not_a_uuid', 'LINE_MESSAGING_API', 'LINE', contact_id, purpose, source, sender_identity_id, content_ref, input_hash, 1, now(), 'corr', now()
       FROM dl_outbox_entries WHERE delivery_id = '${legacy.deliveryId}'`,
    ),
    /dl_outbox_entries_line_binding_check/,
  );
});
