/**
 * ids that are deterministic per provisioning request (A1.4/A1.5) — the rows the saga seeds always use these ids
 * so they can replay without duplicating and the correlation can be checked from the id without storing an extra mapping
 */
import { createHash } from 'node:crypto';

/** a v5-style UUID from sha256(namespace:value) — accepted by Postgres `uuid` */
export function deterministicUuid(namespace: string, value: string): string {
  const hex = createHash('sha256').update(`${namespace}:${value}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function firstAdminUserId(requestId: string): string {
  return deterministicUuid('dcontact:first-admin', requestId);
}

/** baseline rows of PLAN_BOOTSTRAP (#392 Bootstrap scope) */
export function bootstrapRowIds(requestId: string) {
  return {
    adminTeamId: deterministicUuid('dcontact:bootstrap:admin-team', requestId),
    generalTeamId: deterministicUuid('dcontact:bootstrap:general-team', requestId),
    generalQueueId: deterministicUuid('dcontact:bootstrap:general-queue', requestId),
    businessHoursId: deterministicUuid('dcontact:bootstrap:business-hours', requestId),
  };
}
