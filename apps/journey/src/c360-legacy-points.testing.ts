import { importAllC360LegacyContactPoints } from '@d-contact/customer-360';
import { PrismaClient } from '@d-contact/db';

/**
 * Cus360 C3 (#793) S4: ลำดับ rollout จริงของ fixture — legacy ContactIdentity ต้องถูก import เป็น
 * contact point ผ่าน operator command ก่อน resolver ของ journey-composition จะ resolve ได้
 */
// ไม่มี default ไป DB ร่วม (port 5433): import ต้องลง DB แยกของงานเท่านั้น สร้าง client ตอนใช้ครั้งแรก
let client: PrismaClient | undefined;
function application(): PrismaClient {
  const url = process.env.APPLICATION_DATABASE_URL;
  if (!url)
    throw new Error('ต้องตั้ง APPLICATION_DATABASE_URL ของ DB แยกก่อน import legacy fixture');
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

/** แถวของ Cus360 อ้าง ContactIdentity ผ่าน FK จึงต้องลบก่อน cleanup ของ fixture */
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
