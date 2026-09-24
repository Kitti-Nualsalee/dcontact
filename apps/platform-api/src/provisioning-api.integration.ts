/**
 * A1.6 (#411) acceptance ของ Platform API ผ่าน HTTP จริง + Postgres จริง (role `dcontact_platform`)
 *
 * token ลงนามในเครื่อง (shape เดียวกับ Keycloak จริงที่ A1.2 ตรวจแล้ว); saga/command worker ใช้ fake
 * ports จึงไม่ต้องมี Keycloak — ครอบ permission matrix, tenant/mixed token, idempotency, stale
 * revision, target swap, concurrent recovery, generic 404, 429 + Retry-After, 503 และ dependency
 * failure หลังรับคำขอ
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@d-contact/db';
import {
  createFakeProvisioningPorts,
  OperatorCommandWorker,
  PlatformCatalog,
  ProvisioningRecoveryService,
  ProvisioningSagaWorker,
} from '@d-contact/platform-control';
import { PlatformApiModule } from './platform-api.module.js';
import type { PlatformAuthDiagnostic } from './platform-auth.js';
import { createPlatformServices } from './platform-services.js';
import { createTestSigner, platformClaims, tenantClaims, TEST_NOW } from './test-tokens.js';

const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://dcontact:dcontact@localhost:5433/dcontact?schema=public';
const PLATFORM_URL =
  process.env.PLATFORM_DATABASE_URL ??
  'postgresql://dcontact_platform:dcontact_platform@localhost:5433/dcontact?schema=public';
const SIP_BASE = 'sip.platform-api.test';
const run = randomUUID().slice(0, 8);

const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
const platform = new PrismaClient({ datasources: { db: { url: PLATFORM_URL } } });
const catalog = new PlatformCatalog(platform);
const templateVersion = `api-baseline-${run}`;
let planVersion = 0;
const tenants: string[] = [];
const fakes = createFakeProvisioningPorts();
const saga = new ProvisioningSagaWorker(platform, fakes.ports, {
  workerId: `api-saga-${run}`,
  sipBaseDomain: SIP_BASE,
  scope: () => ({ tenantId: { in: [...tenants] } }),
  backoffBaseMs: 1,
  backoffMaxMs: 1,
});
const commands = new OperatorCommandWorker(
  platform,
  { recovery: new ProvisioningRecoveryService(platform, fakes.ports, { sipBaseDomain: SIP_BASE }) },
  { workerId: `api-commands-${run}`, scope: () => ({ tenantId: { in: [...tenants] } }) },
);

let app: INestApplication;
let baseUrl: string;
const diagnostics: PlatformAuthDiagnostic[] = [];
const tokens: Record<string, string> = {};
let sequence = 0;

function input(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  const label = `api-${run}-${sequence}`;
  return {
    displayName: `API Customer ${sequence}`,
    slug: label,
    primaryDomain: `${label}.example.test`,
    locale: 'th-TH',
    timezone: 'Asia/Bangkok',
    planCode: 'growth',
    bootstrapTemplateVersion: templateVersion,
    firstAdmin: { email: `owner+${label}@example.test`, displayName: 'First Admin' },
    ...overrides,
  };
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; key?: string } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token ?? tokens.operator}`,
      'x-correlation-id': `corr-${run}`,
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: (text ? JSON.parse(text) : undefined) as Record<string, any>,
  };
}

async function create(overrides: Record<string, unknown> = {}) {
  const result = await call('POST', '/api/v1/provisioning-requests', {
    body: input(overrides),
    key: `create-${randomUUID()}`,
  });
  assert.equal(result.status, 202, result.text);
  tenants.push(result.body.request.tenantId);
  return result.body.request as { requestId: string; tenantId: string; revision: number };
}

/** request ที่ saga ส่งไปรอ operator (dependency ล้มหลังรับคำขอแล้ว) */
async function actionRequired() {
  const request = await create();
  fakes.systems.KEYCLOAK_ORGANIZATION.fail('permanent');
  // saga เห็นเฉพาะ request นี้ — fault ต้องไม่ถูก request ของเคสอื่นหยิบไป
  await new ProvisioningSagaWorker(platform, fakes.ports, {
    workerId: `api-saga-${randomUUID().slice(0, 8)}`,
    sipBaseDomain: SIP_BASE,
    scope: () => ({ tenantId: request.tenantId }),
  }).drain();
  return (await call('GET', `/api/v1/provisioning-requests/${request.requestId}`)).body;
}

