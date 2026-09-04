import assert from 'node:assert/strict';
import test from 'node:test';
import { fanoutAgentOffer } from './agent-offer-fanout.js';

test('routing.offered is forwarded only with its tenant and assigned agent identity', async () => {
  const delivered: unknown[] = [];
  await fanoutAgentOffer(
    {
      deliverRoutingEvent: async (event) => {
        delivered.push(event);
        return 1;
      },
    },
    {
      eventId: 'offer-1',
      type: 'routing.offered',
      tenantId: 'tenant-1',
      occurredAt: '2026-09-04T05:10:00.000Z',
      correlationId: 'call-1',
      orderingKey: 'interaction-1',
      payload: { interactionId: 'interaction-1', userId: 'agent-1' },
    },
  );
  assert.deepEqual(delivered, [
    { type: 'routing.offered', tenantId: 'tenant-1', interactionId: 'interaction-1', userId: 'agent-1' },
  ]);
});

test('routing.offered with a tenant mismatch is rejected before WebSocket delivery', async () => {
  await assert.rejects(
    fanoutAgentOffer(
      { deliverRoutingEvent: async () => 1 },
      {
        eventId: 'offer-2',
        type: 'routing.offered',
        tenantId: 'tenant-1',
        occurredAt: '2026-09-04T05:10:00.000Z',
        correlationId: 'call-1',
        orderingKey: 'interaction-1',
        payload: { interactionId: 'interaction-1', userId: 'agent-1', tenantId: 'tenant-2' },
      },
    ),
    /tenantId/,
  );
});
