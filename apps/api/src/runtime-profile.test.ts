import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import {
  ApiRuntimeProfileError,
  RuntimeProfileRouteGuard,
  assertEntrypointProfile,
  resolveApiRuntimeProfile,
  type RuntimeProfileDiagnostic,
} from './runtime-profile.js';

function rejectsWith(work: () => unknown, code: ApiRuntimeProfileError['code']) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ApiRuntimeProfileError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

test('ไม่ตั้ง profile = default ที่เปิด Kafka/LINE ตามเดิม', () => {
  assert.deepEqual(resolveApiRuntimeProfile({}), {
    name: 'default',
    kafka: 'ENABLED',
    lineWebhook: 'ENABLED',
    providerEgress: 'ALLOWED',
    allowedRoutePrefixes: null,
  });
});

test('uat ปิด Kafka/LINE/egress และจำกัด route เฉพาะ Journey authoring', () => {
  const profile = resolveApiRuntimeProfile({
    DCONTACT_API_PROFILE: 'uat',
    DATABASE_URL: 'postgresql://uat',
    J5_CANVAS_WRITE_ENABLED: 'true',
  });
  assert.equal(profile.name, 'uat');
  assert.equal(profile.kafka, 'DISABLED');
  assert.equal(profile.lineWebhook, 'DISABLED');
  assert.equal(profile.providerEgress, 'BLOCKED');
  assert.deepEqual(profile.allowedRoutePrefixes, [
    '/api/v1/journey-authoring',
    '/api/v1/runtime-profile',
  ]);
});

test('profile ที่ไม่รู้จักทำให้บูตไม่ผ่าน', () => {
  rejectsWith(
    () => resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'staging' }),
    'UNKNOWN_PROFILE',
  );
});

test('uat + config ของ provider/Kafka/voice = fail closed และรายงานเฉพาะชื่อ env ไม่ใช่ค่า', () => {
  const secret = 'line-secret-value-must-not-leak';
  assert.throws(
    () =>
      resolveApiRuntimeProfile({
        DCONTACT_API_PROFILE: 'uat',
        LINE_WEBHOOK_SECRET_SOURCE: secret,
        KAFKA_BROKERS: 'redpanda:9092',
        SIP_BROWSER_NODES_JSON: '[]',
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiRuntimeProfileError);
      assert.equal(error.code, 'CONFLICTING_CONFIGURATION');
      assert.deepEqual(error.variables, [
        'KAFKA_BROKERS',
        'LINE_WEBHOOK_SECRET_SOURCE',
        'SIP_BROWSER_NODES_JSON',
      ]);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  // ค่าว่างไม่ถือว่าตั้งไว้ (compose มักส่ง key ที่ไม่มีค่า)
  assert.equal(
    resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'uat', KAFKA_BROKERS: '' }).name,
    'uat',
  );
});

test('entrypoint รับ profile เดียว: main.ts ปฏิเสธ uat และ uat-main ปฏิเสธ default', () => {
  rejectsWith(
    () => assertEntrypointProfile('default', { DCONTACT_API_PROFILE: 'uat' }),
    'WRONG_ENTRYPOINT',
  );
  rejectsWith(() => assertEntrypointProfile('uat', {}), 'WRONG_ENTRYPOINT');
  assert.equal(assertEntrypointProfile('default', {}).name, 'default');
});

function fakeExchange(url: string, method = 'POST') {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(body: string) {
      this.body = body;
    },
  };
  return {
    request: { url, method } as IncomingMessage,
    response,
    asResponse: response as unknown as ServerResponse,
  };
}

test('route guard ของ uat บล็อก route นอก allowlist พร้อม counter และ log ที่ไม่มี id', () => {
  const diagnostics: RuntimeProfileDiagnostic[] = [];
  const guard = new RuntimeProfileRouteGuard(
    resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'uat' }),
    { write: (diagnostic) => diagnostics.push(diagnostic) },
  );
  let passed = 0;
  const next = () => {
    passed += 1;
  };

  for (const url of [
    '/api/v1/journey-authoring/journeys?limit=10',
    '/api/v1/runtime-profile',
    '/health',
  ]) {
    const exchange = fakeExchange(url, 'GET');
    guard.middleware(exchange.request, exchange.asResponse, next);
  }
  assert.equal(passed, 3);

  const blocked = fakeExchange('/api/v1/line-webhook/1c1e8a7e-2a5b-4a57-9d0c-3a3f3f1b9f00');
  guard.middleware(blocked.request, blocked.asResponse, next);
  // prefix ที่ขึ้นต้นเหมือนกันแต่ไม่ใช่ segment เดียวกันต้องไม่หลุด
  const lookalike = fakeExchange('/api/v1/journey-authoring-admin/x');
  guard.middleware(lookalike.request, lookalike.asResponse, next);

  assert.equal(passed, 3);
  assert.equal(guard.blockedRequests(), 2);
  assert.equal(blocked.response.statusCode, 404);
  assert.equal(JSON.parse(blocked.response.body).code, 'ROUTE_NOT_AVAILABLE_IN_PROFILE');
  assert.deepEqual(diagnostics, [
    {
      event: 'api.runtime_profile.route_blocked',
      profile: 'uat',
      routeFamily: 'line-webhook',
      method: 'POST',
    },
    {
      event: 'api.runtime_profile.route_blocked',
      profile: 'uat',
      routeFamily: 'journey-authoring-admin',
      method: 'POST',
    },
  ]);
});

test('route guard ของ default ปล่อยทุก route', () => {
  const guard = new RuntimeProfileRouteGuard(resolveApiRuntimeProfile({}), {
    write: () => assert.fail('default must not block'),
  });
  const exchange = fakeExchange('/api/v1/line-webhook');
  let passed = false;
  guard.middleware(exchange.request, exchange.asResponse, () => {
    passed = true;
  });
  assert.ok(passed);
  assert.equal(guard.blockedRequests(), 0);
});
