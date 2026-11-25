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

test('no profile = the default that enables Kafka/LINE as before', () => {
  assert.deepEqual(resolveApiRuntimeProfile({}), {
    name: 'default',
    kafka: 'ENABLED',
    lineWebhook: 'ENABLED',
    providerEgress: 'ALLOWED',
    allowedRoutePrefixes: null,
  });
});

test('uat closes Kafka/LINE/egress and restricts routes to Journey authoring only', () => {
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
    '/api/v1/uat-runs',
    '/api/v1/runtime-profile',
  ]);
});

test('uat-e1 is separate from uat and enables only the Embedded dphone while still closing provider egress', () => {
  const profile = resolveApiRuntimeProfile({
    DCONTACT_API_PROFILE: 'uat-e1',
    DATABASE_URL: 'postgresql://uat',
    SIP_BROWSER_NODES_JSON: '[]',
  });
  assert.deepEqual(profile, {
    name: 'uat-e1',
    kafka: 'DISABLED',
    lineWebhook: 'DISABLED',
    providerEgress: 'BLOCKED',
    allowedRoutePrefixes: [
      '/api/v1/runtime-profile',
      '/api/v1/tenant/embed-origins',
      '/api/v1/me/work-session',
      '/api/v1/workspace/agent',
    ],
  });
  rejectsWith(
    () =>
      resolveApiRuntimeProfile({
        DCONTACT_API_PROFILE: 'uat-e1',
        KAFKA_BROKERS: 'redpanda:9092',
      }),
    'CONFLICTING_CONFIGURATION',
  );
});

test('an unknown profile makes the boot fail', () => {
  rejectsWith(
    () => resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'staging' }),
    'UNKNOWN_PROFILE',
  );
});

test('uat + provider/Kafka/voice config = fail closed and reports only env names, not values', () => {
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
  // an empty value does not count as set (compose often passes a key with no value)
  assert.equal(
    resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'uat', KAFKA_BROKERS: '' }).name,
    'uat',
  );
});

