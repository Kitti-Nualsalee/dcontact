import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryFixture, RESERVED_AT } from './delivery-fixture.js';
import {
  evaluateVoiceAlerts,
  killStuckVoiceScopes,
  voiceObservabilitySnapshot,
} from './voice-observability.js';
import { VoiceOriginateDeliveryService } from './voice-originate-delivery.js';
import { VoiceRolloutControlPlane } from './voice-rollout-control.js';

test('voice observability แจ้ง stuck settlement และ watchdog kill scope โดยไม่ settle/resend', async (t) => {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const at = new Date(RESERVED_AT);
  const rollout = new VoiceRolloutControlPlane(context.application);
  const scope = { tenantId: context.rawTenantId, telephonyNodeId: 'fs-local' };
  await rollout.ensureScope(scope);
  await rollout.advanceState(scope, 'DRY_RUN', 'operator-1', at);
  await rollout.advanceState(scope, 'SANDBOX', 'operator-1', at);
  await rollout.setTechnicalSwitch(scope, true, 'operator-1', at);
  await rollout.allow({
    ...scope,
    agentUserId: context.agent.userId,
    targetIdentityId: context.rawPhoneIdentityId,
    validFrom: at,
    validUntil: new Date(at.getTime() + 600_000),
    actorRef: 'operator-1',
  });
  const reservation = await context.createVoiceReservation('observability');
  let publishCount = 0;
  const service = new VoiceOriginateDeliveryService(
    context.application,
    context.governance,
    { publish: async () => void (publishCount += 1) },
    { enabled: true, now: () => at, rollout },
  );
  assert.deepEqual(
    await service.enqueue({
      tenantId: context.rawTenantId,
      userId: context.agent.userId,
      leaseId: context.agent.leaseId,
      actionKey: reservation.rawActionKey,
      reservationId: reservation.rawId,
      contactId: context.command.contactId,
      identityId: context.rawPhoneIdentityId,
      correlationId: 'observability',
    }),
    { status: 'QUEUED' },
  );
  const stale = new Date(at.getTime() - 180_000);
  await context.owner.dlOutboxEntry.updateMany({
    where: { tenantId: context.rawTenantId, actionKey: reservation.rawActionKey },
    data: { updatedAt: stale, submittedAt: stale },
  });
  const snapshot = await voiceObservabilitySnapshot(context.application, {
    tenantId: context.rawTenantId,
    now: at,
  });
  assert.equal(snapshot.settlement.inFlight, 1);
  assert.ok(evaluateVoiceAlerts(snapshot).some((alert) => alert.code === 'VOICE_SETTLEMENT_STUCK'));
  assert.deepEqual(
    await killStuckVoiceScopes(context.application, { tenantId: context.rawTenantId, now: at }),
    ['fs-local'],
  );
  assert.equal(publishCount, 1);
  assert.equal(
    (await context.owner.dlVoiceScopeGate.findFirstOrThrow({ where: scope })).killed,
    true,
  );
  assert.equal(
    (await context.reservationRow(reservation.rawId))?.settlementStatus,
    'UNKNOWN_RECONCILING',
  );
});
