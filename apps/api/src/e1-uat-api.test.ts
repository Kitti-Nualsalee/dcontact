import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { createE1UatApiModule } from './e1-uat-api.js';
import { RuntimeProfileRouteGuard, resolveApiRuntimeProfile } from './runtime-profile.js';

test('uat-e1 mount launcher กับ E1 API เท่านั้น และยังบังคับ OIDC', async (t) => {
  const profile = resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'uat-e1' });
  const routeGuard = new RuntimeProfileRouteGuard(profile, { write: () => undefined });
  const module = createE1UatApiModule({
    database: {} as never,
    verifier: { verifyAccessToken: async () => Promise.reject(new Error('invalid')) },
    diagnostics: { write: () => undefined },
    lifecycle: { isActive: async () => true },
    status: {
      profile,
      routeGuard,
      journeyAuthoring: { canvasWrite: false, publishUi: false },
    },
    embedOrigins: {} as never,
    leases: {} as never,
    screenPop: {} as never,
    clickToCall: {} as never,
    sipCredentials: {},
    shellOptions: {
      scriptUrl: 'https://uat.example/workspace/embed/dphone-embed.js',
      auth: { issuer: 'https://uat.example/auth/realms/dcontact', clientId: 'dphone-embedded' },
    },
  });
  const app = await NestFactory.create(module, { logger: false });
  app.use(routeGuard.middleware);
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const { port } = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${base}/embed/v1/dphone-launcher.js`)).status, 200);
  assert.equal((await fetch(`${base}/api/v1/tenant/embed-origins`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/me/work-session`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/workspace/agent/snapshot`)).status, 401);
  const blocked = await fetch(`${base}/api/v1/journey-authoring/journeys`);
  assert.equal(blocked.status, 404);
  assert.equal(((await blocked.json()) as { code: string }).code, 'ROUTE_NOT_AVAILABLE_IN_PROFILE');
});

test('composition root ของ uat-e1 ไม่มี Kafka, LINE หรือ delivery provider', () => {
  const source = readFileSync(join(__dirname, 'e1-uat-api.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [
    '@d-contact/kafka',
    '@d-contact/delivery',
    'line-webhook',
    'createConsumer',
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'i'), forbidden);
  }
});
