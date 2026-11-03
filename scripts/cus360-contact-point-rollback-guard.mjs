/**
 * Cus360 C3 (#793) S5: rollback guard ของ contact point bridge ตาม E1 E
 *
 * เมื่อ DB มี contact point แล้ว image ปลายทางของ rollback ต้องมี bridge (S4) ไม่เช่นนั้น resolver แบบ
 * raw ของ ContactIdentity จะกลับมา resolve ค่า shared/retired/review-required ข้าม guard
 * ("ห้ามคืน raw unsafe resolver") rollback ไม่แตะ DB: ใช้ SQL อ่านอย่างเดียวและ probe image แบบไม่มี network
 *
 * สคริปต์นี้แยกจาก `infra/uat/bin/uat-deploy.sh` ไว้ก่อน เพื่อไม่ชนกับงาน UAT ที่ค้างอยู่ (#812);
 * ขั้นเชื่อมคือเรียก probe สองตัวใน `rollback_preflight` แล้วส่งผลให้ `decideContactPointRollback`
 */

/** SQL อ่านอย่างเดียว: NONE เมื่อยังไม่มีตารางหรือยังไม่มีแถว, PRESENT เมื่อมี contact point แล้ว */
export const CONTACT_POINT_LEDGER_SQL = `BEGIN READ ONLY;
SELECT CASE
  WHEN to_regclass('public.c360_contact_points') IS NULL THEN 'NONE'
  -- ตารางอาจยังไม่มีใน release ก่อน C1: query แบบ dynamic จึงไม่ถูก parse เมื่อไม่มีตาราง
  WHEN xpath_exists('/table/row', query_to_xml(
    'SELECT 1 FROM public.c360_contact_points LIMIT 1', false, false, '')) THEN 'PRESENT'
  ELSE 'NONE' END;
COMMIT;`;

/**
 * รันใน image ปลายทางด้วย `node -e` (ไม่มี network, read-only): BRIDGED เมื่อ @d-contact/db ของ image
 * export bridge ของ S4 ครบ ไม่เช่นนั้น UNBRIDGED; path ของ package ส่งเป็น argv[1]
 */
export const CONTACT_POINT_BRIDGE_PROBE = `
const db = require(process.argv[1] || "/app/node_modules/@d-contact/db");
const bridged = ["legacyIdentityEligibility", "eligibleLegacyIdentityByKey"]
  .every((name) => typeof db[name] === "function");
process.stdout.write(bridged ? "BRIDGED" : "UNBRIDGED");
`;

/**
 * ตัดสิน rollback แบบ fail closed: ค่าที่ไม่รู้จักจาก probe ถือว่าไม่ผ่าน
 * @param {{ points: string; bridge?: string }} probe
 * @returns {{ status: 'PASS' } | { status: 'FAIL'; reason: string }}
 */
export function decideContactPointRollback(probe) {
  const points = String(probe.points ?? '').trim();
  if (points === 'NONE') return { status: 'PASS' };
  if (points !== 'PRESENT')
    return { status: 'FAIL', reason: 'ROLLBACK_CONTACT_POINT_LEDGER_INVALID' };
  const bridge = String(probe.bridge ?? '').trim();
  if (bridge === 'BRIDGED') return { status: 'PASS' };
  if (bridge === 'UNBRIDGED')
    return { status: 'FAIL', reason: 'ROLLBACK_CONTACT_POINT_BRIDGE_REQUIRED' };
  return { status: 'FAIL', reason: 'ROLLBACK_CONTACT_POINT_PROBE_FAILED' };
}
