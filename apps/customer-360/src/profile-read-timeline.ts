import { Prisma } from '@d-contact/db';
import {
  C360_SEARCH_DEFAULT_LIMIT,
  C360_SEARCH_MAX_LIMIT,
  C360ReadError,
  c360FilterDigest,
  c360ScopeDigest,
  requireReadableC360Contact,
  runC360OwnerSection,
  type C360CursorCodec,
  type C360SectionResult,
} from './profile-read.js';
import type { C360VerifiedActor } from './profile-authorization.js';

/**
 * Cus360 C2 (#792) S2: Voice timeline ของโปรไฟล์ (R1 J, E1 I)
 *
 * - ตรวจสิทธิ์ลูกค้าด้วย predicate เดียวกับ detail ก่อนเสมอ (DENY=404, DEFER=503) แล้วจึงอ่าน owner (interactions)
 * - คืนเฉพาะ วัน-เวลา/ช่องทาง/สถานะ ไม่มี note/audio/transcript/Cases/ช่องทางอื่น และไม่มี interaction ID
 * - สิทธิ์ดูประวัติของ interaction: ปัจจุบัน owner พิสูจน์ได้เพียง "สายที่ผู้ใช้คนนี้เป็นเจ้าของงานเอง"
 *   (`agent_id`). interactions ไม่มี historical team attribution จึงห้ามเดา queue.team_id ปัจจุบันเป็นสิทธิ์
 *   ย้อนหลัง; รายการที่พิสูจน์ไม่ได้ไม่ถูกคืน และ `coverage = LIMITED` (ไม่ใช่ empty และไม่ใช่ allowed)
 * - owner ล้ม = section UNAVAILABLE ไม่ใช่ list ว่าง
 */

export interface C360TimelineItem {
  startedAt: string;
  endedAt: string | null;
  channel: string;
  state: string;
}

export interface C360TimelinePage {
  items: C360TimelineItem[];
  nextCursor: string | null;
  /** LIMITED = มีสายของลูกค้านี้ที่พิสูจน์สิทธิ์ย้อนหลังให้ผู้ใช้คนนี้ไม่ได้ จึงไม่แสดง */
  coverage: 'COMPLETE' | 'LIMITED';
}

export interface C360TimelineInput {
  limit?: number;
  cursor?: string;
}

const KEY_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

export async function readC360Timeline(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  contactId: string,
  input: C360TimelineInput,
  codec: C360CursorCodec,
): Promise<C360SectionResult<C360TimelinePage>> {
  await requireReadableC360Contact(tx, actor, contactId);
  const limit = input.limit ?? C360_SEARCH_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > C360_SEARCH_MAX_LIMIT)
    throw new C360ReadError(400, 'VALIDATION_FAILED', false, [
      { field: 'limit', code: 'LIMIT_INVALID' },
    ]);
  const cursorScope = {
    kind: 'timeline',
    tenantId: actor.tenantId,
    userId: actor.userId,
    filter: c360FilterDigest([contactId]),
    scope: c360ScopeDigest(actor),
  };
  const position = input.cursor ? codec.open(input.cursor, cursorScope) : null;
  let after = Prisma.sql`true`;
  if (position) {
    const [startedKey, id] = position;
    if (
      position.length !== 2 ||
      !startedKey ||
      !id ||
      !KEY_FORMAT.test(startedKey) ||
      !/^[0-9a-f-]{36}$/i.test(id)
    )
      throw new C360ReadError(400, 'CURSOR_INVALID');
    after = Prisma.sql`(i.queued_at, i.id) < (${startedKey}::timestamp, ${id}::uuid)`;
  }
  return runC360OwnerSection(tx, async () => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        channel: string;
        state: string;
        started_at: string;
        ended_at: string | null;
        started_key: string;
      }[]
    >(Prisma.sql`
      SELECT i.id, i.channel::text AS channel, i.state::text AS state,
             to_char(i.queued_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
             to_char(i.ended_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended_at,
             to_char(i.queued_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS started_key
      FROM interactions i
      WHERE i.tenant_id = ${actor.tenantId}::uuid AND i.contact_id = ${contactId}::uuid
        AND i.channel = 'VOICE' AND i.agent_id = ${actor.userId}::uuid AND ${after}
      ORDER BY i.queued_at DESC, i.id DESC
      LIMIT ${limit + 1}`);
    const [withheld] = await tx.$queryRaw<{ withheld: boolean }[]>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM interactions i
        WHERE i.tenant_id = ${actor.tenantId}::uuid AND i.contact_id = ${contactId}::uuid
          AND i.channel = 'VOICE' AND i.agent_id IS DISTINCT FROM ${actor.userId}::uuid
      ) AS withheld`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        startedAt: row.started_at,
        endedAt: row.ended_at,
        channel: row.channel,
        state: row.state,
      })),
      nextCursor:
        rows.length > limit && last
          ? codec.seal({ ...cursorScope, position: [last.started_key, last.id] })
          : null,
      coverage: withheld?.withheld ? 'LIMITED' : 'COMPLETE',
    } satisfies C360TimelinePage;
  });
}
