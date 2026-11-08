/** ใช้เฉพาะ disposable overview browser harness เพื่อทดสอบ owner/proof/context จริง */
import { randomUUID } from 'node:crypto';
import {
  C360SegmentEvaluator,
  C360SegmentRepository,
  C360SegmentMembershipRepository,
} from '@d-contact/customer-360';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamTeamSegmentScopeRepository } from '@d-contact/iam';
import type { coreFixture } from './tenant-core-test-fixtures.js';
import { ownerCommit, deliverToIam } from './customer-360-test-fixtures.js';
import { contact, grant } from './customer-360-read-test-fixtures.js';

export async function createOverviewBrowserFixture(f: Awaited<ReturnType<typeof coreFixture>>) {
  const admin = f.actors.get('admin')!;
  const original = await f.owner.user.findUniqueOrThrow({
    where: { id: admin.id },
    select: { isActive: true, role: true, keycloakId: true },
  });
  let scope: Awaited<ReturnType<typeof createScope>> | undefined;
  let oldCustomerId: string | undefined;
  let oldGrant: Awaited<ReturnType<typeof grant>> | undefined;
  async function createScope() {
    const contactId = randomUUID();
    await f.owner.contact.create({
      data: { id: contactId, tenantId: f.tenantId, displayName: 'Synthetic scope fixture' },
    });
    const segmentId = `overview-scope:${randomUUID()}`;
    const evaluator = new C360SegmentEvaluator(new DcExprEvaluator());
    const segments = new C360SegmentRepository(f.db, evaluator);
    const draft = await segments.createVersion({
      tenantId: f.tenantId,
      segmentId,
      version: 1,
      definition: {
        contractVersion: 1,
        name: 'Overview scope',
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
      correlationId: 'overview-fixture',
    });
    await segments.publishVersion({
      tenantId: f.tenantId,
      segmentId,
      version: 1,
      expectedContentDigest: draft.contentDigest,
      expectedHeadVersion: 0,
    });
    const scopes = new IamTeamSegmentScopeRepository(f.db);
    await scopes.grant({
      tenantId: f.tenantId,
      teamId: f.teamId,
      segmentId,
      permission: 'VIEW',
      correlationId: 'overview-fixture',
    });
    return {
      ...f,
      contactId,
      segmentId,
      segments,
      scopes,
      memberships: new C360SegmentMembershipRepository(f.db, evaluator),
      snapshotVersion: 0,
      membershipRevision: 0,
    };
  }
  return {
    async change(kind: string) {
      if (kind === 'role')
        await f.owner.user.update({ where: { id: admin.id }, data: { role: 'SUPERVISOR' } });
      else if (kind === 'proof')
        await f.owner.user.update({ where: { id: admin.id }, data: { keycloakId: randomUUID() } });
      else if (kind === 'scope-lag') {
        scope ??= await createScope();
        await ownerCommit(scope, 'GOLD');
        await deliverToIam(scope);
        await ownerCommit(scope, 'SILVER');
      } else if (kind === 'grant-customer') {
        oldCustomerId ??= await contact(f, { displayName: 'Synthetic old actor customer' });
        if (!oldGrant) oldGrant = await grant(f, 'admin', oldCustomerId, 'READ');
      } else return false;
      return true;
    },
    async restore() {
      await f.owner.user.update({ where: { id: admin.id }, data: original });
      if (scope) await deliverToIam(scope);
      if (oldGrant) {
        await f.owner.c360ContactCustodianRevocation.create({
          data: {
            id: randomUUID(),
            tenantId: f.tenantId,
            grantId: oldGrant.id,
            actorIdentityKey: oldGrant.actorIdentityKey,
            commandId: oldGrant.commandId,
            reason: 'fixture cleanup',
            evidenceRef: 'fixture',
          },
        });
        oldGrant = undefined;
      }
    },
  };
}
