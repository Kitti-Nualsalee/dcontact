import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryFixture, RESERVED_AT } from './delivery-fixture.js';
import { VoiceOriginateEnqueuer } from './voice-originate-enqueue.js';
import { VoiceRolloutControlPlane } from './voice-rollout-control.js';

test('voice rollout: progression + allowlist + race-safe cap + kill เป็น durable authority', async (t) => {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const at = new Date(RESERVED_AT);
  const control = new VoiceRolloutControlPlane(context.application);
  const scope = { tenantId: context.rawTenantId, telephonyNodeId: 'fs-local' };
  assert.equal((await control.ensureScope(scope)).businessState, 'DISABLED');
  await control.advanceState(scope, 'DRY_RUN', 'operator-1', at);
  await control.advanceState(scope, 'SANDBOX', 'operator-1', at);
  await control.setTechnicalSwitch(scope, true, 'operator-1', at);
  await control.configureCaps(
    scope,
    { tenantPerMinute: 2, tenantPerDay: 20, agentPerMinute: 1, agentPerDay: 10 },
    'operator-1',
    at,
  );
  await control.allow({
    ...scope,
    agentUserId: context.agent.userId,
    targetIdentityId: context.rawPhoneIdentityId,
    validFrom: at,
    validUntil: new Date(at.getTime() + 60_000),
    actorRef: 'operator-1',
  });
  const enqueuer = new VoiceOriginateEnqueuer(context.application, context.governance, {
    enabled: true,
    now: () => at,
    rollout: control,
  });
  const deliveries: string[] = [];
  for (const label of ['cap-a', 'cap-b']) {
    const reservation = await context.createVoiceReservation(label);
    await enqueuer.enqueue({
      tenantId: context.rawTenantId,
      userId: context.agent.userId,
      leaseId: context.agent.leaseId,
      actionKey: reservation.rawActionKey,
      reservationId: reservation.rawId,
      contactId: context.command.contactId,
      identityId: context.rawPhoneIdentityId,
      correlationId: `corr-${label}`,
    });
    deliveries.push(
      (
        await context.owner.dlOutboxEntry.findFirstOrThrow({
          where: { tenantId: context.rawTenantId, actionKey: reservation.rawActionKey },
        })
      ).deliveryId,
    );
  }

  const authorization = (deliveryId: string) =>
    control.authorize({
      ...scope,
      deliveryId,
      agentUserId: context.agent.userId,
      targetIdentityId: context.rawPhoneIdentityId,
      at,
    });

  const concurrent = await Promise.all(deliveries.map(authorization));
  assert.equal(concurrent.filter((result) => result.status === 'ALLOWED').length, 1);
  assert.equal(
    concurrent.filter(
      (result) => result.status === 'DENIED' && result.reasonCode === 'VOICE_RATE_CAP_EXCEEDED',
    ).length,
    1,
  );
  const winner = deliveries[concurrent.findIndex((result) => result.status === 'ALLOWED')]!;
  assert.deepEqual(await authorization(winner), {
    status: 'ALLOWED',
    state: 'SANDBOX',
    replay: true,
  });
  await control.kill(scope, 'operator-1', at);
  assert.deepEqual(await authorization(winner), {
    status: 'DENIED',
    reasonCode: 'VOICE_SCOPE_KILLED',
  });
  await assert.rejects(
    () => control.setTechnicalSwitch(scope, true, 'operator-1', at),
    /VOICE_ROLLOUT_KILLED/,
  );
  assert.equal(
    await context.owner.dlVoiceAuditEvent.count({ where: { tenantId: context.rawTenantId } }),
    7,
  );
});

test('voice rollout DRY_RUN บันทึก evidence แต่ไม่อนุญาตให้ claim/provider traffic', async (t) => {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const at = new Date(RESERVED_AT);
  const control = new VoiceRolloutControlPlane(context.application);
  const scope = { tenantId: context.rawTenantId, telephonyNodeId: 'fs-local' };
  await control.ensureScope(scope);
  await control.advanceState(scope, 'DRY_RUN', 'operator-1', at);
  await control.setTechnicalSwitch(scope, true, 'operator-1', at);
  await control.allow({
    ...scope,
    agentUserId: context.agent.userId,
    targetIdentityId: context.rawPhoneIdentityId,
    validFrom: at,
    validUntil: new Date(at.getTime() + 60_000),
    actorRef: 'operator-1',
  });
  const reservation = await context.createVoiceReservation('dry-run');
  const enqueuer = new VoiceOriginateEnqueuer(context.application, context.governance, {
    enabled: true,
    now: () => at,
    rollout: control,
  });
  assert.deepEqual(
    await enqueuer.enqueue({
      tenantId: context.rawTenantId,
      userId: context.agent.userId,
      leaseId: context.agent.leaseId,
      actionKey: reservation.rawActionKey,
      reservationId: reservation.rawId,
      contactId: context.command.contactId,
      identityId: context.rawPhoneIdentityId,
      correlationId: 'dry-run',
    }),
    { status: 'UNAVAILABLE', reasonCode: 'VOICE_DRY_RUN' },
  );
  assert.equal(
    await context.owner.dlOutboxEntry.count({ where: { tenantId: context.rawTenantId } }),
    0,
  );
  assert.equal(
    await context.owner.dlVoiceAuditEvent.count({
      where: { tenantId: context.rawTenantId, code: 'VOICE_DRY_RUN_EVALUATED' },
    }),
    1,
  );
});
