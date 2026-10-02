import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VoiceTelephonyOutcomeHandler,
  type VoiceTelephonyEvent,
} from './voice-telephony-outcome.js';

function event(type: 'call.created' | 'call.answered' | 'call.hangup'): VoiceTelephonyEvent {
  return {
    eventId: `event-${type}`,
    type,
    tenantId: 'tenant-1',
    occurredAt: '2026-10-02T08:00:00.000Z',
    correlationId: 'call-1',
    payload: {
      deliveryId: 'delivery_1',
      providerRequestKey: 'provider_1',
    },
  };
}

test('maps outbound telephony lifecycle to normalized Delivery outcomes', async () => {
  const outcomes: string[] = [];
  const handler = new VoiceTelephonyOutcomeHandler({
    record: async (input) => {
      outcomes.push(input.outcome);
      return 'APPLIED';
    },
  });
  assert.equal(await handler.handle(event('call.created')), 'APPLIED');
  assert.equal(await handler.handle(event('call.answered')), 'APPLIED');
  assert.equal(await handler.handle(event('call.hangup')), 'APPLIED');
  assert.deepEqual(outcomes, ['PROVIDER_ACCEPTED', 'DELIVERED', 'DELIVERY_FAILED']);
});

test('ignores inbound events without delivery metadata', async () => {
  const inbound = event('call.answered');
  delete inbound.payload.deliveryId;
  assert.equal(
    await new VoiceTelephonyOutcomeHandler({ record: async () => 'APPLIED' }).handle(inbound),
    'IGNORED',
  );
});