test('an entrypoint accepts a single profile: main.ts rejects uat and uat-main rejects default', () => {
  rejectsWith(
    () => assertEntrypointProfile('default', { DCONTACT_API_PROFILE: 'uat' }),
    'WRONG_ENTRYPOINT',
  );
  rejectsWith(() => assertEntrypointProfile('uat', {}), 'WRONG_ENTRYPOINT');
  assert.equal(
    assertEntrypointProfile('uat-e1', { DCONTACT_API_PROFILE: 'uat-e1' }).name,
    'uat-e1',
  );
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

test('the uat route guard blocks routes outside the allowlist with a counter and a log that has no id', () => {
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
  // a prefix that starts the same but is not the same segment must not slip through
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

test('the default route guard lets every route through', () => {
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

const UAT_LINE = {
  DCONTACT_API_PROFILE: 'uat-line',
  DATABASE_URL: 'postgresql://uat',
  LINE_WEBHOOK_SECRET_SOURCE: 'file',
  LINE_CREDENTIAL_DIR: '/run/secrets',
  LINE_WEBHOOK_TENANT_ID: 'tenant-ref',
  LINE_WEBHOOK_CHANNEL_ACCOUNT_ID: '2007056595',
  LINE_WEBHOOK_DESTINATION: 'destination-ref',
  LINE_WEBHOOK_PAYLOAD_KEY_REF: 'payload-key-ref',
};

test('#565/#566 uat-line opens only the webhook: no Kafka, no internet egress, and /api/ keeps only the runtime profile + the pilot read-only', () => {
  const profile = resolveApiRuntimeProfile(UAT_LINE);
  assert.equal(profile.name, 'uat-line');
  assert.equal(profile.kafka, 'DISABLED');
  assert.equal(profile.lineWebhook, 'ENABLED');
  assert.equal(profile.providerEgress, 'BLOCKED');
  assert.deepEqual(profile.allowedRoutePrefixes, ['/api/v1/runtime-profile', '/api/v1/line-pilot']);
});

test('#565 uat-line + env outside the allowlist or a secret that is not a file = fail closed without reporting values', () => {
  for (const [name, value] of [
    ['LINE_CHANNEL_ACCESS_TOKEN', 'token-value-must-not-leak'],
    ['LINE_CHANNEL_SECRET', 'secret-value-must-not-leak'],
    ['KAFKA_BROKERS', 'kafka:9092'],
    ['SIP_BROWSER_NODES_JSON', '[]'],
  ] as const) {
    assert.throws(
      () => resolveApiRuntimeProfile({ ...UAT_LINE, [name]: value }),
      (error: unknown) => {
        assert.ok(error instanceof ApiRuntimeProfileError);
        assert.equal(error.code, 'CONFLICTING_CONFIGURATION');
        assert.deepEqual(error.variables, [name]);
        assert.doesNotMatch(error.message, /must-not-leak/);
        return true;
      },
    );
  }
  for (const mode of ['keychain', 'disabled', undefined]) {
    rejectsWith(
      () => resolveApiRuntimeProfile({ ...UAT_LINE, LINE_WEBHOOK_SECRET_SOURCE: mode }),
      'CONFLICTING_CONFIGURATION',
    );
  }
});

test('#565 the uat profile still rejects every LINE_* including the set uat-line allows', () => {
  rejectsWith(
    () => resolveApiRuntimeProfile({ ...UAT_LINE, DCONTACT_API_PROFILE: 'uat' }),
    'CONFLICTING_CONFIGURATION',
  );
});

test('#565 the line-webhook entrypoint accepts only uat-line and uat-main does not accept uat-line', () => {
  assert.equal(assertEntrypointProfile('uat-line', UAT_LINE).name, 'uat-line');
  rejectsWith(
    () => assertEntrypointProfile('uat-line', { DCONTACT_API_PROFILE: 'uat' }),
    'WRONG_ENTRYPOINT',
  );
  rejectsWith(() => assertEntrypointProfile('uat', UAT_LINE), 'WRONG_ENTRYPOINT');
});

test('B4 eligibility/destinations opens only workspace and does not open lookalike/provider routes', () => {
  const paths = [
    '/api/v1/tenant-voice/eligibility',
    '/api/v1/tenant-voice/destinations',
    '/api/v1/tenant-voice/destinations/fixture/binding',
    '/api/v1/tenant-voice/queues/fixture/required-skills',
  ];
  for (const name of ['uat', 'uat-e1', 'uat-workspace']) {
    const guard = new RuntimeProfileRouteGuard(
      resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: name }),
      { write() {} },
    );
    for (const path of paths)
      assert.equal(guard.isAllowed(path), name === 'uat-workspace', `${name}: ${path}`);
  }
  const guard = new RuntimeProfileRouteGuard(
    resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'uat-workspace' }),
    { write() {} },
  );
  for (const path of [
    '/api/v1/tenant-voice/eligibility-evil',
    '/api/v1/tenant-voice/destinations-evil',
    '/api/v1/tenant-voice/provider',
    '/api/v1/tenant-voice/admin',
    '/api/v1/journey-authoring/journeys',
    '/api/v1/line/webhook',
  ])
    assert.equal(guard.isAllowed(path), false, path);
});

test('uat-workspace opens extra UI APIs opt-in and keeps the E1/provider boundary', () => {
  const profile = resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'uat-workspace' });
  assert.equal(profile.kafka, 'DISABLED');
  assert.equal(profile.lineWebhook, 'DISABLED');
  assert.equal(profile.providerEgress, 'BLOCKED');
  const guard = new RuntimeProfileRouteGuard(profile, { write() {} });
  for (const path of [
    '/api/v1/me/navigation',
    '/api/v1/me/navigation/pins',
    '/api/v1/tenant/navigation/default-pins',
    '/api/v1/tenant/locale-defaults',
    '/api/v1/tenant/core-settings/capabilities',
    '/api/v1/tenant/core-settings/organization',
    '/api/v1/tenant/core-settings/commands/command-id',
    '/api/v1/tenant/core-settings/commands/command-id/reconcile',
    '/api/v1/tenant/core-settings/teams',
    '/api/v1/tenant/core-settings/teams/team-id',
    '/api/v1/tenant/core-settings/teams/team-id/deactivate',
    '/api/v1/workspace/supervisor/snapshot',
    '/api/v1/workspace/agent/snapshot',
    '/api/v1/workspace/agent/history',
    '/api/v1/workspace/agent/interactions/fixture/wrapup-v1',
    '/api/v1/workspace/agent/interactions/fixture/wrapup-result',
    '/api/v1/workspace/agent/interactions/fixture/wrapup-commands/command',
  ]) {
    assert.equal(guard.isAllowed(path), true, path);
  }
  for (const path of [
    '/api/v1/line/webhook',
    '/api/v1/journey-authoring/journeys',
    '/api/v1/interactions',
    '/api/v1/me/navigation-evil',
    '/api/v1/queues',
    '/api/v1/people/users',
    '/api/v1/tenant/core-settings/_test/organization',
  ]) {
    assert.equal(guard.isAllowed(path), false, path);
  }
  for (const name of ['LINE_CHANNEL_ACCESS_TOKEN', 'KAFKA_BROKERS']) {
    rejectsWith(
      () => resolveApiRuntimeProfile({ DCONTACT_API_PROFILE: 'uat-workspace', [name]: 'conflict' }),
      'CONFLICTING_CONFIGURATION',
    );
  }
  rejectsWith(
    () => assertEntrypointProfile('uat-e1', { DCONTACT_API_PROFILE: 'uat-workspace' }),
    'WRONG_ENTRYPOINT',
  );
});
