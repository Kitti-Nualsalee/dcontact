import assert from 'node:assert/strict';
import test from 'node:test';
import {
  J3_BUSINESS_RESULTS,
  J3_ERROR_CONTRACT,
  J3ContractError,
  assertSegmentMembershipChangeEnvelope,
  canonicalSegmentMembershipHash,
  contactId,
  customerSegmentMembershipStreamId,
  customerSnapshotVersion,
  membershipRevision,
  segmentDefinitionVersion,
  segmentEntryId,
  segmentEvidenceRef,
  segmentId,
  tenantId,
  validateReadSegmentMembershipChangesInput,
  validateResolveSegmentEntryInput,
  validateSegmentMembershipChangePayload,
  type CustomerSegmentMembershipReader,
  type CustomerContextReader,
  type J3KafkaEnvelopeV2,
  type SegmentMembershipChangePayloadV1,
} from './index.js';

const entered: SegmentMembershipChangePayloadV1 = {
  contractVersion: 1,
  changeKind: 'ENTERED',
  contactId: contactId('contact-a'),
  segmentId: segmentId('segment-a'),
  entryId: segmentEntryId('entry-a'),
  segmentDefinitionVersion: segmentDefinitionVersion(3),
  membershipRevision: membershipRevision(7),
  snapshotVersion: customerSnapshotVersion(11),
  evaluatedAt: '2026-09-13T04:00:00.000Z',
  stateDigest: 'a'.repeat(64),
  evidenceRef: segmentEvidenceRef('evidence:segment-a:7'),
};

const streamId = customerSegmentMembershipStreamId(entered.contactId, entered.segmentId);

const envelope: J3KafkaEnvelopeV2<SegmentMembershipChangePayloadV1> = {
  schemaVersion: 2,
  eventKind: 'CANONICAL',
  eventId: 'event-membership-7',
  type: 'customer.segment.changed',
  tenantId: 'tenant-a',
  occurredAt: '2026-09-13T04:00:01.000Z',
  correlationId: 'correlation-j3',
  causationId: 'c360-evaluation-7',
  orderingKey: streamId,
  aggregateType: 'customer_segment_membership',
  aggregateId: streamId,
  aggregateVersion: 7,
  payload: entered,
};

test('รับ closed payload union ครบทั้งห้า membership change kinds', () => {
  const changes: readonly SegmentMembershipChangePayloadV1[] = [
    entered,
    {
      ...entered,
      changeKind: 'LEFT',
      membershipRevision: membershipRevision(8),
      supersedesRevision: membershipRevision(7),
    },
    {
      ...entered,
      changeKind: 'CORRECTED',
      membershipRevision: membershipRevision(9),
      supersedesRevision: membershipRevision(8),
    },
    {
      ...entered,
      changeKind: 'REFILTER_REQUIRED',
      membershipRevision: membershipRevision(10),
      supersedesRevision: membershipRevision(9),
    },
    {
      ...entered,
      changeKind: 'IDENTITY_INVALIDATED',
      membershipRevision: membershipRevision(11),
      supersedesRevision: membershipRevision(10),
    },
  ];

  for (const change of changes) {
    assert.deepEqual(validateSegmentMembershipChangePayload(change), change);
  }
});

test('ปฏิเสธ unknown field, raw attribute, PII-shaped reference และ contract version ที่ไม่รองรับ', () => {
  assert.throws(
    () => validateSegmentMembershipChangePayload({ ...entered, arbitrary: 'value' }),
    (error: unknown) =>
      error instanceof J3ContractError && error.code === 'PAYLOAD_VALIDATION_FAILED',
  );
  assert.throws(
    () => validateSegmentMembershipChangePayload({ ...entered, attributes: { loyalty: 'gold' } }),
    /closed contract/,
  );
  assert.throws(
    () => validateSegmentMembershipChangePayload({ ...entered, contactId: 'alice@example.com' }),
    /opaque internal reference/,
  );
  assert.throws(
    () => validateSegmentMembershipChangePayload({ ...entered, entryId: '081-234-5678' }),
    /opaque internal reference/,
  );
  assert.throws(
    () => validateSegmentMembershipChangePayload({ ...entered, contractVersion: 2 }),
    (error: unknown) =>
      error instanceof J3ContractError && error.code === 'UNSUPPORTED_CONTRACT_VERSION',
  );
});

