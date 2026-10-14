/**
 * D1.12 (#451): app registry ของ Console/Workspace และกติกาการมองเห็น/หมุด (D1.2 #422)
 *
 * - รายการแอปที่มองเห็นคำนวณที่ server เท่านั้น: role (จาก token) + effective entitlement (ADR-009)
 *   แอปที่ไม่ผ่านถูกตัดออกก่อนถึง browser — ไม่มีสถานะ "ล็อก" ใน launcher/rail
 * - entitlement: แอปที่ระบุ key ต้องได้ `entitlements[key] === true` จาก plan binding (fail-closed)
 *   ยกเว้น tenant ที่ **ไม่มี plan binding เลย** (tenant ก่อน A1 เช่น demo) ใช้ role อย่างเดียว เพราะ
 *   tenant กลุ่มนี้ยังไม่มีแนวคิด plan — tenant จาก provisioning มี binding เสมอจึงยัง fail-closed
 *   (ผู้ใช้ตัดสิน 2026-09-25 ใน #451)
 * - key ของ module เป็น snake_case ตามตัวตรวจ plan (`planEntitlementErrors`) — ADR-025 เรียก
 *   `modules.journey.*` และ ADR-027 เรียก `modules.contactGovernance.*`
 * - registry มีเฉพาะหน้าจอที่มีอยู่จริง — แอปใหม่เพิ่มแถวที่นี่พร้อม i18n key ของ launcher
 */

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
 * #651: พื้นที่งานบน rail (ลำดับ = ลำดับบน rail, ตาม `mockups/assets/app.js` RAIL)
 * พื้นที่ที่ไม่มีรายการที่ผู้ใช้เห็นจะไม่ถูกส่งไป browser — เพิ่มหน้าใหม่ = เพิ่มแถวใน `NAVIGATION_APPS` ที่ระบุ area/section
 * พร้อมข้อความ `navigation.areas.<id>` / `navigation.sections.<id>` ของ Console และ Workspace
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
  'people',
  'wfm',
  'qm',
  'analytics',
  'integrations',
  'history',
  'reports',
] as const;
export type NavigationAreaId = (typeof NAVIGATION_AREAS)[number];

export type NavigationHostApp = 'console' | 'workspace';

/**
 * #658: หน้าย่อยของแอป (เช่น แท็บของ Governance) — แสดงเป็นรายการในเมนูย่อยแทนแท็บในหน้า
 * ไม่ใช่แอปแยก: ปักหมุด/launcher ยังเป็นระดับแอป และสิทธิ์การมองเห็นเท่ากับแอป (API ปลายทาง authorize เองทุก request)
 */
export interface NavigationPageDefinition {
  /** id ภายในแอป (a-z, ขีดกลาง) */
  id: string;
  /** key ใน catalog ของ shell */
  labelKey: string;
  /** path ภายใน host app ของแอป — ห้ามมี PII */
  path: string;
}

export interface NavigationAppDefinition {
  id: string;
  group: NavigationGroupId;
  /** key ใน catalog ของ shell (D1.13) */
  labelKey: string;
  /** #651: พื้นที่งานบน rail ที่รายการนี้อยู่ */
  area: NavigationAreaId;
  /** #651: กลุ่มย่อยในเมนูย่อยของ area — id เป็น key ของ `navigation.sections.<id>` (a-z, ขีดกลาง) */
  section: string;
  hostApp: NavigationHostApp;
  /** path ภายใน host app — ห้ามมี PII; ลิงก์ข้าม host app เปิดแท็บใหม่ (ADR-026 ข้อ 3) */
  path: string;
  /** realm role อย่างน้อยหนึ่งตัว — เป็นแค่การมองเห็น API ปลายทางยัง authorize เองทุก request */
  roles: readonly string[];
  entitlement?: string;
  /** #658: หน้าย่อยในเมนูย่อย (ตามลำดับ); ไม่ระบุ = รายการเดียวของแอป */
  pages?: readonly NavigationPageDefinition[];
}

