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
  ['home', 'agent-workspace', 'supervisor-workspace', 'dphone-embedding'].includes(app.id),
);

export function createWorkspaceUatApiModule(dependencies: E1UatApiDependencies) {
  const base = createE1UatApiModule(dependencies);
  const events = new SupervisorLiveEventStream();
  return {
    events,
    module: {
      ...base,
      controllers: [
        ...(base.controllers ?? []),
        NavigationController,
        TenantLocaleDefaultsController,
        SupervisorLiveController,
      ],
      providers: [
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
