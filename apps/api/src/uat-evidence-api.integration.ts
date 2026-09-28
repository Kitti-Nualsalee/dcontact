/**
 * U1.5 (#433) acceptance — หลักฐานภาพหน้าจอ, negative scan และ evidence bundle ผ่าน HTTP จริง
 * (guard + RLS + trigger บน Postgres); mock ได้เฉพาะ token verifier และ object storage (in-memory แทน MinIO
 * ของ UAT stack — adapter จริงครอบใน uat-evidence-storage.test.ts)
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { JourneyAuthoringCapability } from '@d-contact/cxa-contracts';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import {
  JourneyTemplateRepository,
  UatEvidenceRepository,
  UatFixtureProvisioner,
  UatJourneyWriteGuard,
  UatRunRepository,
  importJourneyDefinition,
  scanUatText,
  verifyUatEvidenceBundleDigest,
  type JourneyDefinitionContent,
  type UatEvidenceBundleV1,
  type UatEvidenceStorage,
} from '@d-contact/journey';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { UAT_EVIDENCE_REPOSITORY, UatEvidenceController } from './uat-evidence-api.js';
import { UAT_RUN_REPOSITORY, UatRunController } from './uat-run-api.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../journey/test/fixtures/j5/j1-schedule.json'), 'utf8'),
) as JourneyDefinitionContent;

/** token ปลอมรูป JWT — ไม่ใช่ credential จริง */
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1YXQtZmFrZSJ9.c2lnbmF0dXJlLWZha2U';

