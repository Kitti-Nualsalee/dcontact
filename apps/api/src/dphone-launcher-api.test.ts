import 'reflect-metadata';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import {
  DPHONE_LAUNCHER_OPTIONS,
  DphoneLauncherController,
  defaultLauncherReleasesDir,
} from './dphone-launcher-api.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';

async function serve(t: TestContext, releasesDir: string) {
  @Module({
    controllers: [DphoneLauncherController],
    providers: [
      { provide: DPHONE_LAUNCHER_OPTIONS, useValue: { releasesDir } },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: { verifyAccessToken: async () => ({}) },
      },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return (path: string) => fetch(`${base}${path}`);
}

test('E1.15: alias v1 (cache 5 นาที) และ version ที่ตรึง (immutable 1 ปี) ได้ไฟล์เดียวกันพร้อม integrity; CORS สาธารณะ', async (t) => {
  const get = await serve(t, defaultLauncherReleasesDir());
  const alias = await get('/embed/v1/dphone-launcher.js');
  assert.equal(alias.status, 200);
  assert.equal(alias.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(alias.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(alias.headers.get('access-control-allow-origin'), '*');
  const version = alias.headers.get('x-dphone-launcher-version')!;
  const pinned = await get(`/embed/v${version}/dphone-launcher.js`);
  assert.equal(pinned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await pinned.text(), await alias.text());

  const releases = (await (await get('/embed/releases.json')).json()) as {
    versions: Record<string, { integrity: string }>;
    aliases: Record<string, string>;
  };
  assert.equal(releases.aliases.v1, version);
  assert.equal(
    releases.versions[version]!.integrity,
    pinned.headers.get('x-dphone-launcher-integrity'),
  );
});

test('E1.15: version ที่ไม่มี, path แปลก และไฟล์ที่ถูกแก้ = 404 (fail closed); ชี้ alias กลับ = rollback ทันที', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-api-'));
  cpSync(defaultLauncherReleasesDir(), dir, { recursive: true });
  const get = await serve(t, dir);
  for (const path of [
    '/embed/v9/dphone-launcher.js',
    '/embed/v9.9.9/dphone-launcher.js',
    '/embed/..%2F..%2Fpackage.json/dphone-launcher.js',
    '/embed/latest/dphone-launcher.js',
  ]) {
    assert.equal((await get(path)).status, 404, path);
  }

  // สร้าง 1.0.1 แล้วเลื่อน alias → rollback กลับ 1.0.0 โดยไม่ restart
  const { createHash } = await import('node:crypto');
  const index = JSON.parse(
    (await import('node:fs')).readFileSync(join(dir, 'index.json'), 'utf8'),
  ) as { versions: Record<string, { integrity: string }>; aliases: Record<string, string> };
  const next = 'export const next = true;\n';
  cpSync(join(dir, '1.0.0'), join(dir, '1.0.1'), { recursive: true });
  writeFileSync(join(dir, '1.0.1', 'dphone-launcher.js'), next);
  index.versions['1.0.1'] = {
    integrity: `sha384-${createHash('sha384').update(next).digest('base64')}`,
  };
  index.aliases.v1 = '1.0.1';
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
  assert.equal(await (await get('/embed/v1/dphone-launcher.js')).text(), next);
  index.aliases.v1 = '1.0.0';
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
  const rolledBack = await get('/embed/v1/dphone-launcher.js');
  assert.equal(rolledBack.headers.get('x-dphone-launcher-version'), '1.0.0');

  writeFileSync(join(dir, '1.0.0', 'dphone-launcher.js'), 'tampered');
  assert.equal((await get('/embed/v1.0.0/dphone-launcher.js')).status, 404);
});
