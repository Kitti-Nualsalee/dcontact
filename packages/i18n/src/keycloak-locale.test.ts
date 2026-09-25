import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readUserLocalePreference,
  saveUserLocale,
  UserLocaleSaveError,
} from './keycloak-locale.js';

test('อ่าน locale/zoneinfo จาก claims และข้ามค่าที่ใช้ไม่ได้', () => {
  assert.deepEqual(readUserLocalePreference({ locale: 'en', zoneinfo: 'Asia/Bangkok' }), {
    locale: 'en',
    timeZone: 'Asia/Bangkok',
  });
  assert.deepEqual(readUserLocalePreference({ locale: 'de', zoneinfo: 'nowhere' }), {});
  assert.deepEqual(readUserLocalePreference(undefined), {});
});

test('บันทึกผ่าน Account API โดยคงข้อมูลเดิมและเปลี่ยนเฉพาะ attributes.locale', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (!init?.method) {
      return Response.json({
        username: 'agent1000@demo.local',
        firstName: 'Agent',
        attributes: { locale: ['th'], tenant_id: ['t-1'] },
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  await saveUserLocale({
    issuer: 'http://kc/realms/dcontact/',
    accessToken: 'token-1',
    locale: 'en',
    fetch: fakeFetch,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, 'http://kc/realms/dcontact/account');
  assert.equal(calls[1]!.init?.method, 'POST');
  assert.equal((calls[1]!.init?.headers as Record<string, string>).authorization, 'Bearer token-1');
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), {
    username: 'agent1000@demo.local',
    firstName: 'Agent',
    attributes: { locale: ['en'], tenant_id: ['t-1'] },
  });
});

test('Account API ปฏิเสธ → โยน UserLocaleSaveError พร้อม status', async () => {
  const denied = (async () => new Response(null, { status: 403 })) as typeof fetch;
  await assert.rejects(
    saveUserLocale({ issuer: 'http://kc/realms/x', accessToken: 't', locale: 'th', fetch: denied }),
    (error: unknown) => error instanceof UserLocaleSaveError && error.status === 403,
  );
});

test('fetchTenantLocaleDefaults ส่ง bearer และแปลงค่าที่ไม่ใช่ string เป็น null', async () => {
  const { fetchTenantLocaleDefaults } = await import('./tenant-defaults.js');
  let seen: { url: string; auth?: string } | undefined;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seen = { url, auth: (init?.headers as Record<string, string>).authorization };
    return Response.json({ locale: 'en', timeZone: 42 });
  }) as typeof fetch;
  const result = await fetchTenantLocaleDefaults({
    apiBaseUrl: 'https://api.example/',
    accessToken: 'tok',
    fetch: fakeFetch,
  });
  assert.deepEqual(seen, {
    url: 'https://api.example/api/v1/tenant/locale-defaults',
    auth: 'Bearer tok',
  });
  assert.deepEqual(result, { locale: 'en', timeZone: null });
});
