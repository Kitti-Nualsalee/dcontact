/**
 * D1.12 (#451): the app registry of Console/Workspace and the visibility/pin rules (D1.2 #422)
 *
 * - the visible app list is computed on the server only: role (from the token) + effective entitlement (ADR-009)
 *   apps that fail are removed before reaching the browser — there is no "locked" state in the launcher/rail
 * - entitlement: an app that names a key needs `entitlements[key] === true` from the plan binding (fail-closed)
 *   except a tenant with **no plan binding at all** (a pre-A1 tenant such as demo), which uses the role alone because
 *   such tenants have no concept of a plan yet — a tenant from provisioning always has a binding so it stays fail-closed
 *   (decided by the user 2026-09-25 in #451)
 * - module keys are snake_case following the plan checker (`planEntitlementErrors`) — ADR-025 calls
 *   `modules.journey.*` and ADR-027 calls `modules.contactGovernance.*`
 * - the registry has only screens that really exist — a new app adds a row here together with the launcher i18n key
 */

import { resolveQmHumanEvaluation } from './qm-evaluation-config.js';
import { resolveRecordingSupervisorPlayback } from './recording-playback-config.js';
import { resolveLineChat } from './line-chat-config.js';
import { resolveWebchat } from './webchat-config.js';

export const MAX_PINS = 15;

export const NAVIGATION_GROUPS = [
  'live',
  'automation',
  'operations',
  'quality',
  'data',
  'settings',
] as const;
export type NavigationGroupId = (typeof NAVIGATION_GROUPS)[number];

/**
 * #651: work areas on the rail (order = order on the rail, per `mockups/assets/app.js` RAIL)
 * an area with no item the user can see is not sent to the browser — adding a page = adding a row to `NAVIGATION_APPS` that names area/section
 * together with the `navigation.areas.<id>` / `navigation.sections.<id>` text of the Console and Workspace
 */
export const NAVIGATION_AREAS = [
  'home',
  'workspace',
  'supervisor',
  'outbound',
  'journeys',
  'governance',
  'cases',
  'routing',
  'ai',
  'customers',
  'people',
  'wfm',
  'qm',
  'analytics',
  'integrations',
  'history',
  'reports',
  'settings',
] as const;
export type NavigationAreaId = (typeof NAVIGATION_AREAS)[number];

export type NavigationHostApp = 'console' | 'workspace';

/**
 * #658: sub-pages of an app (e.g. the Governance tabs) — shown as items in the submenu instead of tabs in the page
 * not a separate app: pinning/launcher stay at the app level and the visibility permission equals the app's (the target API authorizes every request itself)
 */
export interface NavigationPageDefinition {
  /** id within the app (a-z, hyphen) */
  id: string;
  /** key in the shell catalog */
  labelKey: string;
  /** path inside the app's host app — must contain no PII */
  path: string;
}

export interface NavigationAppDefinition {
  id: string;
  group: NavigationGroupId;
  /** key in the shell catalog (D1.13) */
  labelKey: string;
  /** #651: the work area on the rail that this item belongs to */
  area: NavigationAreaId;
  /** #651: sub-group in the area's submenu — the id is the key of `navigation.sections.<id>` (a-z, hyphen) */
  section: string;
  hostApp: NavigationHostApp;
  /** path inside the host app — must contain no PII; a link across host apps opens a new tab (ADR-026 item 3) */
  path: string;
  /** at least one realm role — visibility only; the target API still authorizes every request itself */
  roles: readonly string[];
  entitlement?: string;
  /** #658: sub-pages in the submenu (in order); omitted = the app's single item */
  pages?: readonly NavigationPageDefinition[];
}

/**
 * #967 team recordings for Supervisors — in the menu only for deployments that set
 * `RECORDING_SUPERVISOR_PLAYBACK=on`; the API checks permission by the answering team on every request
 */
export const TEAM_RECORDINGS_APP: NavigationAppDefinition = Object.freeze({
  id: 'team-recordings',
  area: 'supervisor',
  section: 'work',
  group: 'operations',
  labelKey: 'navigation.apps.teamRecordings',
  hostApp: 'console',
  path: '/?view=team-recordings',
  roles: ['supervisor'],
});

