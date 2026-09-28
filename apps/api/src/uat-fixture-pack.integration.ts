/**
 * U1.9 (#506) acceptance — fixture pack ของ UAT first slice ที่ commit ไว้ใช้เปิด run ได้จริงบน Postgres:
 * example ที่กรอกค่าสังเคราะห์ → `scripts/u1-uat-fixture-render.mjs` → CLI `uat-provision` (U1.8) = CREATED →
 * `เริ่มรอบใหม่` ของ maker ผ่าน HTTP (guard + IAM grant + RLS ของ app role + J5 จริง) → validate/compile/
 * preview/simulate ด้วย fixture ที่ server ตรึงไว้ถึง EXIT แบบ `SIMULATION_ONLY` → ส่งตรวจ/อนุมัติ/publish
 * mock ได้เฉพาะ token verifier (เหมือน `uat-run-api.integration.ts`)
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import {
  JourneyTemplateRepository,
  UatJourneyWriteGuard,
  UatRunRepository,
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
import { runUatProvisionCli } from './uat-provision.js';
import { UAT_RUN_REPOSITORY, UatRunController } from './uat-run-api.js';

const OWNER_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://dcontact:dcontact@localhost:5433/dcontact?schema=public';
const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const ROOT = resolve(__dirname, '../../..');
const EXAMPLE_PATH = resolve(ROOT, 'infra/uat/uat-provision.example.json');
const TEMPLATE_PATH = resolve(ROOT, 'infra/uat/fixtures/uat-first-slice.v1.template.json');
const RENDERER = resolve(ROOT, 'scripts/u1-uat-fixture-render.mjs');
/** SHA สังเคราะห์ของ release — ใน UAT จริงคือ `<sha>` ที่ deploy */
const BUILD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PACK_VERSION = 'uat-first-slice-1';

type Line = Record<string, string>;
type Persona = 'maker' | 'reviewer';

const example = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as Record<string, any>;
const template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')) as Record<string, any>;

