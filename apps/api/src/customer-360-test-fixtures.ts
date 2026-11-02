import { randomUUID } from 'node:crypto';
import {
  C360SegmentEvaluator,
  C360SegmentMembershipRepository,
  C360SegmentRepository,
} from '@d-contact/customer-360';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamTeamSegmentScopeRepository } from '@d-contact/iam';
import type { SegmentMembershipChangePayloadV1 } from '@d-contact/cxa-contracts';
import { Customer360Controller } from './customer-360-api.js';
import { coreFixture } from './tenant-core-test-fixtures.js';

/** Cus360 C1 (#791): fixture ร่วมของ S3/S4 ใช้ owner writers จริง ไม่เขียน head ปลอม */
export type Fixture = Awaited<ReturnType<typeof setup>>;

export async function setup(extraControllers: Parameters<typeof coreFixture>[0] = []) {
  const f = await coreFixture([Customer360Controller, ...extraControllers]);
  const contactId = randomUUID();
  await f.owner.contact.create({
    data: { id: contactId, tenantId: f.tenantId, displayName: 'ลูกค้า C1' },
  });
  const segmentId = `segment:c1-${f.tenantId.slice(0, 8)}`;
  const evaluator = new C360SegmentEvaluator(new DcExprEvaluator());
  const segments = new C360SegmentRepository(f.db, evaluator);
  const draft = await segments.createVersion({
    tenantId: f.tenantId,
    segmentId,
    version: 1,
    definition: {
      contractVersion: 1,
      name: 'C1 VIEW',
      expression: {
        language: 'DC_EXPR',
        version: 1,
        expression: {
          type: 'comparison',
          operator: 'eq',
          left: { type: 'ref', path: ['contact', 'tier'] },
          right: { type: 'literal', value: 'GOLD' },
        },
      },
    },
    correlationId: 'c1-s3-definition',
  });
  await segments.publishVersion({
    tenantId: f.tenantId,
    segmentId,
    version: 1,
    expectedContentDigest: draft.contentDigest,
    expectedHeadVersion: 0,
  });
  return {
    ...f,
    contactId,
    segmentId,
    segments,
    memberships: new C360SegmentMembershipRepository(f.db, evaluator),
    scopes: new IamTeamSegmentScopeRepository(f.db),
    snapshotVersion: 0,
    membershipRevision: 0,
  };
}

/** owner commit (C360) โดยไม่ส่งต่อให้ IAM — จำลอง projection lag ก่อน Kafka */
export async function ownerCommit(f: Fixture, tier: 'GOLD' | 'SILVER') {
  f.snapshotVersion += 1;
  await f.segments.recordFactSnapshot({
    tenantId: f.tenantId,
    contactId: f.contactId,
    snapshotVersion: f.snapshotVersion,
    attributes: { tier: { type: 'STRING', value: tier } },
    computed: {},
    sourceCutoffAt: new Date().toISOString(),
    correlationId: `c1-s3-snapshot-${f.snapshotVersion}`,
  });
  const result = await f.memberships.commitEvaluation({
    tenantId: f.tenantId,
    contactId: f.contactId,
    segmentId: f.segmentId,
    segmentDefinitionVersion: 1,
    snapshotVersion: f.snapshotVersion,
    expectedMembershipRevision: f.membershipRevision,
    commandId: `command:${randomUUID()}`,
    correlationId: `c1-s3-${randomUUID()}`,
  });
  f.membershipRevision = result.membershipRevision;
}

/** IAM consumer รับ event ของ head ปัจจุบัน (เส้นทางเดียวกับ Kafka consumer จริง) */
export async function deliverToIam(
  f: Fixture,
  changeKind?: SegmentMembershipChangePayloadV1['changeKind'],
) {
  const head = await f.owner.c360SegmentMembershipHead.findUniqueOrThrow({
    where: {
      tenantId_contactId_segmentId: {
        tenantId: f.tenantId,
        contactId: f.contactId,
        segmentId: f.segmentId,
      },
    },
  });
  await f.scopes.applyMembershipChange({
    tenantId: f.tenantId,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    consumerGroup: 'iam-scope-c1-s3',
    payload: {
      contractVersion: 1,
      changeKind: changeKind ?? (head.state === 'IN' ? 'ENTERED' : 'LEFT'),
      contactId: head.contactId,
      segmentId: head.segmentId,
      entryId: head.entryId,
      segmentDefinitionVersion: head.segmentDefinitionVersion,
      membershipRevision: head.membershipRevision,
      snapshotVersion: head.snapshotVersion,
      evaluatedAt: head.evaluatedAt.toISOString(),
      stateDigest: head.stateDigest,
      evidenceRef: head.evidenceRef,
    } as unknown as SegmentMembershipChangePayloadV1,
  });
}

export async function grantCustodian(f: Fixture, token: string, permission: 'READ' | 'MANAGE') {
  const actor = f.actors.get(token)!;
  const commandId = randomUUID();
  const actorIdentityKey = 'operator-fixture';
  await f.owner.c360ProfileCommand.create({
    data: {
      tenantId: f.tenantId,
      actorIdentityKey,
      commandId,
      action: 'CUSTODIAN_GRANT',
      resourceType: 'CONTACT',
      resourceId: f.contactId,
      payloadDigest: 'f'.repeat(64),
      normalizationContractVersion: 'cus360-v1',
    },
  });
  const grant = await f.owner.c360ContactCustodianGrant.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      contactId: f.contactId,
      granteeUserId: actor.id,
      permission,
      origin: 'OPERATOR',
      evidenceRef: 'fixture-evidence',
      actorIdentityKey,
      commandId,
    },
  });
  return { grant, commandId, actorIdentityKey };
}

export async function activeHead(f: Fixture) {
  await f.owner.c360IdentityHead.create({
    data: {
      tenantId: f.tenantId,
      contactId: f.contactId,
      canonicalContactId: f.contactId,
      state: 'ACTIVE',
      stateDigest: 'e'.repeat(64),
    },
  });
}
