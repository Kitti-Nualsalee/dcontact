import { createHash, randomUUID } from 'node:crypto';
import {
  C360ContactPointError,
  normalizeC360Email,
  normalizeC360Phone,
  type C360ContactPointErrorCode,
} from '@d-contact/contact-points';
import { Prisma } from '@d-contact/db';
import { C360ProfileCommandError } from './profile-command.js';
import { tryC360IdentityFences } from './profile-fences.js';
import { C360_CONTACT_POINT_QUOTA } from './profile-points.js';

/**
 * Cus360 C3 (#793) S3: inventory และ import legacy ContactIdentity → contact point ตาม E1 D
 *
 * - อ่าน ContactIdentity อย่างเดียว ไม่แก้ owner/value/verification/consent ของแถวเดิม
 * - ผ่าน parser ตามค่าที่บันทึกไว้จริง = ACTIVE; ไม่มี + และไม่มีประเทศ, extension หรือรูปแบบผิด =
 *   REVIEW_REQUIRED (ไม่มี normalized key จึงไม่ถูก lookup/dispatch) ไม่เดาประเทศจาก tenant/locale
 * - identity หลายแถวของ contact เดียวที่ normalize แล้วซ้ำกัน (หรือซ้ำ point ACTIVE เดิม) เก็บเป็น
 *   REVIEW_REQUIRED เหตุผล DUPLICATE_ON_CONTACT: ยังมี provenance ครบ แต่ lookup ใช้ ACTIVE ตัวเดียว
 * - idempotent: unique (tenant_id, source_identity_id) และ FK (tenant, identity, contact) พิสูจน์
 *   provenance; รันซ้ำได้โดยไม่สร้างแถวซ้ำ legacy ที่เกิน quota ไม่ถูกตัดทิ้ง
 * - รายงานมีแค่ counts และ digest ไม่มีค่า phone/email ดิบ
 */
export const C360_LEGACY_IMPORT_BATCH_MAX = 200;

const IMPORTABLE = ['PHONE', 'EMAIL'] as const;
type ImportableType = (typeof IMPORTABLE)[number];

export type C360LegacyClassification =
  | { state: 'ACTIVE'; normalizedValue: string; normalizationVersion: string }
  | { state: 'REVIEW_REQUIRED'; reason: C360ContactPointErrorCode | 'DUPLICATE_ON_CONTACT' };

export function classifyC360LegacyIdentity(
  type: ImportableType,
  value: string,
): C360LegacyClassification {
  try {
    // legacy ไม่มีประเทศที่ผู้ใช้เลือกไว้ จึงรับเฉพาะเบอร์ international ที่ parse ได้ทั้งข้อความ
    const point = type === 'PHONE' ? normalizeC360Phone(value, null) : normalizeC360Email(value);
    return {
      state: 'ACTIVE',
      normalizedValue: point.normalizedValue,
      normalizationVersion: point.normalizationVersion,
    };
  } catch (error) {
    if (error instanceof C360ContactPointError)
      return { state: 'REVIEW_REQUIRED', reason: error.code };
    throw error;
  }
}

interface LegacyIdentityRow {
  id: string;
  contact_id: string;
  type: ImportableType;
  value: string;
  imported: boolean;
}

export interface C360LegacyInventory {
  tenantId: string;
  identities: Record<ImportableType, number>;
  imported: number;
  pending: { active: number; reviewRequired: number };
  reviewReasons: Record<string, number>;
  /** contact ที่ ACTIVE ต่อชนิดเกิน quota หลัง import (ไม่ถูกตัดทิ้ง แต่เพิ่มใหม่ไม่ได้) */
  contactsOverQuota: number;
  /** normalized key เดียวกันบนหลาย contact (เก็บได้ตาม R1 แต่ต้องไม่ถูกตีความเป็นคนเดียวกัน) */
  sharedKeys: { keys: number; contacts: number; digest: string };
  identityHeads: { missing: number; merged: number; ambiguous: number };
}

function keyDigest(tenantId: string, keys: string[]): string {
  // digest ผูก tenant เพื่อเทียบรอบต่อรอบได้ โดยไม่เปิดเผยค่าและเทียบข้าม tenant ไม่ได้
  const hash = createHash('sha256').update(`c360-legacy-keys-v1\0${tenantId}`);
  for (const key of [...keys].sort()) hash.update(`\0${key}`);
  return hash.digest('hex');
}

/** ACTIVE ซ้ำบน contact เดียวกันทำไม่ได้ (unique index) จึงลดเป็น REVIEW_REQUIRED แทนการทิ้งแถว */
function dedupe(
  result: C360LegacyClassification,
  row: { contact_id: string; type: string },
  contactKeys: Set<string>,
): C360LegacyClassification {
  if (result.state !== 'ACTIVE') return result;
  const key = `${row.contact_id}\0${row.type}\0${result.normalizationVersion}\0${result.normalizedValue}`;
  if (contactKeys.has(key)) return { state: 'REVIEW_REQUIRED', reason: 'DUPLICATE_ON_CONTACT' };
  contactKeys.add(key);
  return result;
}

