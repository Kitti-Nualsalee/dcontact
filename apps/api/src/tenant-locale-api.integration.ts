/**
 * D1.11 (#450): `GET /api/v1/tenant/locale-defaults`
 *
 * ต่อ DB ด้วย `dcontact_app` (NOBYPASSRLS) เพื่อพิสูจน์ว่า tenant เห็นเฉพาะ `tenant_settings` ของตัวเอง
 * และ tenant ที่ไม่มีแถว settings ได้ `null` แทน error
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
} from './gateway-auth.js';
import { TENANT_LOCALE_DATABASE, TenantLocaleDefaultsController } from './tenant-locale-api.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

async function harness(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const withSettings = randomUUID();
  const withoutSettings = randomUUID();

  for (const id of [withSettings, withoutSettings]) {
    await owner.tenant.create({
      data: {
        id,
        name: `D1.11 locale ${id.slice(0, 8)}`,
        slug: `d1-11-locale-${id.slice(0, 8)}`,
        sipDomain: `${id.slice(0, 8)}.d1-11-locale.test`,
      },
    });
  }
  await owner.tenantSettings.create({
    data: {
      tenantId: withSettings,
      locale: 'en',
      timezone: 'Asia/Tokyo',
      bootstrapTemplateVersion: 'd1-11-test',
      bootstrapTemplateDigest: 'a'.repeat(64),
      provisioningRequestId: randomUUID(),
    },
  });

  const claims = (tenant: string, roles: string[]): VerifiedOidcClaims => {
    const slug = `d1-11-locale-${tenant.slice(0, 8)}`;
    const userId = randomUUID();
    return {
      tenant_id: tenant,
      tenant_slug: slug,
      organization: { [slug]: { tenant_id: [tenant] } },
      azp: 'agent-desktop',
      sub: userId,
      preferred_username: 'user',
      exp: 2_000_000_000,
      realm_access: { roles },
      dc_user_id: userId,
      sid: 'session',
    };
  };
  const verifier = {
    verifyAccessToken: async (token: string): Promise<VerifiedOidcClaims> => {
      if (token === 'agent-with-settings') return claims(withSettings, ['agent']);
      if (token === 'admin-without-settings') return claims(withoutSettings, ['admin']);
      throw new Error('token ไม่ถูกต้อง');
    },
  };

  @Module({
    controllers: [TenantLocaleDefaultsController],
    providers: [
      { provide: TENANT_LOCALE_DATABASE, useValue: application },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;

  t.after(async () => {
    await app.close();
    await owner.tenantSettings.deleteMany({ where: { tenantId: withSettings } });
    await owner.tenant.deleteMany({ where: { id: { in: [withSettings, withoutSettings] } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const get = (token?: string) =>
    fetch(`http://127.0.0.1:${port}/api/v1/tenant/locale-defaults`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  return { get };
}

test('ผู้ใช้ทุก role ของ tenant อ่านค่าเริ่มต้นของ tenant ตัวเองได้', async (t) => {
  const { get } = await harness(t);
  const response = await get('agent-with-settings');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { locale: 'en', timeZone: 'Asia/Tokyo' });
});

test('tenant ที่ไม่มี tenant_settings ได้ null ไม่ใช่ error และไม่เห็นค่าของ tenant อื่น', async (t) => {
  const { get } = await harness(t);
  const response = await get('admin-without-settings');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { locale: null, timeZone: null });
});

test('ไม่มี bearer token → 401', async (t) => {
  const { get } = await harness(t);
  assert.equal((await get()).status, 401);
});