/**
 * #1044 web chat settings — in the menu only for deployments that set `WEBCHAT=on`
 * the Admin edits and the Supervisor reads; the API reads the role from the DB on every request
 */
export const WEBCHAT_SETTINGS_APP: NavigationAppDefinition = Object.freeze({
  id: 'webchat-settings',
  area: 'integrations',
  section: 'channels',
  group: 'settings',
  labelKey: 'navigation.apps.webchatSettings',
  hostApp: 'console',
  path: '/?view=webchat-settings',
  roles: ['supervisor', 'admin'],
});

/**
 * #1054 LINE chat settings — in the menu only for deployments that set `LINE_CHAT=on`
 * the Admin edits and the Supervisor reads; the API reads the role from the DB on every request
 */
export const LINE_SETTINGS_APP: NavigationAppDefinition = Object.freeze({
  id: 'line-settings',
  area: 'integrations',
  section: 'channels',
  group: 'settings',
  labelKey: 'navigation.apps.lineSettings',
  hostApp: 'console',
  path: '/?view=line-settings',
  roles: ['supervisor', 'admin'],
});

/**
 * #971 human quality evaluation — in the menu only for deployments that set `QM_HUMAN_EVALUATION=on`
 * the API checks the role from the DB and the answering team on every request
 */
export const QM_HUMAN_EVALUATION_APPS: readonly NavigationAppDefinition[] = Object.freeze([
  {
    id: 'team-evaluations',
    area: 'qm',
    section: 'work',
    group: 'quality',
    labelKey: 'navigation.apps.teamEvaluations',
    hostApp: 'console',
    path: '/?view=team-evaluations',
    roles: ['supervisor'],
  },
  {
    id: 'my-quality',
    area: 'qm',
    section: 'work',
    group: 'quality',
    labelKey: 'navigation.apps.myQuality',
    hostApp: 'console',
    path: '/?view=my-quality',
    roles: ['agent'],
  },
  {
    id: 'qm-forms',
    area: 'qm',
    section: 'configuration',
    group: 'quality',
    labelKey: 'navigation.apps.qmForms',
    hostApp: 'console',
    path: '/?view=qm-forms',
    roles: ['admin'],
  },
]);

