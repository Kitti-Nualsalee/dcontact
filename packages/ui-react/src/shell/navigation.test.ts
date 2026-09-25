import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAppHref, toShellModel, type NavigationResponseV1 } from './navigation.js';

const hostOrigins = {
  console: 'https://console.demo.example',
  workspace: 'https://workspace.demo.example',
} as const;

test('ลิงก์ในแอปเดียวกันเป็น relative ส่วนอีกแอปเป็น absolute และส่งต่อ tenant alias เท่านั้น', () => {
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

test('toShellModel แปล label ด้วย i18n ของแอป และทำเครื่องหมายแอปอีกฝั่งเป็น external', () => {
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
