/** ข้อมูลจำลองจาก registry จริง — server คัด role/plan ก่อนส่งให้ browser */
import { createRequire } from 'node:module';
import type { EffectiveEntitlements } from '../../../api/src/navigation-registry.js';
const { NAVIGATION_GROUPS, visibleApps, visibleAreas } = createRequire(import.meta.url)(
  '../../../api/src/navigation-registry.ts',
) as typeof import('../../../api/src/navigation-registry.js');

export function homeNavigation(
  roles = ['admin'],
  shellV2 = true,
  entitlements: EffectiveEntitlements = null,
) {
  const apps = visibleApps({ roles, entitlements });
  return {
    groups: NAVIGATION_GROUPS.filter((id) => apps.some((app) => app.group === id)).map((id) => ({
      id,
      labelKey: `navigation.groups.${id}`,
    })),
    apps: apps.map(({ id, group, labelKey, hostApp, path }) => ({
      id,
      groupId: group,
      labelKey,
      hostApp,
      path,
    })),
    areas: visibleAreas(apps).map((area) => ({
      ...area,
      labelKey: `navigation.areas.${area.id}`,
      sections: area.sections.map((section) => ({
        ...section,
        labelKey: `navigation.sections.${section.id}`,
      })),
    })),
    pins: { appIds: apps.map((app) => app.id), source: 'SYSTEM', revision: 0 },
    limits: { maxPins: 15 },
    features: { shellV2 },
  };
}
