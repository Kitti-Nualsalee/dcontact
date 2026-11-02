import assert from 'node:assert/strict';
import test from 'node:test';
import { peopleKeycloakRequest } from './tenant-people-backchannel.js';

const issuer = 'https://identity.example.test/auth/realms/dcontact';
const backchannel = 'http://keycloak:8080/auth/realms/dcontact';

test('backchannel ส่งเฉพาะ token และ People ของ realm เดิม โดยคง signal/body และห้าม redirect', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const request: typeof fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    return Response.json({ ready: true });
  };
  const transport = peopleKeycloakRequest(issuer, backchannel, request);
  const signal = AbortSignal.timeout(5_000);
  const body = new URLSearchParams({ client_secret: 'synthetic-only' });
  await transport(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    body,
    signal,
    redirect: 'follow',
  });
  await transport(new URL(`${issuer}/dc-tenant-people/readiness?tenantId=synthetic`));
  await transport(`${issuer}/dc-tenant-people/operations/synthetic/steps/CREATE_IDENTITY`, {
    method: 'POST',
    headers: { Authorization: 'Bearer synthetic-only' },
  });
  assert.equal(calls[0]?.url, `${backchannel}/protocol/openid-connect/token`);
  assert.equal(calls[0]?.options?.signal, signal);
  assert.equal(calls[0]?.options?.body, body);
  assert.equal(calls[0]?.options?.redirect, 'error');
  assert.equal(calls[1]?.url, `${backchannel}/dc-tenant-people/readiness?tenantId=synthetic`);
  assert.equal(calls[2]?.options?.method, 'POST');
});

test('ไม่มี opt-in ใช้ HTTPS transport เดิมโดยไม่เปลี่ยนปลายทางหรือตัวเลือก TLS', () => {
  const request: typeof fetch = async () => Response.json({});
  assert.equal(peopleKeycloakRequest(issuer, undefined, request), request);
});

test('backchannel ปฏิเสธ host/port/realm/protocol และ URL components ที่ไม่ได้อนุมัติ', () => {
  for (const target of [
    '',
    'http://127.0.0.1:8080/auth/realms/dcontact',
    'http://keycloak.evil:8080/auth/realms/dcontact',
    'http://keycloak:8081/auth/realms/dcontact',
    'https://keycloak:8080/auth/realms/dcontact',
    'http://keycloak:8080/auth/realms/foreign',
    'http://user:secret@keycloak:8080/auth/realms/dcontact',
    `${backchannel}?query=1`,
    `${backchannel}#fragment`,
    `${backchannel}/`,
  ])
    assert.throws(() => peopleKeycloakRequest(issuer, target));
  for (const publicIssuer of [
    'http://identity.example.test/auth/realms/dcontact',
    `${issuer}?query=1`,
    `${issuer}#fragment`,
    'https://user:secret@identity.example.test/auth/realms/dcontact',
  ])
    assert.throws(() => peopleKeycloakRequest(publicIssuer, backchannel));
});

test('backchannel ปฏิเสธ foreign issuer/admin/account/path traversal ก่อนส่งข้อมูล', async () => {
  let sent = 0;
  const request: typeof fetch = async () => {
    sent += 1;
    return Response.json({});
  };
  const transport = peopleKeycloakRequest(issuer, backchannel, request);
  for (const target of [
    'https://foreign.example.test/auth/realms/dcontact/dc-tenant-people/readiness',
    `${issuer}/dc-account/profile`,
    `${issuer}/admin/users`,
    `${issuer}/dc-tenant-people/../../admin/users`,
    `${issuer}/dc-tenant-people/%2e%2e%2fadmin/users`,
    `${issuer}/dc-tenant-people-foreign/readiness`,
    `${issuer}/protocol/openid-connect/token/foreign`,
    `${issuer}/dc-tenant-people/readiness#fragment`,
    'https://user:secret@identity.example.test/auth/realms/dcontact/dc-tenant-people/readiness',
  ])
    await assert.rejects(() => transport(target));
  await assert.rejects(() => transport(new Request(`${issuer}/dc-tenant-people/readiness`)));
  assert.equal(sent, 0);
});
