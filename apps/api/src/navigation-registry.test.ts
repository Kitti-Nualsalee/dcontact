import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PINS,
  NAVIGATION_APPS,
  NAVIGATION_AREAS,
  NAVIGATION_GROUPS,
  effectivePins,
  navigationApps,
  pinValidationError,
  tenantAvailableApps,
  visibleApps,
  visibleAreas,
} from './navigation-registry.js';

const ids = (apps: { id: string }[]) => apps.map((app) => app.id);
const FULL = { module_journey: true, module_contact_governance: true };

test('registry: ids are unique, groups are in the agreed set, paths have no PII placeholder and are internal paths', () => {
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

test('different roles see different items', () => {
  assert.deepEqual(ids(visibleApps({ roles: ['agent'], entitlements: FULL })), [
    'home',
    'agent-workspace',
    'agent-history',
    'team-cases',
  ]);
  assert.deepEqual(ids(visibleApps({ roles: ['supervisor', 'agent'], entitlements: FULL })), [
    'home',
    'agent-workspace',
    'supervisor-workspace',
    'journeys',
    'contact-governance',
    'agent-history',
    'team-history',
    'team-cases',
    'voice-routing',
    'customers',
    'core-settings',
  ]);
  assert.deepEqual(ids(visibleApps({ roles: ['compliance'], entitlements: FULL })), [
    'home',
    'contact-governance',
  ]);
  assert.deepEqual(ids(visibleApps({ roles: ['journey-ingress'], entitlements: FULL })), []);
});

test('different plans see different items — the key must be exactly true (fail-closed)', () => {
  const admin = ['admin'];
  assert.deepEqual(ids(visibleApps({ roles: admin, entitlements: { module_journey: true } })), [
    'home',
    'agent-workspace',
    'supervisor-workspace',
    'journeys',
    'team-history',
    'voice-routing',
    'tenant-people',
    'customers',
    'customer-overview',
    'customer-rules',
    'customer-activity',
    'customer-tags',
    'customer-import',
    'customer-access',
    'core-settings',
  ]);
  assert.deepEqual(ids(visibleApps({ roles: admin, entitlements: {} })), [
    'home',
    'agent-workspace',
    'supervisor-workspace',
    'team-history',
    'voice-routing',
    'tenant-people',
    'customers',
    'customer-overview',
    'customer-rules',
    'customer-activity',
    'customer-tags',
    'customer-import',
    'customer-access',
    'core-settings',
  ]);
  assert.deepEqual(
    ids(
      visibleApps({
        roles: admin,
        entitlements: { module_journey: 1, module_contact_governance: 'yes' },
      }),
    ),
    [
      'home',
      'agent-workspace',
      'supervisor-workspace',
      'team-history',
      'voice-routing',
      'tenant-people',
      'customers',
      'customer-overview',
      'customer-rules',
      'customer-activity',
      'customer-tags',
      'customer-import',
      'customer-access',
      'core-settings',
    ],
  );
});

test('a tenant with no plan binding (null) uses the role alone', () => {
  assert.deepEqual(ids(visibleApps({ roles: ['admin'], entitlements: null })), [
    'home',
    'agent-workspace',
    'supervisor-workspace',
    'journeys',
    'contact-governance',
    'dphone-embedding',
    'team-history',
    'voice-routing',
    'tenant-people',
    'customers',
    'customer-overview',
    'customer-rules',
    'customer-activity',
    'customer-tags',
    'customer-import',
    'customer-access',
    'core-settings',
  ]);
});

test('E1.11: dphone embedding is visible only to ADMIN/SUPERVISOR of a plan that has module_api_cti', () => {
  const cti = { module_api_cti: true };
  assert.deepEqual(ids(visibleApps({ roles: ['admin'], entitlements: cti })), [
    'home',
    'agent-workspace',
    'supervisor-workspace',
    'dphone-embedding',
    'team-history',
    'voice-routing',
    'tenant-people',
    'customers',
    'customer-overview',
    'customer-rules',
    'customer-activity',
    'customer-tags',
    'customer-import',
    'customer-access',
    'core-settings',
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

test("the tenant's starter set depends on the entitlement, not the admin's role", () => {
  assert.deepEqual(ids(tenantAvailableApps({ module_contact_governance: true })), [
    'home',
    'agent-workspace',
    'supervisor-workspace',
    'contact-governance',
    'agent-history',
    'team-history',
    'team-cases',
    'voice-routing',
    'tenant-people',
    'customers',
    'customer-overview',
    'customer-rules',
    'customer-activity',
    'customer-tags',
    'customer-import',
    'customer-access',
    'core-settings',
  ]);
});

test('effective pins: a user overrides the tenant over the system and invisible apps are filtered out', () => {
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
    appIds: ['home', 'agent-workspace', 'agent-history', 'team-cases'],
    source: 'SYSTEM',
  });
});

test('pin validation: over 15 first, then an app that does not exist and one without permission get the same error', () => {
  const allowed = visibleApps({ roles: ['agent'], entitlements: FULL });
  const tooMany = Array.from({ length: MAX_PINS + 1 }, (_, i) => `app-${i}`);
  assert.equal(pinValidationError(tooMany, allowed), 'PIN_LIMIT_EXCEEDED');
  assert.equal(pinValidationError(['journeys'], allowed), 'APP_NOT_AVAILABLE');
  assert.equal(pinValidationError(['no-such-app'], allowed), 'APP_NOT_AVAILABLE');
  assert.equal(pinValidationError(['home', 'agent-workspace'], allowed), null);
  assert.equal(pinValidationError([], allowed), null);
});

test('#651: menu areas are filtered by role/plan; order follows the rail; empty areas are not sent', () => {
  const areaIds = (input: Parameters<typeof visibleApps>[0]) =>
    visibleAreas(visibleApps(input)).map((area) => area.id);
  assert.deepEqual(areaIds({ roles: ['agent'], entitlements: FULL }), [
    'home',
    'workspace',
    'cases',
    'history',
  ]);
  assert.deepEqual(areaIds({ roles: ['admin'], entitlements: null }), [
    'home',
    'workspace',
    'supervisor',
    'journeys',
    'governance',
    'routing',
    'customers',
    'people',
    'integrations',
    'history',
    'settings',
  ]);
  assert.deepEqual(areaIds({ roles: ['compliance'], entitlements: FULL }), ['home', 'governance']);
  assert.deepEqual(areaIds({ roles: ['journey-ingress'], entitlements: FULL }), []);
  // the area order follows NAVIGATION_AREAS, not the row order in the registry
  const reversed = [...NAVIGATION_APPS].reverse();
  assert.deepEqual(
    visibleAreas(reversed).map((area) => area.id),
    NAVIGATION_AREAS.filter((id) => NAVIGATION_APPS.some((app) => app.area === id)),
  );
});

test('#860: the customer menu is in a single area per permission (the CSV import page #909 and the team permission #915 are admin only)', () => {
  const customerArea = (roles: string[]) =>
    visibleAreas(visibleApps({ roles, entitlements: null })).find(
      (area) => area.id === 'customers',
    );
  assert.deepEqual(
    customerArea(['admin'])?.sections.flatMap((section) => section.items.map((item) => item.appId)),
    [
      'customers',
      'customer-overview',
      'customer-rules',
      'customer-activity',
      'customer-tags',
      'customer-import',
      'customer-access',
    ],
  );
  assert.deepEqual(
    customerArea(['supervisor'])?.sections.flatMap((section) =>
      section.items.map((item) => item.appId),
    ),
    ['customers'],
  );
  assert.equal(customerArea(['agent']), undefined);
  assert.equal(customerArea(['compliance']), undefined);
  const people = visibleAreas(visibleApps({ roles: ['admin'], entitlements: null })).find(
    (area) => area.id === 'people',
  );
  assert.deepEqual(
    people?.sections.map((section) => section.id),
    ['accounts'],
  );
});

test('#651: every visible app is in exactly one area and an item references a real appId', () => {
  const visible = visibleApps({ roles: ['admin'], entitlements: null });
  const items = visibleAreas(visible).flatMap((area) =>
    area.sections.flatMap((section) => section.items.map((item) => item.appId)),
  );
  assert.deepEqual([...items].sort(), ids(visible).sort());
  assert.equal(new Set(items).size, items.length);
});

test('#651: several apps in the same area/sub-group follow the registry order and sub-groups split by section', () => {
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

test('#658: Governance and Voice send sub-pages from the registry while other apps have no pages', () => {
  const visible = visibleApps({ roles: ['compliance'], entitlements: FULL });
  const area = visibleAreas(visible).find((a) => a.id === 'governance');
  assert.equal(area!.id, 'governance');
  const [item] = area!.sections[0]!.items;
  assert.equal(item!.appId, 'contact-governance');
  assert.deepEqual(
    item!.pages!.map((page) => page.id),
    ['overview', 'exceptions', 'policies', 'audit'],
  );
  for (const page of item!.pages!) {
    assert.match(page.id, /^[a-z][a-z-]*$/);
    assert.ok(page.path.startsWith('/?view=governance&section='), page.path);
    assert.ok(
      !/(contact|series|policy|version)Id/i.test(page.path),
      'there must be no id in the path',
    );
  }
  // a sub-page is not an app: not in the launcher/pins
  assert.ok(!visible.some((app) => app.id === 'overview' || app.id === 'audit'));
  const everyone = visibleAreas(visibleApps({ roles: ['admin'], entitlements: null }));
  const withoutPages = everyone
    .flatMap((a) => a.sections.flatMap((s) => s.items))
    .filter(
      (i) =>
        !['contact-governance', 'voice-routing', 'tenant-people', 'core-settings'].includes(
          i.appId,
        ),
    );
  assert.ok(withoutPages.every((i) => i.pages === undefined));
  const voice = everyone
    .find((a) => a.id === 'routing')!
    .sections.flatMap((s) => s.items)
    .find((i) => i.appId === 'voice-routing')!;
  assert.deepEqual(
    voice.pages!.map((p) => p.id),
    ['queues', 'skills', 'destinations', 'agent-skills'],
  );
});

test('#967 team recordings are in the Supervisor menu only for deployments that enable it', () => {
  assert.equal(
    navigationApps(false).some((app) => app.id === 'team-recordings'),
    false,
  );
  const enabled = navigationApps(true);
  const enabledIds = enabled.map((app) => app.id);
  const visibleTo = (roles: string[]) =>
    ids(visibleApps({ roles, entitlements: FULL }, enabled)).includes('team-recordings');
  assert.equal(visibleTo(['supervisor']), true);
  assert.equal(visibleTo(['agent']), false);
  assert.equal(visibleTo(['admin']), false);
  assert.deepEqual(
    enabledIds.slice(enabledIds.indexOf('supervisor-workspace'), enabledIds.indexOf('journeys')),
    ['supervisor-workspace', 'team-recordings'],
  );
});

test('#971 the quality evaluation app is in the menu by role only for deployments that enable it', () => {
  const qmIds = ['team-evaluations', 'my-quality', 'qm-forms'];
  assert.equal(
    navigationApps(true, false).some((app) => qmIds.includes(app.id)),
    false,
  );
  const enabled = navigationApps(false, true);
  const visibleTo = (roles: string[]) =>
    ids(visibleApps({ roles, entitlements: FULL }, enabled)).filter((id) => qmIds.includes(id));
  assert.deepEqual(visibleTo(['supervisor']), ['team-evaluations']);
  assert.deepEqual(visibleTo(['agent']), ['my-quality']);
  assert.deepEqual(visibleTo(['admin']), ['qm-forms']);
  assert.ok(enabled.filter((app) => qmIds.includes(app.id)).every((app) => app.area === 'qm'));
  // both switches on: the original order of team recordings does not change
  const both = navigationApps(true, true).map((app) => app.id);
  assert.equal(both.indexOf('team-recordings'), both.indexOf('supervisor-workspace') + 1);
});
