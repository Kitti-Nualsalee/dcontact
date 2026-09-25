import assert from 'node:assert/strict';
import test from 'node:test';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { KeycloakAdminClient } from './keycloak-admin.js';
import {
  currentTraceparent,
  keycloakOperation,
  safeAttributes,
  startPlatformTracing,
  withSpan,
} from './platform-tracing.js';

const USER = '6f1c2b1e-8e0a-4d6b-9a57-0d6f3c1b2a90';

test('ไม่ตั้ง OTLP endpoint = ปิด (no-op) และไม่มี traceparent ให้เก็บ', async () => {
  assert.equal(startPlatformTracing({ serviceName: 's', env: {} }).enabled, false);
  await withSpan('noop', {}, async () => {
    assert.equal(currentTraceparent(), null);
  });
});

test('safeAttributes รับเฉพาะ key ที่อนุญาตและค่าที่เป็น id/code — email/ข้อความอิสระถูกทิ้ง', () => {
  assert.deepEqual(
    safeAttributes({
      'dcontact.request_id': USER,
      'dcontact.step_key': 'FIRST_ADMIN',
      'dcontact.attempt': 2,
      'dcontact.code': 'owner@example.test',
      'dcontact.action': 'แก้อีเมล',
      'user.email': 'owner@example.test',
      'http.route': '/api/v1/provisioning-requests/:requestId',
    }),
    {
      'dcontact.request_id': USER,
      'dcontact.step_key': 'FIRST_ADMIN',
      'dcontact.attempt': 2,
      'http.route': '/api/v1/provisioning-requests/:requestId',
    },
  );
  assert.equal(
    keycloakOperation('GET', `/users/${USER}/groups?search=owner@example.test`),
    'GET /users/{id}/groups',
  );
});

test('span ต่อจาก traceparent ที่เก็บไว้ (worker restart) และ Keycloak call เป็น CLIENT span ที่ไม่มี query', async (t) => {
  const exporter = new InMemorySpanExporter();
  const tracing = startPlatformTracing({ serviceName: 'test', exporter });
  t.after(async () => {
    await tracing.shutdown();
    trace.disable();
  });

  let stored: string | null = null;
  await withSpan('HTTP POST', {}, async () => {
    stored = currentTraceparent();
  });
  assert.match(stored ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  const keycloak = new KeycloakAdminClient({
    baseUrl: 'http://keycloak.test',
    realm: 'dcontact',
    clientId: 'dcontact-provisioner',
    clientSecret: 'secret',
    fetch: async (url) =>
      String(url).includes('/token')
        ? new Response(JSON.stringify({ access_token: 'token', expires_in: 60 }))
        : new Response('[]', { status: 200 }),
  });
  // process ใหม่ไม่มี context ในหน่วยความจำ — มีแค่ traceparent จาก DB
  await withSpan('provisioning.step FIRST_ADMIN', { parent: stored }, async () => {
    await keycloak.admin(
      'GET',
      `/users?email=${encodeURIComponent('owner@example.test')}&exact=true`,
    );
    await keycloak.admin('GET', `/users/${USER}`, { accept: [200, 404] });
  });

  const spans = exporter.getFinishedSpans();
  const traceIds = new Set(spans.map((span) => span.spanContext().traceId));
  assert.equal(traceIds.size, 1, 'ทุก span ต้องอยู่ใน trace เดียวกับ HTTP request');
  assert.deepEqual(spans.map((span) => span.name).sort(), [
    'HTTP POST',
    'keycloak GET /users',
    'keycloak GET /users/{id}',
    'provisioning.step FIRST_ADMIN',
  ]);
  const serialized = JSON.stringify(spans.map((span) => [span.name, span.attributes]));
  assert.equal(serialized.includes('owner'), false);
  assert.equal(serialized.includes(USER), false);
});
