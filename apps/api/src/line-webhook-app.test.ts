import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { createLineWebhookModule } from './line-webhook-app.js';
import { RuntimeProfileRouteGuard, resolveApiRuntimeProfile } from './runtime-profile.js';

const UAT_LINE = {
  DCONTACT_API_PROFILE: 'uat-line',
  LINE_WEBHOOK_SECRET_SOURCE: 'file',
};

const PILOT_TENANT = '4e342ec5-d35b-41ed-bd44-1cf47a41af4b';
const OTHER_TENANT = '7d1a1f0e-3c55-4b5e-9a0f-2b8f6f1d9e11';

function claims(tenantId: string, roles: string[]): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: 'uat',
    organization: { uat: { tenant_id: [tenantId] } },
    dc_user_id: '619b9c43-8495-420d-b3d3-34d9fd0b5b89',
    sid: 'keycloak-session-1',
    exp: 2_000_000_000,
    realm_access: { roles },
  };
}

const TOKENS: Record<string, VerifiedOidcClaims> = {
  admin: claims(PILOT_TENANT, ['admin']),
  maker: claims(PILOT_TENANT, ['maker']),
  'other-admin': claims(OTHER_TENANT, ['admin']),
};

async function start(t: test.TestContext) {
  const profile = resolveApiRuntimeProfile(UAT_LINE);
  const routeGuard = new RuntimeProfileRouteGuard(profile, { write: () => undefined });
  const received: Array<{ rawBody: Buffer; signature: string | undefined }> = [];
  const ingress = {
    handle: async (request: { rawBody: Buffer; signature: string | undefined }) => {
      received.push(request);
      return { status: request.signature === 'valid' ? 200 : 401, code: 'TEST' };
    },
  };
  const listed: Array<{ actorRef: string; limit: number; before?: string }> = [];
  const inbound = {
    list: async (input: { actorRef: string; limit: number; before?: string }) => {
      listed.push(input);
      return { items: [], quarantined: 0, nextCursor: null };
    },
  };
  const app = await NestFactory.create(
    createLineWebhookModule({
      ingress,
      status: { profile, routeGuard },
      inbound,
      tenantId: PILOT_TENANT,
      verifier: {
        verifyAccessToken: async (token: string) => {
          const verified = TOKENS[token];
          if (!verified) throw new Error('invalid token');
          return verified;
        },
      },
      diagnostics: { write: () => undefined },
      lifecycle: { isActive: async () => true },
    }),
    { logger: false, rawBody: true },
  );
  app.use(routeGuard.middleware);
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, received, routeGuard, listed };
}

test('#565 line-webhook ส่ง raw body + signature ให้ ingress และตอบแค่ machine code', async (t) => {
  const { base, received } = await start(t);
  const body = '{"destination":"x","events":[]}';
  const response = await fetch(`${base}/webhook/line`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': 'valid' },
    body,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { code: 'TEST' });
  assert.equal(received[0]?.rawBody.toString('utf8'), body);

  const unsigned = await fetch(`${base}/webhook/line`, { method: 'POST', body: '{}' });
  assert.equal(unsigned.status, 401);
});

test('#565 line-webhook ไม่มี route อื่น: /api/ นอก runtime profile ถูกบล็อกและนับ', async (t) => {
  const { base, routeGuard } = await start(t);
  const profile = await fetch(`${base}/api/v1/runtime-profile`);
  assert.equal(profile.status, 200);
  assert.deepEqual(await profile.json(), {
    profile: 'uat-line',
    kafka: 'DISABLED',
    lineWebhook: 'ENABLED',
    providerEgress: 'BLOCKED',
    blockedRequests: 0,
  });
  for (const path of ['/api/v1/journey-authoring/journeys', '/api/v1/uat-runs/current']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  assert.equal(routeGuard.blockedRequests(), 2);
  assert.equal((await fetch(`${base}/webhook/line`)).status, 404);
  assert.equal((await fetch(`${base}/webhook/other`, { method: 'POST' })).status, 404);
});

test('#566 read API ต้อง login + role admin + tenant ของ pilot และส่ง actor ให้ reader', async (t) => {
  const { base, listed } = await start(t);
  const get = (token?: string, query = '') =>
    fetch(`${base}/api/v1/line-pilot/inbound${query}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const access = (token?: string) =>
    fetch(`${base}/api/v1/line-pilot/access`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  assert.equal((await access()).status, 401);
  assert.equal((await access('maker')).status, 403);
  assert.equal((await access('other-admin')).status, 403);
  assert.equal((await access('admin')).status, 204);
  // ตรวจสิทธิ์อย่างเดียว: ไม่เรียก reader (ไม่อ่านข้อความ ไม่ audit)
  assert.equal(listed.length, 0);
  assert.equal((await get()).status, 401);
  assert.equal((await get('forged')).status, 401);
  assert.equal((await get('maker')).status, 403);
  assert.equal((await get('other-admin')).status, 403);
  assert.equal(listed.length, 0);

  const ok = await get('admin', '?limit=20');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { items: [], quarantined: 0, nextCursor: null });
  assert.deepEqual(listed, [{ actorRef: '619b9c43-8495-420d-b3d3-34d9fd0b5b89', limit: 20 }]);
  for (const limit of ['0', '101', 'abc']) {
    assert.equal((await get('admin', `?limit=${limit}`)).status, 400, limit);
  }
  // webhook ยังเป็น public แม้มี OIDC guard
  const webhook = await fetch(`${base}/webhook/line`, {
    method: 'POST',
    headers: { 'x-line-signature': 'valid' },
    body: '{}',
  });
  assert.equal(webhook.status, 200);
});

test('#565/#566 composition root ของ line-webhook ไม่พึ่ง Kafka/Journey/voice/object storage', () => {
  const code = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const source = code('line-webhook-app.ts') + code('line-webhook-main.ts');
  for (const forbidden of [
    '@d-contact/kafka',
    '@d-contact/journey',
    'ioredis',
    'minio',
    '@aws-sdk',
    'recording',
    'telephony',
    'HttpLineProviderTransport',
    'createConsumer',
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'i'), forbidden);
  }
  const imports = [...source.matchAll(/from '(@d-contact\/[^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(imports)].sort(), [
    '@d-contact/db',
    '@d-contact/delivery',
    '@d-contact/workspace-session',
  ]);
});