test('บังคับ entry lineage และ monotonic correction revision', () => {
  const { entryId: _entryId, ...withoutEntry } = entered;
  assert.throws(
    () => validateSegmentMembershipChangePayload(withoutEntry),
    /entryId.*จำเป็นต้องระบุ/,
  );
  assert.throws(
    () =>
      validateSegmentMembershipChangePayload({
        ...entered,
        changeKind: 'CORRECTED',
        supersedesRevision: entered.membershipRevision,
      }),
    /supersedesRevision.*ต้องน้อยกว่า membershipRevision/,
  );
});

test('canonical hash คงที่สำหรับ duplicate ผูก tenant และไม่ขึ้นกับ transport metadata', () => {
  const tenantA = tenantId('tenant-a');
  const original = canonicalSegmentMembershipHash(tenantA, envelope.payload);
  const redeliveredEnvelope = {
    ...envelope,
    eventId: 'event-redelivery',
    occurredAt: '2026-09-13T04:05:00.000Z',
    correlationId: 'correlation-redelivery',
    causationId: 'transport-retry',
  };
  const redelivery = canonicalSegmentMembershipHash(tenantA, {
    stateDigest: entered.stateDigest,
    evaluatedAt: entered.evaluatedAt,
    snapshotVersion: entered.snapshotVersion,
    membershipRevision: entered.membershipRevision,
    segmentDefinitionVersion: entered.segmentDefinitionVersion,
    entryId: entered.entryId,
    segmentId: entered.segmentId,
    contactId: entered.contactId,
    changeKind: entered.changeKind,
    contractVersion: entered.contractVersion,
    evidenceRef: entered.evidenceRef,
  });

  assert.equal(redelivery, original);
  assert.equal(canonicalSegmentMembershipHash(tenantA, redeliveredEnvelope.payload), original);
  assert.notEqual(canonicalSegmentMembershipHash(tenantId('tenant-b'), entered), original);
  assert.notEqual(
    canonicalSegmentMembershipHash(tenantA, { ...entered, stateDigest: 'b'.repeat(64) }),
    original,
  );
});

test('Kafka V2 binding ใช้ membershipRevision และ logical contact:segment stream', () => {
  assert.deepEqual(assertSegmentMembershipChangeEnvelope(envelope), envelope);
  assert.throws(
    () => assertSegmentMembershipChangeEnvelope({ ...envelope, aggregateVersion: 8 }),
    (error: unknown) => error instanceof J3ContractError && error.code === 'BINDING_MISMATCH',
  );
  assert.throws(
    () => assertSegmentMembershipChangeEnvelope({ ...envelope, orderingKey: 'contact-a:other' }),
    (error: unknown) => error instanceof J3ContractError && error.code === 'ORDERING_KEY_MISMATCH',
  );
  assert.throws(
    () => assertSegmentMembershipChangeEnvelope({ ...envelope, schemaVersion: 3 }),
    (error: unknown) =>
      error instanceof J3ContractError && error.code === 'UNSUPPORTED_SCHEMA_VERSION',
  );
});