async function harness(t: TestContext) {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_DATABASE_URL } } });
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const directory = mkdtempSync(join(tmpdir(), 'u1-9-'));
  t.after(async () => {
    rmSync(directory, { recursive: true, force: true });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  const ids = {
    tenantId: randomUUID(),
    teamId: randomUUID(),
    maker: randomUUID(),
    reviewer: randomUUID(),
  };
  const short = ids.tenantId.slice(0, 8);
  /** สำเนาของ example ที่ "operator" กรอกด้วยค่าสังเคราะห์ (แทน secret store) */
  const filled = {
    ...example,
    tenant: { id: ids.tenantId, slug: `u1-9-${short}`, name: `UAT first slice ${short}` },
    ownerTeam: { id: ids.teamId, name: `Journey owners ${short}` },
    maker: {
      dcUserId: ids.maker,
      email: `maker-${short}@uat-tester.example`,
      displayName: `ผู้ทดสอบ Maker ${short}`,
    },
    reviewer: {
      dcUserId: ids.reviewer,
      email: `reviewer-${short}@uat-tester.example`,
      displayName: `ผู้ทดสอบ Reviewer ${short}`,
    },
    rollout: { ...example.rollout, evidenceRef: 'u1-9-fixture-pack-test' },
    fixturePack: { ...example.fixturePack, packVersion: PACK_VERSION },
  };

  const render = (input: unknown) => {
    const result = spawnSync(
      process.execPath,
      [RENDERER, '--input', '-', '--build-sha', BUILD_SHA],
      { input: JSON.stringify(input), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, any>;
  };

  let files = 0;
  const cli = async (value: unknown, options: { check?: boolean } = {}) => {
    const file = join(directory, `input-${(files += 1)}.json`);
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    const lines: string[] = [];
    const code = await runUatProvisionCli(
      ['--input', file, ...(options.check ? ['--check'] : [])],
      { DATABASE_URL: OWNER_DATABASE_URL, UAT_TENANT_ID: ids.tenantId },
      (line) => lines.push(line),
    );
    const parsed = lines.map((line) => JSON.parse(line) as Line);
    return {
      code,
      output: lines.join('\n'),
      last: parsed.at(-1)!,
      parts: parsed.filter((line) => line.part),
    };
  };

  const verifier = {
    verifyAccessToken: async (token: string): Promise<VerifiedOidcClaims> => {
      if (token !== 'maker' && token !== 'reviewer') throw new Error('token ไม่ถูกต้อง');
      const persona = token as Persona;
      const slug = `u1-9-${short}`;
      return {
        tenant_id: ids.tenantId,
        tenant_slug: slug,
        organization: { [slug]: { tenant_id: [ids.tenantId] } },
        azp: 'console',
        sub: ids[persona],
        preferred_username: persona,
        exp: 2_000_000_000,
        realm_access: { roles: ['admin'] },
        dc_user_id: ids[persona],
        sid: `${persona}-session`,
      };
    },
  };

  const startApp = async () => {
    const authoring = new JourneyTemplateRepository(application, {
      authorization: new IamJourneyAuthoringAuthorizer(),
      evaluator: new DcExprEvaluator(),
      flags: { canvasWrite: true, publishUi: true, templateCatalog: false, templateUpgrade: false },
      writeGuard: new UatJourneyWriteGuard(),
    });
    const runs = new UatRunRepository(application, authoring);

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
    const port = (app.getHttpServer().address() as AddressInfo).port;
    return async (
      method: 'GET' | 'POST' | 'PUT',
      path: string,
      persona: Persona,
      body?: unknown,
    ) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${persona}`,
          'content-type': 'application/json',
          ...(method !== 'GET' ? { 'idempotency-key': `u1-9-${randomUUID()}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
  };

  return { owner, ids, filled, render, cli, startApp };
}

const PARTS = [
  'tenant',
  'ownerTeam',
  'rollout',
  'user:maker',
  'user:reviewer',
  'subject:maker',
  'subject:reviewer',
  'grants:maker',
  'grants:reviewer',
  'fixturePack',
];

test('U1.9 example ที่ยังไม่กรอก / ยังไม่ render ถูก CLI ปฏิเสธก่อนแตะฐานข้อมูล', async (t) => {
  const f = await harness(t);
  const unfilled = await f.cli(example);
  assert.equal(unfilled.code, 1);
  assert.deepEqual(unfilled.last, {
    type: 'u1.uat.provision',
    mode: 'apply',
    status: 'FAIL',
    code: 'INPUT_PLACEHOLDER',
    field: 'tenant.id',
  });
  const checkOnly = await f.cli(example, { check: true });
  assert.deepEqual([checkOnly.code, checkOnly.last.code], [1, 'INPUT_PLACEHOLDER']);
  // กรอกแล้วแต่ข้ามขั้น render
  const unrendered = await f.cli(f.filled);
  assert.deepEqual(
    [unrendered.code, unrendered.last.code, unrendered.last.field],
    [1, 'FIXTURE_PACK_NOT_RENDERED', 'fixturePack.template'],
  );
  assert.equal(await f.owner.tenant.count({ where: { id: f.ids.tenantId } }), 0);
  assert.doesNotMatch(unfilled.output + unrendered.output, /@|ผู้ทดสอบ/);
});

test('U1.9 pack ที่ render จาก template → provision CREATED → maker เปิด run → validate/compile/simulate ถึง EXIT → publish', async (t) => {
  const f = await harness(t);
  const input = f.render(f.filled);

  // --check ก่อน apply แล้วจึง apply (ขั้นเดียวกับ runbook)
  const checked = await f.cli(input, { check: true });
  assert.equal(checked.code, 0, JSON.stringify(checked.last));
  assert.deepEqual(
    checked.parts.map((line) => [line.part, line.status]),
    PARTS.map((part) => [part, 'WOULD_CREATE']),
  );
  const applied = await f.cli(input);
  assert.equal(applied.code, 0, JSON.stringify(applied.last));
  assert.deepEqual(
    applied.parts.map((line) => [line.part, line.status]),
    PARTS.map((part) => [part, 'CREATED']),
  );
  const pack = applied.parts.at(-1)!;
  // digest ของ --check (ก่อนเขียน) = digest ที่เขียนจริง; รันซ้ำ = UNCHANGED
  assert.equal(checked.parts.at(-1)!.digest, pack.digest);
  const again = await f.cli(f.render(f.filled));
  assert.deepEqual(
    again.parts.map((line) => line.status),
    PARTS.map(() => 'UNCHANGED'),
  );
  assert.doesNotMatch(checked.output + applied.output + again.output, /@|ผู้ทดสอบ/);

  const call = await f.startApp();
  // RUN_OPENED: `เริ่มรอบใหม่` ของ maker — J5 รับ baseline ของ pack เป็น draft
  const run = await call('POST', 'uat-runs/start', 'maker', {
    environment: 'uat',
    packVersion: PACK_VERSION,
    expectedRevision: 0,
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.lifecycle, 'ACTIVE');
  assert.equal(run.body.sequence, 1);
  assert.deepEqual(run.body.fixturePack, {
    environment: 'uat',
    packVersion: PACK_VERSION,
    digest: pack.digest,
    buildSha: BUILD_SHA,
  });
  assert.deepEqual(
    run.body.steps.map((step: { stepId: string }) => step.stepId),
    template.steps.map((step: { stepId: string }) => step.stepId),
  );
  const journeyId = run.body.journeyId as string;
  const journey = `journey-authoring/journeys/${journeyId}`;

  // BASELINE_OPEN: draft ของ run = baseline ของ pack (EVENT_TRIGGER → SEND → EXIT)
  const baseline = await call('GET', journey, 'maker');
  assert.equal(baseline.status, 200, JSON.stringify(baseline.body));
  const document = baseline.body.draft.document;
  assert.deepEqual(
    [document.trigger.type, ...document.nodes.map((node: { type: string }) => node.type)],
    ['EVENT_TRIGGER', 'SEND', 'EXIT'],
  );

  // MAKER_EDIT: แทรก WAIT 600 วินาทีหลัง SEND ผ่าน API เดียวกับ Console → EVENT_TRIGGER → SEND → WAIT → EXIT
  const edited = await call('PUT', `${journey}/draft`, 'maker', {
    expectedHeadVersion: baseline.body.head.version,
    expectedDraftRevision: baseline.body.head.currentDraftRevision,
    expectedDraftDigest: baseline.body.head.currentDraftDigest,
    document: {
      ...document,
      nodes: [...document.nodes, { nodeId: 'wait-1', type: 'WAIT', config: { waitSeconds: 600 } }],
      edges: [
        ...document.edges.filter((edge: { edgeId: string }) => edge.edgeId !== 'send-1.next'),
        {
          edgeId: 'send-1.next',
          source: { nodeId: 'send-1', portId: 'next' },
          target: { nodeId: 'wait-1' },
        },
        {
          edgeId: 'wait-1.next',
          source: { nodeId: 'wait-1', portId: 'next' },
          target: { nodeId: 'done' },
        },
      ],
      layout: { nodes: { ...document.layout.nodes, 'wait-1': { x: 80, y: 250 } } },
    },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const state = await call('GET', journey, 'maker');
  assert.equal(state.body.head.currentDraftRevision, baseline.body.head.currentDraftRevision + 1);
  const binding = {
    draftRevision: state.body.head.currentDraftRevision,
    draftDigest: state.body.head.currentDraftDigest,
  };

  // DIAGNOSTIC_RECOVERY (ผลสุดท้าย) / COMPILE / PREVIEW_PLAN
  const validated = await call('POST', `${journey}/validate`, 'maker', binding);
  assert.equal(validated.status, 200, JSON.stringify(validated.body));
  assert.deepEqual(validated.body.diagnostics, []);
  const compiled = await call('POST', `${journey}/compile`, 'maker', {
    ...binding,
    expectedHeadVersion: state.body.head.version,
  });
  assert.equal(compiled.status, 200, JSON.stringify(compiled.body));
  assert.deepEqual(compiled.body.diagnostics, []);
  const artifact = compiled.body.artifact;
  assert.ok(artifact);
  const preview = await call('POST', `${journey}/preview`, 'maker', {
    compileDigest: artifact.compileDigest,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.entryNodeId, 'send-1');

  // SIMULATE / SIMULATE_EXIT_PATH: fixture ที่ server ตรึงไว้ของ run → EXIT แบบ SIMULATION_ONLY
  const fixture = await call('GET', 'uat-runs/current/simulation-fixture', 'maker');
  assert.equal(fixture.status, 200, JSON.stringify(fixture.body));
  assert.deepEqual(fixture.body.fixture, template.simulationFixture);
  assert.deepEqual(
    (await call('GET', 'uat-runs/current/simulation-fixture', 'reviewer')).body,
    fixture.body,
  );
  const simulate = () =>
    call('POST', `${journey}/simulations`, 'maker', {
      compileDigest: artifact.compileDigest,
      fixture: fixture.body.fixture,
    });
  const simulated = await simulate();
  assert.equal(simulated.status, 200, JSON.stringify(simulated.body));
  assert.equal(simulated.body.profile, 'SIMULATION_ONLY');
  assert.equal(simulated.body.terminal, 'EXIT');
  assert.deepEqual(simulated.body.diagnostics, []);
  assert.deepEqual(
    simulated.body.transitions.map(
      (entry: { nodeId: string; portId: string | null; virtualAt: string }) => [
        entry.nodeId,
        entry.portId,
        entry.virtualAt,
      ],
    ),
    [
      ['send-1', 'next', '2026-09-01T02:00:00.000Z'],
      ['wait-1', 'next', '2026-09-01T02:00:00.000Z'],
      ['done', null, '2026-09-01T02:10:00.000Z'],
    ],
  );
  // SIMULATE_REPEATABLE
  assert.deepEqual((await simulate()).body, simulated.body);

  // step result ได้ป้ายสถานะและ expected จาก catalog ของ pack
  for (const [stepId, label] of [
    ['SIMULATE', 'SIMULATION_ONLY'],
    ['MAKER_EDIT', 'REAL_STATE'],
  ] as const) {
    const recorded = await call('POST', `uat-runs/${run.body.runId}/step-results`, 'maker', {
      stepId,
      outcome: 'PASS',
      actual: 'เห็นตาม expected',
    });
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    assert.equal(recorded.body.stateLabel, label);
    const catalog = template.steps.find((step: { stepId: string }) => step.stepId === stepId);
    assert.equal(recorded.body.expected, catalog.expected);
  }

  // SUBMIT_REVIEW → SELF_APPROVAL_REJECTED → REVIEW_APPROVE (หา candidate เอง) → PUBLISH → AUDIT
  const candidate = {
    ...binding,
    compileDigest: artifact.compileDigest,
    referenceDigest: artifact.referenceDigest,
    capabilityDigest: artifact.capabilityDigest,
    baseHeadVersion: state.body.head.version,
    baseHeadDigest: null,
  };
  const review = await call('POST', `${journey}/reviews`, 'maker', candidate);
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const decision = {
    expectedReviewState: 'IN_REVIEW',
    decision: 'APPROVE',
    reasonCode: 'LOOKS_GOOD',
    evidenceRef: 'u1-9-review',
  };
  const selfApproval = await call(
    'POST',
    `journey-authoring/reviews/${review.body.reviewId}/decisions`,
    'maker',
    decision,
  );
  assert.equal(selfApproval.status, 403, JSON.stringify(selfApproval.body));
  // maker ของ UAT ไม่มี journey.review (U1.8 grant) — ด่านแรกของ maker-checker
  assert.deepEqual(selfApproval.body, {
    code: 'CAPABILITY_REQUIRED',
    safeParams: { capability: 'journey.review' },
  });
  const queue = await call('GET', 'journey-authoring/reviews', 'reviewer');
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  assert.ok(
    JSON.stringify(queue.body).includes(review.body.reviewId),
    'reviewer เห็น candidate เอง',
  );
  const approved = await call(
    'POST',
    `journey-authoring/reviews/${review.body.reviewId}/decisions`,
    'reviewer',
    decision,
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const published = await call('POST', `${journey}/publish`, 'maker', {
    reviewId: review.body.reviewId,
    ...candidate,
    expectedHeadVersion: candidate.baseHeadVersion,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const audit = await call('GET', `${journey}/audit`, 'maker');
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
});
