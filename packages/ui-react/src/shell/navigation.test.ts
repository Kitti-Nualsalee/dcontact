import assert from 'node:assert/strict';
import test from 'node:test';
import { areaOf } from './areas.js';
import { buildAppHref, toShellModel, type NavigationResponseV1 } from './navigation.js';

const hostOrigins = {
  console: 'https://console.demo.example',
  workspace: 'https://workspace.demo.example',
} as const;

test('same-app links are relative, the other app is absolute, and only the tenant alias is forwarded', () => {
  assert.equal(
    buildAppHref({
      hostApp: 'console',
      path: '/?view=journeys',
      currentHost: 'console',
      hostOrigins,
      tenantAlias: 'demo',
    }),
    '/?view=journeys&tenant=demo',
  );
  assert.equal(
    buildAppHref({
      hostApp: 'workspace',
      path: '/?view=supervisor',
      currentHost: 'console',
      hostOrigins,
    }),
    'https://workspace.demo.example/?view=supervisor',
  );
});

test('toShellModel translates labels with the app i18n and marks apps of the other host as external', () => {
  const response: NavigationResponseV1 = {
    groups: [{ id: 'live', labelKey: 'navigation.groups.live' }],
    apps: [
      {
        id: 'agent-workspace',
        groupId: 'live',
        labelKey: 'navigation.apps.agentWorkspace',
        hostApp: 'workspace',
        path: '/',
      },
      {
        id: 'journeys',
        groupId: 'automation',
        labelKey: 'navigation.apps.journeys',
        hostApp: 'console',
        path: '/?view=journeys',
      },
    ],
    pins: { appIds: ['journeys'], source: 'SYSTEM', revision: 0 },
    limits: { maxPins: 15 },
    features: { shellV2: true },
  };
  const model = toShellModel(response, {
    currentHost: 'console',
    hostOrigins,
    tenantAlias: 'demo',
    translate: (key) => `t(${key})`,
  });
  assert.deepEqual(model.groups, [{ id: 'live', label: 't(navigation.groups.live)' }]);
  assert.deepEqual(model.apps[0], {
    id: 'agent-workspace',
    groupId: 'live',
    label: 't(navigation.apps.agentWorkspace)',
    external: true,
    href: 'https://workspace.demo.example/?tenant=demo',
  });
  assert.equal(model.apps[1]!.external, false);
  assert.equal(model.apps[1]!.href, '/?view=journeys&tenant=demo');
});

test('unknown origin of the other app → no link, and that app is dropped from the shell (never guessed as localhost)', () => {
  assert.equal(
    buildAppHref({ hostApp: 'workspace', path: '/', currentHost: 'console', hostOrigins: {} }),
    null,
  );
  assert.equal(
    buildAppHref({
      hostApp: 'console',
      path: '/?view=journeys',
      currentHost: 'console',
      hostOrigins: {},
    }),
    '/?view=journeys',
  );
  const model = toShellModel(
    {
      groups: [],
      apps: [
        { id: 'agent-workspace', groupId: 'live', labelKey: 'a', hostApp: 'workspace', path: '/' },
        {
          id: 'journeys',
          groupId: 'automation',
          labelKey: 'j',
          hostApp: 'console',
          path: '/?view=journeys',
        },
      ],
      pins: { appIds: [], source: 'SYSTEM', revision: 0 },
      limits: { maxPins: 15 },
      features: { shellV2: true },
    },
    { currentHost: 'console', hostOrigins: {}, translate: (key) => key },
  );
  assert.deepEqual(
    model.apps.map((app) => app.id),
    ['journeys'],
  );
});

const areaResponse: NavigationResponseV1 = {
  groups: [],
  apps: [
    {
      id: 'agent-workspace',
      groupId: 'live',
      labelKey: 'a.agent',
      hostApp: 'workspace',
      path: '/',
    },
    {
      id: 'journeys',
      groupId: 'automation',
      labelKey: 'a.journeys',
      hostApp: 'console',
      path: '/?view=journeys',
    },
    {
      id: 'dphone-embedding',
      groupId: 'settings',
      labelKey: 'a.dphone',
      hostApp: 'console',
      path: '/?view=dphone-embedding',
    },
  ],
  areas: [
    {
      id: 'workspace',
      labelKey: 'area.workspace',
      sections: [{ id: 'work', labelKey: 'section.work', items: [{ appId: 'agent-workspace' }] }],
    },
    {
      id: 'integrations',
      labelKey: 'area.integrations',
      sections: [
        { id: 'embedding', labelKey: 'section.embedding', items: [{ appId: 'dphone-embedding' }] },
      ],
    },
    {
      id: 'journeys',
      labelKey: 'area.journeys',
      sections: [{ id: 'work', labelKey: 'section.work', items: [{ appId: 'journeys' }] }],
    },
  ],
  pins: { appIds: [], source: 'SYSTEM', revision: 0 },
  limits: { maxPins: 15 },
  features: { shellV2: true },
};

