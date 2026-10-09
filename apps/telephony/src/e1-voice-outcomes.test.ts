import assert from 'node:assert/strict';
import test from 'node:test';
import { E1VoiceOutcomes } from './e1-voice-outcomes.js';
import type { VoiceOriginateOutcomeInput } from '@d-contact/delivery';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';

const tenantId = '00000000-0000-4000-8000-000000000001';
const callUuid = '00000000-0000-4000-8000-000000000002';
const event: KafkaEventEnvelope<TelephonyCallEvent> = {
  eventId: 'event-1',
  type: 'call.answered',
  tenantId,
  occurredAt: '2026-10-09T10:00:00.000Z',
  correlationId: callUuid,
  orderingKey: callUuid,
  payload: {
    callUuid,
    telephonyNodeId: 'e1-uat-sandbox',
    vendor: 'freeswitch',
    deliveryId: 'delivery-1',
    providerRequestKey: 'request-1',
    caller: '1101',
    destination: '1102',
  },
};

test('outcome ตรวจ origination UUID/node/durable claim ก่อน settle และไม่รับขาอื่นหรือ metadata ปลอม', async () => {
  const outcomes: VoiceOriginateOutcomeInput[] = [];
  let claimed = true;
  const transaction = {
    $executeRawUnsafe: async () => undefined,
    dlVoiceOriginate: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        assert.equal(where.tenantId, tenantId);
        assert.equal(where.telephonyNodeId, 'e1-uat-sandbox');
        return where.originationUuid === callUuid ? { deliveryId: 'delivery-1' } : null;
      },
    },
    dlOutboxEntry: { findFirst: async () => ({ providerRequestKey: 'request-1' }) },
    interaction: { findFirst: async () => null },
    dlVoiceAuditEvent: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        assert.equal(where.eventId, 'e1-sandbox:call.originate:delivery-1');
        return claimed ? {} : null;
      },
    },
  };
  const database = {
    $transaction: async (work: (transaction: object) => Promise<unknown>) => work(transaction),
  };
  const bridge = new E1VoiceOutcomes(database as never, tenantId, 'e1-uat-sandbox', {
    record: async (input) => {
      outcomes.push(input);
      return 'APPLIED';
    },
  });
  assert.equal(await bridge.handle({ ...event, tenantId: 'other-tenant' }), 'IGNORED');
  assert.equal(
    await bridge.handle({ ...event, payload: { ...event.payload, telephonyNodeId: 'other-node' } }),
    'IGNORED',
  );
  assert.equal(
    await bridge.handle({ ...event, payload: { ...event.payload, callUuid: 'other-leg' } }),
    'IGNORED',
  );
  assert.equal(
    await bridge.handle({
      ...event,
      payload: { ...event.payload, providerRequestKey: 'wrong-request' },
    }),
    'IGNORED',
  );
  claimed = false;
  assert.equal(await bridge.handle(event), 'IGNORED');
  assert.equal(outcomes.length, 0);
  claimed = true;
  assert.equal(await bridge.handle(event), 'APPLIED');
  assert.equal(outcomes[0].outcome, 'DELIVERED');
  assert.equal(outcomes[0].deliveryId, 'delivery-1');
  assert.equal(JSON.stringify(outcomes).includes('1102'), false);
  assert.equal(await bridge.backgroundFailure('job-1', callUuid), 'APPLIED');
  assert.equal(outcomes[1].outcome, 'DELIVERY_FAILED');
  assert.equal(outcomes[1].outcomeRef, 'esl-job:job-1');
});

test('BACKGROUND_JOB failure ปิดเฉพาะ outbound ที่ยัง ASSIGNED ไม่ค้างงานและไม่แตะสาย ACTIVE', async () => {
  let state = 'ASSIGNED';
  const events: unknown[] = [];
  const transaction = {
    $executeRawUnsafe: async () => undefined,
    dlVoiceOriginate: { findFirst: async () => ({ deliveryId: 'delivery-1' }) },
    dlOutboxEntry: { findFirst: async () => ({ providerRequestKey: 'request-1' }) },
    dlVoiceAuditEvent: { findFirst: async () => ({}) },
    interaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        assert.equal(where.tenantId, tenantId);
        assert.equal(where.externalId, callUuid);
        assert.equal(where.channel, 'VOICE');
        assert.equal(where.direction, 'OUTBOUND');
        assert.equal(where.state, 'ASSIGNED');
        return state === 'ASSIGNED' ? { id: 'interaction-1' } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: { state: string };
      }) => {
        assert.equal(where.tenantId, tenantId);
        assert.equal(where.state, 'ASSIGNED');
        if (state !== 'ASSIGNED') return { count: 0 };
        state = data.state;
        return { count: 1 };
      },
    },
    interactionEvent: { create: async (input: unknown) => events.push(input) },
  };
  const database = {
    $transaction: async (work: (transaction: object) => Promise<unknown>) => work(transaction),
  };
  const bridge = new E1VoiceOutcomes(database as never, tenantId, 'e1-uat-sandbox', {
    record: async () => 'APPLIED',
  });
  await bridge.backgroundFailure('job-1', callUuid);
  assert.equal(state, 'ABANDONED');
  await bridge.backgroundFailure('job-1', callUuid);
  assert.equal(events.length, 1);
  state = 'ACTIVE';
  await bridge.backgroundFailure('job-2', callUuid);
  assert.equal(state, 'ACTIVE');
  assert.equal(events.length, 1);
});
