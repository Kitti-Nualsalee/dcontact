import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionKey,
  contactId,
  identityId,
  outcomeRef,
  reservationId,
  tenantId,
  type AuthorizeAndReserveInput,
  type ContactGovernancePort,
  type DeliveryId,
  type ProviderRequestKey,
} from './index.js';
import type { EnqueueDeliveryCommand } from './delivery.js';
import { ContactGovernanceFake } from './testing/contact-governance-fake.js';
import { DeliveryTestAdapter } from './testing/delivery-fake.js';
import {
  runDeliveryPortConformanceSuite,
  type DeliveryConformanceHarness,
} from './testing/delivery-conformance.js';

function setup(): DeliveryConformanceHarness & {
  governance: ContactGovernancePort;
  command: EnqueueDeliveryCommand;
} {
  let now = Date.parse('2026-09-09T00:00:00Z');
  const fake = new ContactGovernanceFake(() => now);
  const tenant = tenantId('tenant-a');
  const authorization: AuthorizeAndReserveInput = {
    actionKey: actionKey('action-a'),
    channel: 'EMAIL',
    purpose: 'SERVICE',
    source: 'JOURNEY',
    sourceId: 'journey-a',
    contactId: contactId('contact-a'),
    identityId: identityId('identity-a'),
    policyVersion: 1,
  };
  fake.seed(tenant, authorization, {
    decision: 'ALLOW',
    decisionId: 'decision-a',
    reasonCode: 'POLICY_PASSED',
    policyVersion: 1,
    trace: [],
    reservationId: 'reservation-a',
    reservationExpiresAt: '2026-09-09T00:15:00Z',
  });
  const delivery = new DeliveryTestAdapter(fake);
  const command: EnqueueDeliveryCommand = {
    tenantId: tenant,
    source: 'JOURNEY',
    actionKey: actionKey('action-a'),
    reservationId: reservationId('reservation-a'),
    channel: 'EMAIL',
    contactId: contactId('contact-a'),
    identityId: identityId('identity-a'),
    contentRef: 'template-a',
    correlationId: 'trace-a',
    purpose: 'SERVICE',
    senderIdentityId: 'sender-a',
    leaseExpiresAt: '2026-09-09T00:05:00Z',
  };
  return {
    delivery,
    governance: fake,
    command,
    unknownReservationId: reservationId('reservation-missing'),
    mismatchedActionKey: actionKey('action-b'),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

runDeliveryPortConformanceSuite('DeliveryTestAdapter', setup);

function bindingOf(command: EnqueueDeliveryCommand, deliveryId: DeliveryId) {
  return {
    tenantId: command.tenantId,
    correlationId: command.correlationId,
    reservationId: command.reservationId,
    actionKey: command.actionKey,
    deliveryId,
  };
}

test('cancel before submit releases the reservation via governance using the minted deliveryId', async () => {
  const { delivery, governance, command } = setup();
  const queued = await delivery.enqueue(command);
  assert.equal(queued.status, 'QUEUED');
  const { deliveryId: id } = queued as { deliveryId: DeliveryId };
  const release = await governance.releaseBeforeSubmit({
    ...bindingOf(command, id),
    reason: 'CANCELLED_BEFORE_SUBMIT',
  });
  assert.equal(release.state, 'RELEASED');
});

test('timeout after submit settles UNKNOWN_RECONCILING on the minted providerRequestKey without losing the binding', async () => {
  const { delivery, governance, command } = setup();
  const queued = await delivery.enqueue(command);
  const { deliveryId: id, providerRequestKey: key } = queued as {
    deliveryId: DeliveryId;
    providerRequestKey: ProviderRequestKey;
  };
  const binding = bindingOf(command, id);
  await governance.beginProviderSubmission({
    ...binding,
    expectedLeaseVersion: 1,
    providerRequestKey: key,
  });
  const uncertain = await governance.settleDelivery({
    ...binding,
    providerRequestKey: key,
    outcomeRef: outcomeRef('outcome-timeout'),
    outcome: 'UNKNOWN_RECONCILING',
    occurredAt: '2026-09-09T00:01:00Z',
  });
  assert.equal(uncertain.status, 'UNKNOWN_RECONCILING');
  assert.equal(uncertain.deliveryId, id);
});

test('out-of-order outcome after a terminal settlement does not regress state, threaded through delivery-minted IDs', async () => {
  const { delivery, governance, command } = setup();
  const queued = await delivery.enqueue(command);
  const { deliveryId: id, providerRequestKey: key } = queued as {
    deliveryId: DeliveryId;
    providerRequestKey: ProviderRequestKey;
  };
  const binding = bindingOf(command, id);
  await governance.beginProviderSubmission({
    ...binding,
    expectedLeaseVersion: 1,
    providerRequestKey: key,
  });
  const delivered = await governance.settleDelivery({
    ...binding,
    providerRequestKey: key,
    outcomeRef: outcomeRef('outcome-final'),
    outcome: 'DELIVERED',
    occurredAt: '2026-09-09T00:01:00Z',
  });
  assert.equal(delivered.state, 'CONFIRMED');
  assert.equal(delivered.status, 'SETTLED');

  const lateFailure = await governance.settleDelivery({
    ...binding,
    providerRequestKey: key,
    outcomeRef: outcomeRef('outcome-late'),
    outcome: 'DELIVERY_FAILED',
    occurredAt: '2026-09-09T00:02:00Z',
  });
  assert.deepEqual(lateFailure, delivered);
});
