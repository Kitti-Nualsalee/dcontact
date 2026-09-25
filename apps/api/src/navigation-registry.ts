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

export type NavigationHostApp = 'console' | 'workspace';

export interface NavigationAppDefinition {
  id: string;
  group: NavigationGroupId;
  /** key ใน catalog ของ shell (D1.13) */
  labelKey: string;
  hostApp: NavigationHostApp;
  /** path ภายใน host app — ห้ามมี PII; ลิงก์ข้าม host app เปิดแท็บใหม่ (ADR-026 ข้อ 3) */
  path: string;
  /** realm role อย่างน้อยหนึ่งตัว — เป็นแค่การมองเห็น API ปลายทางยัง authorize เองทุก request */
  roles: readonly string[];
  entitlement?: string;
}

export const NAVIGATION_APPS: readonly NavigationAppDefinition[] = Object.freeze([
  {
    id: 'agent-workspace',
    group: 'live',
    labelKey: 'navigation.apps.agentWorkspace',
    hostApp: 'workspace',
    path: '/',
    roles: ['agent', 'supervisor', 'admin'],
  },
  {
    id: 'supervisor-workspace',
    group: 'live',
    labelKey: 'navigation.apps.supervisorWorkspace',
    hostApp: 'workspace',
    path: '/?view=supervisor',
    roles: ['supervisor', 'admin'],
  },
  {
    id: 'journeys',
    group: 'automation',
    labelKey: 'navigation.apps.journeys',
    hostApp: 'console',
    path: '/?view=journeys',
    roles: ['supervisor', 'admin'],
    entitlement: 'module_journey',
  },
  {
    id: 'contact-governance',
    group: 'quality',
    labelKey: 'navigation.apps.contactGovernance',
    hostApp: 'console',
    path: '/?view=governance',
    roles: ['supervisor', 'admin', 'compliance'],
    entitlement: 'module_contact_governance',
  },
]);

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