before(async () => {
  await catalog.publishBootstrapTemplate({
    version: templateVersion,
    manifest: {
      schemaVersion: 1,
      adminTeam: { name: 'Admin Team' },
      drafts: {
        generalTeam: { name: 'General Team' },
        generalQueue: { name: 'General Queue' },
        businessHours: {
          name: 'Business hours',
          weekly: [{ day: 1, open: '09:00', close: '18:00' }],
        },
      },
    },
  });
  planVersion = (
    await catalog.publishPlanVersion({
      planCode: 'growth',
      entitlements: { agent_seats: 10, run_marker: parseInt(run.slice(0, 6), 16) },
    })
  ).version;
  const signer = await createTestSigner();
  app = await NestFactory.create(
    PlatformApiModule.register({
      verifier: signer.verifier,
      diagnostics: { write: (diagnostic) => diagnostics.push(diagnostic) },
      clock: () => TEST_NOW,
      services: createPlatformServices(platform, { sipBaseDomain: SIP_BASE }),
    }),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  tokens.operator = await signer.sign(platformClaims('platform_operator'));
  tokens.auditor = await signer.sign(platformClaims('platform_auditor'));
  tokens.tenant = await signer.sign(tenantClaims({ aud: 'dcontact-platform-api' }));
  tokens.mixed = await signer.sign(platformClaims('platform_operator', { tenant_id: 't-1' }));
});

after(async () => {
  await app?.close();
  await owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    for (const table of [
      'pf_operator_commands',
      'pf_first_admin_email_revisions',
      'pf_invitations',
      'pf_request_payload_revisions',
      'pf_action_history',
      'pf_command_receipts',
      'pf_identity_reservations',
      'pf_provisioning_step_receipts',
      'pf_provisioning_steps',
      'pf_provisioning_requests',
    ]) {
      await transaction.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "tenant_id" = ANY($1::uuid[])`,
        tenants,
      );
    }
    await transaction.$executeRawUnsafe(
      `DELETE FROM "tenants" WHERE "id" = ANY($1::uuid[])`,
      tenants,
    );
    await transaction.$executeRawUnsafe(
      `DELETE FROM "pf_bootstrap_templates" WHERE "version" = $1`,
      templateVersion,
    );
    await transaction.$executeRawUnsafe(
      `DELETE FROM "pf_plan_versions" WHERE "plan_code" = 'growth' AND "version" = $1`,
      planVersion,
    );
  });
  await Promise.all([owner.$disconnect(), platform.$disconnect()]);
});

describe('Platform API (A1.6)', { concurrency: false }, () => {
  test('permission matrix: auditor อ่านได้แต่เขียนไม่ได้; tenant/mixed token ถูกปฏิเสธทุก endpoint', async () => {
    const request = await create();
    const reads = [
      '/api/v1/tenants?limit=1',
      `/api/v1/provisioning-requests/${request.requestId}`,
      `/api/v1/tenants/${request.tenantId}/action-history`,
    ];
    for (const path of reads) {
      assert.equal((await call('GET', path, { token: tokens.auditor })).status, 200, path);
    }
    const writes: Array<[string, string, unknown]> = [
      ['POST', '/api/v1/provisioning-requests', input()],
      ['PATCH', `/api/v1/provisioning-requests/${request.requestId}`, { expectedRevision: 1 }],
      ['POST', `/api/v1/provisioning-requests/${request.requestId}/actions/retry/previews`, {}],
      ['POST', `/api/v1/provisioning-requests/${request.requestId}/actions/retry`, {}],
    ];
    for (const [method, path, body] of writes) {
      const denied = await call(method, path, {
        token: tokens.auditor,
        body,
        key: `key-${randomUUID()}`,
      });
      assert.deepEqual([denied.status, denied.body.code], [403, 'FORBIDDEN'], `${method} ${path}`);
    }
    for (const token of [tokens.tenant, tokens.mixed]) {
      for (const [method, path] of [
        ['GET', reads[0]!],
        ...writes.map(([m, p]) => [m, p]),
      ] as const) {
        const denied = await call(method, path, {
          token,
          ...(method === 'GET' ? {} : { body: {} }),
          key: `key-${randomUUID()}`,
        });
        assert.deepEqual(
          [denied.status, denied.body.code],
          [401, 'UNAUTHENTICATED'],
          `${method} ${path}`,
        );
      }
    }
    // auditor เขียนไม่ได้ = ไม่มีคำขอใหม่เกิดขึ้น
    assert.equal(
      await owner.pfProvisioningRequest.count({ where: { tenantId: { in: tenants } } }),
      1,
    );
  });

  test('create: 202 + Location, replay key เดิมได้ request เดิม, key ซ้ำ payload อื่น/ไม่มี key/slug ชน', async () => {
    const body = input();
    const key = `create-${randomUUID()}`;
    const first = await call('POST', '/api/v1/provisioning-requests', { body, key });
    assert.equal(first.status, 202, first.text);
    tenants.push(first.body.request.tenantId);
    assert.equal(
      first.headers.get('location'),
      `/api/v1/provisioning-requests/${first.body.request.requestId}`,
    );
    assert.deepEqual([first.body.replayed, first.body.request.status], [false, 'PENDING']);
    assert.equal(first.body.request.plan.version, planVersion);
    // ไม่คืน raw email
    assert.equal(first.text.includes(body.firstAdmin.email), false);
    assert.match(first.body.request.firstAdmin.emailMasked, /^o\*\*\*@example\.test$/);

    const replay = await call('POST', '/api/v1/provisioning-requests', { body, key });
    assert.deepEqual(
      [replay.status, replay.body.replayed, replay.body.request.requestId],
      [202, true, first.body.request.requestId],
    );
    const reused = await call('POST', '/api/v1/provisioning-requests', {
      body: { ...body, displayName: 'Another Customer' },
      key,
    });
    assert.deepEqual([reused.status, reused.body.code], [409, 'IDEMPOTENCY_KEY_REUSED']);
    const missingKey = await call('POST', '/api/v1/provisioning-requests', { body: input() });
    assert.deepEqual(
      [missingKey.status, missingKey.body.code, missingKey.body.fieldErrors],
      [400, 'VALIDATION_FAILED', { idempotencyKey: 'REQUIRED' }],
    );
    const slugTaken = await call('POST', '/api/v1/provisioning-requests', {
      body: input({ slug: body.slug }),
      key: `create-${randomUUID()}`,
    });
    assert.deepEqual(
      [slugTaken.status, slugTaken.body.code, slugTaken.body.retryable],
      [409, 'TENANT_SLUG_CONFLICT', false],
    );
    const invalid = await call('POST', '/api/v1/provisioning-requests', {
      body: input({ timezone: 'Mars/Olympus' }),
      key: `create-${randomUUID()}`,
    });
    assert.deepEqual([invalid.status, invalid.body.fieldErrors?.timezone], [400, 'INVALID']);
  });

  test('generic 404: request/tenant/preview ที่ไม่มีหรือเป็นของ request อื่นตอบเหมือนกันโดยไม่เผย existence', async () => {
    const mine = await create();
    const other = await create();
    const otherPreview = await call(
      'POST',
      `/api/v1/provisioning-requests/${other.requestId}/actions/retry/previews`,
    );
    const missing = [
      `/api/v1/provisioning-requests/${randomUUID()}`,
      '/api/v1/provisioning-requests/not-a-uuid',
      `/api/v1/tenants/${randomUUID()}/action-history`,
      `/api/v1/provisioning-requests/${mine.requestId}/actions/previews/${otherPreview.body.commandId}`,
      `/api/v1/provisioning-requests/${mine.requestId}/commands/${randomUUID()}`,
    ];
    const bodies = new Set<string>();
    for (const path of missing) {
      const result = await call('GET', path);
      assert.equal(result.status, 404, path);
      assert.equal(result.body.requestId, undefined);
      const { correlationId: _correlation, ...rest } = result.body;
      bodies.add(JSON.stringify(rest));
    }
    assert.equal(bodies.size, 1);
    assert.equal(
      (
        await call(
          'POST',
          `/api/v1/provisioning-requests/${mine.requestId}/actions/unknown/previews`,
        )
      ).status,
      404,
    );
  });

  test('PATCH: stale revision และ identity field = 409; ค่าที่แก้ได้คืน representation ใหม่', async () => {
    const request = await create();
    const stale = await call('PATCH', `/api/v1/provisioning-requests/${request.requestId}`, {
      body: {
        expectedRevision: request.revision + 5,
        changes: { timezone: 'Asia/Tokyo' },
        reasonCode: 'CUSTOMER_CORRECTION',
        comment: 'แก้เขตเวลา',
      },
    });
    assert.deepEqual(
      [stale.status, stale.body.code, stale.body.requestId],
      [409, 'REVISION_CONFLICT', request.requestId],
    );
    const locked = await call('PATCH', `/api/v1/provisioning-requests/${request.requestId}`, {
      body: {
        expectedRevision: request.revision,
        changes: { slug: 'hijack' },
        reasonCode: 'CUSTOMER_CORRECTION',
        comment: 'แก้ slug',
      },
    });
    assert.deepEqual([locked.status, locked.body.code], [409, 'FIELD_LOCKED']);
    const edited = await call('PATCH', `/api/v1/provisioning-requests/${request.requestId}`, {
      body: {
        expectedRevision: request.revision,
        changes: { timezone: 'Asia/Tokyo' },
        reasonCode: 'CUSTOMER_CORRECTION',
        comment: 'แก้เขตเวลา',
      },
    });
    assert.deepEqual(
      [edited.status, edited.body.timezone, edited.body.revision],
      [200, 'Asia/Tokyo', request.revision + 1],
    );
  });

  test('recovery: preview async → execute 202; คำสั่งซ้อน 409, replay 202, target swap 409; dependency failure อยู่ใน request state', async () => {
    const stuck = await actionRequired();
    // dependency ล้มหลังรับคำขอ: API ไม่เคยตอบ 503 แต่สถานะอยู่ใน request
    assert.deepEqual([stuck.status, stuck.failureCode], ['ACTION_REQUIRED', 'DEPENDENCY_REJECTED']);
    const queued = await call(
      'POST',
      `/api/v1/provisioning-requests/${stuck.requestId}/actions/retry/previews`,
    );
    assert.deepEqual([queued.status, queued.body.state], [202, 'QUEUED']);
    await commands.drain();
    const preview = await call('GET', queued.headers.get('location')!, { token: tokens.auditor });
    assert.deepEqual([preview.body.state, preview.body.result.allowed], ['SUCCEEDED', true]);

    const body = {
      expectedRevision: stuck.revision,
      previewDigest: preview.body.result.previewDigest,
      reasonCode: 'OPERATOR_VERIFIED',
      comment: 'ตรวจแล้วว่าไม่มี Organization ค้าง',
    };
    const keys = [`action-${randomUUID()}`, `action-${randomUUID()}`];
    const results = await Promise.all(
      keys.map((key) =>
        call('POST', `/api/v1/provisioning-requests/${stuck.requestId}/actions/retry`, {
          body,
          key,
        }),
      ),
    );
    assert.deepEqual(results.map((result) => result.status).sort(), [202, 409]);
    const winner = results.findIndex((result) => result.status === 202);
    const accepted = results[winner]!;
    assert.equal(results[1 - winner]!.body.code, 'COMMAND_IN_PROGRESS');
    const replay = await call(
      'POST',
      `/api/v1/provisioning-requests/${stuck.requestId}/actions/retry`,
      {
        body,
        key: keys[winner],
      },
    );
    assert.deepEqual(
      [replay.status, replay.body.command.commandId],
      [202, accepted.body.command.commandId],
    );
    // key เดิมกับ request อื่น (target swap) = 409 ไม่ใช่ทำกับ request ผิดตัว
    const other = await create();
    const swap = await call(
      'POST',
      `/api/v1/provisioning-requests/${other.requestId}/actions/retry`,
      {
        body,
        key: keys[winner],
      },
    );
    assert.deepEqual([swap.status, swap.body.code], [409, 'IDEMPOTENCY_KEY_REUSED']);
    await commands.drain();
    const command = await call('GET', accepted.headers.get('location')!);
    assert.deepEqual([command.body.state, command.body.result.status], ['SUCCEEDED', 'RUNNING']);
    await saga.drain();
    const done = await call('GET', `/api/v1/provisioning-requests/${stuck.requestId}`);
    assert.equal(done.body.status, 'SUCCEEDED');
    const notStuck = await call(
      'POST',
      `/api/v1/provisioning-requests/${stuck.requestId}/actions/retry`,
      {
        body: { ...body, expectedRevision: done.body.revision },
        key: `action-${randomUUID()}`,
      },
    );
    assert.deepEqual([notStuck.status, notStuck.body.code], [409, 'INVALID_STATE_TRANSITION']);
  });

  test('resend เกิน cap = 429 พร้อม Retry-After', async () => {
    const request = await create();
    const created = new Date(Date.now() - 10 * 60_000);
    for (let generation = 1; generation <= 4; generation += 1) {
      if (generation > 1) {
        await platform.pfInvitation.updateMany({
          where: { requestId: request.requestId, generation: generation - 1 },
          data: { supersededAt: created, revision: { increment: 1 } },
        });
      }
      await platform.pfInvitation.create({
        data: {
          id: randomUUID(),
          requestId: request.requestId,
          tenantId: request.tenantId,
          generation,
          keycloakUserId: randomUUID(),
          recipientHash: 'd'.repeat(64),
          lifespanSeconds: 259200,
          requestedByKind: generation === 1 ? 'SYSTEM' : 'PLATFORM_OPERATOR',
          requestedBy: 'fixture',
          reasonCode: generation === 1 ? null : 'RECIPIENT_REQUESTED',
          createdAt: new Date(created.getTime() + generation * 1000),
        },
      });
    }
    const limited = await call(
      'POST',
      `/api/v1/provisioning-requests/${request.requestId}/actions/resend-invitation`,
      {
        body: { reasonCode: 'RECIPIENT_REQUESTED', comment: 'ผู้รับแจ้งว่าไม่ได้รับ' },
        key: `resend-${randomUUID()}`,
      },
    );
    assert.deepEqual(
      [limited.status, limited.body.code, limited.body.retryable],
      [429, 'INVITATION_RESEND_LIMITED', true],
    );
    const retryAfter = Number(limited.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= 3600, String(retryAfter));
  });

  test('control plane ต่อ DB ไม่ได้ = 503 retryable; response/diagnostics ไม่มี token', async () => {
    const broken = new PrismaClient({
      datasources: {
        db: { url: 'postgresql://dcontact_platform:x@127.0.0.1:1/dcontact?connect_timeout=1' },
      },
    });
    const signer = await createTestSigner();
    const down = await NestFactory.create(
      PlatformApiModule.register({
        verifier: signer.verifier,
        diagnostics: { write: () => undefined },
        clock: () => TEST_NOW,
        services: createPlatformServices(broken, { sipBaseDomain: SIP_BASE }),
      }),
      { logger: false },
    );
    await down.listen(0, '127.0.0.1');
    try {
      const url = (await down.getUrl()).replace('[::1]', '127.0.0.1');
      const response = await fetch(`${url}/api/v1/tenants`, {
        headers: {
          authorization: `Bearer ${await signer.sign(platformClaims('platform_auditor'))}`,
        },
      });
      const body = (await response.json()) as Record<string, unknown>;
      assert.deepEqual(
        [response.status, body.code, body.retryable],
        [503, 'SERVICE_UNAVAILABLE', true],
      );
      assert.equal(JSON.stringify(body).includes('127.0.0.1'), false);
    } finally {
      await down.close();
      await broken.$disconnect();
    }
    const serialized = JSON.stringify(diagnostics);
    for (const token of Object.values(tokens)) assert.equal(serialized.includes(token), false);
  });
});
