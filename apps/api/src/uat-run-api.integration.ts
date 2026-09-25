/**
 * U1.1 (#429) acceptance — UAT fixture pack, run record และ `เริ่มรอบใหม่` ผ่าน HTTP จริง
 * (guard + IAM grant + RLS บน Postgres); mock ได้เฉพาะ token verifier และความล้มของ port ภายนอก
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { JourneyAuthoringCapability } from '@d-contact/cxa-contracts';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import {
  JourneyTemplateRepository,
  UatFixtureProvisioner,
  UatJourneyWriteGuard,
  UatRunError,
  UatRunRepository,
  importJourneyDefinition,
  type JourneyDefinitionContent,
  type UatJourneyAuthoringPort,
} from '@d-contact/journey';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import {
  JOURNEY_AUTHORING_REPOSITORY,
  JourneyAuthoringController,
} from './journey-authoring-api.js';
import { UAT_RUN_REPOSITORY, UatRunController } from './uat-run-api.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../journey/test/fixtures/j5/j1-schedule.json'), 'utf8'),
) as JourneyDefinitionContent;

type Persona = 'maker' | 'reviewer' | 'outsider' | 'foreign';

async function harness(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  t.after(() => Promise.all([owner.$disconnect(), application.$disconnect()]));
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const teamId = randomUUID();
  const users: Record<Persona, string> = {
    maker: randomUUID(),
    reviewer: randomUUID(),
    outsider: randomUUID(),
    foreign: randomUUID(),
  };
  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: {
        id,
        name: `U1.1 ${id.slice(0, 8)}`,
        slug: `u1-1-${id.slice(0, 8)}`,
        sipDomain: `${id.slice(0, 8)}.u1-1.test`,
      },
    });
    await owner.jrAuthoringRolloutState.create({
      data: {
        tenantId: id,
        stage: 'INTERNAL_SYNTHETIC',
        canvasWriteEnabled: true,
        publishUiEnabled: true,
        updatedByRef: 'ops',
        evidenceRef: 'u1-1-test',
      },
    });
  }
  await owner.team.create({ data: { id: teamId, tenantId, name: `u1-1-${teamId}` } });
  const grants: Array<[Persona, JourneyAuthoringCapability]> = [
    ['maker', 'journey.read'],
    ['maker', 'journey.edit'],
    ['maker', 'journey.publish'],
    ['reviewer', 'journey.read'],
    ['reviewer', 'journey.review'],
    ['outsider', 'journey.read'],
  ];
  for (const persona of ['maker', 'reviewer', 'outsider'] as const) {
    await owner.iamAuthoringSubject.create({
      data: { tenantId, subjectId: users[persona], authenticationStrength: 'STANDARD' },
    });
  }
  for (const [persona, capability] of grants) {
    await owner.iamAuthoringCapabilityGrant.create({
      data: {
        tenantId,
        subjectId: users[persona],
        capability,
        scopeKind: 'TEAM',
        scopeId: teamId,
        grantedByRef: 'iam-admin',
      },
    });
  }

  const verifier = {
    verifyAccessToken: async (token: string): Promise<VerifiedOidcClaims> => {
      if (!(token in users)) throw new Error('token ไม่ถูกต้อง');
      const persona = token as Persona;
      const tenant = persona === 'foreign' ? otherTenantId : tenantId;
      const slug = `u1-1-${tenant.slice(0, 8)}`;
      return {
        tenant_id: tenant,
        tenant_slug: slug,
        organization: { [slug]: { tenant_id: [tenant] } },
        azp: 'console',
        sub: users[persona],
        preferred_username: persona,
        exp: 2_000_000_000,
        realm_access: { roles: ['admin'] },
        dc_user_id: users[persona],
        sid: `${persona}-session`,
      };
    },
  };
  const authoring = new JourneyTemplateRepository(application, {
    authorization: new IamJourneyAuthoringAuthorizer(),
    evaluator: new DcExprEvaluator(),
    flags: { canvasWrite: true, publishUi: true, templateCatalog: false, templateUpgrade: false },
    writeGuard: new UatJourneyWriteGuard(),
  });
  // port ของ J5 ที่ inject ความล้มได้ — จำลอง crash ระหว่างช่วงที่ 1 กับ 3 ของ `เริ่มรอบใหม่`
  const port = {
    failNext: false,
    async createJourneyDraft(...args: Parameters<UatJourneyAuthoringPort['createJourneyDraft']>) {
      if (port.failNext) {
        port.failNext = false;
        throw new Error('simulated crash before Journey draft');
      }
      return authoring.createJourneyDraft(...args);
    },
  };
  const runs = new UatRunRepository(application, port);

  @Module({
    controllers: [JourneyAuthoringController, UatRunController],
    providers: [
      { provide: JOURNEY_AUTHORING_REPOSITORY, useValue: authoring },
      { provide: UAT_RUN_REPOSITORY, useValue: runs },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const port_ = (app.getHttpServer().address() as AddressInfo).port;

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    persona: Persona,
    init: { key?: string | null; body?: unknown } = {},
  ) => {
    const key = init.key === undefined && method !== 'GET' ? `key-${randomUUID()}` : init.key;
    const response = await fetch(`http://127.0.0.1:${port_}/api/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${persona}`,
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const manifest = (overrides: Record<string, unknown> = {}) => ({
    schema: 'UatFixturePackV1',
    environment: 'uat',
    packVersion: 'pack-1',
    buildSha: 'a1b2c3d4e5f6',
    tenantId,
    ownerTeamId: teamId,
    makerSubjectId: users.maker,
    reviewerSubjectId: users.reviewer,
    senderRef: 'sender-synthetic-1',
    contentRef: 'content-synthetic-1',
    baselineDocument: importJourneyDefinition({ ...fixture, ownerTeamId: teamId }),
    simulationFixture: {
      fixtureId: 'uat-fx-1',
      startAt: '2026-09-01T00:00:00.000Z',
      seed: 'uat-seed-1',
      context: {},
    },
    steps: [
      { stepId: 'LOGIN', title: 'Login', expected: 'เห็น Journey list', stateLabel: 'REAL_STATE' },
      {
        stepId: 'SIMULATE',
        title: 'Simulate',
        expected: 'เห็น transitions ที่ติดป้ายจำลอง',
        stateLabel: 'SIMULATION_ONLY',
      },
    ],
    ...overrides,
  });
  const provisioner = new UatFixtureProvisioner(owner);

  /** provision pack แล้วเปิด run แรก */
  const started = async () => {
    await provisioner.provision(manifest());
    const run = await call('POST', 'uat-runs/start', 'maker', {
      body: { environment: 'uat', packVersion: 'pack-1', expectedRevision: 0 },
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    return run.body as { runId: string; journeyId: string; revision: number };
  };

  /** compile + submit review ของ Journey ใน run */
  const submitReview = async (journeyId: string) => {
    const state = (await call('GET', `journey-authoring/journeys/${journeyId}`, 'maker')).body;
    const binding = {
      draftRevision: state.head.currentDraftRevision,
      draftDigest: state.head.currentDraftDigest,
    };
    const compiled = await call(
      'POST',
      `journey-authoring/journeys/${journeyId}/compile`,
      'maker',
      {
        body: { ...binding, expectedHeadVersion: state.head.version },
      },
    );
    assert.equal(compiled.status, 200, JSON.stringify(compiled.body));
    const artifact = compiled.body.artifact;
    const candidate = {
      ...binding,
      compileDigest: artifact.compileDigest,
      referenceDigest: artifact.referenceDigest,
      capabilityDigest: artifact.capabilityDigest,
      baseHeadVersion: state.head.version,
      baseHeadDigest: null,
    };
    const review = await call('POST', `journey-authoring/journeys/${journeyId}/reviews`, 'maker', {
      body: candidate,
    });
    return { review, candidate, compileDigest: artifact.compileDigest as string };
  };

  return {
    owner,
    tenantId,
    teamId,
    users,
    call,
    manifest,
    provisioner,
    started,
    submitReview,
    port,
  };
}

test('U1.1 provision: idempotent, digest ต่าง fail closed, preflight และ manifest ที่มี PII ถูกปฏิเสธ', async (t) => {
  const f = await harness(t);
  const created = await f.provisioner.provision(f.manifest());
  assert.equal(created.status, 'CREATED');
  const again = await f.provisioner.provision(f.manifest());
  assert.deepEqual(again, { ...created, status: 'UNCHANGED' });
  assert.equal(await f.owner.uatFixturePack.count({ where: { tenantId: f.tenantId } }), 1);

  const rejects = async (value: unknown, code: UatRunError['code'], safeParams?: object) =>
    assert.rejects(f.provisioner.provision(value), (error: unknown) => {
      assert.ok(error instanceof UatRunError, String(error));
      assert.equal(error.code, code);
      if (safeParams) assert.deepEqual(error.safeParams, safeParams);
      return true;
    });
  await rejects(f.manifest({ buildSha: 'ffffffffffff' }), 'FIXTURE_PACK_DIGEST_MISMATCH');
  await rejects(
    f.manifest({ packVersion: 'pack-2', reviewerSubjectId: f.users.outsider }),
    'FIXTURE_PREFLIGHT_FAILED',
    { check: 'REVIEWER_GRANTS' },
  );
  await rejects(
    f.manifest({ packVersion: 'pack-3', tenantId: randomUUID() }),
    'FIXTURE_PREFLIGHT_FAILED',
    { check: 'TENANT_BINDING' },
  );
  await rejects(
    f.manifest({ packVersion: 'pack-4', senderRef: 'tester@example.com' }),
    'FIXTURE_MANIFEST_INVALID',
    {
      kind: 'EMAIL',
    },
  );
  await rejects(
    f.manifest({ packVersion: 'pack-5', reviewerSubjectId: f.users.maker }),
    'FIXTURE_MANIFEST_INVALID',
    { field: 'reviewerSubjectId' },
  );
  // ไม่มีอะไรถูกเขียนจาก pack ที่ถูกปฏิเสธ
  assert.equal(await f.owner.uatFixturePack.count({ where: { tenantId: f.tenantId } }), 1);
});

test('U1.1 เริ่มรอบใหม่: เฉพาะ maker, idempotent, revision CAS, resume หลัง crash และไม่รั่วข้าม tenant', async (t) => {
  const f = await harness(t);
  await f.provisioner.provision(f.manifest());
  assert.deepEqual((await f.call('GET', 'uat-runs/current', 'maker')).body, {
    code: 'UAT_RUN_NOT_FOUND',
  });
  const body = { environment: 'uat', packVersion: 'pack-1', expectedRevision: 0 };

  const byReviewer = await f.call('POST', 'uat-runs/start', 'reviewer', { body });
  assert.deepEqual([byReviewer.status, byReviewer.body.code], [403, 'UAT_CAPABILITY_REQUIRED']);

  // crash หลังเปิด run ก่อนสร้าง Journey → key เดิมทำต่อจนจบ ได้ run เดียว Journey เดียว
  const key = `start-${randomUUID()}`;
  f.port.failNext = true;
  const crashed = await f.call('POST', 'uat-runs/start', 'maker', { key, body });
  assert.equal(crashed.status, 500);
  const first = await f.call('POST', 'uat-runs/start', 'maker', { key, body });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.sequence, 1);
  assert.equal(first.body.lifecycle, 'ACTIVE');
  assert.match(first.body.journeyId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(first.body.fixturePack.packVersion, 'pack-1');
  const replay = await f.call('POST', 'uat-runs/start', 'maker', { key, body });
  assert.deepEqual(replay, first);
  assert.equal(await f.owner.uatRun.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.jrJourneyHead.count({ where: { tenantId: f.tenantId } }), 1);

  const conflict = await f.call('POST', 'uat-runs/start', 'maker', {
    key,
    body: { ...body, expectedRevision: 5 },
  });
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'IDEMPOTENCY_CONFLICT']);
  // key เดิมจากผู้ทดสอบอีกคนไม่ได้ผลของ maker
  const borrowed = await f.call('POST', 'uat-runs/start', 'reviewer', { key, body });
  assert.deepEqual([borrowed.status, borrowed.body.code], [409, 'IDEMPOTENCY_CONFLICT']);
  const stale = await f.call('POST', 'uat-runs/start', 'maker', { body });
  assert.deepEqual(
    [stale.status, stale.body.code, stale.body.safeParams],
    [409, 'REVISION_CONFLICT', { currentRevision: first.body.revision }],
  );

  const current = await f.call('GET', 'uat-runs/current', 'reviewer');
  assert.deepEqual(current.body, first.body);
  // Journey ของ run เป็น draft จริงของ J5
  const journey = await f.call(
    'GET',
    `journey-authoring/journeys/${first.body.journeyId}`,
    'maker',
  );
  assert.equal(journey.status, 200);

  for (const persona of ['outsider', 'foreign'] as const) {
    const hidden = await f.call('GET', `uat-runs/${first.body.runId}`, persona);
    assert.deepEqual([hidden.status, hidden.body], [404, { code: 'UAT_RUN_NOT_FOUND' }], persona);
  }
});

