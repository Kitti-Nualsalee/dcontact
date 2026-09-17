import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  contactId as toContactId,
  customerSnapshotVersion,
  membershipRevision,
  segmentDefinitionVersion,
  segmentEntryId,
  segmentId,
  teamId as toTeamId,
  tenantId as toTenantId,
} from '@d-contact/cxa-contracts';
import { PrismaClient } from '@d-contact/db';
import { IamTeamSegmentScopeRepository } from '@d-contact/iam';
import { createJourneyFoundationPorts, createJourneyOutcomeTriggerPorts } from './index.js';

const OWNER_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://dcontact:dcontact@localhost:5433/dcontact?schema=public';
const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';
const at = '2099-01-01T00:00:00.000Z';

async function fixture(t: TestContext) {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_DATABASE_URL } } });
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const contactId = randomUUID();
  t.after(async () => {
    const where = { tenantId };
    await owner.iamScopeConsumerInbox.deleteMany({ where });
    await owner.iamScopeInvalidationOutbox.deleteMany({ where });
    await owner.iamContactSegmentScopeProjection.deleteMany({ where });
    await owner.iamTeamSegmentScopeRevocation.deleteMany({ where });
    await owner.iamTeamSegmentScopeActiveGrant.deleteMany({ where });
    await owner.iamTeamSegmentScopeGrant.deleteMany({ where });
    await owner.iamTeamScopeVersion.deleteMany({ where });
    await owner.contact.deleteMany({ where });
    await owner.team.deleteMany({ where });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'Journey composition IAM test',
      slug: `journey-composition-iam-${tenantId}`,
      sipDomain: `${tenantId}.journey-composition.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Journey owner' } });
  await owner.contact.create({ data: { id: contactId, tenantId } });
  return {
    application,
    tenantId,
    teamId,
    contactId,
    scope: new IamTeamSegmentScopeRepository(application),
  };
}

test('Journey composition ใช้ IAM current scope สำหรับ foundation และ outcome ports', async (t) => {
  const f = await fixture(t);
  const contactGrant = await f.scope.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: 'VIP',
    permission: 'CONTACT',
    correlationId: 'journey-composition-contact-grant',
  });
  await f.scope.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: 'VIP',
    permission: 'WORK',
    correlationId: 'journey-composition-work-grant',
  });
  await f.scope.applyMembershipChange({
    tenantId: f.tenantId,
    eventId: 'journey-composition-membership-entered',
    occurredAt: at,
    consumerGroup: 'journey-composition-test',
    payload: {
      contractVersion: 1,
      contactId: toContactId(f.contactId),
      segmentId: segmentId('VIP'),
      membershipRevision: membershipRevision(1),
      changeKind: 'ENTERED',
      entryId: segmentEntryId('journey-composition-entry'),
      segmentDefinitionVersion: segmentDefinitionVersion(1),
      snapshotVersion: customerSnapshotVersion(1),
      evaluatedAt: at,
      stateDigest: 'a'.repeat(64),
    },
  });

  const authorizationInput = {
    tenantId: toTenantId(f.tenantId),
    teamId: toTeamId(f.teamId),
    contactId: toContactId(f.contactId),
    at,
  };
  const foundation = createJourneyFoundationPorts(f.application);
  const outcome = createJourneyOutcomeTriggerPorts(f.application);
  const [contactScope, workScope] = await Promise.all([
    foundation.teamContactScopeAuthorizer.authorize({
      ...authorizationInput,
      permission: 'CONTACT',
    }),
    outcome.teamContactScopeAuthorizer.authorize({ ...authorizationInput, permission: 'WORK' }),
  ]);
  assert.equal(contactScope.decision, 'ALLOW');
  assert.equal(workScope.decision, 'ALLOW');
  assert.equal(contactScope.scopeVersion, 2);
  assert.equal(workScope.scopeVersion, 2);

  await f.scope.revoke({
    tenantId: f.tenantId,
    grantId: contactGrant.grant.id,
    reasonCode: 'ADMIN_REVOKE',
    correlationId: 'journey-composition-contact-revoke',
  });
  const revoked = await foundation.teamContactScopeAuthorizer.authorize({
    ...authorizationInput,
    permission: 'CONTACT',
  });
  assert.equal(revoked.decision, 'DENY');
  assert.equal(revoked.reasonCode, 'TEAM_SEGMENT_NOT_ALLOWED');
});
