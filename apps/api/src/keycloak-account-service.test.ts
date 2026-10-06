import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountPolicyError } from './account-policy.js';
import {
  KeycloakAccountServiceClient,
  KeycloakOrganizationMfa,
} from './keycloak-account-service.js';

const ISSUER = 'http://keycloak.test/realms/dcontact';
const TENANT = 'f506c58a-ff3c-4525-88a0-96ce9c351d15';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function fakeKeycloak(responses: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: String(init.body ?? ''),
    };
    calls.push(call);
    const next = responses.shift();
    assert.ok(next, `ไม่ได้คาดว่าจะมีการเรียก ${call.method} ${url}`);
    return next(call);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const tokenResponse =
  (token: string, expiresIn = 300) =>
  () =>
    Response.json({ access_token: token, expires_in: expiresIn });
const status = (code: number) => () => new Response(null, { status: code });

test('sync บังคับ 2FA: ขอ token แบบ client_credentials แล้ว PUT ไปที่ extension ของ tenant', async () => {
  const { calls, fetch } = fakeKeycloak([tokenResponse('t1'), status(204)]);
  const port = new KeycloakOrganizationMfa(
    new KeycloakAccountServiceClient({ issuer: `${ISSUER}/`, clientSecret: 's3cret', fetch }),
  );
  await port.setMfaRequired(TENANT, true);

  assert.equal(calls[0]!.url, `${ISSUER}/protocol/openid-connect/token`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0]!.body)), {
    grant_type: 'client_credentials',
    client_id: 'dcontact-account-service',
    client_secret: 's3cret',
  });
  assert.equal(calls[1]!.method, 'PUT');
  assert.equal(
    calls[1]!.url,
    `${ISSUER}/dc-account/organizations/by-tenant/${TENANT}/mfa-required`,
  );
  assert.equal(calls[1]!.headers.authorization, 'Bearer t1');
  assert.deepEqual(JSON.parse(calls[1]!.body), { required: true });
});

test('token ถูก cache จนใกล้หมดอายุ; 401 = ขอ token ใหม่แล้วลองซ้ำครั้งเดียว', async () => {
  let now = 0;
  const { calls, fetch } = fakeKeycloak([
    tokenResponse('t1', 300),
    status(204),
    status(204),
    // ผ่านไป 271 วินาที (เหลือ < 30 วินาที) → ขอใหม่
    tokenResponse('t2', 300),
    status(401),
    tokenResponse('t3', 300),
    status(204),
  ]);
  const port = new KeycloakOrganizationMfa(
    new KeycloakAccountServiceClient({ issuer: ISSUER, clientSecret: 's', fetch, now: () => now }),
  );
  await port.setMfaRequired(TENANT, true);
  await port.setMfaRequired(TENANT, false);
  now = 271_000;
  await port.setMfaRequired(TENANT, true);
  assert.deepEqual(
    calls.map((call) => call.headers.authorization ?? 'token'),
    ['token', 'Bearer t1', 'Bearer t1', 'token', 'Bearer t2', 'token', 'Bearer t3'],
  );
});

test('ทุกความล้มเหลวเป็น IDENTITY_UNAVAILABLE และไม่แนบรายละเอียดของ Keycloak', async () => {
  const cases: Array<Array<(call: Call) => Response | Promise<Response>>> = [
    [status(401)],
    [() => Response.json({ error: 'invalid_client' }, { status: 401 })],
    [() => Response.json({ nope: true })],
    [tokenResponse('t'), () => Response.json({ code: 'ORGANIZATION_NOT_FOUND' }, { status: 404 })],
    [tokenResponse('t'), status(403)],
    [tokenResponse('t'), status(401), tokenResponse('t2'), status(401)],
    [
      () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED secret-host:8443');
      },
    ],
  ];
  for (const responses of cases) {
    const { fetch } = fakeKeycloak(responses);
    const port = new KeycloakOrganizationMfa(
      new KeycloakAccountServiceClient({ issuer: ISSUER, clientSecret: 's', fetch }),
    );
    await assert.rejects(port.setMfaRequired(TENANT, true), (error: unknown) => {
      assert.ok(error instanceof AccountPolicyError);
      assert.equal(error.code, 'IDENTITY_UNAVAILABLE');
      assert.equal(error.message, 'IDENTITY_UNAVAILABLE');
      return true;
    });
  }
});

test('timeout ของ Keycloak ไม่ค้าง request — ยกเลิกตาม timeoutMs', async () => {
  const fetch = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as typeof globalThis.fetch;
  const port = new KeycloakOrganizationMfa(
    new KeycloakAccountServiceClient({ issuer: ISSUER, clientSecret: 's', fetch, timeoutMs: 20 }),
  );
  // timer ของ AbortSignal.timeout เป็น unref — กัน event loop ว่างก่อน abort ใน test
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await assert.rejects(port.setMfaRequired(TENANT, true), { code: 'IDENTITY_UNAVAILABLE' });
  } finally {
    clearInterval(keepAlive);
  }
});
