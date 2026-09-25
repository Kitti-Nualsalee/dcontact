import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PINS,
  NAVIGATION_APPS,
  NAVIGATION_GROUPS,
  effectivePins,
  pinValidationError,
  tenantAvailableApps,
  visibleApps,
} from './navigation-registry.js';

const ids = (apps: { id: string }[]) => apps.map((app) => app.id);
const FULL = { module_journey: true, module_contact_governance: true };

test('registry: id ไม่ซ้ำ, กลุ่มอยู่ในชุดที่ตกลง, path ไม่มี PII placeholder และเป็น path ภายใน', () => {
  assert.equal(new Set(ids([...NAVIGATION_APPS])).size, NAVIGATION_APPS.length);
  for (const app of NAVIGATION_APPS) {
    assert.ok(NAVIGATION_GROUPS.includes(app.group), app.id);
    assert.match(app.id, /^[a-z][a-z0-9-]{1,47}$/);
    assert.match(app.path, /^\/(?!\/)/);
    assert.ok(app.roles.length > 0, app.id);
  }
});

test('role ต่างกันเห็นรายการต่างกัน', () => {
  assert.deepEqual(ids(visibleApps({ roles: ['agent'], entitlements: FULL })), ['agent-workspace']);
  assert.deepEqual(ids(visibleApps({ roles: ['supervisor', 'agent'], entitlements: FULL })), [
    'agent-workspace',
    'supervisor-workspace',
    'journeys',
    'contact-governance',
  ]);
  assert.deepEqual(ids(visibleApps({ roles: ['compliance'], entitlements: FULL })), [
    'contact-governance',
  ]);
  assert.deepEqual(ids(visibleApps({ roles: ['journey-ingress'], entitlements: FULL })), []);
});

test('plan ต่างกันเห็นรายการต่างกัน — key ต้องเป็น true เท่านั้น (fail-closed)', () => {
  const admin = ['admin'];
  assert.deepEqual(ids(visibleApps({ roles: admin, entitlements: { module_journey: true } })), [
    'agent-workspace',
    'supervisor-workspace',
    'journeys',
  ]);
  assert.deepEqual(ids(visibleApps({ roles: admin, entitlements: {} })), [
    'agent-workspace',
    'supervisor-workspace',
  ]);
  assert.deepEqual(
    ids(
      visibleApps({
        roles: admin,
        entitlements: { module_journey: 1, module_contact_governance: 'yes' },
      }),
    ),
    ['agent-workspace', 'supervisor-workspace'],
  );
});

test('tenant ที่ไม่มี plan binding (null) ใช้ role อย่างเดียว', () => {
  assert.deepEqual(ids(visibleApps({ roles: ['admin'], entitlements: null })), [
    'agent-workspace',
    'supervisor-workspace',
    'journeys',
    'contact-governance',
  ]);
});

test('ชุดเริ่มต้นของ tenant ขึ้นกับ entitlement ไม่ขึ้นกับ role ของ admin', () => {
  assert.deepEqual(ids(tenantAvailableApps({ module_contact_governance: true })), [
    'agent-workspace',
    'supervisor-workspace',
    'contact-governance',
  ]);
});

test('หมุดที่มีผล: ผู้ใช้ทับ tenant ทับ system และกรองแอปที่มองไม่เห็นออก', () => {
  const visible = visibleApps({ roles: ['agent'], entitlements: FULL });
  assert.deepEqual(
    effectivePins({
      visible,
      userPins: ['journeys', 'agent-workspace'],
      tenantPins: ['agent-workspace'],
    }),
    { appIds: ['agent-workspace'], source: 'USER' },
  );
  assert.deepEqual(effectivePins({ visible, userPins: [], tenantPins: ['agent-workspace'] }), {
    appIds: [],
    source: 'USER',
  });
  assert.deepEqual(
    effectivePins({
      visible,
      userPins: null,
      tenantPins: ['contact-governance', 'agent-workspace'],
    }),
    { appIds: ['agent-workspace'], source: 'TENANT' },
  );
  assert.deepEqual(effectivePins({ visible, userPins: null, tenantPins: null }), {
    appIds: ['agent-workspace'],
    source: 'SYSTEM',
  });
});

test('ตรวจหมุด: เกิน 15 ก่อน แล้วแอปที่ไม่มีอยู่กับไม่มีสิทธิ์ได้ error เดียวกัน', () => {
  const allowed = visibleApps({ roles: ['agent'], entitlements: FULL });
  const tooMany = Array.from({ length: MAX_PINS + 1 }, (_, i) => `app-${i}`);
  assert.equal(pinValidationError(tooMany, allowed), 'PIN_LIMIT_EXCEEDED');
  assert.equal(pinValidationError(['journeys'], allowed), 'APP_NOT_AVAILABLE');
  assert.equal(pinValidationError(['no-such-app'], allowed), 'APP_NOT_AVAILABLE');
  assert.equal(pinValidationError(['agent-workspace'], allowed), null);
  assert.equal(pinValidationError([], allowed), null);
});
