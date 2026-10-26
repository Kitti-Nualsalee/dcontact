import { TenantCoreSettingsController, TENANT_CORE_DATABASE } from './tenant-core-api.js';
import { TenantVoiceCatalogController, TENANT_VOICE_DATABASE } from './tenant-voice-catalog-api.js';
import { TenantPeopleController } from './tenant-people-api.js';
import { TENANT_PEOPLE_READINESS } from './tenant-people-readiness.js';
import { configuredPeopleRuntime } from './tenant-people-composition.js';
/** #684: เพิ่ม UI APIs บน E1 sandbox โดยไม่ import default composition root */
import { createE1UatApiModule, type E1UatApiDependencies } from './e1-uat-api.js';
import {
  NavigationController,
  NAVIGATION_DATABASE,
  NAVIGATION_REGISTRY,
} from './navigation-api.js';
import { NAVIGATION_APPS } from './navigation-registry.js';
import { TenantLocaleDefaultsController, TENANT_LOCALE_DATABASE } from './tenant-locale-api.js';
import {
  SupervisorLiveController,
  SupervisorLiveEventStream,
  SUPERVISOR_LIVE_DATABASE,
} from './supervisor-live-api.js';

/** ส่งเฉพาะแอปที่ profile นี้ mount backend จริง; role/entitlement ยังตรวจใน controller */
export const WORKSPACE_UAT_APPS = NAVIGATION_APPS.filter((app) =>
  [
    'home',
    'agent-workspace',
    'supervisor-workspace',
    'dphone-embedding',
    'agent-history',
    'voice-routing',
    'tenant-people',
    'core-settings',
  ].includes(app.id),
);

export function createWorkspacePeopleRuntime(
  dependencies: Pick<E1UatApiDependencies, 'environment' | 'peopleDisableFlush'>,
) {
  return configuredPeopleRuntime(
    dependencies.environment ?? process.env,
    dependencies.peopleDisableFlush,
  );
}

export function createWorkspaceUatApiModule(dependencies: E1UatApiDependencies) {
  const base = createE1UatApiModule(dependencies);
  const events = new SupervisorLiveEventStream();
  return {
    events,
    module: {
      ...base,
      controllers: [
        TenantCoreSettingsController,
        TenantVoiceCatalogController,
        TenantPeopleController,
        ...(base.controllers ?? []),
        NavigationController,
        TenantLocaleDefaultsController,
        SupervisorLiveController,
      ],
      providers: [
        { provide: TENANT_CORE_DATABASE, useValue: dependencies.database },
        { provide: TENANT_VOICE_DATABASE, useValue: dependencies.database },
        {
          provide: TENANT_PEOPLE_READINESS,
          useFactory: () => createWorkspacePeopleRuntime(dependencies),
        },
        ...(base.providers ?? []),
        { provide: NAVIGATION_DATABASE, useValue: dependencies.database },
        { provide: NAVIGATION_REGISTRY, useValue: WORKSPACE_UAT_APPS },
        { provide: TENANT_LOCALE_DATABASE, useValue: dependencies.database },
        { provide: SUPERVISOR_LIVE_DATABASE, useValue: dependencies.database },
        { provide: SupervisorLiveEventStream, useValue: events },
      ],
    },
  };
}
