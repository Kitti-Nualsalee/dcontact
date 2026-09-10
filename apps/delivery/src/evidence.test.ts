import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DELIVERY_EVIDENCE_FIELDS,
  InlineContentRejectedError,
  assertOpaqueContentRef,
  canonicalInputHash,
  deliveryEvidence,
  mintOpaqueKey,
} from './evidence.js';
import { ProviderTrafficNotAllowedError, ScriptedTestTransport } from './test-transport.js';
import type { DlOutboxEntry } from '@d-contact/db';

const CONTACT_ID = '2f1c6d1a-9d2f-4f0e-9d0b-4a1d6b0f3c11';
const IDENTITY_VALUE = 'somchai.customer@example.test';

function entry(overrides: Partial<DlOutboxEntry> = {}): DlOutboxEntry {
  return {
    id: 'f0a1b2c3-d4e5-4678-89ab-cdef01234567',
    tenantId: 'a1b2c3d4-e5f6-4789-8abc-def012345678',
    actionKey: 'journey-1:step-2',
    reservationId: 'b2c3d4e5-f6a7-4890-9bcd-ef0123456789',
    deliveryId: 'dlv_0123456789abcdef0123456789abcdef',
    providerRequestKey: 'prq_0123456789abcdef0123456789abcdef',
    adapter: 'TEST_ADAPTER',
    channel: 'EMAIL',
    contactId: CONTACT_ID,
    identityId: null,
    purpose: 'MARKETING',
    source: 'JOURNEY',
    senderIdentityId: 'sender-1',
    contentRef: 'template:welcome/v3',
    inputHash: 'hash',
    state: 'QUEUED',
    leaseVersion: 1,
    leaseExpiresAt: new Date('2026-09-10T09:30:00.000Z'),
    submittedAt: null,
    outcome: null,
    outcomeRef: null,
    settledAt: null,
    correlationId: 'corr-1',
    causationId: null,
    createdAt: new Date('2026-09-10T09:00:00.000Z'),
    updatedAt: new Date('2026-09-10T09:00:00.000Z'),
    ...overrides,
  } as DlOutboxEntry;
}

test('evidence exposes only allowlisted opaque fields', () => {
  const evidence = deliveryEvidence(entry());
  assert.deepEqual(Object.keys(evidence).sort(), [...DELIVERY_EVIDENCE_FIELDS].sort());
});

test('evidence never carries contentRef, sender binding or purpose text', () => {
  const serialized = JSON.stringify(deliveryEvidence(entry()));
  for (const leaked of ['template:welcome/v3', 'sender-1', 'contentRef', 'senderIdentityId']) {
    assert.equal(serialized.includes(leaked), false, `evidence ยังมี ${leaked}`);
  }
});

test('minted keys are digests that do not embed the action key or contact id', () => {
  const inputHash = canonicalInputHash({ contactId: CONTACT_ID, contentRef: 'template:a' });
  const minted = mintOpaqueKey('delivery', 'tenant-1', 'journey-1:step-2', inputHash);
  assert.match(minted, /^dlv_[0-9a-f]{32}$/);
  assert.equal(minted.includes(CONTACT_ID), false);
  assert.equal(minted.includes('journey-1'), false);
});

test('minted keys are deterministic per input and differ by kind', () => {
  const inputHash = canonicalInputHash({ contentRef: 'template:a' });
  const first = mintOpaqueKey('delivery', 'tenant-1', 'action-1', inputHash);
  const again = mintOpaqueKey('delivery', 'tenant-1', 'action-1', inputHash);
  const provider = mintOpaqueKey('provider-request', 'tenant-1', 'action-1', inputHash);
  assert.equal(first, again);
  assert.notEqual(first, provider);
});

test('canonical hash ignores correlation and causation but tracks payload', () => {
  const base = { contentRef: 'template:a', correlationId: 'corr-1' };
  assert.equal(
    canonicalInputHash(base),
    canonicalInputHash({ contentRef: 'template:a', correlationId: 'corr-2', causationId: 'x' }),
  );
  assert.notEqual(canonicalInputHash(base), canonicalInputHash({ contentRef: 'template:b' }));
});

test('contentRef that is really an address or a message body is rejected', () => {
  assert.throws(() => assertOpaqueContentRef(IDENTITY_VALUE), InlineContentRejectedError);
  assert.throws(
    () => assertOpaqueContentRef('สวัสดีคุณสมชาย โปรโมชันวันนี้'),
    InlineContentRejectedError,
  );
  assert.throws(() => assertOpaqueContentRef('+66812345678'), InlineContentRejectedError);
  assertOpaqueContentRef('template:welcome/v3');
});

test('transport refuses anything that is not the test adapter', async () => {
  const transport = new ScriptedTestTransport();
  await assert.rejects(
    () =>
      transport.submit({
        adapter: 'LINE_PROVIDER' as 'TEST_ADAPTER',
        deliveryId: 'dlv_1',
        providerRequestKey: 'prq_1',
        channel: 'LINE',
        contentRef: 'template:a',
      }),
    ProviderTrafficNotAllowedError,
  );
  assert.equal(transport.requests.length, 0);
});

test('scripted transport replays its script then defaults to accepted', async () => {
  const transport = new ScriptedTestTransport([{ status: 'REJECTED', reasonCode: 'BLOCKED' }]);
  const request = {
    adapter: 'TEST_ADAPTER' as const,
    deliveryId: 'dlv_1',
    providerRequestKey: 'prq_1',
    channel: 'EMAIL' as const,
    contentRef: 'template:a',
  };
  assert.deepEqual(await transport.submit(request), {
    status: 'REJECTED',
    reasonCode: 'BLOCKED',
  });
  assert.deepEqual(await transport.submit(request), { status: 'ACCEPTED' });
  assert.equal(transport.submissionsFor('prq_1'), 2);
});