const BASE_NAVIGATION_APPS: readonly NavigationAppDefinition[] = Object.freeze([
  {
    id: 'home',
    area: 'home',
    section: 'work',
    group: 'operations',
    labelKey: 'navigation.apps.home',
    hostApp: 'console',
    path: '/?view=home',
    roles: ['agent', 'supervisor', 'admin', 'compliance'],
  },
  {
    id: 'agent-workspace',
    area: 'workspace',
    section: 'work',
    group: 'live',
    labelKey: 'navigation.apps.agentWorkspace',
    hostApp: 'workspace',
    path: '/',
    roles: ['agent', 'supervisor', 'admin'],
  },
  {
    id: 'supervisor-workspace',
    area: 'supervisor',
    section: 'live',
    group: 'live',
    labelKey: 'navigation.apps.supervisorWorkspace',
    hostApp: 'workspace',
    path: '/?view=supervisor',
    roles: ['supervisor', 'admin'],
  },
  {
    id: 'journeys',
    area: 'journeys',
    section: 'work',
    group: 'automation',
    labelKey: 'navigation.apps.journeys',
    hostApp: 'console',
    path: '/?view=journeys',
    roles: ['supervisor', 'admin'],
    entitlement: 'module_journey',
  },
  {
    id: 'contact-governance',
    area: 'governance',
    section: 'work',
    group: 'quality',
    labelKey: 'navigation.apps.contactGovernance',
    hostApp: 'console',
    path: '/?view=governance',
    roles: ['supervisor', 'admin', 'compliance'],
    entitlement: 'module_contact_governance',
    // #658: Governance page tabs → items in the submenu (the path matches `parseGovernanceLocation`)
    pages: [
      {
        id: 'overview',
        labelKey: 'navigation.pages.contactGovernance.overview',
        path: '/?view=governance&section=overview',
      },
      {
        id: 'exceptions',
        labelKey: 'navigation.pages.contactGovernance.exceptions',
        path: '/?view=governance&section=exceptions',
      },
      {
        id: 'policies',
        labelKey: 'navigation.pages.contactGovernance.policies',
        path: '/?view=governance&section=policies',
      },
      {
        id: 'audit',
        labelKey: 'navigation.pages.contactGovernance.audit',
        path: '/?view=governance&section=audit',
      },
    ],
  },
  {
    // E1.11 (#485): allowlist of origins that embed dphone — ADMIN edits, SUPERVISOR views
    // the launcher hides it when there is no `modules.api.cti`; opening the URL directly shows a locked page with a message about the plan
    id: 'dphone-embedding',
    area: 'integrations',
    section: 'embedding',
    group: 'settings',
    labelKey: 'navigation.apps.dphoneEmbedding',
    hostApp: 'console',
    path: '/?view=dphone-embedding',
    roles: ['supervisor', 'admin'],
    entitlement: 'module_api_cti',
  },
  {
    id: 'agent-history',
    area: 'history',
    section: 'work',
    group: 'operations',
    labelKey: 'navigation.apps.agentHistory',
    hostApp: 'console',
    path: '/?view=agent-history',
    roles: ['agent'],
  },
  {
    // #986 team history and work summary — a Supervisor sees their own team, an Admin sees all teams (the API checks the DB on every request)
    id: 'team-history',
    area: 'history',
    section: 'work',
    group: 'operations',
    labelKey: 'navigation.apps.teamHistory',
    hostApp: 'console',
    path: '/?view=team-history',
    roles: ['supervisor', 'admin'],
  },
  {
    // #956 cases the Agent handles in the team — the API checks permission per request itself (sees only their own team's cases)
    id: 'team-cases',
    area: 'cases',
    section: 'work',
    group: 'operations',
    labelKey: 'navigation.apps.teamCases',
    hostApp: 'console',
    path: '/?view=team-cases',
    roles: ['agent'],
  },
  {
    id: 'voice-routing',
    area: 'routing',
    section: 'configuration',
    group: 'settings',
    labelKey: 'navigation.apps.voiceRouting',
    hostApp: 'console',
    path: '/?view=voice-routing',
    roles: ['admin', 'supervisor'],
    pages: [
      {
        id: 'queues',
        labelKey: 'navigation.pages.voiceRouting.queues',
        path: '/?view=voice-routing&section=queues',
      },
      {
        id: 'skills',
        labelKey: 'navigation.pages.voiceRouting.skills',
        path: '/?view=voice-routing&section=skills',
      },
      {
        id: 'destinations',
        labelKey: 'navigation.pages.voiceRouting.destinations',
        path: '/?view=voice-routing&section=destinations',
      },
      {
        id: 'agent-skills',
        labelKey: 'navigation.pages.voiceRouting.agentSkills',
        path: '/?view=voice-routing&section=agent-skills',
      },
    ],
  },
  {
    id: 'tenant-people',
    area: 'people',
    section: 'accounts',
    group: 'settings',
    labelKey: 'navigation.apps.tenantPeople',
    hostApp: 'console',
    path: '/?view=tenant-people',
    roles: ['admin'],
    pages: [
      {
        id: 'users',
        labelKey: 'navigation.pages.tenantPeople.users',
        path: '/?view=tenant-people',
      },
      {
        id: 'agent-skills',
        labelKey: 'navigation.pages.tenantPeople.agentSkills',
        path: '/?view=tenant-people&section=agent-skills',
      },
    ],
  },
  {
    // Cus360 C2 (#792): Customers + read-only profile; no Agent/Compliance (no generic directory, R1 C)
    // per-item permission is decided at the API on every request — the role here is only menu visibility
    id: 'customers',
    area: 'customers',
    section: 'customers',
    group: 'operations',
    labelKey: 'navigation.apps.customers',
    hostApp: 'console',
    path: '/?view=customers',
    roles: ['admin', 'supervisor'],
  },
  {
    id: 'customer-overview',
    area: 'customers',
    section: 'customers',
    group: 'operations',
    labelKey: 'navigation.apps.customerOverview',
    hostApp: 'console',
    path: '/?view=customer-overview',
    roles: ['admin'],
  },
  {
    id: 'customer-rules',
    area: 'customers',
    section: 'customers',
    group: 'operations',
    labelKey: 'navigation.apps.customerRules',
    hostApp: 'console',
    path: '/?view=customer-rules',
    roles: ['admin'],
  },
  {
    id: 'customer-activity',
    area: 'customers',
    section: 'customers',
    group: 'operations',
    labelKey: 'navigation.apps.customerActivity',
    hostApp: 'console',
    path: '/?view=customer-activity',
    roles: ['admin'],
  },
  {
    id: 'customer-tags',
    area: 'customers',
    section: 'customers',
    group: 'operations',
    labelKey: 'navigation.apps.customerTags',
    hostApp: 'console',
    path: '/?view=customer-tags',
    roles: ['admin'],
  },
  {
    id: 'customer-import',
    area: 'customers',
    section: 'customers',
    group: 'operations',
    labelKey: 'navigation.apps.customerImport',
    hostApp: 'console',
    path: '/?view=customer-import',
    roles: ['admin'],
  },
  {
    id: 'customer-access',
    area: 'customers',
    section: 'customers',
    group: 'operations',
    labelKey: 'navigation.apps.customerAccess',
    hostApp: 'console',
    path: '/?view=customer-access',
    roles: ['admin'],
  },
  {
    id: 'core-settings',
    area: 'settings',
    section: 'configuration',
    group: 'settings',
    labelKey: 'navigation.apps.coreSettings',
    hostApp: 'console',
    path: '/?view=core-settings&page=organization',
    roles: ['admin', 'supervisor'],
    pages: [
      {
        id: 'organization',
        labelKey: 'navigation.pages.coreSettings.organization',
        path: '/?view=core-settings&page=organization',
      },
      {
        id: 'teams',
        labelKey: 'navigation.pages.coreSettings.teams',
        path: '/?view=core-settings&page=teams',
      },
      {
        id: 'not-ready-reasons',
        labelKey: 'navigation.pages.coreSettings.notReadyReasons',
        path: '/?view=core-settings&page=not-ready-reasons',
      },
    ],
  },
]);

