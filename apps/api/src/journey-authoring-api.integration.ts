/**
 * J5.5 (#343) — Journey authoring/template REST API
 *
 * ครอบ acceptance ของ #343 ผ่าน HTTP จริง (guard + IAM grant + RLS): route/DTO แบบ strict,
 * idempotency, generic not-found สองtenant, list ที่ไม่รั่ว, CAS stale, review/publish และ
 * publish recovery ที่ไม่มี optimistic success
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { JourneyAuthoringCapability } from '@d-contact/cxa-contracts';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import {
  JourneyTemplateRepository,
  importJourneyDefinition,
  type JourneyAuthoringCheckpoint,
  type JourneyDefinitionContent,
} from '@d-contact/journey';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { RuntimeProfileRouteGuard, resolveApiRuntimeProfile } from './runtime-profile.js';
import { createUatApiModule } from './uat-api.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';
const REMINDER = '5b0c7a4e-8f1d-4c3a-9b2e-1a7d3c5e9f01';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../journey/test/fixtures/j5/j1-schedule.json'), 'utf8'),
) as JourneyDefinitionContent;

type Persona = 'author' | 'reviewer' | 'outsider' | 'foreign';

async function harness(
  t: TestContext,
  options: { checkpoint?: (name: JourneyAuthoringCheckpoint) => void } = {},
) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const teamId = randomUUID();
  const otherTeamId = randomUUID();
  const users: Record<Persona, string> = {
    author: randomUUID(),
    reviewer: randomUUID(),
    outsider: randomUUID(),
    foreign: randomUUID(),
  };

  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: {
        id,
        name: `J5.5 ${id.slice(0, 8)}`,
        slug: `j5-5-${id.slice(0, 8)}`,
        sipDomain: `${id.slice(0, 8)}.j5-5.test`,
      },
    });
    await owner.jrAuthoringRolloutState.create({
      data: {
        tenantId: id,
        stage: 'INTERNAL_SYNTHETIC',
        canvasWriteEnabled: true,
        publishUiEnabled: true,
        templateCatalogEnabled: true,
        templateUpgradeEnabled: true,
        updatedByRef: 'ops',
        evidenceRef: 'j5-5-test',
      },
    });
  }
  await owner.team.createMany({
    data: [
      { id: teamId, tenantId, name: `j5-5-a-${teamId}` },
      { id: otherTeamId, tenantId, name: `j5-5-b-${otherTeamId}` },
    ],
  });
  const grants: Array<[Persona, JourneyAuthoringCapability, string, string]> = [
    ...(['journey.read', 'journey.edit', 'journey.publish', 'template.read'] as const).map(
      (capability) =>
        ['author', capability, teamId, tenantId] as [
          Persona,
          JourneyAuthoringCapability,
          string,
          string,
        ],
    ),
    ['reviewer', 'journey.read', teamId, tenantId],
    ['reviewer', 'journey.review', teamId, tenantId],
    ['outsider', 'journey.read', otherTeamId, tenantId],
    ['outsider', 'journey.edit', otherTeamId, tenantId],
    ['foreign', 'journey.read', teamId, otherTenantId],
    ['foreign', 'journey.edit', teamId, otherTenantId],
  ];
  for (const persona of Object.keys(users) as Persona[]) {
    await owner.iamAuthoringSubject.create({
      data: {
        tenantId: persona === 'foreign' ? otherTenantId : tenantId,
        subjectId: users[persona],
        authenticationStrength: 'STANDARD',
      },
    });
  }
  for (const [persona, capability, scopeId, tenant] of grants) {
    await owner.iamAuthoringCapabilityGrant.create({
      data: {
        tenantId: tenant,
        subjectId: users[persona],
        capability,
        scopeKind: 'TEAM',
        scopeId,
        grantedByRef: 'iam-admin',
      },
    });
  }

  const claims = (persona: Persona): VerifiedOidcClaims => {
    const tenant = persona === 'foreign' ? otherTenantId : tenantId;
    const slug = `j5-5-${tenant.slice(0, 8)}`;
    return {
      tenant_id: tenant,
      tenant_slug: slug,
      organization: { [slug]: { tenant_id: [tenant] } },
      azp: 'agent-desktop',
      sub: users[persona],
      preferred_username: persona,
      exp: 2_000_000_000,
      realm_access: { roles: ['supervisor'] },
      dc_user_id: users[persona],
      sid: `${persona}-session`,
    };
  };
  const verifier = {
    verifyAccessToken: async (token: string): Promise<VerifiedOidcClaims> => {
      if (token in users) return claims(token as Persona);
      throw new Error('token ไม่ถูกต้อง');
    },
  };
  const repository = new JourneyTemplateRepository(application, {
    authorization: new IamJourneyAuthoringAuthorizer(),
    evaluator: new DcExprEvaluator(),
    flags: { canvasWrite: true, publishUi: true, templateCatalog: true, templateUpgrade: true },
    checkpoint: options.checkpoint,
  });

  // U1.2 (#430): ประกอบผ่าน composition root ของ UAT เพื่อพิสูจน์ว่า authoring/review/publish/simulate
  // ทำงานครบใน profile ที่ปิด Kafka/LINE/egress (controller + guard ชุดเดียวกับที่ UAT deploy)
  const profile = resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'uat' });
  const routeGuard = new RuntimeProfileRouteGuard(profile, { write: () => undefined });
  const app = await NestFactory.create(
    createUatApiModule({
      repository,
      verifier,
      diagnostics: { write: () => undefined },
      status: {
        profile,
        routeGuard,
        journeyAuthoring: { canvasWrite: true, publishUi: true },
      },
    }),
    { logger: false },
  );
  app.use(routeGuard.middleware);
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;

  t.after(async () => {
    await app.close();
    const where = { tenantId: { in: [tenantId, otherTenantId] } };
    await owner.jrTemplateUpgradeApplication.deleteMany({ where });
    await owner.jrTemplateProvenance.deleteMany({ where });
    await owner.jrAuthoringOutbox.deleteMany({ where });
    await owner.jrAuthoringAudit.deleteMany({ where });
    await owner.jrAuthoringCommandReceipt.deleteMany({ where });
    await owner.jrReviewDecisionRecord.deleteMany({ where });
    await owner.jrReviewCandidate.deleteMany({ where });
    await owner.$transaction([
      owner.jrJourneyHead.deleteMany({ where }),
      owner.jrJourneyDraft.deleteMany({ where }),
    ]);
    await owner.jrJourneyDefinition.deleteMany({ where });
    await owner.iamAuthoringCapabilityGrant.deleteMany({ where });
    await owner.iamAuthoringSubject.deleteMany({ where });
    await owner.jrAuthoringRolloutState.deleteMany({ where });
    await owner.team.deleteMany({ where });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    persona: Persona,
    init: { key?: string | null; body?: unknown } = {},
  ) => {
    const key = init.key === undefined && method !== 'GET' ? `key-${randomUUID()}` : init.key;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/journey-authoring/${path}`, {
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

  const document = () => importJourneyDefinition({ ...fixture, ownerTeamId: teamId });

  /** สร้าง → compile → author submit → reviewer approve; คืน binding ที่พร้อม publish */
  const approved = async () => {
    const created = await call('POST', 'journeys', 'author', {
      body: { ownerTeamId: teamId, document: document() },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const journeyId = created.body.journeyId as string;
    const compiled = await call('POST', `journeys/${journeyId}/compile`, 'author', {
      body: { draftRevision: 1, draftDigest: created.body.draftDigest, expectedHeadVersion: 1 },
    });
    assert.equal(compiled.status, 200, JSON.stringify(compiled.body));
    const artifact = compiled.body.artifact;
    const binding = {
      draftRevision: 1,
      draftDigest: created.body.draftDigest as string,
      compileDigest: artifact.compileDigest as string,
      referenceDigest: artifact.referenceDigest as string,
      capabilityDigest: artifact.capabilityDigest as string,
      baseHeadVersion: 1,
      baseHeadDigest: null,
    };
    const review = await call('POST', `journeys/${journeyId}/reviews`, 'author', { body: binding });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    const vote = await call('POST', `reviews/${review.body.reviewId}/decisions`, 'reviewer', {
      body: {
        expectedReviewState: 'IN_REVIEW',
        decision: 'APPROVE',
        reasonCode: 'LOOKS_GOOD',
        evidenceRef: 'ticket-1',
      },
    });
    assert.equal(vote.status, 200, JSON.stringify(vote.body));
    assert.equal(vote.body.state, 'APPROVED');
    return {
      journeyId,
      publish: { reviewId: review.body.reviewId as string, ...binding, expectedHeadVersion: 1 },
      compileDigest: artifact.compileDigest as string,
    };
  };

  return { owner, tenantId, teamId, otherTeamId, users, call, document, approved };
}

/** error เป็น contract ปิด: code/safeParams/diagnostics เท่านั้น ไม่มี message ที่ localized หรือ stack */
function assertClosedError(body: Record<string, unknown>, code: string) {
  assert.equal(body.code, code);
  for (const key of Object.keys(body)) {
    assert.ok(
      ['code', 'safeParams', 'diagnostics', 'diagnosticsTruncated', 'resolution'].includes(key),
      `field ${key} ไม่ควรอยู่ใน error`,
    );
  }
}

test('J5-AU01/ID01 strict DTO, Idempotency-Key และ receipt เดิมสำหรับ payload เดิม', async (t) => {
  const f = await harness(t);
  const body = { ownerTeamId: f.teamId, document: f.document() };

  const unknownField = await f.call('POST', 'journeys', 'author', {
    body: { ...body, tenantId: randomUUID() },
  });
  assert.equal(unknownField.status, 400);
  assertClosedError(unknownField.body, 'REQUEST_MALFORMED');
  assert.deepEqual(unknownField.body.safeParams, { field: 'body.tenantId' });

  const missingKey = await f.call('POST', 'journeys', 'author', { key: null, body });
  assert.equal(missingKey.status, 400);
  assert.deepEqual(missingKey.body.safeParams, { field: 'Idempotency-Key' });

  const badPath = await f.call('GET', 'journeys/not-a-uuid', 'author');
  assert.equal(badPath.status, 400);

  const unauthenticated = await f.call('GET', 'journeys', 'nobody' as Persona);
  assert.equal(unauthenticated.status, 401);

  const key = `create-${randomUUID()}`;
  const first = await f.call('POST', 'journeys', 'author', { key, body });
  assert.equal(first.status, 200);
  const replay = await f.call('POST', 'journeys', 'author', { key, body });
  assert.deepEqual(replay, first);
  const conflict = await f.call('POST', 'journeys', 'author', {
    key,
    body: {
      ...body,
      document: { ...f.document(), settings: { ...f.document().settings, name: 'x' } },
    },
  });
  assert.equal(conflict.status, 409);
  assertClosedError(conflict.body, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await f.owner.jrJourneyHead.count({ where: { tenantId: f.tenantId } }), 1);

  // outsider มี journey.edit แค่ทีมอื่น: สร้างใส่ทีมนี้ได้ 403 ไม่ใช่ข้อมูลรั่ว
  const denied = await f.call('POST', 'journeys', 'outsider', { body });
  assert.equal(denied.status, 403);
  assertClosedError(denied.body, 'CAPABILITY_REQUIRED');
});

test('J5-TI01 generic not-found สองtenant, list/pagination ไม่รั่ว และ CAS stale ตอบ 409', async (t) => {
  const f = await harness(t);
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const created = await f.call('POST', 'journeys', 'author', {
      body: { ownerTeamId: f.teamId, document: f.document() },
    });
    ids.push(created.body.journeyId);
  }
  ids.sort();

  const missing = await f.call('GET', `journeys/${randomUUID()}`, 'author');
  const foreign = await f.call('GET', `journeys/${ids[0]}`, 'foreign');
  const hidden = await f.call('GET', `journeys/${ids[0]}`, 'outsider');
  for (const response of [missing, foreign, hidden]) {
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { code: 'JOURNEY_NOT_FOUND' });
  }
  const foreignWrite = await f.call('PUT', `journeys/${ids[0]}/draft`, 'foreign', {
    body: {
      expectedHeadVersion: 1,
      expectedDraftRevision: 1,
      expectedDraftDigest: 'a'.repeat(64),
      document: f.document(),
    },
  });
  assert.deepEqual([foreignWrite.status, foreignWrite.body], [404, { code: 'JOURNEY_NOT_FOUND' }]);

  const page1 = await f.call('GET', 'journeys?limit=2', 'author');
  assert.deepEqual(
    page1.body.items.map((item: { journeyId: string }) => item.journeyId),
    ids.slice(0, 2),
  );
  assert.equal(page1.body.nextCursor, ids[1]);
  assert.equal(page1.body.total, undefined);
  const page2 = await f.call('GET', `journeys?limit=2&cursor=${page1.body.nextCursor}`, 'author');
  assert.deepEqual(
    page2.body.items.map((item: { journeyId: string }) => item.journeyId),
    ids.slice(2),
  );
  assert.equal(page2.body.nextCursor, null);
  assert.deepEqual((await f.call('GET', 'journeys', 'outsider')).body, {
    items: [],
    nextCursor: null,
  });
  assert.deepEqual((await f.call('GET', 'journeys', 'foreign')).body.items, []);
  assert.equal((await f.call('GET', 'journeys?lifecycle=NOPE', 'author')).status, 400);

  // CAS: revision เก่าตอบ 409 พร้อม revision/digest ปัจจุบัน ไม่มี auto-merge
  const state = (await f.call('GET', `journeys/${ids[0]}`, 'author')).body;
  assert.deepEqual(state.templateNotices, []);
  const update = (digest: string) =>
    f.call('PUT', `journeys/${ids[0]}/draft`, 'author', {
      body: {
        expectedHeadVersion: state.head.version,
        expectedDraftRevision: state.head.currentDraftRevision,
        expectedDraftDigest: digest,
        document: f.document(),
      },
    });
  assert.equal((await update(state.head.currentDraftDigest)).status, 200);
  const stale = await update(state.head.currentDraftDigest);
  assert.equal(stale.status, 409);
  assertClosedError(stale.body, 'PUBLISHED_HEAD_CONFLICT');
});

