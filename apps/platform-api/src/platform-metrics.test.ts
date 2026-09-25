import assert from 'node:assert/strict';
import test from 'node:test';
import { Registry } from 'prom-client';
import { carriesTenantContext, type PlatformAuthDiagnostic } from './platform-auth.js';
import { meteredDiagnostics } from './platform-metrics.js';
import { platformClaims, tenantClaims } from './test-tokens.js';

test('meteredDiagnostics นับตาม decision/reason/capability โดยไม่มี subject/correlation id', async () => {
  const registry = new Registry();
  const forwarded: PlatformAuthDiagnostic[] = [];
  const sink = meteredDiagnostics({ write: (event) => forwarded.push(event) }, registry);
  sink.write({
    event: 'platform.request.authorized',
    correlationId: 'corr-secret-1',
    capability: 'PROVISIONING_MUTATE',
    subject: 'sub-leak',
  });
  sink.write({
    event: 'platform.request.denied',
    correlationId: 'corr-secret-2',
    reason: 'TENANT_CONTEXT_PRESENT',
  });
  sink.write({
    event: 'platform.request.denied',
    correlationId: 'corr-secret-3',
    reason: 'MIXED_TOKEN_TRIPWIRE',
    capability: 'CONTROL_PLANE_READ',
  });
  assert.equal(forwarded.length, 3);
  const text = await registry.metrics();
  for (const series of [
    'dcontact_platform_api_auth_decisions_total{decision="authorized",reason="none",capability="PROVISIONING_MUTATE"} 1',
    'dcontact_platform_api_auth_decisions_total{decision="denied",reason="TENANT_CONTEXT_PRESENT",capability="none"} 1',
    'dcontact_platform_api_auth_decisions_total{decision="denied",reason="MIXED_TOKEN_TRIPWIRE",capability="CONTROL_PLANE_READ"} 1',
  ]) {
    assert.ok(text.includes(series), `ขาด ${series}\n${text}`);
  }
  assert.equal(/corr-secret|sub-leak/.test(text), false);
});

test('tripwire ตรวจ tenant context ด้วยรายการของตัวเอง', () => {
  assert.equal(carriesTenantContext(platformClaims('platform_operator')), false);
  assert.equal(carriesTenantContext(tenantClaims()), true);
  for (const extra of [
    { tenant_id: 't-1' },
    { organization: { demo: {} } },
    { dc_user_id: 'u-1' },
    { realm_access: { roles: ['admin'] } },
    { aud: ['dcontact-platform-api', 'dcontact-api'] },
  ]) {
    assert.equal(carriesTenantContext(platformClaims('platform_operator', extra)), true);
  }
});
