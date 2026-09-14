/**
 * CG4.10 (#193): คำสั่ง operator สำหรับ backfill CG3 → CG4 ต่อ tenant
 *
 *   pnpm --filter @d-contact/contact-governance cg4:backfill --tenant=<uuid> --operator=<opaque-ref>
 *
 * พิมพ์ report เป็น JSON ที่มีเฉพาะ opaque id, version, scope key และ reason code — ไม่มี PII
 * รันซ้ำได้: source ที่ backfill แล้วถูกนับใน `alreadyRecorded` และไม่ถูกแตะซ้ำ
 */
import { PrismaClient } from '@d-contact/db';
import { Cg4LegacyBackfill } from './cg4-legacy-backfill.js';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const tenantId = argument('tenant');
const operatorRef = argument('operator');
if (!tenantId || !operatorRef) {
  process.stderr.write('usage: cg4:backfill --tenant=<uuid> --operator=<opaque-ref>\n');
  process.exit(2);
}

// ใช้ application role (RLS) เหมือน owner service อื่น ไม่ใช้ owner connection
const url = process.env.APPLICATION_DATABASE_URL ?? process.env.DATABASE_URL;
const database = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
try {
  const report = await new Cg4LegacyBackfill(database).run({ tenantId, operatorRef });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await database.$disconnect();
}