type Persona = 'maker' | 'reviewer' | 'outsider' | 'foreign';

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG 1x1 จริง — `shade` ทำให้ byte ต่างกันได้ */
function png(shade = 0x80, extra: Buffer[] = []): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...extra,
    chunk('IDAT', deflateSync(Buffer.from([0, shade]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** object storage ในหน่วยความจำ — แทน bucket ส่วนตัวของ UAT stack */
function memoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const storage: UatEvidenceStorage = {
    putObject: async ({ key, bytes, contentType }) => {
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    getObject: async (key) => objects.get(key)?.bytes ?? null,
    deleteObject: async (key) => {
      objects.delete(key);
    },
  };
  return { storage, objects };
}

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
        name: `U1.5 ${id.slice(0, 8)}`,
        slug: `u1-5-${id.slice(0, 8)}`,
        sipDomain: `${id.slice(0, 8)}.u1-5.test`,
      },
    });
    await owner.jrAuthoringRolloutState.create({
      data: {
        tenantId: id,
        stage: 'INTERNAL_SYNTHETIC',
        canvasWriteEnabled: true,
        publishUiEnabled: true,
        updatedByRef: 'ops',
        evidenceRef: 'u1-5-test',
      },
    });
  }
  await owner.team.create({ data: { id: teamId, tenantId, name: `u1-5-${teamId}` } });
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
      const slug = `u1-5-${tenant.slice(0, 8)}`;
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
  const { storage, objects } = memoryStorage();

  @Module({
    controllers: [UatRunController, UatEvidenceController],
    providers: [
      { provide: UAT_RUN_REPOSITORY, useValue: new UatRunRepository(application, authoring) },
      {
        provide: UAT_EVIDENCE_REPOSITORY,
        useValue: new UatEvidenceRepository(application, storage),
      },
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
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    persona: Persona | null,
    init: { key?: string | null; body?: unknown } = {},
  ) => {
    const key = init.key === undefined && method !== 'GET' ? `key-${randomUUID()}` : init.key;
    const response = await fetch(`${base}/${path}`, {
      method,
      headers: {
        ...(persona ? { authorization: `Bearer ${persona}` } : {}),
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      headers: response.headers,
    };
  };

  const upload = async (
    runId: string,
    persona: Persona,
    bytes: Uint8Array,
    init: { stepId?: string | null; contentType?: string; key?: string } = {},
  ) => {
    const response = await fetch(`${base}/uat-runs/${runId}/evidence`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${persona}`,
        'content-type': init.contentType ?? 'image/png',
        'idempotency-key': init.key ?? `evidence-${randomUUID()}`,
        ...(init.stepId === null ? {} : { 'x-uat-step-id': init.stepId ?? 'LOGIN' }),
      },
      body: bytes,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const content = (runId: string, evidenceId: string, persona: Persona) =>
    fetch(`${base}/uat-runs/${runId}/evidence/${evidenceId}/content`, {
      headers: { authorization: `Bearer ${persona}` },
    });

  const provisioner = new UatFixtureProvisioner(owner);
  const started = async (packVersion = 'pack-1', expectedRevision = 0) => {
    await provisioner.provision({
      schema: 'UatFixturePackV1',
      environment: 'uat',
      packVersion,
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
        {
          stepId: 'LOGIN',
          title: 'Login',
          expected: 'เห็น Journey list',
          stateLabel: 'REAL_STATE',
        },
        {
          stepId: 'SIMULATE',
          title: 'Simulate',
          expected: 'เห็น transitions ที่ติดป้ายจำลอง',
          stateLabel: 'SIMULATION_ONLY',
        },
      ],
    });
    const run = await call('POST', 'uat-runs/start', 'maker', {
      body: { environment: 'uat', packVersion, expectedRevision },
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    return run.body as { runId: string; journeyId: string; revision: number };
  };

  const evidenceCount = () => owner.uatRunEvidence.count({ where: { tenantId } });

  return {
    owner,
    application,
    tenantId,
    otherTenantId,
    call,
    upload,
    content,
    started,
    objects,
    evidenceCount,
  };
}

test('U1.5 อัปโหลด/อ่านภาพหน้าจอตามสิทธิ์ของผู้ทดสอบ idempotent และไม่รั่วข้าม tenant', async (t) => {
  const f = await harness(t);
  const run = await f.started();
  const shot = png();

  const key = `evidence-${randomUUID()}`;
  const uploaded = await f.upload(run.runId, 'maker', shot, { key });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const view = uploaded.body;
  assert.deepEqual(Object.keys(view).sort(), [
    'contentType',
    'evidenceId',
    'recordedAt',
    'recordedByRef',
    'sha256',
    'sizeBytes',
    'stepId',
  ]);
  assert.equal(view.stepId, 'LOGIN');
  assert.equal(view.contentType, 'image/png');
  assert.equal(view.sizeBytes, shot.length);
  assert.match(view.sha256, /^[a-f0-9]{64}$/);
  // object อยู่ใต้ prefix ของ tenant/run/evidence เท่านั้น
  assert.deepEqual(
    [...f.objects.keys()],
    [`uat-evidence/${f.tenantId}/${run.runId}/${view.evidenceId}`],
  );

  // key เดิม + ไฟล์เดิม = replay ไม่เก็บซ้ำ; key เดิม + ไฟล์อื่น = conflict และไม่ทิ้ง object ค้าง
  assert.deepEqual(await f.upload(run.runId, 'maker', shot, { key }), uploaded);
  const reused = await f.upload(run.runId, 'maker', png(0x10), { key });
  assert.deepEqual([reused.status, reused.body.code], [409, 'IDEMPOTENCY_CONFLICT']);
  assert.equal(await f.evidenceCount(), 1);
  assert.equal(f.objects.size, 1);

  // reviewer ของ pack อ่านได้: list + byte ผ่าน API พร้อม header ที่ห้าม cache/sniff
  const listed = await f.call('GET', `uat-runs/${run.runId}/evidence`, 'reviewer');
  assert.deepEqual(listed.body, { runId: run.runId, items: [view] });
  const read = await f.content(run.runId, view.evidenceId, 'reviewer');
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'image/png');
  assert.equal(read.headers.get('cache-control'), 'private, no-store');
  assert.equal(read.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), shot);

  // ต้อง login; ผู้ที่ไม่ใช่ผู้ทดสอบของ pack และ tenant อื่นเห็นเป็น run ที่ไม่มีอยู่
  assert.equal((await f.call('GET', `uat-runs/${run.runId}/evidence`, null)).status, 401);
  for (const persona of ['outsider', 'foreign'] as const) {
    const upload = await f.upload(run.runId, persona, png(0x20));
    assert.deepEqual([upload.status, upload.body], [404, { code: 'UAT_RUN_NOT_FOUND' }], persona);
    const list = await f.call('GET', `uat-runs/${run.runId}/evidence`, persona);
    assert.deepEqual([list.status, list.body], [404, { code: 'UAT_RUN_NOT_FOUND' }], persona);
    const bytes = await f.content(run.runId, view.evidenceId, persona);
    assert.equal(bytes.status, 404, persona);
    for (const path of ['bundle']) {
      const hidden = await f.call('GET', `uat-runs/${run.runId}/${path}`, persona);
      assert.equal(hidden.status, 404, `${persona} ${path}`);
    }
    const scan = await f.call('POST', `uat-runs/${run.runId}/scan`, persona);
    assert.equal(scan.status, 404, `${persona} scan`);
  }
  assert.equal(await f.evidenceCount(), 1);
  assert.equal(f.objects.size, 1);
  // RLS: tenant อื่นมองไม่เห็นแถว metadata แม้ query ตรง
  assert.equal(
    await withTenantDatabaseTransaction(f.application, f.otherTenantId, (tx) =>
      tx.uatRunEvidence.count(),
    ),
    0,
  );

  // step ต้องอยู่ใน catalog ของ run และต้องมี header step
  const unknownStep = await f.upload(run.runId, 'maker', shot, { stepId: 'NOT_IN_CATALOG' });
  assert.deepEqual([unknownStep.status, unknownStep.body.safeParams], [400, { field: 'stepId' }]);
  const noStep = await f.upload(run.runId, 'maker', shot, { stepId: null });
  assert.deepEqual([noStep.status, noStep.body.safeParams], [400, { field: 'x-uat-step-id' }]);
  const missing = await f.content(run.runId, randomUUID(), 'maker');
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { code: string }).code, 'EVIDENCE_NOT_FOUND');
});

test('U1.5 trace/HAR/network log ถูกปฏิเสธและไม่มีอะไรถูกเก็บ', async (t) => {
  const f = await harness(t);
  const run = await f.started();
  const trace = Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.alloc(64)]);
  const har = Buffer.from(JSON.stringify({ log: { version: '1.2', entries: [] } }));
  const cases: Array<[Buffer, string, object]> = [
    [trace, 'application/zip', { reason: 'CONTENT_TYPE' }],
    [har, 'application/json', { reason: 'CONTENT_TYPE' }],
    [Buffer.from('GET /x 200\n'), 'text/plain', { reason: 'CONTENT_TYPE' }],
    // ประกาศว่าเป็นภาพแต่ magic bytes ไม่ใช่
    [trace, 'image/png', { detected: 'ZIP' }],
    [har, 'image/jpeg', { detected: 'JSON' }],
    [Buffer.from('GET /x 200\n'), 'image/png', { detected: 'TEXT' }],
    // polyglot: PNG ที่พ่วง trace.zip ต่อท้าย
    [Buffer.concat([png(), trace]), 'image/png', { detected: 'PNG', reason: 'TRAILING_DATA' }],
  ];
  for (const [bytes, contentType, safeParams] of cases) {
    const rejected = await f.upload(run.runId, 'maker', bytes, { contentType });
    assert.deepEqual(
      [rejected.status, rejected.body],
      [415, { code: 'EVIDENCE_TYPE_REJECTED', safeParams }],
      `${contentType} ${JSON.stringify(safeParams)}`,
    );
  }
  const oversized = await f.upload(
    run.runId,
    'maker',
    Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024)]),
  );
  assert.deepEqual([oversized.status, oversized.body.code], [413, 'EVIDENCE_TOO_LARGE']);
  assert.equal(await f.evidenceCount(), 0);
  assert.equal(f.objects.size, 0);
  // DB ปฏิเสธ content type อื่นแม้เขียนตรง
  await assert.rejects(
    f.owner.uatRunEvidence.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenantId,
        runId: run.runId,
        stepId: 'LOGIN',
        contentType: 'application/zip',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        storageKey: 'x',
        recordedByRef: 'maker',
        recordedAt: new Date(),
      },
    }),
    /uat_run_evidence_values_check/,
  );
});

test('U1.5 หลักฐานของ run ที่ปิดแล้วเพิ่ม/แก้/ลบไม่ได้ แต่ยังอ่านได้', async (t) => {
  const f = await harness(t);
  const run1 = await f.started();
  const first = await f.upload(run1.runId, 'maker', png());
  assert.equal(first.status, 200);
  // run 1 ยังไม่ publish → เริ่มรอบใหม่ = ABANDONED
  const run2 = await f.started('pack-1', run1.revision);
  assert.notEqual(run2.runId, run1.runId);

  const late = await f.upload(run1.runId, 'maker', png(0x11));
  assert.deepEqual([late.status, late.body.code], [409, 'UAT_RUN_CLOSED']);
  assert.equal(f.objects.size, 1, 'ไม่มี object ค้างจากคำขอที่ถูกปฏิเสธ');
  const read = await f.content(run1.runId, first.body.evidenceId, 'reviewer');
  assert.equal(read.status, 200);

  // trigger ของ DB: insert เข้า run ที่ปิดแล้ว / update / delete ไม่ได้ แม้ใช้ connection ของ owner
  const evidenceId = randomUUID();
  await assert.rejects(
    f.owner.uatRunEvidence.create({
      data: {
        id: evidenceId,
        tenantId: f.tenantId,
        runId: run1.runId,
        stepId: 'LOGIN',
        contentType: 'image/png',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        storageKey: `uat-evidence/${f.tenantId}/${run1.runId}/${evidenceId}`,
        recordedByRef: 'maker',
        recordedAt: new Date(),
      },
    }),
    /UAT_RUN_CLOSED/,
  );
  await assert.rejects(
    f.owner.uatRunEvidence.update({
      where: { id: first.body.evidenceId },
      data: { sha256: 'b'.repeat(64) },
    }),
    /UAT_APPEND_ONLY/,
  );
  await assert.rejects(
    f.owner.uatRunEvidence.delete({ where: { id: first.body.evidenceId } }),
    /UAT_APPEND_ONLY/,
  );
  // app role ไม่มีสิทธิ์ UPDATE/DELETE เลย
  await assert.rejects(
    withTenantDatabaseTransaction(
      f.application,
      f.tenantId,
      (tx) => tx.$executeRaw`DELETE FROM uat_run_evidence WHERE tenant_id = ${f.tenantId}::uuid`,
    ),
    /permission denied/,
  );
});

test('U1.5 negative scan: token ปลอมใน fixture ทำให้ run FAIL (S1) โดยไม่สะท้อนค่าที่พบ', async (t) => {
  const f = await harness(t);
  const run = await f.started();
  const leaked = await f.call('POST', `uat-runs/${run.runId}/step-results`, 'maker', {
    body: { stepId: 'LOGIN', outcome: 'PASS', actual: `เห็นหน้าจอ token ${FAKE_JWT}` },
  });
  assert.equal(leaked.status, 200, JSON.stringify(leaked.body));
  const withMetadata = await f.upload(
    run.runId,
    'maker',
    png(0x40, [
      chunk('tEXt', Buffer.from('Comment\u0000https://sso.test/cb?code=abc&state=xyz', 'latin1')),
    ]),
    { stepId: 'SIMULATE' },
  );
  assert.equal(withMetadata.status, 200, JSON.stringify(withMetadata.body));

  const scan = await f.call('POST', `uat-runs/${run.runId}/scan`, 'reviewer');
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  assert.equal(scan.body.status, 'FAILED');
  assert.equal(scan.body.severity, 'S1');
  assert.deepEqual(
    scan.body.findings.map((finding: { kind: string; location: object }) => [
      finding.kind,
      finding.location,
    ]),
    [
      ['JWT', { source: 'STEP_RESULT', stepId: 'LOGIN', resultIndex: 0, field: 'actual' }],
      [
        'OIDC_CODE',
        {
          source: 'EVIDENCE',
          stepId: 'SIMULATE',
          evidenceId: withMetadata.body.evidenceId,
          field: 'PNG_TEXT',
        },
      ],
      [
        'OIDC_STATE',
        {
          source: 'EVIDENCE',
          stepId: 'SIMULATE',
          evidenceId: withMetadata.body.evidenceId,
          field: 'PNG_TEXT',
        },
      ],
    ],
  );
  assert.doesNotMatch(JSON.stringify(scan.body), /eyJ|code=|state=/);
  // scan ซ้ำบนเนื้อหาเดิม = ผลเดิม ไม่เพิ่มแถว
  const again = await f.call('POST', `uat-runs/${run.runId}/scan`, 'maker');
  assert.deepEqual(again.body, scan.body);
  assert.equal(await f.owner.uatRunScan.count({ where: { runId: run.runId } }), 1);

  const bundle = (await f.call('GET', `uat-runs/${run.runId}/bundle`, 'maker')).body;
  assert.equal(bundle.verdict, 'FAIL');
  assert.deepEqual(bundle.scan, scan.body);
  assert.ok(verifyUatEvidenceBundleDigest(bundle));
  // ผล scan เป็น append-only
  await assert.rejects(
    f.owner.uatRunScan.delete({ where: { id: scan.body.scanId } }),
    /UAT_APPEND_ONLY/,
  );
});

test('U1.5 bundle ของ run ตัวอย่างผ่าน scan, digest ตรวจซ้ำได้ และไม่มี byte/PII', async (t) => {
  const f = await harness(t);
  const run = await f.started();
  for (const stepId of ['LOGIN', 'SIMULATE']) {
    const recorded = await f.call('POST', `uat-runs/${run.runId}/step-results`, 'maker', {
      body: { stepId, outcome: 'PASS', actual: 'เป็นไปตามที่คาด', correlationId: `corr-${stepId}` },
    });
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  }
  const shot = await f.upload(run.runId, 'reviewer', png(0x55), { stepId: 'SIMULATE' });
  assert.equal(shot.status, 200);

  const response = await f.call('GET', `uat-runs/${run.runId}/bundle`, 'reviewer');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const bundle = response.body as UatEvidenceBundleV1;
  assert.equal(bundle.schema, 'UatEvidenceBundleV1');
  assert.deepEqual(bundle.manifest, {
    runId: run.runId,
    sequence: 1,
    environment: 'uat',
    packVersion: 'pack-1',
    fixtureDigest: bundle.manifest.fixtureDigest,
    buildSha: 'a1b2c3d4e5f6',
    journeyId: run.journeyId,
    lifecycle: 'ACTIVE',
    openedAt: bundle.manifest.openedAt,
    closedAt: null,
  });
  assert.match(bundle.manifest.fixtureDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(bundle.stateLabels, { REAL_STATE: ['LOGIN'], SIMULATION_ONLY: ['SIMULATE'] });
  assert.deepEqual(
    bundle.stepResults.map((result) => [result.stepId, result.stateLabel]),
    [
      ['LOGIN', 'REAL_STATE'],
      ['SIMULATE', 'SIMULATION_ONLY'],
    ],
  );
  assert.deepEqual(bundle.screenshots, [shot.body]);
  assert.ok(bundle.auditRefs.length >= 1, 'มี audit ของ Journey ที่สร้างใน run');
  assert.ok(bundle.auditRefs.every((ref) => ref.action !== 'AUDIT_READ'));
  assert.equal(bundle.scan.status, 'PASSED');
  assert.deepEqual(bundle.scan.findings, []);
  assert.equal(bundle.verdict, 'PASS');

  // digest คำนวณซ้ำจาก canonical JSON ได้ค่าเดิม; แก้เนื้อหาแล้วไม่ผ่าน
  assert.ok(verifyUatEvidenceBundleDigest(bundle));
  assert.equal(verifyUatEvidenceBundleDigest({ ...bundle, verdict: 'FAIL' }), false);
  // bundle ทั้งก้อนผ่าน scanner เดียวกัน และไม่มี byte ของภาพ
  assert.deepEqual(scanUatText(JSON.stringify(bundle)), []);
  assert.doesNotMatch(JSON.stringify(bundle), /iVBOR|base64|"bytes"/);
  // export ซ้ำบนเนื้อหาเดิมได้ bundle เดิม (scan ถูกใช้ซ้ำ)
  const again = await f.call('GET', `uat-runs/${run.runId}/bundle`, 'maker');
  assert.equal(again.body.digest, bundle.digest);
});