test('#651: toShellModel builds areas in the order the server sends; the area href is the first item; the other app = new tab', () => {
  const model = toShellModel(areaResponse, {
    currentHost: 'console',
    hostOrigins,
    tenantAlias: 'demo',
    translate: (key) => `t:${key}`,
  });
  assert.deepEqual(
    model.areas.map((area) => [area.id, area.label, area.href, area.external]),
    [
      ['workspace', 't:area.workspace', 'https://workspace.demo.example/?tenant=demo', true],
      ['integrations', 't:area.integrations', '/?view=dphone-embedding&tenant=demo', false],
      ['journeys', 't:area.journeys', '/?view=journeys&tenant=demo', false],
    ],
  );
  assert.deepEqual(model.areas[1]!.sections, [
    {
      id: 'embedding',
      label: 't:section.embedding',
      items: [
        {
          id: 'dphone-embedding',
          label: 't:a.dphone',
          href: '/?view=dphone-embedding&tenant=demo',
          external: false,
        },
      ],
    },
  ]);
});

test('#651: items with an unknown origin are dropped, and areas left empty go with them (no rail button that leads nowhere)', () => {
  const model = toShellModel(areaResponse, {
    currentHost: 'console',
    hostOrigins: { console: hostOrigins.console },
    translate: (key) => key,
  });
  assert.deepEqual(
    model.areas.map((area) => area.id),
    ['integrations', 'journeys'],
  );
});

test('#651: an older API that sends no areas gets empty areas (the rail goes back to showing app pins)', () => {
  const { areas: _omitted, ...legacy } = areaResponse;
  void _omitted;
  const model = toShellModel(legacy, { currentHost: 'console', hostOrigins, translate: (k) => k });
  assert.deepEqual(model.areas, []);
});

test('#651: areaOf finds the area from the app in use — an app outside the registry (e.g. the account page) belongs to no area', () => {
  const { areas } = toShellModel(areaResponse, {
    currentHost: 'console',
    hostOrigins,
    translate: (k) => k,
  });
  assert.equal(areaOf(areas, 'journeys'), 'journeys');
  assert.equal(areaOf(areas, 'dphone-embedding'), 'integrations');
  assert.equal(areaOf(areas, 'account'), undefined);
  assert.equal(areaOf(undefined, 'journeys'), undefined);
});

test('#658: an app whose pages are spread into several items with the same id, separated by pageId; href uses the page path + tenant', () => {
  const response: NavigationResponseV1 = {
    ...areaResponse,
    apps: [
      ...areaResponse.apps,
      {
        id: 'contact-governance',
        groupId: 'quality',
        labelKey: 'a.governance',
        hostApp: 'console',
        path: '/?view=governance',
      },
    ],
    areas: [
      {
        id: 'governance',
        labelKey: 'area.governance',
        sections: [
          {
            id: 'work',
            labelKey: 'section.work',
            items: [
              {
                appId: 'contact-governance',
                pages: [
                  {
                    id: 'overview',
                    labelKey: 'p.overview',
                    path: '/?view=governance&section=overview',
                  },
                  { id: 'audit', labelKey: 'p.audit', path: '/?view=governance&section=audit' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const model = toShellModel(response, {
    currentHost: 'console',
    hostOrigins,
    tenantAlias: 'demo',
    translate: (key) => `t:${key}`,
  });
  assert.deepEqual(model.areas[0]!.sections[0]!.items, [
    {
      id: 'contact-governance',
      pageId: 'overview',
      label: 't:p.overview',
      href: '/?view=governance&section=overview&tenant=demo',
      external: false,
    },
    {
      id: 'contact-governance',
      pageId: 'audit',
      label: 't:p.audit',
      href: '/?view=governance&section=audit&tenant=demo',
      external: false,
    },
  ]);
  // the area href = the first page, and areaOf still finds the area from the app id
  assert.equal(model.areas[0]!.href, '/?view=governance&section=overview&tenant=demo');
  assert.equal(areaOf(model.areas, 'contact-governance'), 'governance');
});
