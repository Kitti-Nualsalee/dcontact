import assert from 'node:assert/strict';
import test from 'node:test';
import { KeycloakAdminClient } from './keycloak-admin.js';
import { deterministicUuid, firstAdminUserId } from './provisioning-ids.js';
import { ProvisioningStepError } from './provisioning-saga.js';

const SECRET_BODY = '{"errorMessage":"admin+leak@example.test already exists"}';

function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    if (url.endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 300 }), {
        status: 200,
      });
    }
    return respond(url, init ?? {});
  }) as typeof fetch;
  return {
    calls,
    keycloak: new KeycloakAdminClient({
      baseUrl: 'http://keycloak.test',
      realm: 'dcontact',
      clientId: 'dcontact-provisioner',
      clientSecret: 'secret',
      fetch: fetcher,
    }),
  };
}

async function stepError(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof ProvisioningStepError, String(error));
    // no response body/email/token leaks out with the error
    assert.equal(`${error.message}${error.stack}`.includes('leak@example.test'), false);
    return `${error.kind}:${error.code}`;
  }
  throw new Error('must throw');
}

test('maps status to a sanitized step error: read 5xx retryable, write 5xx unknown outcome, 4xx permanent', async () => {
  const cases: Array<[string, number, string]> = [
    ['GET', 503, 'TRANSIENT:KEYCLOAK_SERVER_ERROR'],
    ['POST', 502, 'AMBIGUOUS:KEYCLOAK_SERVER_ERROR'],
    ['POST', 403, 'PERMANENT:KEYCLOAK_FORBIDDEN'],
    ['PUT', 400, 'PERMANENT:KEYCLOAK_REJECTED'],
    ['GET', 429, 'TRANSIENT:KEYCLOAK_RATE_LIMITED'],
  ];
  for (const [method, status, expected] of cases) {
    const { keycloak } = client(() => new Response(SECRET_BODY, { status }));
    assert.equal(
      await stepError(keycloak.admin(method as 'GET', '/users')),
      expected,
      `${method} ${status}`,
    );
  }
});

test('network failure: reads are retryable, writes are treated as possibly done; abort = timeout', async () => {
  const { keycloak } = client(() => {
    throw new TypeError('fetch failed');
  });
  assert.equal(await stepError(keycloak.admin('GET', '/users')), 'TRANSIENT:KEYCLOAK_UNREACHABLE');
  assert.equal(await stepError(keycloak.admin('POST', '/users')), 'AMBIGUOUS:KEYCLOAK_UNREACHABLE');
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await stepError(keycloak.admin('POST', '/users', { signal: controller.signal })),
    'AMBIGUOUS:EXTERNAL_TIMEOUT',
  );
});

test('a status the caller accepts is returned for the caller to decide, and a 401 requests a new token once', async () => {
  let unauthorized = true;
  const { keycloak, calls } = client(() => {
    if (unauthorized) {
      unauthorized = false;
      return new Response('', { status: 401 });
    }
    return new Response('', { status: 409 });
  });
  const response = await keycloak.admin('POST', '/organizations', { accept: [201, 409] });
  assert.equal(response.status, 409);
  assert.deepEqual(calls, [
    'POST /realms/dcontact/protocol/openid-connect/token',
    'POST /admin/realms/dcontact/organizations',
    'POST /realms/dcontact/protocol/openid-connect/token',
    'POST /admin/realms/dcontact/organizations',
  ]);
});

test('first-admin user id is deterministic per request and a UUID Postgres accepts', () => {
  const requestId = '0ecbd23a-3cb9-4992-8577-b3039abb5a07';
  assert.equal(firstAdminUserId(requestId), firstAdminUserId(requestId));
  assert.notEqual(firstAdminUserId(requestId), firstAdminUserId(requestId.replace('0e', '1e')));
  assert.match(
    deterministicUuid('ns', 'value'),
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