export const NAVIGATION_APPS: readonly NavigationAppDefinition[] = Object.freeze([
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
    // #658: แท็บของหน้า Governance → รายการในเมนูย่อย (path ตรงกับ `parseGovernanceLocation`)
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
    // E1.11 (#485): allowlist ของ origin ที่ฝัง dphone — ADMIN แก้, SUPERVISOR ดู
    // launcher ซ่อนเมื่อไม่มี `modules.api.cti`; เปิด URL ตรงเห็นหน้าล็อกพร้อมข้อความเรื่อง plan
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
]);

export interface NavigationAreaItemView {
  appId: string;
  /** #658: ส่งเฉพาะแอปที่มีหน้าย่อย — client รุ่นเก่าเห็นรายการเดียวตาม `appId` */
  pages?: NavigationPageDefinition[];
}

export interface NavigationAreaView {
  id: NavigationAreaId;
  sections: { id: string; items: NavigationAreaItemView[] }[];
}

/**
 * #651: พื้นที่/กลุ่มย่อย/รายการเมนูจากแอปที่ผู้ใช้มองเห็นแล้วเท่านั้น
 * ลำดับพื้นที่ตาม `NAVIGATION_AREAS`; กลุ่มย่อยและรายการตามลำดับของ registry; พื้นที่ว่างไม่ถูกส่ง
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

/** `null` = tenant ไม่มี plan binding */
export type EffectiveEntitlements = Readonly<Record<string, unknown>> | null;

export function entitled(app: NavigationAppDefinition, entitlements: EffectiveEntitlements) {
  if (!app.entitlement || entitlements === null) return true;
  return entitlements[app.entitlement] === true;
}

/** แอปที่ผู้ใช้คนนี้มองเห็น ตามลำดับของ registry */
export function visibleApps(
  input: { roles: readonly string[]; entitlements: EffectiveEntitlements },
  registry: readonly NavigationAppDefinition[] = NAVIGATION_APPS,
): NavigationAppDefinition[] {
  return registry.filter(
    (app) =>
      app.roles.some((role) => input.roles.includes(role)) && entitled(app, input.entitlements),
  );
}

/** แอปที่ tenant ADMIN ใส่ในชุดเริ่มต้นได้ — ตาม entitlement ของ tenant ไม่ขึ้นกับ role ของ admin */
export function tenantAvailableApps(
  entitlements: EffectiveEntitlements,
  registry: readonly NavigationAppDefinition[] = NAVIGATION_APPS,
): NavigationAppDefinition[] {
  return registry.filter((app) => entitled(app, entitlements));
}

export type PinSource = 'USER' | 'TENANT' | 'SYSTEM';

/**
 * หมุดที่มีผล: ผู้ใช้ทับ tenant; ไม่มีทั้งคู่ = แอปที่มองเห็นตามลำดับ registry
 * หมุดที่เคยปักแต่ตอนนี้มองไม่เห็น (role/plan เปลี่ยน) ถูกกรองออกตอนอ่าน ไม่เปิดเผยว่ายังมีอยู่
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
 * ตรวจชุดหมุดกับแอปที่อนุญาต — แอปที่ไม่มีอยู่และแอปที่มีแต่ไม่มีสิทธิ์ได้ error เดียวกัน
 * เพื่อไม่ให้ใช้ endpoint นี้สำรวจว่ามีแอปอะไรที่ตัวเองมองไม่เห็น
 */
export function pinValidationError(
  appIds: readonly string[],
  allowed: readonly NavigationAppDefinition[],
): PinValidationError | null {
  if (appIds.length > MAX_PINS) return 'PIN_LIMIT_EXCEEDED';
  const allowedIds = new Set(allowed.map((app) => app.id));
  return appIds.every((id) => allowedIds.has(id)) ? null : 'APP_NOT_AVAILABLE';
}