/**
 * the deployment's app list: adds team recordings after "live team" and the quality evaluation app
 * at the end of the list when enabled (area `qm` is already in the order of `NAVIGATION_AREAS`)
 */
export function navigationApps(
  recordingPlayback: boolean,
  qmHumanEvaluation = false,
  webchat = false,
  lineChat = false,
): readonly NavigationAppDefinition[] {
  const apps = [...BASE_NAVIGATION_APPS];
  if (recordingPlayback) {
    const after = apps.findIndex((app) => app.id === 'supervisor-workspace') + 1;
    apps.splice(after, 0, TEAM_RECORDINGS_APP);
  }
  if (qmHumanEvaluation) apps.push(...QM_HUMAN_EVALUATION_APPS);
  if (webchat) {
    const after = apps.findIndex((app) => app.id === 'dphone-embedding') + 1;
    apps.splice(after, 0, WEBCHAT_SETTINGS_APP);
  }
  if (lineChat) {
    const after =
      apps.findIndex((app) => app.id === (webchat ? 'webchat-settings' : 'dphone-embedding')) + 1;
    apps.splice(after, 0, LINE_SETTINGS_APP);
  }
  return Object.freeze(apps);
}

export const NAVIGATION_APPS: readonly NavigationAppDefinition[] = navigationApps(
  resolveRecordingSupervisorPlayback(process.env),
  resolveQmHumanEvaluation(process.env),
  resolveWebchat(process.env),
  resolveLineChat(process.env),
);

