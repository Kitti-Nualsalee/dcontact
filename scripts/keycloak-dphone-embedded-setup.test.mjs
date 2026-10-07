import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DPHONE_EMBEDDED_CLIENT,
  DPHONE_EMBEDDED_LIFESPANS,
  dphoneEmbeddedClient,
  dphoneTemplateClientId,
} from './keycloak-dphone-embedded-setup.mjs';

test('ใช้ agent-desktop เป็น template โดยค่าเริ่มต้น', () => {
  assert.equal(dphoneTemplateClientId, 'agent-desktop');
});

test('สร้าง public client ที่คัดลอก mapper และจำกัด redirect ตาม origin', () => {
  const mapper = {
    id: 'mapper-id-from-template',
    name: 'dcontact-api audience',
    protocol: 'openid-connect',
  };
  const client = dphoneEmbeddedClient(
    { fullScopeAllowed: false, protocolMappers: [mapper] },
    'https://uat.example.test',
  );

  assert.equal(client.clientId, DPHONE_EMBEDDED_CLIENT);
  assert.equal(client.publicClient, true);
  assert.equal(client.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(
    client.attributes['access.token.lifespan'],
    String(DPHONE_EMBEDDED_LIFESPANS.accessTokenSeconds),
  );
  assert.deepEqual(client.redirectUris, ['https://uat.example.test/dphone/auth/callback']);
  assert.deepEqual(client.webOrigins, ['https://uat.example.test']);
  assert.deepEqual(client.protocolMappers, [{ name: mapper.name, protocol: mapper.protocol }]);
  assert.equal(client.fullScopeAllowed, false);
});
