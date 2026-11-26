/**
 * A1.5b (#441) on real Postgres: edit the first admin email before the identity step succeeds
 *
 * Covers acceptance: editable before FIRST_ADMIN starts/when it conflicts, locked once it has really started or succeeded, an email that clashes with
 * another reservation gets a stable code, the old reservation is TOMBSTONED and there is no raw email in audit/evidence
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PlatformProvisioningError, type PlatformProvisioningErrorCode } from '@d-contact/shared';
import { createPlatformFixture, OPERATOR, SIP_BASE } from './platform-fixture.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import { platformIdentityHash } from './provisioning-input.js';
import { ProvisioningRecoveryService } from './provisioning-recovery.js';
import { ProvisioningRequestEditor } from './provisioning-request-editor.js';
import { ProvisioningSagaWorker, type ProvisioningStepPort } from './provisioning-saga.js';

const TAKEN = 'someone-else@example.test';

async function setup(t: TestContext) {
  const f = await createPlatformFixture();
  t.after(() => f.dispose());
  const tenants: string[] = [];
  const fakes = createFakeProvisioningPorts();
  // an existing external identity of someone else: find reports MISMATCH before creating anything (like the real FirstAdminPort)
  const firstAdmin: ProvisioningStepPort = {
    find: async (context) =>
      context.request.firstAdminEmail === TAKEN
        ? { status: 'MISMATCH', code: 'FIRST_ADMIN_EMAIL_CONFLICT' }
        : fakes.systems.FIRST_ADMIN.find(context),
    execute: (context, signal) => fakes.systems.FIRST_ADMIN.execute(context, signal),
  };
  const ports = { ...fakes.ports, FIRST_ADMIN: firstAdmin };
  const saga = new ProvisioningSagaWorker(f.platform, ports, {
    workerId: `email-${randomUUID().slice(0, 8)}`,
    sipBaseDomain: SIP_BASE,
    scope: () => ({ tenantId: { in: [...tenants] } }),
    backoffBaseMs: 1,
    backoffMaxMs: 1,
  });
  const recovery = new ProvisioningRecoveryService(f.platform, ports, { sipBaseDomain: SIP_BASE });
  const editor = new ProvisioningRequestEditor(f.platform);
  const accept = async (overrides: Parameters<typeof f.input>[0] = {}) => {
    const input = f.input(overrides);
    const key = `idem-${randomUUID()}`;
    const result = await f.repository().accept({
      idempotencyKey: key,
      input,
      plan: f.plan,
      actor: OPERATOR,
      correlationId: `corr-${key}`,
    });
    f.track(result.tenantId);
    tenants.push(result.tenantId);
    return { ...result, input };
  };
  const request = (requestId: string) =>
    f.owner.pfProvisioningRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { steps: true },
    });
  const change = async (
    requestId: string,
    email: string,
    overrides: Record<string, unknown> = {},
  ) =>
    editor.edit({
      requestId,
      expectedRevision: (await request(requestId)).revision,
      changes: { firstAdminEmail: email },
      reasonCode: 'CUSTOMER_CORRECTION',
      comment: 'customer reported a new admin email',
      actor: OPERATOR,
      correlationId: 'corr-email',
      ...overrides,
    });
  return { f, saga, recovery, editor, accept, request, change };
}

async function rejectsWith(work: Promise<unknown>, code: PlatformProvisioningErrorCode) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof PlatformProvisioningError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

const hash = (email: string) => platformIdentityHash('first-admin-email', email);

test('before FIRST_ADMIN starts: reserve the new email, tombstone the old one, revision + audit have no raw email', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const next = `new-admin-${randomUUID().slice(0, 8)}@example.test`;
  const result = await s.change(accepted.requestId, next);
  assert.deepEqual(result.changedFields, ['firstAdminEmail']);

  const after = await s.request(accepted.requestId);
  assert.deepEqual([after.firstAdminEmail, after.firstAdminEmailHash], [next, hash(next)]);
  // the original idempotency payload does not change
  assert.notEqual(after.payloadDigest, result.payloadDigest);
  const reservations = await s.f.owner.pfIdentityReservation.findMany({
    where: { requestId: accepted.requestId, kind: 'FIRST_ADMIN_EMAIL' },
  });
  assert.deepEqual(
    reservations.map((row) => [row.valueKey, row.state]).sort(),
    [
      [hash(accepted.input.firstAdmin.email), 'TOMBSTONED'],
      [hash(next), 'HELD'],
    ].sort(),
  );
  const [revision] = await s.f.owner.pfFirstAdminEmailRevision.findMany({
    where: { requestId: accepted.requestId },
  });
  assert.deepEqual(
    [revision!.previousEmailHash, revision!.emailHash, revision!.requestRevision],
    [hash(accepted.input.firstAdmin.email), hash(next), after.revision],
  );
  const evidence = JSON.stringify([
    revision,
    await s.f.owner.pfActionHistory.findMany({ where: { requestId: accepted.requestId } }),
  ]);
  assert.equal(evidence.includes(next), false);
  assert.equal(evidence.includes(accepted.input.firstAdmin.email), false);

  // the old email is still held for 30 days: a new request cannot use it
  await rejectsWith(
    s.accept({ firstAdmin: { email: accepted.input.firstAdmin.email, displayName: 'X' } }),
    'FIRST_ADMIN_EMAIL_CONFLICT',
  );
  await s.saga.drain();
  assert.equal((await s.request(accepted.requestId)).status, 'SUCCEEDED');
});

test('an email held by another request = FIRST_ADMIN_EMAIL_CONFLICT (audit) and nothing changes', async (t) => {
  const s = await setup(t);
  const owner = await s.accept();
  const accepted = await s.accept();
  const before = await s.request(accepted.requestId);
  await rejectsWith(
    s.change(accepted.requestId, owner.input.firstAdmin.email),
    'FIRST_ADMIN_EMAIL_CONFLICT',
  );
  const after = await s.request(accepted.requestId);
  assert.deepEqual(
    [after.revision, after.firstAdminEmailHash],
    [before.revision, before.firstAdminEmailHash],
  );
  assert.equal(
    await s.f.owner.pfIdentityReservation.count({
      where: { requestId: accepted.requestId, state: 'TOMBSTONED' },
    }),
    0,
  );
  const rejected = await s.f.owner.pfActionHistory.findFirstOrThrow({
    where: { requestId: accepted.requestId, action: 'REQUEST_EDITED', outcome: 'REJECTED' },
  });
  assert.equal(rejected.errorCode, 'FIRST_ADMIN_EMAIL_CONFLICT');
});

test('clash with an external identity: ACTION_REQUIRED → edit the email → Retry through preview then finish', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept({ firstAdmin: { email: TAKEN, displayName: 'Taken' } });
  await s.saga.drain();
  const stuck = await s.request(accepted.requestId);
  assert.deepEqual(
    [stuck.status, stuck.failureCode],
    ['ACTION_REQUIRED', 'FIRST_ADMIN_EMAIL_CONFLICT'],
  );
  await s.change(accepted.requestId, `fixed-${randomUUID().slice(0, 8)}@example.test`);

  const preview = await s.recovery.preview({ requestId: accepted.requestId, action: 'RETRY_STEP' });
  assert.deepEqual([preview.allowed, preview.finding], [true, 'NOT_FOUND']);
  await s.recovery.execute({
    requestId: accepted.requestId,
    action: 'RETRY_STEP',
    expectedRevision: preview.revision,
    previewDigest: preview.previewDigest,
    reasonCode: 'OPERATOR_VERIFIED',
    comment: 'email corrected',
    actor: OPERATOR,
    correlationId: 'corr-retry',
  });
  await s.saga.drain();
  assert.equal((await s.request(accepted.requestId)).status, 'SUCCEEDED');
});

test('lock: after FIRST_ADMIN has really started or succeeded, editing with other fields, the old email and the DB guard', async (t) => {
  const s = await setup(t);
  const done = await s.accept();
  await s.saga.drain();
  // a finished request = state not allowed; check the step lock with a request whose FIRST_ADMIN succeeded but is not finished yet
  await rejectsWith(s.change(done.requestId, 'late@example.test'), 'INVALID_STATE_TRANSITION');

  const accepted = await s.accept();
  const request = await s.request(accepted.requestId);
  await rejectsWith(
    s.editor.edit({
      requestId: accepted.requestId,
      expectedRevision: request.revision,
      changes: { firstAdminEmail: 'x@example.test', displayName: 'Other' },
      reasonCode: 'CUSTOMER_CORRECTION',
      comment: 'edit several fields',
      actor: OPERATOR,
      correlationId: 'corr-multi',
    }),
    'VALIDATION_FAILED',
  );
  await rejectsWith(
    s.change(accepted.requestId, accepted.input.firstAdmin.email),
    'VALIDATION_FAILED',
  );

  // FIRST_ADMIN has started before (attempt > 0) and stopped for another reason = an external identity may already exist → lock
  await s.f.owner.pfProvisioningStep.update({
    where: { requestId_stepKey: { requestId: accepted.requestId, stepKey: 'FIRST_ADMIN' } },
    data: {
      state: 'ACTION_REQUIRED',
      attempt: 1,
      errorCode: 'DEPENDENCY_REJECTED',
      revision: { increment: 1 },
    },
  });
  await rejectsWith(s.change(accepted.requestId, 'another@example.test'), 'FIELD_LOCKED');

  // the guard in the DB enforces it again even when called directly with the platform role
  await assert.rejects(
    s.f.platform.pfProvisioningRequest.update({
      where: { id: accepted.requestId },
      data: { firstAdminEmailHash: hash('bypass@example.test'), revision: { increment: 1 } },
    }),
    /PF_FIRST_ADMIN_EMAIL_LOCKED/,
  );
  const fresh = await s.accept();
  await assert.rejects(
    s.f.platform.pfProvisioningRequest.update({
      where: { id: fresh.requestId },
      data: { firstAdminEmailHash: hash('unreserved@example.test'), revision: { increment: 1 } },
    }),
    /PF_FIRST_ADMIN_EMAIL_UNRESERVED/,
  );
});