export interface NavigationAreaItemView {
  appId: string;
  /** #658: sent only for apps that have sub-pages — an older client sees a single item per `appId` */
  pages?: NavigationPageDefinition[];
}

export interface NavigationAreaView {
  id: NavigationAreaId;
  sections: { id: string; items: NavigationAreaItemView[] }[];
}

/**
 * #651: areas/sub-groups/menu items from apps the user can already see, only
 * area order follows `NAVIGATION_AREAS`; sub-groups and items follow the registry order; empty areas are not sent
 */
export function visibleAreas(visible: readonly NavigationAppDefinition[]): NavigationAreaView[] {
  return NAVIGATION_AREAS.flatMap((areaId) => {
    const sections: NavigationAreaView['sections'] = [];
    for (const app of visible) {
      if (app.area !== areaId) continue;
      let section = sections.find((candidate) => candidate.id === app.section);
      if (!section) {
        section = { id: app.section, items: [] };
        sections.push(section);
      }
      section.items.push({
        appId: app.id,
        ...(app.pages && app.pages.length > 0
          ? { pages: app.pages.map((page) => ({ ...page })) }
          : {}),
      });
    }
    return sections.length > 0 ? [{ id: areaId, sections }] : [];
  });
}

/** `null` = the tenant has no plan binding */
export type EffectiveEntitlements = Readonly<Record<string, unknown>> | null;

export function entitled(app: NavigationAppDefinition, entitlements: EffectiveEntitlements) {
  if (!app.entitlement || entitlements === null) return true;
  return entitlements[app.entitlement] === true;
}

/** apps this user can see, in registry order */
export function visibleApps(
  input: { roles: readonly string[]; entitlements: EffectiveEntitlements },
  registry: readonly NavigationAppDefinition[] = NAVIGATION_APPS,
): NavigationAppDefinition[] {
  return registry.filter(
    (app) =>
      app.roles.some((role) => input.roles.includes(role)) && entitled(app, input.entitlements),
  );
}

/** apps a tenant ADMIN can put in the starter set — by the tenant's entitlement, independent of the admin's role */
export function tenantAvailableApps(
  entitlements: EffectiveEntitlements,
  registry: readonly NavigationAppDefinition[] = NAVIGATION_APPS,
): NavigationAppDefinition[] {
  return registry.filter((app) => entitled(app, entitlements));
}

export type PinSource = 'USER' | 'TENANT' | 'SYSTEM';

/**
 * effective pins: the user overrides the tenant; neither = the visible apps in registry order
 * a pin that was set but is now invisible (role/plan changed) is filtered out on read, without revealing that it still exists
 */
export function effectivePins(input: {
  visible: readonly NavigationAppDefinition[];
  userPins: readonly string[] | null;
  tenantPins: readonly string[] | null;
}): { appIds: string[]; source: PinSource } {
  const visibleIds = new Set(input.visible.map((app) => app.id));
  const keepVisible = (ids: readonly string[]) => ids.filter((id) => visibleIds.has(id));
  if (input.userPins !== null) return { appIds: keepVisible(input.userPins), source: 'USER' };
  if (input.tenantPins !== null) return { appIds: keepVisible(input.tenantPins), source: 'TENANT' };
  return { appIds: input.visible.slice(0, MAX_PINS).map((app) => app.id), source: 'SYSTEM' };
}

export type PinValidationError = 'PIN_LIMIT_EXCEEDED' | 'APP_NOT_AVAILABLE';

/**
 * validate the pin set against the allowed apps — an app that does not exist and an app that exists but is not permitted get the same error
 * so this endpoint cannot be used to probe which apps exist that the caller cannot see
 */
export function pinValidationError(
  appIds: readonly string[],
  allowed: readonly NavigationAppDefinition[],
): PinValidationError | null {
  if (appIds.length > MAX_PINS) return 'PIN_LIMIT_EXCEEDED';
  const allowedIds = new Set(allowed.map((app) => app.id));
  return appIds.every((id) => allowedIds.has(id)) ? null : 'APP_NOT_AVAILABLE';
}
