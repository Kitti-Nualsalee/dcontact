import type { Prisma, PrismaClient } from '@d-contact/db';
import { coreOrganizationNameError, coreTimeZoneValid } from '@d-contact/shared';
import { coreFail } from './tenant-core-errors.js';
import {
  coreIdentityKey,
  executeCoreCommand,
  prepareCoreCommand,
  type CoreIdentity,
} from './tenant-core-command.js';

interface OrganizationSnapshot {
  id: string;
  displayName: string;
  defaults: null | { locale: string; timeZone: string; initializationSource: string };
  revision: string;
}
export async function coreOrganizationSnapshot(tx: Prisma.TransactionClient, tenantId: string) {
  // GET ใน READ COMMITTED ต้องอ่าน aggregate จาก statement snapshot เดียวกันด้วย
  const [row] = await tx.$queryRaw<{ value: OrganizationSnapshot | null }[]>`
    SELECT public.dc_core_organization_snapshot(${tenantId}::uuid) AS value`;
  if (!row?.value) coreFail('CORE_ACCESS_DENIED', 403);
  return row.value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) coreFail('INVALID_REQUEST', 400);
  return value as Record<string, unknown>;
}
function strictKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((k) => !keys.includes(k))) coreFail('INVALID_REQUEST', 400);
}
export async function updateCoreOrganization(
  db: PrismaClient,
  identity: CoreIdentity,
  body: unknown,
) {
  const input = record(body);
  strictKeys(input, ['commandId', 'expectedRevision', 'patch']);
  const raw = record(input.patch);
  strictKeys(raw, ['displayName', 'defaults']);
  if (!Object.keys(raw).length) coreFail('INVALID_REQUEST', 400);
  const patch: { displayName?: string; defaults?: { locale: string; timeZone: string } } = {};
  if (Object.hasOwn(raw, 'displayName')) {
    if (typeof raw.displayName !== 'string') coreFail('INVALID_REQUEST', 400);
    patch.displayName = raw.displayName.trim();
  }
  if (Object.hasOwn(raw, 'defaults')) {
    const defaults = record(raw.defaults);
    strictKeys(defaults, ['locale', 'timeZone']);
    if (typeof defaults.locale !== 'string' || typeof defaults.timeZone !== 'string')
      coreFail('INVALID_REQUEST', 400);
    patch.defaults = { locale: defaults.locale, timeZone: defaults.timeZone };
  }
  const command = prepareCoreCommand({
    commandId: input.commandId,
    expectedRevision: input.expectedRevision,
    action: 'ORGANIZATION_UPDATE',
    resourceType: 'ORGANIZATION',
    resourceId: identity.tenantId,
    payload: patch,
  });
  return executeCoreCommand(db, identity, command, async (tx) => {
    const locks = await tx.$queryRaw<
      { locked: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`core-profile:${identity.tenantId}`},0)) AS locked`;
    if (!locks[0]?.locked) coreFail('CONFIG_BUSY', 409, { retryable: true });
    const before = await coreOrganizationSnapshot(tx, identity.tenantId);
    if (before.revision !== command.expectedRevision)
      coreFail('REVISION_CONFLICT', 409, { currentRevision: before.revision });
    const fieldErrors: Record<string, string> = {};
    if (patch.displayName !== undefined && coreOrganizationNameError(patch.displayName))
      fieldErrors.displayName = 'core.validation.name';
    if (patch.defaults) {
      if (!['th', 'en'].includes(patch.defaults.locale))
        fieldErrors.locale = 'core.validation.locale';
      if (!coreTimeZoneValid(patch.defaults.timeZone))
        fieldErrors.timeZone = 'core.validation.timeZone';
    }
    if (Object.keys(fieldErrors).length) coreFail('VALIDATION_FAILED', 422, { fieldErrors });
    const nameChanged = patch.displayName !== undefined && patch.displayName !== before.displayName;
    const defaultsChanged =
      patch.defaults &&
      (patch.defaults.locale !== before.defaults?.locale ||
        patch.defaults.timeZone !== before.defaults?.timeZone);
    if (!nameChanged && !defaultsChanged)
      return { outcome: 'NO_OP', revision: BigInt(before.revision), snapshot: before };
    if (nameChanged)
      await tx.tenant.update({
        where: { id: identity.tenantId },
        data: { name: patch.displayName },
      });
    if (defaultsChanged && patch.defaults)
      await tx.tenantSettings.upsert({
        where: { tenantId: identity.tenantId },
        update: { locale: patch.defaults.locale, timezone: patch.defaults.timeZone },
        create: {
          tenantId: identity.tenantId,
          locale: patch.defaults.locale,
          timezone: patch.defaults.timeZone,
          initializationSource: 'CORE_ADMIN',
          initializedByUserId: identity.userId,
          initializedByIdentityKey: coreIdentityKey(identity),
          initializedByCommandId: command.commandId,
        },
      });
    const snapshot = await coreOrganizationSnapshot(tx, identity.tenantId);
    return {
      outcome: 'APPLIED',
      revision: BigInt(snapshot.revision),
      beforeRevision: BigInt(before.revision),
      before,
      snapshot,
    };
  });
}