test('U1.1 fixture ที่ server ตรึงให้ simulation ซ้ำได้ผลเดิม และ step result มาจาก catalog', async (t) => {
  const f = await harness(t);
  const run = await f.started();

  const fixtureA = await f.call('GET', 'uat-runs/current/simulation-fixture', 'maker');
  const fixtureB = await f.call('GET', 'uat-runs/current/simulation-fixture', 'reviewer');
  assert.equal(fixtureA.status, 200);
  assert.deepEqual(fixtureA.body, fixtureB.body);
  assert.equal(fixtureA.body.fixture.startAt, '2026-09-01T00:00:00.000Z');

  const { compileDigest } = await f.submitReview(run.journeyId);
  const simulate = () =>
    f.call('POST', `journey-authoring/journeys/${run.journeyId}/simulations`, 'maker', {
      body: { compileDigest, fixture: fixtureA.body.fixture },
    });
  const [first, second] = [await simulate(), await simulate()];
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.profile, 'SIMULATION_ONLY');
  assert.deepEqual(first.body, second.body);

  const key = `step-${randomUUID()}`;
  const recorded = await f.call('POST', `uat-runs/${run.runId}/step-results`, 'reviewer', {
    key,
    body: { stepId: 'SIMULATE', outcome: 'PASS', actual: 'เห็นป้ายจำลองเท่านั้น' },
  });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.stateLabel, 'SIMULATION_ONLY');
  assert.equal(recorded.body.expected, 'เห็น transitions ที่ติดป้ายจำลอง');
  assert.deepEqual(
    await f.call('POST', `uat-runs/${run.runId}/step-results`, 'reviewer', {
      key,
      body: { stepId: 'SIMULATE', outcome: 'PASS', actual: 'เห็นป้ายจำลองเท่านั้น' },
    }),
    recorded,
  );
  const unknownStep = await f.call('POST', `uat-runs/${run.runId}/step-results`, 'maker', {
    body: { stepId: 'NOT_IN_CATALOG', outcome: 'PASS', actual: 'x' },
  });
  assert.deepEqual([unknownStep.status, unknownStep.body.safeParams], [400, { field: 'stepId' }]);
  const failWithoutSeverity = await f.call('POST', `uat-runs/${run.runId}/step-results`, 'maker', {
    body: { stepId: 'LOGIN', outcome: 'FAIL', actual: 'ล็อกอินไม่ได้' },
  });
  assert.deepEqual(
    [failWithoutSeverity.status, failWithoutSeverity.body.safeParams],
    [400, { field: 'severity' }],
  );
  const current = await f.call('GET', 'uat-runs/current', 'maker');
  assert.equal(current.body.stepResults.length, 1);
});