async function legacyIdentities(
  tx: Prisma.TransactionClient,
  tenantId: string,
  options: { pendingOnly: boolean; limit?: number },
): Promise<LegacyIdentityRow[]> {
  return tx.$queryRaw<LegacyIdentityRow[]>`
    SELECT ci.id, ci.contact_id, ci.type::text AS type, ci.value,
           EXISTS (SELECT 1 FROM c360_contact_points p
                   WHERE p.tenant_id = ci.tenant_id AND p.source_identity_id = ci.id) AS imported
    FROM contact_identities ci
    WHERE ci.tenant_id = ${tenantId}::uuid AND ci.type::text IN ('PHONE', 'EMAIL')
      AND (${!options.pendingOnly} OR NOT EXISTS (
        SELECT 1 FROM c360_contact_points p
        WHERE p.tenant_id = ci.tenant_id AND p.source_identity_id = ci.id))
    ORDER BY ci.id
    ${options.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${options.limit}`}`;
}

/** Dry-run: สำรวจสิ่งที่ import จะทำโดยไม่เขียนอะไร */
export async function inventoryC360LegacyContactPoints(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<C360LegacyInventory> {
  const rows = await legacyIdentities(tx, tenantId, { pendingOnly: false });
  const identities: Record<ImportableType, number> = { PHONE: 0, EMAIL: 0 };
  const reviewReasons: Record<string, number> = {};
  let imported = 0;
  let active = 0;
  let review = 0;
  // ACTIVE ที่จะมีหลัง import ต่อ contact/ชนิด และ key → contacts สำหรับ shared/collision
  const perContact = new Map<string, number>();
  const keyContacts = new Map<string, Set<string>>();
  const existing = await tx.c360ContactPoint.findMany({
    where: { tenantId, state: 'ACTIVE' },
    select: { contactId: true, kind: true, normalizedValue: true, normalizationVersion: true },
  });
  const add = (contactId: string, kind: string, key: string) => {
    const slot = `${contactId}\0${kind}`;
    perContact.set(slot, (perContact.get(slot) ?? 0) + 1);
    const contacts = keyContacts.get(key) ?? new Set<string>();
    contacts.add(contactId);
    keyContacts.set(key, contacts);
  };
  const contactKeys = new Set<string>();
  for (const point of existing) {
    add(
      point.contactId,
      point.kind,
      `${point.kind}\0${point.normalizationVersion}\0${point.normalizedValue}`,
    );
    contactKeys.add(
      `${point.contactId}\0${point.kind}\0${point.normalizationVersion}\0${point.normalizedValue}`,
    );
  }
  for (const row of rows) {
    identities[row.type] += 1;
    if (row.imported) {
      imported += 1;
      continue;
    }
    const result = dedupe(classifyC360LegacyIdentity(row.type, row.value), row, contactKeys);
    if (result.state === 'ACTIVE') {
      active += 1;
      add(
        row.contact_id,
        row.type,
        `${row.type}\0${result.normalizationVersion}\0${result.normalizedValue}`,
      );
    } else {
      review += 1;
      reviewReasons[result.reason] = (reviewReasons[result.reason] ?? 0) + 1;
    }
  }
  const shared = [...keyContacts.entries()].filter(([, contacts]) => contacts.size > 1);
  const [heads] = await tx.$queryRaw<{ missing: bigint; merged: bigint; ambiguous: bigint }[]>`
    SELECT count(*) FILTER (WHERE ih.contact_id IS NULL) AS missing,
           count(*) FILTER (WHERE ih.state::text = 'MERGED') AS merged,
           count(*) FILTER (WHERE ih.state::text = 'AMBIGUOUS') AS ambiguous
    FROM contacts c
    LEFT JOIN c360_identity_heads ih ON ih.tenant_id = c.tenant_id AND ih.contact_id = c.id
    WHERE c.tenant_id = ${tenantId}::uuid`;
  return {
    tenantId,
    identities,
    imported,
    pending: { active, reviewRequired: review },
    reviewReasons,
    contactsOverQuota: new Set(
      [...perContact.entries()]
        .filter(([, count]) => count > C360_CONTACT_POINT_QUOTA)
        .map(([slot]) => slot.split('\0')[0]),
    ).size,
    sharedKeys: {
      keys: shared.length,
      contacts: new Set(shared.flatMap(([, contacts]) => [...contacts])).size,
      digest: keyDigest(
        tenantId,
        shared.map(([key]) => key),
      ),
    },
    identityHeads: {
      missing: Number(heads?.missing ?? 0),
      merged: Number(heads?.merged ?? 0),
      ambiguous: Number(heads?.ambiguous ?? 0),
    },
  };
}

export interface C360LegacyImportBatch {
  imported: number;
  active: number;
  reviewRequired: number;
  contacts: string[];
  remaining: number;
}

/**
 * Import หนึ่ง batch ใต้ command ของ operator (FK created_command ชี้ไปที่ command นี้)
 * ล็อก contact ที่ได้รับผลเรียง ID แบบ NOWAIT แล้วเพิ่ม profile_revision ครั้งเดียวต่อ contact
 * เพื่อให้คำสั่งแก้ที่ถือ revision เก่าได้ REVISION_CONFLICT แทนการทับข้อมูลที่ import มา
 */
export async function importC360LegacyContactPointsBatch(
  tx: Prisma.TransactionClient,
  context: { tenantId: string; actorIdentityKey: string; commandId: string },
  batchSize: number,
): Promise<C360LegacyImportBatch> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > C360_LEGACY_IMPORT_BATCH_MAX)
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  const rows = await legacyIdentities(tx, context.tenantId, {
    pendingOnly: true,
    limit: batchSize,
  });
  const contacts = [...new Set(rows.map((row) => row.contact_id))].sort();
  // E1 G: identity fence ของ contact ทั้งชุดก่อน profile rows (canonical transition ถือ exclusive)
  await tryC360IdentityFences(tx, context.tenantId, contacts);
  for (const contactId of contacts) {
    try {
      await tx.$queryRaw`
        SELECT id FROM contacts WHERE tenant_id = ${context.tenantId}::uuid AND id = ${contactId}::uuid
        FOR NO KEY UPDATE NOWAIT`;
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      if (/55P03|lock_not_available|could not obtain lock/.test(text))
        throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
      throw error;
    }
  }
  let active = 0;
  let reviewRequired = 0;
  let imported = 0;
  // revision เพิ่มเฉพาะ contact ที่มีแถวถูก insert จริง (แถวที่ ON CONFLICT ไม่ใช่ mutation)
  const touched = new Set<string>();
  const contactKeys = new Set(
    contacts.length === 0
      ? []
      : (
          await tx.c360ContactPoint.findMany({
            where: { tenantId: context.tenantId, contactId: { in: contacts }, state: 'ACTIVE' },
            select: {
              contactId: true,
              kind: true,
              normalizedValue: true,
              normalizationVersion: true,
            },
          })
        ).map(
          (point) =>
            `${point.contactId}\0${point.kind}\0${point.normalizationVersion}\0${point.normalizedValue}`,
        ),
  );
  for (const row of rows) {
    const result = dedupe(classifyC360LegacyIdentity(row.type, row.value), row, contactKeys);
    // ON CONFLICT: แถวที่ import ไปแล้วโดย run ก่อนหน้า (หรือ batch อื่นที่ commit ก่อน) ไม่ถูกสร้างซ้ำ
    const inserted = await tx.$executeRaw`
      INSERT INTO c360_contact_points
        (id, tenant_id, contact_id, kind, raw_value, normalized_value, normalization_version, state,
         source_kind, source_identity_id, created_actor_identity_key, created_command_id)
      VALUES (${randomUUID()}::uuid, ${context.tenantId}::uuid, ${row.contact_id}::uuid, ${row.type},
        ${row.value},
        ${result.state === 'ACTIVE' ? result.normalizedValue : null},
        ${result.state === 'ACTIVE' ? result.normalizationVersion : null},
        ${result.state}, 'LEGACY_IDENTITY', ${row.id}::uuid,
        ${context.actorIdentityKey}, ${context.commandId}::uuid)
      ON CONFLICT (tenant_id, source_identity_id) WHERE source_kind = 'LEGACY_IDENTITY' DO NOTHING`;
    if (inserted !== 1) continue;
    imported += 1;
    touched.add(row.contact_id);
    if (result.state === 'ACTIVE') active += 1;
    else reviewRequired += 1;
  }
  if (touched.size > 0)
    await tx.$executeRaw`
      UPDATE contacts SET profile_revision = profile_revision + 1
      WHERE tenant_id = ${context.tenantId}::uuid AND id IN (${Prisma.join(
        [...touched].map((id) => Prisma.sql`${id}::uuid`),
      )})`;
  const [left] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM contact_identities ci
    WHERE ci.tenant_id = ${context.tenantId}::uuid AND ci.type::text IN ('PHONE', 'EMAIL')
      AND NOT EXISTS (SELECT 1 FROM c360_contact_points p
                      WHERE p.tenant_id = ci.tenant_id AND p.source_identity_id = ci.id)`;
  return {
    imported,
    active,
    reviewRequired,
    contacts: [...touched].sort(),
    remaining: Number(left?.n ?? 0),
  };
}