test('J5-CC01/CC02 review decision ผ่าน reviewId, maker-checker, preview/simulation ผูก compile digest', async (t) => {
  const f = await harness(t);
  const { journeyId, publish, compileDigest } = await f.approved();

  const preview = await f.call('POST', `journeys/${journeyId}/preview`, 'author', {
    body: { compileDigest },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.compileDigest, compileDigest);
  const stalePreview = await f.call('POST', `journeys/${journeyId}/preview`, 'author', {
    body: { compileDigest: 'b'.repeat(64) },
  });
  assert.equal(stalePreview.status, 409);
  assertClosedError(stalePreview.body, 'COMPILE_ARTIFACT_STALE');

  const simulation = await f.call('POST', `journeys/${journeyId}/simulations`, 'author', {
    body: {
      compileDigest,
      fixture: { fixtureId: 'fx-1', startAt: '2026-09-01T00:00:00.000Z', seed: 's1', context: {} },
    },
  });
  assert.equal(simulation.status, 200, JSON.stringify(simulation.body));
  assert.equal(simulation.body.profile, 'SIMULATION_ONLY');
  const badFixture = await f.call('POST', `journeys/${journeyId}/simulations`, 'author', {
    body: {
      compileDigest,
      fixture: { fixtureId: 'fx', startAt: 'x', seed: 's', context: { nested: { pii: 1 } } },
    },
  });
  assert.equal(badFixture.status, 400);

  const validated = await f.call('POST', `journeys/${journeyId}/validate`, 'author', {
    body: { draftRevision: publish.draftRevision, draftDigest: publish.draftDigest },
  });
  assert.deepEqual([validated.status, validated.body.stale], [200, false]);

  // review id ที่ไม่มี/ของ template ตอบ not-found เหมือนกัน; reviewer ที่ไม่มีสิทธิ์ใน tenant อื่นก็เช่นกัน
  const decision = {
    expectedReviewState: 'IN_REVIEW',
    decision: 'APPROVE',
    reasonCode: 'LOOKS_GOOD',
    evidenceRef: 'e',
  };
  const unknownReview = await f.call('POST', `reviews/${randomUUID()}/decisions`, 'reviewer', {
    body: decision,
  });
  assert.deepEqual(
    [unknownReview.status, unknownReview.body],
    [404, { code: 'JOURNEY_NOT_FOUND' }],
  );
  const templateRoute = await f.call(
    'POST',
    `template-reviews/${publish.reviewId}/decisions`,
    'reviewer',
    { body: decision },
  );
  assert.deepEqual(
    [templateRoute.status, templateRoute.body],
    [404, { code: 'TEMPLATE_NOT_FOUND' }],
  );
  const again = await f.call('POST', `reviews/${publish.reviewId}/decisions`, 'reviewer', {
    body: decision,
  });
  assert.equal(again.status, 409);
  assertClosedError(again.body, 'REVIEW_CANDIDATE_STALE');

  // author ไม่มี journey.review — ตัดสิน review ของตัวเองไม่ได้
  const self = await f.call('POST', `reviews/${publish.reviewId}/decisions`, 'author', {
    body: decision,
  });
  assert.equal(self.status, 403);
});

test('J5-RC01/ID02 publish atomic, retry key เดิมได้ receipt เดิม, resolution อ่านอย่างเดียว', async (t) => {
  const f = await harness(t);
  const { journeyId, publish } = await f.approved();
  const key = `publish-${randomUUID()}`;

  const unresolved = await f.call('POST', `journeys/${journeyId}/publish-resolution`, 'author', {
    key: null,
    body: { originalIdempotencyKey: key },
  });
  assert.deepEqual([unresolved.status, unresolved.body.outcome], [200, 'NOT_COMMITTED']);

  const published = await f.call('POST', `journeys/${journeyId}/publish`, 'author', {
    key,
    body: publish,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.deepEqual([published.body.outcome, published.body.version], ['PUBLISHED', 1]);
  assert.deepEqual(
    await f.call('POST', `journeys/${journeyId}/publish`, 'author', { key, body: publish }),
    published,
  );
  const resolved = await f.call('POST', `journeys/${journeyId}/publish-resolution`, 'author', {
    key: null,
    body: { originalIdempotencyKey: key },
  });
  assert.deepEqual(resolved.body, published.body);
  // คนที่มองไม่เห็น journey เอา key ไป resolve ไม่ได้
  const outsider = await f.call('POST', `journeys/${journeyId}/publish-resolution`, 'outsider', {
    key: null,
    body: { originalIdempotencyKey: key },
  });
  assert.deepEqual([outsider.status, outsider.body], [404, { code: 'JOURNEY_NOT_FOUND' }]);
  assert.equal(
    await f.owner.jrJourneyDefinition.count({ where: { tenantId: f.tenantId, journeyId } }),
    1,
  );

  // publish ซ้ำด้วย key ใหม่หลัง head ขยับแล้ว = conflict ไม่ใช่ version ใหม่
  const republish = await f.call('POST', `journeys/${journeyId}/publish`, 'author', {
    body: publish,
  });
  assert.equal(republish.status, 409);

  const audit = await f.call('GET', `journeys/${journeyId}/audit?limit=5`, 'author');
  assert.equal(audit.status, 200);
  assert.ok(audit.body.items.some((row: { action: string }) => row.action === 'JOURNEY_PUBLISHED'));
  const serialized = JSON.stringify(audit.body);
  assert.ok(!serialized.includes('document') && !serialized.includes('graph'));
});

test('J5-RC01 commit ไม่รู้ผลตอบ 202 PUBLISH_OUTCOME_UNKNOWN และ resolve ด้วย key เดิมได้ NOT_COMMITTED', async (t) => {
  let crash = false;
  const f = await harness(t, {
    checkpoint: (name) => {
      if (crash && name === 'HEAD_ACTIVATED') throw new Error('connection reset during commit');
    },
  });
  const { journeyId, publish } = await f.approved();
  const key = `publish-${randomUUID()}`;
  crash = true;
  const unknown = await f.call('POST', `journeys/${journeyId}/publish`, 'author', {
    key,
    body: publish,
  });
  assert.equal(unknown.status, 202);
  assertClosedError(unknown.body, 'PUBLISH_OUTCOME_UNKNOWN');
  assert.deepEqual(unknown.body.resolution, { journeyId, originalIdempotencyKey: key });
  crash = false;

  const resolved = await f.call('POST', `journeys/${journeyId}/publish-resolution`, 'author', {
    key: null,
    body: { originalIdempotencyKey: key },
  });
  assert.equal(resolved.body.outcome, 'NOT_COMMITTED');
  // ยังไม่ commit จึง retry key เดิมได้อย่างปลอดภัย
  const retried = await f.call('POST', `journeys/${journeyId}/publish`, 'author', {
    key,
    body: publish,
  });
  assert.deepEqual([retried.status, retried.body.outcome], [200, 'PUBLISHED']);
});

test('J5-OB01 template API: built-in catalog, instantiate แบบ idempotent และ binding ไม่สะท้อนใน error', async (t) => {
  const f = await harness(t);
  const catalog = await f.call('GET', 'templates?origin=PLATFORM_BUILTIN', 'author');
  assert.equal(catalog.status, 200);
  const reminder = catalog.body.items.find(
    (item: { templateId: string }) => item.templateId === REMINDER,
  );
  assert.ok(reminder);
  const detail = await f.call('GET', `templates/${REMINDER}`, 'author');
  assert.deepEqual([detail.status, detail.body.origin], [200, 'PLATFORM_BUILTIN']);
  assert.equal((await f.call('GET', `templates/${randomUUID()}`, 'author')).status, 404);

  const body = {
    expectedContentDigest: reminder.contentDigest,
    bindings: { reminderContent: 'content-secret-value', senderIdentity: 'sender-1' },
    targetOwnerTeamId: f.teamId,
    name: 'from template',
  };
  const key = `instantiate-${randomUUID()}`;
  const path = `templates/${REMINDER}/versions/1/instantiate`;
  const created = await f.call('POST', path, 'author', { key, body });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(await f.call('POST', path, 'author', { key, body }), created);

  const invalid = await f.call('POST', path, 'author', {
    body: { ...body, bindings: { ...body.bindings, apiKey: 'sk-live-should-not-echo' } },
  });
  assert.equal(invalid.status, 422);
  assert.ok(!JSON.stringify(invalid.body).includes('sk-live-should-not-echo'));
  const nested = await f.call('POST', path, 'author', {
    body: { ...body, bindings: { reminderContent: { nested: true } } },
  });
  assert.equal(nested.status, 400);

  const state = await f.call('GET', `journeys/${created.body.journeyId}`, 'author');
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.templateNotices, []);
});