test('U1.1 run ที่มีงานค้างปิดไม่ได้; run ที่ abandoned ถูกแช่แข็งแต่หลักฐานยังอ่านได้; publish แล้ว = COMPLETED', async (t) => {
  const f = await harness(t);
  const run1 = await f.started();
  const restart = (expectedRevision: number) =>
    f.call('POST', 'uat-runs/start', 'maker', {
      body: { environment: 'uat', packVersion: 'pack-1', expectedRevision },
    });

  const { review, candidate } = await f.submitReview(run1.journeyId);
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const pendingReview = await restart(run1.revision);
  assert.deepEqual(
    [pendingReview.status, pendingReview.body],
    [409, { code: 'UAT_RUN_PENDING_REVIEW', safeParams: { nextSafeAction: 'DECIDE_REVIEW' } }],
  );
  const approved = await f.call(
    'POST',
    `journey-authoring/reviews/${review.body.reviewId}/decisions`,
    'reviewer',
    {
      body: {
        expectedReviewState: 'IN_REVIEW',
        decision: 'APPROVE',
        reasonCode: 'LOOKS_GOOD',
        evidenceRef: 'uat-run-1',
      },
    },
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const pendingPublish = await restart(run1.revision);
  assert.equal(pendingPublish.body.code, 'UAT_RUN_PENDING_PUBLISH');

  // publish แล้วเริ่มรอบใหม่ → run 1 COMPLETED
  const published = await f.call(
    'POST',
    `journey-authoring/journeys/${run1.journeyId}/publish`,
    'maker',
    {
      body: {
        reviewId: review.body.reviewId,
        ...candidate,
        expectedHeadVersion: candidate.baseHeadVersion,
      },
    },
  );
  assert.equal(published.status, 200, JSON.stringify(published.body));
  await f.call('POST', `uat-runs/${run1.runId}/step-results`, 'maker', {
    body: { stepId: 'LOGIN', outcome: 'PASS', actual: 'เห็น Journey list' },
  });
  const run2 = await restart(run1.revision);
  assert.equal(run2.status, 200, JSON.stringify(run2.body));
  assert.equal(run2.body.sequence, 2);
  const closed1 = await f.call('GET', `uat-runs/${run1.runId}`, 'reviewer');
  assert.equal(closed1.body.lifecycle, 'COMPLETED');
  assert.equal(closed1.body.stepResults.length, 1, 'หลักฐานรอบเดิมยังอยู่');

  // run 2 ไม่ได้ publish → เริ่มรอบใหม่ = ABANDONED และ Journey ของมันถูกแช่แข็ง
  const run3 = await restart(run2.body.revision);
  assert.equal(run3.status, 200, JSON.stringify(run3.body));
  const closed2 = await f.call('GET', `uat-runs/${run2.body.runId}`, 'maker');
  assert.equal(closed2.body.lifecycle, 'ABANDONED');
  // compile อ่านอย่างเดียวยังทำได้ แต่ส่งตรวจ (และ mutation อื่นที่ผ่าน lock ของ J5) ไม่ได้
  const frozen = await f.submitReview(run2.body.journeyId);
  assert.deepEqual(
    [frozen.review.status, frozen.review.body],
    [409, { code: 'JOURNEY_LIFECYCLE_CONFLICT', safeParams: { reason: 'UAT_RUN_CLOSED' } }],
  );
  const state = (await f.call('GET', `journey-authoring/journeys/${run2.body.journeyId}`, 'maker'))
    .body;
  const edit = await f.call(
    'PUT',
    `journey-authoring/journeys/${run2.body.journeyId}/draft`,
    'maker',
    {
      body: {
        expectedHeadVersion: state.head.version,
        expectedDraftRevision: state.head.currentDraftRevision,
        expectedDraftDigest: state.head.currentDraftDigest,
        document: f.manifest().baselineDocument,
      },
    },
  );
  assert.deepEqual(
    [edit.status, edit.body],
    [409, { code: 'JOURNEY_LIFECYCLE_CONFLICT', safeParams: { reason: 'UAT_RUN_CLOSED' } }],
  );
  const lateResult = await f.call('POST', `uat-runs/${run2.body.runId}/step-results`, 'maker', {
    body: { stepId: 'LOGIN', outcome: 'PASS', actual: 'x' },
  });
  assert.deepEqual([lateResult.status, lateResult.body.code], [409, 'UAT_RUN_CLOSED']);
  // audit ของ Journey รอบเดิมยังอ่านได้ผ่าน API
  const audit = await f.call('GET', `journey-authoring/journeys/${run1.journeyId}/audit`, 'maker');
  assert.equal(audit.status, 200);

  const history = await f.call('GET', 'uat-runs?limit=2', 'maker');
  assert.deepEqual(
    history.body.items.map((item: { sequence: number }) => item.sequence),
    [3, 2],
  );
  assert.equal(history.body.nextCursor, 2);
});
