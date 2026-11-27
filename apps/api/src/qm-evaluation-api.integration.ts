/** #971: HTTP → PostgreSQL with an application role that does not bypass RLS */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { Prisma, PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import {
  QmEvaluationController,
  QM_EVALUATION_DATABASE,
  QM_HUMAN_EVALUATION,
} from './qm-evaluation-api.js';

const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});
test.after(() => Promise.all([owner.$disconnect(), application.$disconnect()]));

type Role = 'agent' | 'supervisor' | 'admin';
type Json = Record<string, any>;

const FORM = {
  requireCommentBelow: 60,
  sections: [
    {
      id: 'opening',
      name: 'Call opening',
      weight: 20,
      questions: [
        { id: 'greet', type: 'YES_NO', text: 'States company name and own name', points: 10 },
        {
          id: 'verify',
          type: 'YES_NO',
          text: 'Verifies customer identity',
          points: 10,
          autoFail: true,
        },
      ],
    },
    {
      id: 'solve',
      name: 'Problem solving',
      weight: 80,
      questions: [
        {
          id: 'tone',
          type: 'SCALE',
          text: 'Tone of voice',
          points: 10,
          scale: [1, 5],
          allowNa: true,
        },
        { id: 'note', type: 'TEXT', text: 'What went well' },
      ],
    },
  ],
};

