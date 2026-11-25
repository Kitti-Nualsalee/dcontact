import { importAllC360LegacyContactPoints } from '@d-contact/customer-360';
import { PrismaClient } from '@d-contact/db';

/**
 * Cus360 C3 (#793) S4: the real rollout order for the fixture — legacy ContactIdentity must be imported as
 * a contact point through the operator command before the journey-composition resolver can resolve it.
 */
// No default to the shared DB (port 5433): the import must target the task's own DB only. The client is created on first use.
let client: PrismaClient | undefined;
function application(): PrismaClient {
  const url = process.env.APPLICATION_DATABASE_URL;
  if (!url)
    throw new Error(
      'APPLICATION_DATABASE_URL of a separate DB must be set before importing the legacy fixture',
    );
  client ??= new PrismaClient({ datasources: { db: { url } } });
  return client;
}

export async function importLegacyContactPoints(tenantId: string): Promise<void> {
  await importAllC360LegacyContactPoints(
    application(),
    { tenantId, issuer: 'https://fixture.test', subject: 'journey-legacy-import', userId: null },
    { evidenceRef: 'fixture:c3-bridge', reasonCode: 'LEGACY_POINT_MIGRATION' },
  );
}

/** Cus360 rows reference ContactIdentity through an FK, so they must be deleted before the fixture cleanup */
export async function deleteC360Fixtures(owner: PrismaClient, tenantId: string): Promise<void> {
  for (const table of [
    'c360_profile_audits',
    'c360_profile_command_receipts',
    'c360_contact_points',
    'c360_profile_commands',
  ])
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenantId);
}

export async function closeLegacyImportClient(): Promise<void> {
  await client?.$disconnect();
}
