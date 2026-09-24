import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { RuntimeProfileRouteGuard, resolveApiRuntimeProfile } from './runtime-profile.js';
import { createUatApiModule } from './uat-api.js';

const tenantId = '4e342ec5-d35b-41ed-bd44-1cf47a41af4b';

function claims(): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: 'uat',
    organization: { uat: { tenant_id: [tenantId] } },
    dc_user_id: '619b9c43-8495-420d-b3d3-34d9fd0b5b89',
    sid: 'keycloak-session-1',
    exp: 2_000_000_000,
    realm_access: { roles: ['admin'] },
  };
}

async function startUatApi(t: test.TestContext) {
  const profile = resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'uat' });
  const routeGuard = new RuntimeProfileRouteGuard(profile, { write: () => undefined });
  const listed: string[] = [];
  const repository = {
    listVisibleJourneys: async (listedTenant: string) => {
      listed.push(listedTenant);
      return { items: [], nextCursor: null };
    },
  };
  const module = createUatApiModule({
    repository,
    verifier: {
      verifyAccessToken: async (token: string) => {
        if (token === 'maker-token') return claims();
        throw new Error('invalid token');
      },
    },
    diagnostics: { write: () => undefined },
    status: {
      profile,
      routeGuard,
      journeyAuthoring: { canvasWrite: true, publishUi: true },
    },
  });
  const app = await NestFactory.create(module, { logger: false });
  app.use(routeGuard.middleware);
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, listed, routeGuard };
}

test('UAT API mount เฉพาะ Journey authoring ที่ยังต้อง login และบล็อก route อื่นพร้อมนับ', async (t) => {
  const { base, listed } = await startUatApi(t);

  // Journey authoring ถูก mount และยังผ่าน OIDC guard ตามปกติ
  assert.equal((await fetch(`${base}/api/v1/journey-authoring/journeys`)).status, 401);
  const authorized = await fetch(`${base}/api/v1/journey-authoring/journeys`, {
    headers: { authorization: 'Bearer maker-token' },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(listed, [tenantId]);

  // route ของ provider/telephony/workspace ไม่มีใน UAT
  for (const path of [
    '/api/v1/line-webhook',
    '/api/v1/workspace-session/connect',
    '/api/v1/recordings',
    '/api/v1/journey-events',
  ]) {
    const response = await fetch(`${base}${path}`, { method: 'POST' });
    assert.equal(response.status, 404, path);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      'ROUTE_NOT_AVAILABLE_IN_PROFILE',
      path,
    );
  }

  const status = await fetch(`${base}/api/v1/runtime-profile`);
  assert.equal(status.status, 200, 'readiness อ่านได้โดยไม่ต้องมี token');
  assert.deepEqual(await status.json(), {
    profile: 'uat',
    kafka: 'DISABLED',
    lineWebhook: 'DISABLED',
    providerEgress: 'BLOCKED',
    journeyRuntime: 'NOT_DEPLOYED',
    unilateralPublish: 'NOT_EXPOSED',
    blockedRequests: 4,
    journeyAuthoring: { canvasWrite: true, publishUi: true },
  });
});

test('composition root ของ UAT ไม่พึ่ง Kafka/LINE/Redis/MinIO/telephony และไม่มี route ของ unilateral publish', () => {
  const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');
  // ตรวจเฉพาะโค้ด ไม่รวม comment ที่อธิบายว่าไฟล์นี้ตั้งใจไม่ใช้อะไร
  const code = (file: string) =>
    source(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const uat = code('uat-api.ts') + code('uat-main.ts');
  for (const forbidden of [
    '@d-contact/kafka',
    '@d-contact/delivery',
    'ioredis',
    'minio',
    'recording',
    'workspace-session-api',
    'line-webhook',
    'createConsumer',
  ]) {
    assert.doesNotMatch(uat, new RegExp(forbidden, 'i'), forbidden);
  }
  // maker-checker ต้องบังคับจริงใน UAT (#374 §6): controller ที่ mount ไม่เรียกทางลัดนี้
  for (const controller of ['journey-authoring-api.ts', 'journey-template-api.ts']) {
    assert.doesNotMatch(source(controller), /Unilateral/, controller);
  }
});
