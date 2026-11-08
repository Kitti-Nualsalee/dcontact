import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { KeycloakC360TokenIntrospector } from './customer-360-work-auth.js';

test('introspection ส่ง exact token ผ่าน confidential backend โดยไม่ redirect หรือ cache', async (t) => {
  let calls = 0;
  const client = new KeycloakC360TokenIntrospector({
    issuer: 'https://idp.test/realms/test',
    clientId: 'backend',
    clientSecret: 'synthetic-secret',
    fetch: async (url, options) => {
      calls += 1;
      assert.equal(
        String(url),
        'https://idp.test/realms/test/protocol/openid-connect/token/introspect',
      );
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.method, 'POST');
      const body = new URLSearchParams(String(options?.body));
      assert.equal(body.get('token'), 'exact-access-token');
      assert.equal(body.get('client_id'), 'backend');
      assert.equal(body.get('client_secret'), 'synthetic-secret');
      assert.equal(body.get('token_type_hint'), 'access_token');
      return Response.json({ active: true });
    },
  });
  await client.introspect('exact-access-token');
  await client.introspect('exact-access-token');
  assert.equal(calls, 2, 'must not reuse positive introspection results');
  assert.throws(
    () =>
      new KeycloakC360TokenIntrospector({
        issuer: 'http://remote.test/realms/test',
        clientId: 'backend',
        clientSecret: 'x',
      }),
  );
});

test('HTTP introspection timeout จริงต้อง fail closed และไม่เปิด token ใน error', async (t) => {
  const server = createServer((_req, res) => {
    setTimeout(() => res.end('{"active":true}'), 150).unref();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new KeycloakC360TokenIntrospector({
    issuer: `http://127.0.0.1:${address.port}/realms/test`,
    clientId: 'backend',
    clientSecret: 'synthetic-secret',
    timeoutMs: 20,
  });
  await assert.rejects(
    () => client.introspect('private-access-token'),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'WORK_IDENTITY_UNAVAILABLE' &&
      !String(error).includes('private-access-token'),
  );
});
