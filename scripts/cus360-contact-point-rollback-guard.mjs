/**
 * Cus360 C3 (#793) S5: rollback guard for the contact point bridge per E1 E
 *
 * When the DB already has a contact point, the rollback target image must have the bridge (S4); otherwise the raw
 * ContactIdentity resolver would come back and resolve shared/retired/review-required values past the guard
 * ("never return the raw unsafe resolver"). The rollback does not touch the DB: it uses read-only SQL and a probe of the image with no network
 *
 * This script is kept apart from `infra/uat/bin/uat-deploy.sh` for now, to avoid colliding with pending UAT work (#812);
 * the wiring step is to call the two probes in `rollback_preflight` and pass the results to `decideContactPointRollback`
 */

/**
 * Read-only SQL: NONE when the table or any row does not exist yet, PRESENT when a contact point exists
 * The table uses tenant RLS: a role that is not superuser/BYPASSRLS/owner (the table does not FORCE RLS) always sees 0 rows,
 * so it answers ROLE_INSUFFICIENT instead of NONE so the guard does not pass fail-open
 */
export const CONTACT_POINT_LEDGER_SQL = `BEGIN READ ONLY;
SELECT CASE
  WHEN to_regclass('public.c360_contact_points') IS NULL THEN 'NONE'
  WHEN NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user
                   AND (r.rolsuper OR r.rolbypassrls))
   AND NOT EXISTS (SELECT 1 FROM pg_class c
                   WHERE c.oid = to_regclass('public.c360_contact_points')
                     AND NOT c.relforcerowsecurity
                     AND pg_has_role(current_user, c.relowner, 'USAGE')) THEN 'ROLE_INSUFFICIENT'
  -- the table may not exist in a release before C1: the dynamic query is therefore not parsed when the table is absent
  WHEN xpath_exists('/table/row', query_to_xml(
    'SELECT 1 FROM public.c360_contact_points LIMIT 1', false, false, '')) THEN 'PRESENT'
  ELSE 'NONE' END;
COMMIT;`;

/**
 * Runs in the target image with `node -e` (no network, read-only): BRIDGED when @d-contact/db exports the full S4 bridge
 * and the consumers present in the image really call the bridge; otherwise UNBRIDGED
 * argv: [path of @d-contact/db, ...`<consumer file>=<function name that must be called>`]
 * a consumer with no file in the image (e.g. the journey worker is not in the API image) is skipped, but at least one file must be found
 * the role that runs this must have inherited owner privileges (USAGE) so it really bypasses RLS
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
let found = 0;
for (const check of checks) {
  const [file, marker] = check.split("=");
  if (!fs.existsSync(file)) continue;
  found += 1;
  if (!fs.readFileSync(file, "utf8").includes(marker)) bridged = false;
}
// the path in the image changed so no consumer is found = cannot verify, not treated as having a bridge
if (found === 0) bridged = false;
process.stdout.write(bridged ? "BRIDGED" : "UNBRIDGED");
`;

/**
 * Decide the rollback fail-closed: an unknown value from a probe counts as failing
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