async function fixture(t: TestContext, enabled: boolean) {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const ids = {
    teamA: randomUUID(),
    teamB: randomUUID(),
    supervisorA: randomUUID(),
    secondSupervisorA: randomUUID(),
    supervisorB: randomUUID(),
    agentA: randomUUID(),
    agentB: randomUUID(),
    admin: randomUUID(),
    queue: randomUUID(),
    foreignSupervisor: randomUUID(),
    foreignTeam: randomUUID(),
    foreignAdmin: randomUUID(),
  };
  const tokens = new Map<string, VerifiedOidcClaims>();
  const token = (tenant: string, userId: string, role: Role) => {
    const value = `token-${randomUUID()}`;
    tokens.set(value, {
      tenant_id: tenant,
      tenant_slug: `tenant-${tenant}`,
      organization: { [`tenant-${tenant}`]: { tenant_id: [tenant] } },
      dc_user_id: userId,
      sid: `session-${userId}`,
      exp: 2_000_000_000,
      realm_access: { roles: [role] },
    });
    return value;
  };
  for (const [id, label] of [
    [tenantId, 'home'],
    [foreignTenantId, 'foreign'],
  ] as const) {
    await owner.tenant.create({
      data: { id, name: `QM ${label} ${id}`, slug: `qm-${id}`, sipDomain: `${id}.test` },
    });
  }
  await owner.team.createMany({
    data: [
      { id: ids.teamA, tenantId, name: 'Team A' },
      { id: ids.teamB, tenantId, name: 'Team B' },
      { id: ids.foreignTeam, tenantId: foreignTenantId, name: 'Team A' },
    ],
  });
  const user = (
    id: string,
    tenant: string,
    role: 'AGENT' | 'SUPERVISOR' | 'ADMIN',
    teamId: string | null,
    displayName: string,
  ) => ({
    id,
    tenantId: tenant,
    email: `${id}@test.local`,
    passwordHash: 'test',
    displayName,
    role,
    teamId,
  });
  await owner.user.createMany({
    data: [
      user(ids.supervisorA, tenantId, 'SUPERVISOR', ids.teamA, 'Supervisor A'),
      user(ids.secondSupervisorA, tenantId, 'SUPERVISOR', ids.teamA, 'Supervisor A2'),
      user(ids.supervisorB, tenantId, 'SUPERVISOR', ids.teamB, 'Supervisor B'),
      user(ids.agentA, tenantId, 'AGENT', ids.teamA, 'Agent A'),
      user(ids.agentB, tenantId, 'AGENT', ids.teamB, 'Agent B'),
      user(ids.admin, tenantId, 'ADMIN', null, 'Admin'),
      user(ids.foreignSupervisor, foreignTenantId, 'SUPERVISOR', ids.foreignTeam, 'Foreign'),
      user(ids.foreignAdmin, foreignTenantId, 'ADMIN', null, 'Foreign admin'),
    ],
  });
  await owner.queue.create({
    data: { id: ids.queue, tenantId, name: 'Support', channels: ['VOICE'] },
  });

  /** a finished call; `team` is the team the Router recorded at answer time (undefined = no evidence) */
  async function call(input: {
    agentId: string;
    team?: string;
    state?: 'COMPLETED' | 'WRAPUP';
    acceptedAt: string;
  }) {
    const interactionId = randomUUID();
    await owner.$executeRaw(
      Prisma.sql`INSERT INTO interactions (id, tenant_id, channel, direction, state, queue_id, agent_id, external_id)
        VALUES (${interactionId}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND',
          ${input.state ?? 'COMPLETED'}::"InteractionStateType", ${ids.queue}::uuid,
          ${input.agentId}::uuid, ${`call-${interactionId}`})`,
    );
    if (input.team) {
      await owner.voiceInteractionHandlingAttribution.create({
        data: {
          tenantId,
          interactionId,
          agentId: input.agentId,
          teamId: input.team,
          acceptedAt: new Date(input.acceptedAt),
          sourceEventId: `test:${interactionId}`,
        },
      });
    }
    return interactionId;
  }

  @Module({
    controllers: [QmEvaluationController],
    providers: [
      { provide: QM_EVALUATION_DATABASE, useValue: application },
      { provide: QM_HUMAN_EVALUATION, useValue: enabled },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: {
          verifyAccessToken: async (value: string) => {
            const found = tokens.get(value);
            if (!found) throw new Error('invalid token');
            return found;
          },
        },
      },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    // a published evaluation is protected from deletion by a trigger: clean up test data by disabling the trigger for this transaction only
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
      for (const tenant of [tenantId, foreignTenantId]) {
        await tx.commandReceipt.deleteMany({ where: { tenantId: tenant } });
        await tx.qmAuditEvent.deleteMany({ where: { tenantId: tenant } });
        await tx.qmEvaluation.deleteMany({ where: { tenantId: tenant } });
        await tx.qmTranscriptSegment.deleteMany({ where: { tenantId: tenant } });
        await tx.qmTranscript.deleteMany({ where: { tenantId: tenant } });
        await tx.qmTranscriptionJob.deleteMany({ where: { tenantId: tenant } });
        await tx.recording.deleteMany({ where: { tenantId: tenant } });
        await tx.qmFormVersion.deleteMany({ where: { tenantId: tenant } });
        await tx.qmForm.deleteMany({ where: { tenantId: tenant } });
        await tx.voiceInteractionHandlingAttribution.deleteMany({ where: { tenantId: tenant } });
        await tx.interaction.deleteMany({ where: { tenantId: tenant } });
        await tx.queue.deleteMany({ where: { tenantId: tenant } });
        await tx.user.deleteMany({ where: { tenantId: tenant } });
        await tx.team.deleteMany({ where: { tenantId: tenant } });
        await tx.tenant.delete({ where: { id: tenant } });
      }
    });
  });
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/qm`;
  const http = async (
    bearer: string,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as Json) : {} };
  };
  return {
    tenantId,
    ids,
    call,
    http,
    tokens: {
      supervisorA: token(tenantId, ids.supervisorA, 'supervisor'),
      secondSupervisorA: token(tenantId, ids.secondSupervisorA, 'supervisor'),
      supervisorB: token(tenantId, ids.supervisorB, 'supervisor'),
      agentA: token(tenantId, ids.agentA, 'agent'),
      agentB: token(tenantId, ids.agentB, 'agent'),
      admin: token(tenantId, ids.admin, 'admin'),
      foreignSupervisor: token(foreignTenantId, ids.foreignSupervisor, 'supervisor'),
      foreignAdmin: token(foreignTenantId, ids.foreignAdmin, 'admin'),
      /** the token claims admin but the DB says Supervisor */
      forgedAdmin: token(tenantId, ids.supervisorA, 'admin'),
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function publishedForm(f: Fixture, name = 'Inbound call evaluation') {
  const created = await f.http(f.tokens.admin, 'POST', '/forms', {
    commandId: randomUUID(),
    name,
    definition: FORM,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const published = await f.http(
    f.tokens.admin,
    'POST',
    `/forms/${created.json.formId}/draft/publish`,
    {
      commandId: randomUUID(),
      revision: created.json.draft.revision,
    },
  );
  assert.equal(published.status, 200, JSON.stringify(published.json));
  return published.json;
}

test('the switch is off by default: every route returns 403 FEATURE_DISABLED', async (t) => {
  const f = await fixture(t, false);
  for (const [bearer, path] of [
    [f.tokens.admin, '/forms'],
    [f.tokens.supervisorA, '/team-interactions'],
    [f.tokens.agentA, '/my-evaluations'],
    [f.tokens.supervisorA, `/interactions/${randomUUID()}/transcript`],
  ] as const) {
    const response = await f.http(bearer, 'GET', path);
    assert.equal(response.status, 403);
    assert.equal(response.json.code, 'FEATURE_DISABLED');
  }
});

test('Admin creates, edits a draft, publishes and issues a new version; a published version cannot be edited', async (t) => {
  const f = await fixture(t, true);
  const created = await f.http(f.tokens.admin, 'POST', '/forms', {
    commandId: randomUUID(),
    name: '  Main form ',
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.name, 'Main form');
  assert.deepEqual(created.json.draft.definition, {
    scoreMethod: 'WEIGHTED_POINTS',
    requireCommentBelow: null,
    sections: [],
  });
  const formId = created.json.formId as string;

  // a duplicate name ignores case and whitespace
  const duplicate = await f.http(f.tokens.admin, 'POST', '/forms', {
    commandId: randomUUID(),
    name: 'Main form',
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.code, 'FORM_NAME_TAKEN');

  // an empty draft cannot be published
  const empty = await f.http(f.tokens.admin, 'POST', `/forms/${formId}/draft/publish`, {
    commandId: randomUUID(),
    revision: 1,
  });
  assert.equal(empty.status, 422);
  assert.deepEqual(empty.json.errors, [{ path: 'sections', code: 'EMPTY_FORM' }]);

  // a Supervisor does not yet see a form with no active version
  assert.deepEqual((await f.http(f.tokens.supervisorA, 'GET', '/forms')).json.items, []);

  const saved = await f.http(f.tokens.admin, 'PUT', `/forms/${formId}/draft`, {
    revision: 1,
    definition: FORM,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.draft.revision, 2);
  const stale = await f.http(f.tokens.admin, 'PUT', `/forms/${formId}/draft`, {
    revision: 1,
    definition: FORM,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'STALE_REVISION');

  const publishCommand = randomUUID();
  const published = await f.http(f.tokens.admin, 'POST', `/forms/${formId}/draft/publish`, {
    commandId: publishCommand,
    revision: 2,
  });
  assert.equal(published.status, 200);
  assert.equal(published.json.draft, null);
  assert.equal(published.json.current.version, 1);
  // retry with the same commandId gives the same result
  const replay = await f.http(f.tokens.admin, 'POST', `/forms/${formId}/draft/publish`, {
    commandId: publishCommand,
    revision: 2,
  });
  assert.deepEqual(replay.json, published.json);

  const listed = await f.http(f.tokens.supervisorA, 'GET', '/forms');
  assert.deepEqual(
    listed.json.items.map((item: Json) => [
      item.name,
      item.current.version,
      item.current.questionCount,
      'draft' in item,
    ]),
    [['Main form', 1, 4, false]],
  );

  // a published version cannot be edited directly in the DB
  await assert.rejects(
    owner.qmFormVersion.updateMany({
      where: { tenantId: f.tenantId, formId, version: 1 },
      data: { definition: { sections: [] } },
    }),
    /QM_FORM_VERSION_IMMUTABLE/,
  );
  await assert.rejects(
    owner.qmFormVersion.deleteMany({ where: { tenantId: f.tenantId, formId, version: 1 } }),
    /QM_FORM_VERSION_IMMUTABLE/,
  );

  // issue a new draft version from the active one, then publish it as the replacement
  const draft2 = await f.http(f.tokens.admin, 'POST', `/forms/${formId}/draft`, {
    commandId: randomUUID(),
  });
  assert.equal(draft2.status, 201);
  assert.equal(draft2.json.draft.version, 2);
  assert.deepEqual(draft2.json.draft.definition, published.json.current.definition);
  const again = await f.http(f.tokens.admin, 'POST', `/forms/${formId}/draft`, {
    commandId: randomUUID(),
  });
  assert.equal(again.json.code, 'DRAFT_EXISTS');
  const v2 = await f.http(f.tokens.admin, 'POST', `/forms/${formId}/draft/publish`, {
    commandId: randomUUID(),
    revision: draft2.json.draft.revision,
  });
  assert.deepEqual(
    v2.json.versions.map((version: Json) => [version.version, version.status]),
    [
      [2, 'PUBLISHED'],
      [1, 'SUPERSEDED'],
    ],
  );
  const audits = await owner.qmAuditEvent.count({
    where: { tenantId: f.tenantId, action: 'FORM_VERSION_PUBLISHED' },
  });
  assert.equal(audits, 2);
});

test('forms are usable only by a current Admin of the same tenant', async (t) => {
  const f = await fixture(t, true);
  const form = await publishedForm(f);
  // the role in the token is not enough; it must be ADMIN in the DB
  const forged = await f.http(f.tokens.forgedAdmin, 'POST', '/forms', {
    commandId: randomUUID(),
    name: 'Fake',
  });
  assert.equal(forged.status, 403);
  assert.equal((await f.http(f.tokens.supervisorA, 'GET', `/forms/${form.formId}`)).status, 403);
  // another tenant sees neither the list nor the details
  assert.deepEqual((await f.http(f.tokens.foreignAdmin, 'GET', '/forms')).json.items, []);
  assert.equal((await f.http(f.tokens.foreignAdmin, 'GET', `/forms/${form.formId}`)).status, 404);
  assert.equal(
    (await f.http(f.tokens.foreignSupervisor, 'GET', `/form-versions/${form.current.versionId}`))
      .status,
    404,
  );
  // a disabled Admin is rejected immediately
  await owner.user.update({ where: { id: f.ids.admin }, data: { isActive: false } });
  assert.equal((await f.http(f.tokens.admin, 'GET', '/forms')).status, 403);
});

test('a Supervisor evaluates calls answered by their own team, saves a draft, then publishes; an Agent sees their own result', async (t) => {
  const f = await fixture(t, true);
  const form = await publishedForm(f);
  const versionId = form.current.versionId as string;
  const teamCall = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    acceptedAt: '2026-11-20T03:00:00.000Z',
  });
  const otherTeamCall = await f.call({
    agentId: f.ids.agentB,
    team: f.ids.teamB,
    acceptedAt: '2026-11-20T04:00:00.000Z',
  });
  const ownCall = await f.call({
    agentId: f.ids.supervisorA,
    team: f.ids.teamA,
    acceptedAt: '2026-11-20T05:00:00.000Z',
  });
  await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    state: 'WRAPUP',
    acceptedAt: '2026-11-20T06:00:00.000Z',
  });
  await f.call({ agentId: f.ids.agentA, acceptedAt: '2026-11-20T07:00:00.000Z' });
  const range = '?from=2026-11-19T00:00:00.000Z&to=2026-11-21T00:00:00.000Z';

  const listed = await f.http(f.tokens.supervisorA, 'GET', `/team-interactions${range}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.json.items.map((item: Json) => [item.interactionId, item.agentName, item.evaluation]),
    [[teamCall, 'Agent A', null]],
  );

  // another team, another tenant, and a call they answered themselves
  assert.equal(
    (await f.http(f.tokens.supervisorA, 'GET', `/interactions/${otherTeamCall}/human-evaluation`))
      .status,
    404,
  );
  assert.equal(
    (await f.http(f.tokens.foreignSupervisor, 'GET', `/interactions/${teamCall}/human-evaluation`))
      .status,
    404,
  );
  const self = await f.http(
    f.tokens.supervisorA,
    'GET',
    `/interactions/${ownCall}/human-evaluation`,
  );
  assert.equal(self.status, 403);
  assert.equal(self.json.code, 'SELF_EVALUATION_NOT_ALLOWED');

  const empty = await f.http(
    f.tokens.supervisorA,
    'GET',
    `/interactions/${teamCall}/human-evaluation`,
  );
  assert.equal(empty.json.evaluation, null);
  assert.equal(empty.json.interaction.agentName, 'Agent A');

  // first draft: incomplete answers are allowed, no score yet
  const firstCommand = randomUUID();
  const firstBody = {
    commandId: firstCommand,
    formVersionId: versionId,
    answers: { greet: { value: true } },
  };
  const first = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${teamCall}/human-evaluation`,
    firstBody,
  );
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.evaluation.status, 'DRAFT');
  assert.equal(first.json.evaluation.revision, 1);
  assert.equal(first.json.evaluation.score, null);
  assert.deepEqual(first.json.evaluation.progress, { answered: 1, required: 3 });
  assert.equal(first.json.evaluation.form.formName, 'Inbound call evaluation');

  // retry with the same commandId does not create a duplicate result; a different payload gets a conflict
  const replay = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${teamCall}/human-evaluation`,
    firstBody,
  );
  assert.deepEqual(replay.json, first.json);
  const mismatch = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${teamCall}/human-evaluation`,
    {
      ...firstBody,
      answers: {},
    },
  );
  assert.equal(mismatch.json.code, 'COMMAND_PAYLOAD_MISMATCH');
  assert.equal(await owner.qmEvaluation.count({ where: { tenantId: f.tenantId } }), 1);

  // stale draft
  const stale = await f.http(
    f.tokens.secondSupervisorA,
    'PUT',
    `/interactions/${teamCall}/human-evaluation`,
    {
      commandId: randomUUID(),
      formVersionId: versionId,
      answers: {},
    },
  );
  assert.equal(stale.json.code, 'STALE_REVISION');

  // publish with incomplete answers
  const incomplete = await f.http(
    f.tokens.supervisorA,
    'POST',
    `/interactions/${teamCall}/human-evaluation/publish`,
    {
      commandId: randomUUID(),
      revision: 1,
    },
  );
  assert.equal(incomplete.status, 422);
  assert.deepEqual(
    incomplete.json.errors.map((e: Json) => e.path),
    ['answers.verify', 'answers.tone'],
  );

  // fully answered but auto-fail and no comment — a score below the threshold must have a reason
  const complete = await f.http(
    f.tokens.secondSupervisorA,
    'PUT',
    `/interactions/${teamCall}/human-evaluation`,
    {
      commandId: randomUUID(),
      formVersionId: versionId,
      revision: 1,
      answers: {
        greet: { value: true },
        verify: { value: false },
        tone: { value: 4 },
        note: { value: 'Polite' },
      },
    },
  );
  assert.equal(complete.status, 200);
  assert.equal(complete.json.evaluation.score.preview, true);
  assert.equal(complete.json.evaluation.score.finalScore, 0);
  assert.equal(complete.json.evaluation.evaluatorName, 'Supervisor A2');
  const noComment = await f.http(
    f.tokens.supervisorA,
    'POST',
    `/interactions/${teamCall}/human-evaluation/publish`,
    {
      commandId: randomUUID(),
      revision: 2,
    },
  );
  assert.deepEqual(noComment.json.errors, [{ path: 'comment', code: 'COMMENT_REQUIRED' }]);

  const commented = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${teamCall}/human-evaluation`,
    {
      commandId: randomUUID(),
      formVersionId: versionId,
      revision: 2,
      answers: complete.json.evaluation.answers,
      comment: 'Did not verify identity before disclosing information',
    },
  );
  assert.equal(commented.json.evaluation.revision, 3);

  const publishCommand = randomUUID();
  const published = await f.http(
    f.tokens.supervisorA,
    'POST',
    `/interactions/${teamCall}/human-evaluation/publish`,
    {
      commandId: publishCommand,
      revision: 3,
    },
  );
  assert.equal(published.status, 200, JSON.stringify(published.json));
  const evaluation = published.json.evaluation;
  assert.equal(evaluation.status, 'PUBLISHED');
  // opening (10/20 = 50%) × 20 + solve ((4-1)/(5-1) = 75%) × 80 = 70; auto-fail → final 0
  assert.deepEqual(
    { ...evaluation.score },
    {
      preview: false,
      rawScore: 70,
      finalScore: 0,
      autoFailed: true,
      sections: [
        { sectionId: 'opening', score: 50 },
        { sectionId: 'solve', score: 75 },
      ],
    },
  );
  assert.equal(evaluation.evaluatorName, 'Supervisor A');
  const publishReplay = await f.http(
    f.tokens.supervisorA,
    'POST',
    `/interactions/${teamCall}/human-evaluation/publish`,
    {
      commandId: publishCommand,
      revision: 3,
    },
  );
  assert.deepEqual(publishReplay.json, published.json);

  // once published it cannot be edited, through the API or directly in the DB
  const edit = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${teamCall}/human-evaluation`,
    {
      commandId: randomUUID(),
      formVersionId: versionId,
      revision: 4,
      answers: {},
    },
  );
  assert.equal(edit.json.code, 'EVALUATION_PUBLISHED');
  await assert.rejects(
    owner.qmEvaluation.update({ where: { id: evaluation.evaluationId }, data: { comment: 'x' } }),
    /QM_EVALUATION_IMMUTABLE/,
  );
  await assert.rejects(
    owner.qmEvaluation.delete({ where: { id: evaluation.evaluationId } }),
    /QM_EVALUATION_IMMUTABLE/,
  );
  const audit = await owner.qmAuditEvent.findFirstOrThrow({
    where: {
      tenantId: f.tenantId,
      action: 'EVALUATION_PUBLISHED',
      resourceId: evaluation.evaluationId,
    },
  });
  assert.equal((audit.details as Json).source, 'HUMAN');

  // the Supervisor list shows status and score
  const afterList = await f.http(
    f.tokens.supervisorA,
    'GET',
    `/team-interactions${range}&status=PUBLISHED`,
  );
  assert.deepEqual(afterList.json.items[0].evaluation, {
    evaluationId: evaluation.evaluationId,
    status: 'PUBLISHED',
    finalScore: 0,
  });
  assert.deepEqual(
    (await f.http(f.tokens.supervisorA, 'GET', `/team-interactions${range}&status=NOT_EVALUATED`))
      .json.items,
    [],
  );

  // the Agent sees their own result with per-item answers from the snapshot
  const mine = await f.http(f.tokens.agentA, 'GET', '/my-evaluations');
  assert.equal(mine.status, 200);
  assert.deepEqual(
    mine.json.items.map((item: Json) => [
      item.evaluationId,
      item.formName,
      item.finalScore,
      item.rawScore,
      item.autoFailed,
    ]),
    [[evaluation.evaluationId, 'Inbound call evaluation', 0, 70, true]],
  );
  const detail = await f.http(f.tokens.agentA, 'GET', `/my-evaluations/${evaluation.evaluationId}`);
  assert.equal(detail.json.comment, 'Did not verify identity before disclosing information');
  assert.deepEqual(detail.json.answers.verify, { value: false });
  assert.equal(detail.json.form.definition.sections.length, 2);
  // another Agent cannot see it
  assert.deepEqual((await f.http(f.tokens.agentB, 'GET', '/my-evaluations')).json.items, []);
  assert.equal(
    (await f.http(f.tokens.agentB, 'GET', `/my-evaluations/${evaluation.evaluationId}`)).status,
    404,
  );
  // a Supervisor of another team does not see the details
  assert.equal(
    (await f.http(f.tokens.supervisorB, 'GET', `/interactions/${teamCall}/human-evaluation`))
      .status,
    404,
  );
});

test('an Agent does not see drafts, and a Supervisor who moves team loses access immediately', async (t) => {
  const f = await fixture(t, true);
  const form = await publishedForm(f);
  const teamCall = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    acceptedAt: '2026-11-20T03:00:00.000Z',
  });
  const draftCommand = randomUUID();
  const draft = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${teamCall}/human-evaluation`,
    {
      commandId: draftCommand,
      formVersionId: form.current.versionId,
      answers: { greet: { value: true }, verify: { value: true }, tone: { na: true } },
    },
  );
  assert.equal(draft.status, 200);
  // a retry with a different answer key order is still the same command
  const reordered = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${teamCall}/human-evaluation`,
    {
      answers: { tone: { na: true }, verify: { value: true }, greet: { value: true } },
      formVersionId: form.current.versionId,
      commandId: draftCommand,
    },
  );
  assert.deepEqual(reordered.json, draft.json);
  assert.deepEqual((await f.http(f.tokens.agentA, 'GET', '/my-evaluations')).json.items, []);
  assert.equal(
    (await f.http(f.tokens.agentA, 'GET', `/my-evaluations/${draft.json.evaluation.evaluationId}`))
      .status,
    404,
  );

  await owner.user.update({ where: { id: f.ids.supervisorA }, data: { teamId: f.ids.teamB } });
  // the original receipt does not return a result to someone who lost access
  const replayAfterMove = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${teamCall}/human-evaluation`,
    {
      commandId: draftCommand,
      formVersionId: form.current.versionId,
      answers: { greet: { value: true }, verify: { value: true }, tone: { na: true } },
    },
  );
  assert.equal(replayAfterMove.status, 404);
  assert.equal(
    (await f.http(f.tokens.supervisorA, 'GET', `/interactions/${teamCall}/human-evaluation`))
      .status,
    404,
  );
  const publish = await f.http(
    f.tokens.supervisorA,
    'POST',
    `/interactions/${teamCall}/human-evaluation/publish`,
    {
      commandId: randomUUID(),
      revision: 1,
    },
  );
  assert.equal(publish.status, 404);
});

