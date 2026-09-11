/**
 * S1.6 acceptance: S1-LINE-SIM01/02 บน `LineDeliveryPort` — deterministic lifecycle,
 * binding, caps, tenant isolation และ kill ดูสัญญาที่ #102 §2-§6
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runDeliveryPortConformanceSuite,
  type DeliveryConformanceHarness,
} from '@d-contact/cxa-contracts/testing/delivery-conformance.js';
import { actionKey, reservationId, tenantId, type DeliveryId } from '@d-contact/cxa-contracts';
import { LineCapExceededError } from './line-caps-tracker.js';
import { LineSimulationHarness } from './line-simulation-harness.js';
import { GUARD_TENANT_ID, PILOT_TENANT_ID, PILOT_SCOPE } from './line-simulation-fixture.js';

// --- conformance: generic DeliveryPort.enqueue semantics (reuses #67 suite) --------------

runDeliveryPortConformanceSuite('LineDeliveryPort', () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const guardHarness = harness; // reuse; only otherTenantId lookups touch guard tenant's absence
  const conformance: DeliveryConformanceHarness = {
    delivery: harness.port,
    command,
    unknownReservationId: reservationId('line-reservation-missing'),
    mismatchedActionKey: actionKey(`${command.actionKey}-mismatch`),
    otherTenantId: tenantId(GUARD_TENANT_ID),
    advance: (ms: number) => harness.clock.advanceBy(ms),
  };
  void guardHarness;
  return conformance;
});

// --- S1-LINE-SIM01: deterministic lifecycle -----------------------------------------------

test('DISABLED gate refuses enqueue without ever touching governance', async () => {
  const harness = new LineSimulationHarness();
  const command = harness.seedAndBuildCommand();
  const result = await harness.port.enqueue(command);
  assert.deepEqual(result, { status: 'ERROR', code: 'RESERVATION_NOT_FOUND' });
});

test('DRY_RUN proves authorize/reserve/bind then releases with WOULD_SUBMIT, never crossing the barrier', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('DRY_RUN');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  assert.equal(queued.status, 'QUEUED');
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };

  harness.port.claim(command.tenantId, id);
  const submitted = await harness.port.submit(command.tenantId, id, 'corr-1');
  assert.equal(submitted.status, 'WOULD_SUBMIT');
  assert.equal(submitted.evidence.state, 'RELEASED');
  assert.equal(submitted.evidence.dryRun, true);
});

test('SIMULATED_CAPPED_PILOT: full accept -> delivered -> settled lifecycle', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };

  harness.port.claim(command.tenantId, id);
  const submitted = await harness.port.submit(command.tenantId, id, 'corr-1');
  assert.equal(submitted.status, 'AWAITING_CALLBACK');
  assert.equal(submitted.evidence.state, 'SUBMISSION_INTENT_RECORDED');

  const accepted = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'ACCEPTED',
    'ocr-1',
    'corr-1',
  );
  assert.equal(accepted.state, 'ACCEPTED');

  const settled = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'DELIVERED',
    'ocr-2',
    'corr-1',
  );
  assert.equal(settled.state, 'SETTLED');
  assert.equal(settled.outcome, 'DELIVERED');
});

test('provider rejection settles directly without a delivered/failed second callback', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-1');

  const rejected = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'PROVIDER_REJECTED',
    'ocr-reject',
    'corr-1',
  );
  assert.equal(rejected.state, 'SETTLED');
  assert.equal(rejected.outcome, 'PROVIDER_REJECTED');
});

test('timeout before acceptance goes to UNKNOWN_RECONCILING then can only reconcile as PROVIDER_REJECTED', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-1');

  const reconciling = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'TIMEOUT',
    'ocr-timeout',
    'corr-1',
  );
  assert.equal(reconciling.state, 'UNKNOWN_RECONCILING');

  await assert.rejects(
    () =>
      harness.port.deliverCallback(command.tenantId, id, 'DELIVERY_FAILED', 'ocr-wrong', 'corr-1'),
    (error: unknown) => (error as { code?: string }).code === 'LINE_INVALID_TRANSITION',
  );

  const settled = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'PROVIDER_REJECTED',
    'ocr-reconciled',
    'corr-1',
  );
  assert.equal(settled.state, 'SETTLED');
  assert.equal(settled.outcome, 'PROVIDER_REJECTED');
});

test('timeout after acceptance goes to UNKNOWN_RECONCILING then reconciles as DELIVERED or DELIVERY_FAILED', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-1');
  await harness.port.deliverCallback(command.tenantId, id, 'ACCEPTED', 'ocr-accept', 'corr-1');

  const reconciling = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'UNKNOWN_RECONCILING',
    'ocr-status-timeout',
    'corr-1',
  );
  assert.equal(reconciling.state, 'UNKNOWN_RECONCILING');

  const settled = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'DELIVERY_FAILED',
    'ocr-reconciled',
    'corr-1',
  );
  assert.equal(settled.state, 'SETTLED');
  assert.equal(settled.outcome, 'DELIVERY_FAILED');
});

test('duplicate outcomeRef with the same payload is a no-op replay', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-1');

  const first = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'PROVIDER_REJECTED',
    'ocr-dup',
    'corr-1',
  );
  const second = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'PROVIDER_REJECTED',
    'ocr-dup',
    'corr-1',
  );
  assert.deepEqual(second, first);
});

test('conflicting payload under the same outcomeRef is rejected as IDEMPOTENCY_CONFLICT', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-1');

  await harness.port.deliverCallback(
    command.tenantId,
    id,
    'PROVIDER_REJECTED',
    'ocr-conflict',
    'corr-1',
  );
  await assert.rejects(
    () => harness.port.deliverCallback(command.tenantId, id, 'ACCEPTED', 'ocr-conflict', 'corr-1'),
    (error: unknown) => (error as { code?: string }).code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('out-of-order callbacks scheduled later-first are still applied by virtual timestamp order', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-1');

  const startMs = harness.clock.nowMs();
  harness.port.scheduleCallback(command.tenantId, id, 'ACCEPTED', startMs + 2_000, 'later');
  const first = await harness.port.runNext('corr-1');
  assert.equal(first, undefined, 'ยังไม่ถึงเวลา due ตาม virtual clock');

  harness.clock.advanceTo(startMs + 5_000);
  const applied = await harness.port.runNext('corr-1');
  assert.equal(applied?.state, 'ACCEPTED');
});

test('terminal outcome wins over a late duplicate callback that arrives afterward', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-1');

  const settled = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'PROVIDER_REJECTED',
    'ocr-final',
    'corr-1',
  );
  const late = await harness.port.deliverCallback(
    command.tenantId,
    id,
    'ACCEPTED',
    'ocr-late',
    'corr-1',
  );
  assert.deepEqual(late, settled);
});

test('cancel before the barrier releases the reservation', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);

  const cancelled = await harness.port.cancel(command.tenantId, id, 'corr-1');
  assert.equal(cancelled.state, 'CANCELLED');
});

test('cancel after the barrier reconciles instead of releasing or resending', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-1');

  const reconciling = await harness.port.cancel(command.tenantId, id, 'corr-1');
  assert.equal(reconciling.state, 'UNKNOWN_RECONCILING');
});

test('restart on the same shared store replays to the identical state and evidence', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-1');
  const before = harness.port.evidenceFor(command.tenantId, id);

  const restarted = harness.restartPort();
  const after = restarted.evidenceFor(command.tenantId, id);
  assert.deepEqual(after, before);

  const settled = await restarted.deliverCallback(
    command.tenantId,
    id,
    'PROVIDER_REJECTED',
    'ocr-restart',
    'corr-1',
  );
  assert.equal(settled.state, 'SETTLED');
});

// --- S1-LINE-SIM02: concurrency/tenant, caps, guard tenant, binding swap, kill ------------

test('guard tenant reusing the pilot reservationId fails closed without leaking existence', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const guardAttempt = await harness.port.enqueue({
    ...command,
    tenantId: tenantId(GUARD_TENANT_ID),
  });
  assert.deepEqual(guardAttempt, { status: 'ERROR', code: 'RESERVATION_NOT_FOUND' });

  const pilotAttempt = await harness.port.enqueue(command);
  assert.equal(pilotAttempt.status, 'QUEUED');
});

test('a sender identity outside the frozen pilot tuple fails closed even with an otherwise valid reservation', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand({ senderIdentityId: 'line-sender-unapproved' });
  const result = await harness.port.enqueue(command);
  assert.deepEqual(result, { status: 'ERROR', code: 'RESERVATION_NOT_FOUND' });
});

test('per-window submission cap blocks the 21st submission in the same window', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');

  for (let i = 0; i < 20; i += 1) {
    const command = harness.seedAndBuildCommand({ contactId: `line-contact-cap-${i}` });
    const queued = await harness.port.enqueue(command);
    const { deliveryId: id } = queued as { deliveryId: DeliveryId };
    harness.port.claim(command.tenantId, id);
    const submitted = await harness.port.submit(command.tenantId, id, 'corr-cap');
    assert.equal(submitted.status, 'AWAITING_CALLBACK', `submission ${i} ควรผ่าน cap`);
    await harness.port.deliverCallback(
      command.tenantId,
      id,
      'PROVIDER_REJECTED',
      `ocr-cap-${i}`,
      'corr-cap',
    );
  }

  const overCommand = harness.seedAndBuildCommand({ contactId: 'line-contact-cap-over' });
  const queued = await harness.port.enqueue(overCommand);
  const { deliveryId: overId } = queued as { deliveryId: DeliveryId };
  harness.port.claim(overCommand.tenantId, overId);
  const blocked = await harness.port.submit(overCommand.tenantId, overId, 'corr-cap');
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.code, 'SUBMISSION_WINDOW_CAP_EXCEEDED');
});

test('concurrent submission cap blocks a third simultaneous in-flight submission', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');

  const a = harness.seedAndBuildCommand({ contactId: 'line-contact-concurrent-a' });
  const b = harness.seedAndBuildCommand({ contactId: 'line-contact-concurrent-b' });
  const c = harness.seedAndBuildCommand({ contactId: 'line-contact-concurrent-c' });

  for (const command of [a, b]) {
    const queued = await harness.port.enqueue(command);
    const { deliveryId: id } = queued as { deliveryId: DeliveryId };
    harness.port.claim(command.tenantId, id);
    const submitted = await harness.port.submit(command.tenantId, id, 'corr-concurrent');
    assert.equal(submitted.status, 'AWAITING_CALLBACK');
  }

  const queuedC = await harness.port.enqueue(c);
  const { deliveryId: idC } = queuedC as { deliveryId: DeliveryId };
  harness.port.claim(c.tenantId, idC);
  const blocked = await harness.port.submit(c.tenantId, idC, 'corr-concurrent');
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.code, 'CONCURRENT_SUBMISSION_CAP_EXCEEDED');
});

test('per-contact window cap blocks a second submission to the same contact in the window', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const contactId = 'line-contact-repeat';

  const first = harness.seedAndBuildCommand({ contactId });
  const firstQueued = await harness.port.enqueue(first);
  const { deliveryId: firstId } = firstQueued as { deliveryId: DeliveryId };
  harness.port.claim(first.tenantId, firstId);
  const firstSubmit = await harness.port.submit(first.tenantId, firstId, 'corr-repeat');
  assert.equal(firstSubmit.status, 'AWAITING_CALLBACK');
  await harness.port.deliverCallback(
    first.tenantId,
    firstId,
    'PROVIDER_REJECTED',
    'ocr-repeat-1',
    'corr-repeat',
  );

  const second = harness.seedAndBuildCommand({ contactId });
  const secondQueued = await harness.port.enqueue(second);
  const { deliveryId: secondId } = secondQueued as { deliveryId: DeliveryId };
  harness.port.claim(second.tenantId, secondId);
  const secondSubmit = await harness.port.submit(second.tenantId, secondId, 'corr-repeat');
  assert.equal(secondSubmit.status, 'BLOCKED');
  assert.equal(secondSubmit.code, 'CONTACT_WINDOW_CAP_EXCEEDED');
});

test('unknown-reconciling stuck past the virtual timeout system-kills the scope', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-timeout');
  await harness.port.deliverCallback(command.tenantId, id, 'TIMEOUT', 'ocr-stuck', 'corr-timeout');

  harness.clock.advanceBy(31_000);
  const timedOut = harness.port.checkUnknownReconcilingTimeouts(PILOT_SCOPE);
  assert.deepEqual(timedOut, [id]);
  assert.equal(harness.gate.currentState(PILOT_SCOPE), 'KILLED');
});

test('kill blocks new submissions and forces in-flight pre-barrier work to cancel', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);

  harness.gate.kill(PILOT_SCOPE, 'COMPLIANCE', 'PII_LEAK');

  const blockedSubmit = await harness.port.submit(command.tenantId, id, 'corr-kill');
  assert.equal(blockedSubmit.status, 'BLOCKED');
  assert.equal(blockedSubmit.code, 'KILLED');
  assert.equal(blockedSubmit.evidence.state, 'CANCELLED');

  const next = harness.seedAndBuildCommand();
  const refused = await harness.port.enqueue(next);
  assert.deepEqual(refused, { status: 'ERROR', code: 'RESERVATION_NOT_FOUND' });
});

test('CG3 mutation to BLOCK cancels a pre-barrier delivery and never resurrects it on a later loosening replay', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);

  harness.cg3.mutate(command.tenantId, command.identityId, {
    preferences: [
      {
        version: 2,
        identityId: command.identityId ?? null,
        channel: 'LINE',
        purpose: null,
        contactKind: null,
        decision: 'BLOCK',
        timezone: null,
        preferredWindows: [],
      },
    ],
  });

  const cancelled = await harness.port.applyCg3Mutation(
    command.tenantId,
    id,
    'corr-cg3',
    harness.cg3,
  );
  assert.equal(cancelled.state, 'CANCELLED');

  harness.cg3.mutate(command.tenantId, command.identityId, { preferences: [] });
  const replay = await harness.port.applyCg3Mutation(command.tenantId, id, 'corr-cg3', harness.cg3);
  assert.equal(replay.state, 'CANCELLED', 'ผ่อนกฎแล้ว replay ห้าม resurrect งานที่ cancel ไปแล้ว');
});

test('CG3 mutation to BLOCK after the barrier reconciles instead of releasing', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  const command = harness.seedAndBuildCommand();
  const queued = await harness.port.enqueue(command);
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  harness.port.claim(command.tenantId, id);
  await harness.port.submit(command.tenantId, id, 'corr-cg3-post');

  harness.cg3.mutate(command.tenantId, command.identityId, {
    preferences: [
      {
        version: 2,
        identityId: command.identityId ?? null,
        channel: 'LINE',
        purpose: null,
        contactKind: null,
        decision: 'BLOCK',
        timezone: null,
        preferredWindows: [],
      },
    ],
  });

  const reconciling = await harness.port.applyCg3Mutation(
    command.tenantId,
    id,
    'corr-cg3-post',
    harness.cg3,
  );
  assert.equal(reconciling.state, 'UNKNOWN_RECONCILING');
});

// --- maker-checker authority --------------------------------------------------------------

test('only Tenant Admin can propose and only Compliance can approve the rollout gate', () => {
  const harness = new LineSimulationHarness();
  assert.throws(
    () => harness.gate.propose(PILOT_SCOPE, 'COMPLIANCE', 'DRY_RUN'),
    (error: unknown) => (error as { code?: string }).code === 'LINE_GATE_AUTHORIZATION_DENIED',
  );
  harness.gate.propose(PILOT_SCOPE, 'TENANT_ADMIN', 'DRY_RUN');
  assert.throws(
    () => harness.gate.approve(PILOT_SCOPE, 'TENANT_ADMIN'),
    (error: unknown) => (error as { code?: string }).code === 'LINE_GATE_AUTHORIZATION_DENIED',
  );
});

test('gate stages must advance one step at a time', () => {
  const harness = new LineSimulationHarness();
  assert.throws(
    () => harness.gate.propose(PILOT_SCOPE, 'TENANT_ADMIN', 'SIMULATED_CAPPED_PILOT'),
    (error: unknown) => (error as { code?: string }).code === 'LINE_GATE_INVALID_TRANSITION',
  );
});

test('technical switch off forces DISABLED even after business gate reached SIMULATED_CAPPED_PILOT', async () => {
  const harness = new LineSimulationHarness();
  harness.openPilotTo('SIMULATED_CAPPED_PILOT');
  harness.gate.setTechnicalSwitch(PILOT_SCOPE, 'PLATFORM_OPERATOR', false);
  const command = harness.seedAndBuildCommand();
  const result = await harness.port.enqueue(command);
  assert.deepEqual(result, { status: 'ERROR', code: 'RESERVATION_NOT_FOUND' });
});

test('a non-pilot scope can never be proposed, approved, or opened', () => {
  const harness = new LineSimulationHarness();
  const otherScope = {
    tenantId: PILOT_TENANT_ID,
    channel: 'LINE' as const,
    senderIdentityId: 'other-sender',
  };
  assert.throws(
    () => harness.gate.propose(otherScope, 'TENANT_ADMIN', 'DRY_RUN'),
    (error: unknown) => (error as { code?: string }).code === 'LINE_GATE_SCOPE_NOT_ALLOWED',
  );
});

test('LineCapExceededError carries a stable machine-readable code', () => {
  const error = new LineCapExceededError('CONCURRENT_SUBMISSION_CAP_EXCEEDED');
  assert.equal(error.code, 'CONCURRENT_SUBMISSION_CAP_EXCEEDED');
});
