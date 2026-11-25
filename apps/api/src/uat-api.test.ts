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
  const uatRuns = {
    current: async (currentTenant: string) => ({ runId: 'run-1', tenantId: currentTenant }),
  };
  const uatEvidence = {
    list: async (listedTenant: string, _actor: unknown, runId: string) => ({
      runId,
      tenantId: listedTenant,
      items: [],
    }),
  };
  const module = createUatApiModule({
    repository,
    uatRuns,
    uatEvidence,
    verifier: {
      verifyAccessToken: async (token: string) => {
        if (token === 'maker-token') return claims();
        throw new Error('invalid token');
      },
    },
    diagnostics: { write: () => undefined },
    lifecycle: { isActive: async () => true },
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

test('the UAT API mounts only Journey authoring, which still needs login, and blocks other routes with a counter', async (t) => {
  const { base, listed } = await startUatApi(t);

  // Journey authoring is mounted and still passes the OIDC guard as usual
  assert.equal((await fetch(`${base}/api/v1/journey-authoring/journeys`)).status, 401);
  const authorized = await fetch(`${base}/api/v1/journey-authoring/journeys`, {
    headers: { authorization: 'Bearer maker-token' },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(listed, [tenantId]);

  // the UAT run API (U1.1 #429) is mounted and also needs login
  assert.equal((await fetch(`${base}/api/v1/uat-runs/current`)).status, 401);
  const run = await fetch(`${base}/api/v1/uat-runs/current`, {
    headers: { authorization: 'Bearer maker-token' },
  });
  assert.deepEqual(await run.json(), { runId: 'run-1', tenantId });

  // run evidence (U1.5 #433) is under the same prefix and also needs login
  const runId = '9d6b1c1e-8f4c-4c55-9a55-3f1f5f3e7a10';
  assert.equal((await fetch(`${base}/api/v1/uat-runs/${runId}/evidence`)).status, 401);
  const evidence = await fetch(`${base}/api/v1/uat-runs/${runId}/evidence`, {
    headers: { authorization: 'Bearer maker-token' },
  });
  assert.deepEqual(await evidence.json(), { runId, tenantId, items: [] });

  // provider/telephony/workspace routes do not exist in UAT
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
  assert.equal(status.status, 200, 'readiness can be read without a token');
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

/**
 * Phase Contract #374 puts screenshot evidence in the UAT stack's object storage (U1.5 #433) — so the composition root can touch
 * object storage only through the dedicated UAT evidence module, while recording/Kafka/LINE/Redis stay forbidden as before
 */
test('the UAT composition root does not depend on Kafka/LINE/Redis/recording/telephony, object storage is only the UAT evidence module, and there is no unilateral publish route', () => {
  const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');
  // check code only, excluding comments that explain what this file deliberately does not use
  const code = (file: string) =>
    source(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const uat = code('uat-api.ts') + code('uat-main.ts');
  for (const forbidden of [
    '@d-contact/kafka',
    '@d-contact/delivery',
    'ioredis',
    // the object storage client lives only in uat-evidence-storage.ts
    'minio',
    '@aws-sdk',
    'recording',
    'workspace-session-api',
    'line-webhook',
    'createConsumer',
  ]) {
    assert.doesNotMatch(uat, new RegExp(forbidden, 'i'), forbidden);
  }
  const storageImports = [...uat.matchAll(/from '([^']*storage[^']*)'/g)].map((match) => match[1]);
  assert.deepEqual(storageImports, ['./uat-evidence-storage.js']);

  // the evidence module: a private bucket, no presigned/public URL and no other forbidden dependency attached
  const evidence = code('uat-evidence-storage.ts') + code('uat-evidence-api.ts');
  for (const forbidden of [
    'getSignedUrl',
    's3-request-presigner',
    'presign',
    'PutBucketPolicy',
    'PutBucketAcl',
    'PutObjectAcl',
    'ACL',
    'public-read',
    'Redirect',
    '@d-contact/kafka',
    'ioredis',
    'recording',
    'line-webhook',
  ]) {
    assert.doesNotMatch(evidence, new RegExp(forbidden, 'i'), forbidden);
  }
  // maker-checker must really be enforced in UAT (#374 §6): the mounted controllers do not call this shortcut
  for (const controller of ['journey-authoring-api.ts', 'journey-template-api.ts']) {
    assert.doesNotMatch(source(controller), /Unilateral/, controller);
  }
});