test('read-port inputs ปิด caller-supplied snapshot, survivor และ team authority', () => {
  const resolveInput = {
    tenantId: 'tenant-a',
    contactId: 'contact-a',
    segmentId: 'segment-a',
    entryId: 'entry-a',
    membershipRevision: 7,
    at: '2026-09-13T04:00:02.000Z',
  };
  assert.deepEqual(validateResolveSegmentEntryInput(resolveInput), resolveInput);
  for (const forbidden of [
    { membershipSnapshot: {} },
    { survivorContactId: 'contact-b' },
    { teamId: 'team-a' },
  ]) {
    assert.throws(
      () => validateResolveSegmentEntryInput({ ...resolveInput, ...forbidden }),
      /closed contract/,
    );
  }

  assert.deepEqual(
    validateReadSegmentMembershipChangesInput({
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      segmentId: 'segment-a',
      afterRevision: 0,
      throughRevision: 7,
    }),
    {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      segmentId: 'segment-a',
      afterRevision: 0,
      throughRevision: 7,
    },
  );
});

test('CustomerSegmentMembershipReader ให้ผล closed และไม่เปลี่ยน CustomerContextReader เดิม', async () => {
  const legacyReader: CustomerContextReader = {
    async resolveCurrentContext(input) {
      return {
        status: 'RESOLVED',
        contactId: contactId('contact-legacy'),
        segmentMemberships: [
          {
            segmentId: segmentId('segment-legacy'),
            membershipVersion: 4,
            effectiveFrom: input.at,
          },
        ],
        snapshotVersion: 9,
        evaluatedAt: input.at,
      };
    },
  };
  const reader: CustomerSegmentMembershipReader = {
    async resolveEntry(input) {
      return input.entryId === entered.entryId
        ? {
            status: 'ELIGIBLE',
            contactId: input.contactId,
            segmentId: input.segmentId,
            entryId: input.entryId,
            segmentDefinitionVersion: entered.segmentDefinitionVersion,
            membershipRevision: input.membershipRevision,
            snapshotVersion: entered.snapshotVersion,
            evaluatedAt: entered.evaluatedAt,
            stateDigest: entered.stateDigest,
          }
        : { status: 'NOT_FOUND', reasonCode: 'RESOURCE_NOT_FOUND' };
    },
    async readChanges() {
      return { status: 'CHANGES', changes: Object.freeze([entered]) };
    },
  };

  const result = await reader.resolveEntry({
    tenantId: tenantId('tenant-a'),
    contactId: entered.contactId,
    segmentId: entered.segmentId,
    entryId: entered.entryId,
    membershipRevision: entered.membershipRevision,
    at: '2026-09-13T04:00:02.000Z',
  });
  assert.equal(result.status, 'ELIGIBLE');
  const legacyResult = await legacyReader.resolveCurrentContext({
    tenantId: tenantId('tenant-a'),
    contactRef: { kind: 'CRM_ID', value: 'fixture-only' },
    at: '2026-09-13T04:00:02.000Z',
  });
  assert.equal(legacyResult.status, 'RESOLVED');
  if (legacyResult.status === 'RESOLVED') {
    assert.equal(legacyResult.segmentMemberships[0]?.membershipVersion, 4);
  }
});

test('J3 error mapping คงที่และ business result ไม่ปะปนกับ transport error', () => {
  assert.equal(J3_ERROR_CONTRACT.MEMBERSHIP_REVISION_GAP.retryDisposition, 'RECONCILE');
  assert.equal(J3_ERROR_CONTRACT.EVENT_HASH_CONFLICT.retryDisposition, 'QUARANTINE');
  assert.equal(J3_ERROR_CONTRACT.CUSTOMER_360_UNAVAILABLE.retryDisposition, 'RETRY_SAME_IDENTITY');
  assert.equal(J3_ERROR_CONTRACT.RESOURCE_NOT_FOUND.retryDisposition, 'DO_NOT_RETRY');
  assert.equal(Object.isFrozen(J3_ERROR_CONTRACT), true);
  assert.deepEqual(J3_BUSINESS_RESULTS, [
    'DUPLICATE_NO_OP',
    'IGNORED_SUPERSEDED',
    'DEFER',
    'REVIEW',
    'CANCELLED',
    'TOO_LATE',
  ]);
});
