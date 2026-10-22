import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { teamWriterRace } from '@d-contact/db/testing/team-reference-races.js';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import { DcExprEvaluator } from '@d-contact/expression';
import { importJourneyDefinition } from './journey-authoring-compiler.js';
import type { JourneyDefinitionContent } from './journey-definition.js';
import { JourneyTemplateRepository } from './journey-template-repository.js';

async function fixture(t: TestContext) {
  const db = new PrismaClient(),
    app = new PrismaClient({ datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } } });
  t.after(async () => {
    await app.$disconnect();
    await db.$disconnect();
  });
  const tenantId = randomUUID(),
    journeyTeam = randomUUID(),
    templateTeam = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Ownership writers',
      slug: `ownership-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  for (const id of [journeyTeam, templateTeam])
    await db.team.create({ data: { id, tenantId, name: id } });
  await db.jrAuthoringRolloutState.create({
    data: {
      tenantId,
      stage: 'INTERNAL_SYNTHETIC',
      canvasWriteEnabled: true,
      templateCatalogEnabled: true,
      publishUiEnabled: true,
      updatedByRef: 'operator',
      evidenceRef: 'isolated-fixture',
    },
  });
  await db.iamAuthoringSubject.create({
    data: { tenantId, subjectId: 'author', authenticationStrength: 'STRONG' },
  });
  for (const capability of ['journey.edit', 'template.edit'])
    await db.iamAuthoringCapabilityGrant.create({
      data: {
        tenantId,
        subjectId: 'author',
        capability,
        scopeKind: 'TENANT',
        scopeId: tenantId,
        grantedByRef: 'operator',
      },
    });
  const repository = new JourneyTemplateRepository(app, {
    authorization: new IamJourneyAuthoringAuthorizer(),
    evaluator: new DcExprEvaluator(),
    flags: { canvasWrite: true, publishUi: true, templateCatalog: true },
  });
  const context = () => ({
    tenantId,
    actor: { subjectId: 'author', correlationId: randomUUID() },
    idempotencyKey: randomUUID(),
  });
  const definition = JSON.parse(
    readFileSync(resolve(process.cwd(), 'test/fixtures/j5/j1-schedule.json'), 'utf8'),
  ) as JourneyDefinitionContent;
  const document = (ownerTeamId: string) => importJourneyDefinition({ ...definition, ownerTeamId });
  return { db, tenantId, journeyTeam, templateTeam, repository, context, document };
}

test('Team writers: actual Journey/Template draft writers สร้าง current ownership ที่ห้ามปิดทีม', async (t) => {
  const { db, tenantId, journeyTeam, templateTeam, repository, context, document } =
    await fixture(t);
  await repository.createJourneyDraft(context(), {
    ownerTeamId: journeyTeam,
    document: document(journeyTeam),
  });
  await repository.createTemplateDraft(context(), {
    ownerTeamId: templateTeam,
    name: 'Template',
    visibility: 'TEAM',
    document: document(templateTeam),
    parameterSchema: [],
  });
  for (const id of [journeyTeam, templateTeam])
    await assert.rejects(
      withTenantDatabaseTransaction(db, tenantId, (tx) =>
        tx.team.update({ where: { id }, data: { isActive: false } }),
      ),
      /TEAM_REFERENCED/,
    );
});

for (const kind of ['Journey', 'Template'] as const)
  for (const order of ['writer-first', 'deactivate-first'] as const)
    test(`Core Team fence: actual ${kind} draft ownership ${order}`, async (t) => {
      const f = await fixture(t);
      const teamId = kind === 'Journey' ? f.journeyTeam : f.templateTeam;
      await teamWriterRace({
        owner: f.db,
        tenantId: f.tenantId,
        teamId,
        table: kind === 'Journey' ? 'jr_journey_heads' : 'jr_template_heads',
        order,
        write: () =>
          kind === 'Journey'
            ? f.repository.createJourneyDraft(f.context(), {
                ownerTeamId: teamId,
                document: f.document(teamId),
              })
            : f.repository.createTemplateDraft(f.context(), {
                ownerTeamId: teamId,
                name: 'Template race',
                visibility: 'TEAM',
                document: f.document(teamId),
                parameterSchema: [],
              }),
      });
    });
