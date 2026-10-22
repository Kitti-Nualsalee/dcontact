import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { teamWriterRace } from '@d-contact/db/testing/team-reference-races.js';
import { IamJourneyAuthoringDelegations } from './journey-authoring-authorization.js';

for (const operation of ['delegate', 'revoke'] as const)
  for (const order of ['writer-first', 'deactivate-first'] as const)
    test(`Core Team fence: actual authoring ${operation} ${order}`, async (t) => {
      const owner = new PrismaClient(),
        app = new PrismaClient({
          datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
        });
      t.after(async () => {
        await app.$disconnect();
        await owner.$disconnect();
      });
      const tenantId = randomUUID(),
        teamId = randomUUID();
      await owner.tenant.create({
        data: {
          id: tenantId,
          name: 'IAM authoring fence',
          slug: `authoring-${tenantId}`,
          sipDomain: `${tenantId}.test`,
        },
      });
      await owner.team.create({ data: { id: teamId, tenantId, name: 'Authoring' } });
      for (const subjectId of ['maker', 'delegate'])
        await owner.iamAuthoringSubject.create({
          data: { tenantId, subjectId, authenticationStrength: 'STRONG' },
        });
      await owner.iamAuthoringCapabilityGrant.create({
        data: {
          tenantId,
          subjectId: 'maker',
          capability: 'journey.edit',
          scopeKind: 'TENANT',
          scopeId: tenantId,
          grantedByRef: 'isolated-operator',
        },
      });
      const repository = new IamJourneyAuthoringDelegations(app);
      const input = {
        tenantId,
        delegatorSubjectId: 'maker',
        delegateSubjectId: 'delegate',
        capability: 'journey.edit' as const,
        scope: { kind: 'TEAM' as const, id: teamId, teamId },
        durationSeconds: 600,
        evidenceRef: 'isolated-operator',
      };
      const current = operation === 'revoke' ? await repository.delegate(input) : null;
      await teamWriterRace({
        owner,
        tenantId,
        teamId,
        table:
          operation === 'delegate'
            ? 'iam_authoring_delegations'
            : 'iam_authoring_delegation_revocations',
        order,
        existingReferences: operation === 'revoke',
        write: () =>
          current
            ? repository.revoke({
                tenantId,
                delegationId: current.delegationId,
                reasonCode: 'REVOKED',
                revokedByRef: 'isolated-operator',
              })
            : repository.delegate(input),
      });
    });