test('an existing draft can continue on a replaced form version, but a new draft must use the current version', async (t) => {
  const f = await fixture(t, true);
  const form = await publishedForm(f);
  const v1 = form.current.versionId as string;
  const callA = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    acceptedAt: '2026-11-20T03:00:00.000Z',
  });
  const callB = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    acceptedAt: '2026-11-20T04:00:00.000Z',
  });
  const started = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${callA}/human-evaluation`,
    {
      commandId: randomUUID(),
      formVersionId: v1,
      answers: { greet: { value: true } },
    },
  );
  assert.equal(started.status, 200);

  const draft2 = await f.http(f.tokens.admin, 'POST', `/forms/${form.formId}/draft`, {
    commandId: randomUUID(),
  });
  await f.http(f.tokens.admin, 'PUT', `/forms/${form.formId}/draft`, {
    revision: draft2.json.draft.revision,
    name: 'Inbound call evaluation v2',
    definition: { ...FORM, requireCommentBelow: null },
  });
  const v2 = await f.http(f.tokens.admin, 'POST', `/forms/${form.formId}/draft/publish`, {
    commandId: randomUUID(),
    revision: draft2.json.draft.revision + 1,
  });
  assert.equal(v2.status, 200);

  const fresh = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${callB}/human-evaluation`,
    {
      commandId: randomUUID(),
      formVersionId: v1,
      answers: {},
    },
  );
  assert.equal(fresh.json.code, 'FORM_VERSION_NOT_AVAILABLE');

  const continued = await f.http(
    f.tokens.supervisorA,
    'PUT',
    `/interactions/${callA}/human-evaluation`,
    {
      commandId: randomUUID(),
      formVersionId: v1,
      revision: 1,
      answers: { greet: { value: true }, verify: { value: true }, tone: { value: 5 } },
    },
  );
  assert.equal(continued.status, 200);
  // the snapshot keeps the original form name and version
  assert.equal(continued.json.evaluation.form.formName, 'Inbound call evaluation');
  assert.equal(continued.json.evaluation.form.version, 1);
  const published = await f.http(
    f.tokens.supervisorA,
    'POST',
    `/interactions/${callA}/human-evaluation/publish`,
    {
      commandId: randomUUID(),
      revision: 2,
    },
  );
  assert.equal(published.status, 200);
  assert.equal(published.json.evaluation.score.finalScore, 100);
});

