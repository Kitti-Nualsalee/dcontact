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

/**
 * SQL อ่านอย่างเดียว: NONE เมื่อยังไม่มีตารางหรือยังไม่มีแถว, PRESENT เมื่อมี contact point แล้ว
 * ตารางใช้ tenant RLS: role ที่ไม่ใช่ superuser/BYPASSRLS/owner (ตารางไม่ FORCE RLS) จะเห็น 0 แถวเสมอ
 * จึงตอบ ROLE_INSUFFICIENT แทน NONE เพื่อไม่ให้ guard ผ่านแบบ fail open
 */
export const CONTACT_POINT_LEDGER_SQL = `BEGIN READ ONLY;
SELECT CASE
  WHEN to_regclass('public.c360_contact_points') IS NULL THEN 'NONE'
  WHEN NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user
                   AND (r.rolsuper OR r.rolbypassrls))
   AND NOT EXISTS (SELECT 1 FROM pg_class c
                   WHERE c.oid = to_regclass('public.c360_contact_points')
                     AND NOT c.relforcerowsecurity
                     AND pg_has_role(current_user, c.relowner, 'MEMBER')) THEN 'ROLE_INSUFFICIENT'
  -- ตารางอาจยังไม่มีใน release ก่อน C1: query แบบ dynamic จึงไม่ถูก parse เมื่อไม่มีตาราง
  WHEN xpath_exists('/table/row', query_to_xml(
    'SELECT 1 FROM public.c360_contact_points LIMIT 1', false, false, '')) THEN 'PRESENT'
  ELSE 'NONE' END;
COMMIT;`;

/**
 * รันใน image ปลายทางด้วย `node -e` (ไม่มี network, read-only): BRIDGED เมื่อ @d-contact/db export bridge
 * ของ S4 ครบ และ consumer ที่มีอยู่ใน image เรียก bridge จริง ไม่เช่นนั้น UNBRIDGED
 * argv: [path ของ @d-contact/db, ...`<ไฟล์ consumer>=<ชื่อฟังก์ชันที่ต้องถูกเรียก>`]
 * consumer ที่ไม่มีไฟล์ใน image (เช่น journey worker ไม่อยู่ใน API image) ถูกข้าม
 */
export const CONTACT_POINT_BRIDGE_PROBE = `
const fs = require("fs");
const [dbPath = "/app/node_modules/@d-contact/db", ...consumers] = process.argv.slice(1);
const db = require(dbPath);
let bridged = ["legacyIdentityEligibility", "eligibleLegacyIdentityByKey"]
  .every((name) => typeof db[name] === "function");
const checks = consumers.length > 0 ? consumers : [
  "/app/dist/click-to-call.js=eligibleLegacyIdentityByKey",
  "/app/node_modules/@d-contact/journey-composition/dist/index.js=legacyIdentityEligibility",
];
for (const check of checks) {
  const [file, marker] = check.split("=");
  if (!fs.existsSync(file)) continue;
  if (!fs.readFileSync(file, "utf8").includes(marker)) bridged = false;
}
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
  if (points === 'ROLE_INSUFFICIENT')
    return { status: 'FAIL', reason: 'ROLLBACK_CONTACT_POINT_ROLE_INSUFFICIENT' };
  if (points !== 'PRESENT')
    return { status: 'FAIL', reason: 'ROLLBACK_CONTACT_POINT_LEDGER_INVALID' };
  const bridge = String(probe.bridge ?? '').trim();
  if (bridge === 'BRIDGED') return { status: 'PASS' };
  if (bridge === 'UNBRIDGED')
    return { status: 'FAIL', reason: 'ROLLBACK_CONTACT_POINT_BRIDGE_REQUIRED' };
  return { status: 'FAIL', reason: 'ROLLBACK_CONTACT_POINT_PROBE_FAILED' };
}
