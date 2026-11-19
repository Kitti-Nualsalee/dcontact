import type { TeamScopePermission, TeamViewScope } from '../team-scopes/api.js';

/**
 * #915: Admin ให้ทีมเห็นและทำงานกับลูกค้าผ่าน segment ระบบของ #911 เท่านั้นในรอบนี้
 * (ยังไม่มีหน้า authoring segment) — id ต้องตรงกับที่ evaluator ใน apps/api สร้าง
 */
export const SYSTEM_SEGMENTS = ['system:all-customers', 'system:vip'] as const;
/** key ใน catalog — i18next ใช้ `:` แยก namespace จึงใช้ id ของ segment เป็น key ตรง ๆ ไม่ได้ */
export const SEGMENT_LABEL_KEYS: Record<(typeof SYSTEM_SEGMENTS)[number], string> = {
  'system:all-customers': 'segments.allCustomers',
  'system:vip': 'segments.vip',
};
export const PERMISSIONS: readonly TeamScopePermission[] = ['WORK', 'VIEW'];

export interface AccessTeam {
  id: string;
  name: string;
  isActive: boolean;
}

export interface AccessRow {
  grantId: string;
  teamId: string;
  /** null = ทีมไม่อยู่ในรายการ (ถูกปิดหรือโหลดไม่ครบ) ให้หน้าแสดง id แทน */
  teamName: string | null;
  teamActive: boolean;
  segmentId: string;
  permission: TeamScopePermission;
}

/** รวม grant กับชื่อทีม เรียงตามชื่อทีม → segment → WORK ก่อน VIEW */
export function accessRows(scopes: readonly TeamViewScope[], teams: readonly AccessTeam[]) {
  const byId = new Map(teams.map((team) => [team.id, team]));
  return scopes
    .map((scope): AccessRow => ({
      grantId: scope.grantId,
      teamId: scope.teamId,
      teamName: byId.get(scope.teamId)?.name ?? null,
      teamActive: byId.get(scope.teamId)?.isActive ?? false,
      segmentId: scope.segmentId,
      permission: scope.permission ?? 'VIEW',
    }))
    .sort(
      (a, b) =>
        (a.teamName ?? `￿${a.teamId}`).localeCompare(b.teamName ?? `￿${b.teamId}`, 'th') ||
        a.segmentId.localeCompare(b.segmentId) ||
        PERMISSIONS.indexOf(a.permission) - PERMISSIONS.indexOf(b.permission),
    );
}

/** ทีมที่ให้สิทธิ์ใหม่ได้ = ทีมที่ยังใช้งาน เรียงตามชื่อ */
export function grantableTeams(teams: readonly AccessTeam[]) {
  return teams.filter((team) => team.isActive).sort((a, b) => a.name.localeCompare(b.name, 'th'));
}

/** มี grant เดียวกันอยู่แล้ว — กันการกดซ้ำก่อนส่ง (server ตอบ DUPLICATE ได้อยู่แล้ว) */
export function hasGrant(
  rows: readonly AccessRow[],
  input: { teamId: string; segmentId: string; permission: TeamScopePermission },
) {
  return rows.some(
    (row) =>
      row.teamId === input.teamId &&
      row.segmentId === input.segmentId &&
      row.permission === input.permission,
  );
}

/** เหตุผลการถอนต้องยาว 3–120 ตัวอักษรตาม API */
export function validRevokeReason(value: string) {
  const length = value.trim().length;
  return length >= 3 && length <= 120;
}