test('a Supervisor reads the transcript of a team call beside the form; every read of text is audited', async (t) => {
  const f = await fixture(t, true);
  const teamCall = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    acceptedAt: '2026-11-20T03:00:00.000Z',
  });
  const path = `/interactions/${teamCall}/transcript`;
  const read = () => f.http(f.tokens.supervisorA, 'GET', path);
  const accessAudits = () =>
    owner.qmAuditEvent.findMany({
      where: { tenantId: f.tenantId, action: 'TRANSCRIPT_ACCESSED' },
    });

  assert.deepEqual((await read()).json, {
    status: 'NOT_REQUESTED',
    failureCode: null,
    transcript: null,
  });

  const recording = await owner.recording.create({
    data: {
      tenantId: f.tenantId,
      interactionId: teamCall,
      storageKey: `recordings/${teamCall}.wav`,
      telephonyPath: `/recordings/${teamCall}.wav`,
      startedAt: new Date('2026-11-20T03:00:01.000Z'),
      endedAt: new Date('2026-11-20T03:01:00.000Z'),
    },
  });
  const job = await owner.qmTranscriptionJob.create({
    data: {
      tenantId: f.tenantId,
      interactionId: teamCall,
      recordingId: recording.id,
      trigger: 'AUTOMATIC',
      languageHint: 'th-TH',
      maxAttempts: 3,
    },
  });
  assert.equal((await read()).json.status, 'PROCESSING');
  await owner.qmTranscriptionJob.update({
    where: { id: job.id },
    data: { status: 'FAILED', failureCode: 'AbortError' },
  });
  // a provider exception name is not a contract: it reaches the UI as TRANSCRIPTION_ERROR
  assert.deepEqual((await read()).json, {
    status: 'FAILED',
    failureCode: 'TRANSCRIPTION_ERROR',
    transcript: null,
  });
  await owner.qmTranscriptionJob.update({
    where: { id: job.id },
    data: { failureCode: 'RECORDING_NOT_ARCHIVED' },
  });
  assert.equal((await read()).json.failureCode, 'RECORDING_NOT_ARCHIVED');
  assert.equal((await accessAudits()).length, 0);

  await owner.qmTranscriptionJob.update({ where: { id: job.id }, data: { status: 'READY' } });
  const transcript = await owner.qmTranscript.create({
    data: {
      tenantId: f.tenantId,
      interactionId: teamCall,
      recordingId: recording.id,
      jobId: job.id,
      providerId: 'test-asr',
      modelId: 'test-model',
      language: 'th-TH',
      confidenceAvg: 0.9,
      baseline: {},
    },
  });
  // inserted out of order: the API returns them by time
  await owner.qmTranscriptSegment.createMany({
    data: [
      { speaker: 'CONTACT' as const, startMs: 2500, endMs: 4000, text: 'second line' },
      { speaker: 'AGENT' as const, startMs: 500, endMs: 2000, text: 'first line' },
    ].map((segment) => ({ ...segment, tenantId: f.tenantId, transcriptId: transcript.id })),
  });
  const ready = await read();
  assert.equal(ready.status, 200, JSON.stringify(ready.json));
  assert.equal(ready.json.status, 'READY');
  assert.equal(ready.json.transcript.transcriptId, transcript.id);
  assert.equal(ready.json.transcript.language, 'th-TH');
  assert.deepEqual(
    ready.json.transcript.segments.map((segment: Json) => [
      segment.speaker,
      segment.startMs,
      segment.endMs,
      segment.text,
    ]),
    [
      ['AGENT', 500, 2000, 'first line'],
      ['CONTACT', 2500, 4000, 'second line'],
    ],
  );
  const audits = await accessAudits();
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actorUserId, f.ids.supervisorA);
  assert.equal(audits[0]!.resourceId, transcript.id);
  const details = audits[0]!.details as Json;
  assert.equal(details.via, 'HUMAN_EVALUATION');
  assert.equal(details.interactionId, teamCall);
  assert.match(String(details.ip), /127\.0\.0\.1/);

  // the same gate as the evaluation: another team, another tenant, the Agent role and an unfinished call
  assert.equal((await f.http(f.tokens.supervisorB, 'GET', path)).status, 404);
  assert.equal((await f.http(f.tokens.foreignSupervisor, 'GET', path)).status, 404);
  assert.equal((await f.http(f.tokens.agentA, 'GET', path)).status, 403);
  assert.equal((await f.http(f.tokens.admin, 'GET', path)).status, 403);
  // a call the Supervisor answered themselves
  const ownCall = await f.call({
    agentId: f.ids.supervisorA,
    team: f.ids.teamA,
    acceptedAt: '2026-11-20T05:00:00.000Z',
  });
  const self = await f.http(f.tokens.supervisorA, 'GET', `/interactions/${ownCall}/transcript`);
  assert.equal(self.status, 403);
  assert.equal(self.json.code, 'SELF_EVALUATION_NOT_ALLOWED');
  const wrapUp = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    state: 'WRAPUP',
    acceptedAt: '2026-11-20T04:00:00.000Z',
  });
  assert.equal(
    (await f.http(f.tokens.supervisorA, 'GET', `/interactions/${wrapUp}/transcript`)).status,
    404,
  );
  assert.equal((await accessAudits()).length, 1);

  // ADR-010 item 4: the transcript outlives the audio, so it is still readable after retention deletes the recording
  await owner.recording.update({ where: { id: recording.id }, data: { deletedAt: new Date() } });
  const afterDelete = await read();
  assert.equal(afterDelete.json.status, 'READY');
  assert.equal(afterDelete.json.transcript.segments.length, 2);
  assert.equal((await accessAudits()).length, 2);
});
