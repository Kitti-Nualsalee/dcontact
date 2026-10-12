import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PINS,
  NAVIGATION_APPS,
  NAVIGATION_AREAS,
  NAVIGATION_GROUPS,
  effectivePins,
  pinValidationError,
  tenantAvailableApps,
  visibleApps,
  visibleAreas,
} from './navigation-registry.js';

const ids = (apps: { id: string }[]) => apps.map((app) => app.id);
const FULL = { module_journey: true, module_contact_governance: true };

test('registry: id ไม่ซ้ำ, กลุ่มอยู่ในชุดที่ตกลง, path ไม่มี PII placeholder และเป็น path ภายใน', () => {
  assert.equal(new Set(ids([...NAVIGATION_APPS])).size, NAVIGATION_APPS.length);
  for (const app of NAVIGATION_APPS) {
    assert.ok(NAVIGATION_GROUPS.includes(app.group), app.id);
    assert.ok(NAVIGATION_AREAS.includes(app.area), app.id);
    assert.match(app.section, /^[a-z][a-z0-9-]{1,31}$/, app.id);
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
    'dphone-embedding',
  ]);
});

test('E1.11: dphone embedding เห็นเฉพาะ ADMIN/SUPERVISOR ของ plan ที่มี module_api_cti', () => {
  const cti = { module_api_cti: true };
  assert.deepEqual(ids(visibleApps({ roles: ['admin'], entitlements: cti })), [
    'agent-workspace',
    'supervisor-workspace',
    'dphone-embedding',
  ]);
  assert.equal(
    ids(visibleApps({ roles: ['agent'], entitlements: cti })).includes('dphone-embedding'),
    false,
  );
  assert.equal(
    ids(visibleApps({ roles: ['admin'], entitlements: FULL })).includes('dphone-embedding'),
    false,
  );
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

test('#651: พื้นที่เมนูคัดตาม role/plan; ลำดับตาม rail; พื้นที่ว่างไม่ถูกส่ง', () => {
  const areaIds = (input: Parameters<typeof visibleApps>[0]) =>
    visibleAreas(visibleApps(input)).map((area) => area.id);
  assert.deepEqual(areaIds({ roles: ['agent'], entitlements: FULL }), ['workspace']);
  assert.deepEqual(areaIds({ roles: ['admin'], entitlements: null }), [
    'workspace',
    'supervisor',
    'journeys',
    'governance',
    'integrations',
  ]);
  assert.deepEqual(areaIds({ roles: ['compliance'], entitlements: FULL }), ['governance']);
  assert.deepEqual(areaIds({ roles: ['journey-ingress'], entitlements: FULL }), []);
  // ลำดับพื้นที่ตาม NAVIGATION_AREAS ไม่ใช่ตามลำดับแถวใน registry
  const reversed = [...NAVIGATION_APPS].reverse();
  assert.deepEqual(
    visibleAreas(reversed).map((area) => area.id),
    NAVIGATION_AREAS.filter((id) => NAVIGATION_APPS.some((app) => app.area === id)),
  );
});

test('#651: ทุกแอปที่มองเห็นอยู่ในพื้นที่หนึ่งเดียว และ item อ้าง appId จริง', () => {
  const visible = visibleApps({ roles: ['admin'], entitlements: null });
  const items = visibleAreas(visible).flatMap((area) =>
    area.sections.flatMap((section) => section.items.map((item) => item.appId)),
  );
  assert.deepEqual([...items].sort(), ids(visible).sort());
  assert.equal(new Set(items).size, items.length);
});

test('#651: แอปหลายตัวในพื้นที่/กลุ่มย่อยเดียวกันเรียงตาม registry และแยกกลุ่มย่อยตาม section', () => {
  const base = NAVIGATION_APPS[0]!;
  const fake = [
    { ...base, id: 'a-one', area: 'routing', section: 'setup' },
    { ...base, id: 'a-two', area: 'routing', section: 'rules' },
    { ...base, id: 'a-three', area: 'routing', section: 'setup' },
  ] as const;
  assert.deepEqual(visibleAreas(fake), [
    {
      id: 'routing',
      sections: [
        { id: 'setup', items: [{ appId: 'a-one' }, { appId: 'a-three' }] },
        { id: 'rules', items: [{ appId: 'a-two' }] },
      ],
    },
  ]);
});
