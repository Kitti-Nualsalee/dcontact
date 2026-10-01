import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { createLineWebhookModule } from './line-webhook-app.js';
import { RuntimeProfileRouteGuard, resolveApiRuntimeProfile } from './runtime-profile.js';

const UAT_LINE = {
  DCONTACT_API_PROFILE: 'uat-line',
  LINE_WEBHOOK_SECRET_SOURCE: 'file',
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
  const app = await NestFactory.create(
    createLineWebhookModule({ ingress, status: { profile, routeGuard } }),
    { logger: false, rawBody: true },
  );
  app.use(routeGuard.middleware);
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, received, routeGuard };
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

test('#565 composition root ของ line-webhook ไม่พึ่ง Kafka/Journey/voice/object storage/OIDC', () => {
  const code = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const source = code('line-webhook-app.ts') + code('line-webhook-main.ts');
  for (const forbidden of [
    '@d-contact/kafka',
    '@d-contact/journey',
    '@d-contact/workspace-session',
    'ioredis',
    'minio',
    '@aws-sdk',
    'recording',
    'telephony',
    'OidcGlobalGuard',
    'HttpLineProviderTransport',
    'createConsumer',
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'i'), forbidden);
  }
  const imports = [...source.matchAll(/from '(@d-contact\/[^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(imports)].sort(), ['@d-contact/db', '@d-contact/delivery']);
});
