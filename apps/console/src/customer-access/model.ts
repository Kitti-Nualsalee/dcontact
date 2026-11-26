import type { TeamScopePermission, TeamViewScope } from '../team-scopes/api.js';

/**
 * #915: in this round Admin lets teams see and work with customers only through the system segments of #911
 * (there is no segment authoring page yet) — the id must match what the evaluator in apps/api creates
 */
export const SYSTEM_SEGMENTS = ['system:all-customers', 'system:vip'] as const;
/** key in the catalog — i18next uses `:` to separate namespaces, so the segment id cannot be used directly as a key */
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
  /** null = the team is not in the list (disabled or not fully loaded), so the page shows the id instead */
  teamName: string | null;
  teamActive: boolean;
  segmentId: string;
  permission: TeamScopePermission;
}

/** combine grants with team names, sorted by team name → segment → WORK before VIEW */
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

/** teams that can be newly granted = teams still active, sorted by name */
export function grantableTeams(teams: readonly AccessTeam[]) {
  return teams.filter((team) => team.isActive).sort((a, b) => a.name.localeCompare(b.name, 'th'));
}

/** an identical grant already exists — prevents a double press before sending (the server can answer DUPLICATE anyway) */
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

/** the revoke reason must be 3–120 characters per the API */
export function validRevokeReason(value: string) {
  const length = value.trim().length;
  return length >= 3 && length <= 120;
}

/** the other kind of team access on the same segment that remains after revoking `row` — VIEW/WORK are separate grant rows */
export function remainingPermission(rows: readonly AccessRow[], row: AccessRow) {
  return rows.find(
    (other) =>
      other.grantId !== row.grantId &&
      other.teamId === row.teamId &&
      other.segmentId === row.segmentId &&
      other.permission !== row.permission,
  )?.permission;
}
