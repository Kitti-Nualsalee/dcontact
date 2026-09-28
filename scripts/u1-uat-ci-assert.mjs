import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * U1.10 (#507): ตรวจผลของแต่ละขั้นใน workflow `uat-image-smoke` (UAT stack จริงใน Docker บน runner)
 *
 *   node scripts/u1-uat-ci-assert.mjs smoke <smoke.json>
 *   node scripts/u1-uat-ci-assert.mjs provision <check|apply|reapply> <output.jsonl>
 *   node scripts/u1-uat-ci-assert.mjs accounts <output.jsonl>
 *   node scripts/u1-uat-ci-assert.mjs step <SKIPPED|PASS> <output.jsonl>   (backup/deploy ของ uat-deploy.sh)
 *
 * อ่านเฉพาะ JSON ที่ script ของ U1.6/U1.8 พิมพ์ (id/สถานะ/digest — ไม่มี secret) ไม่ผ่าน = exit 1
 */

/** ต้อง PASS ทุกตัว; UAT-L06 ต้องใช้ token ของบัญชีที่ผูก TOTP แล้ว จึง SKIPPED ได้ใน CI */
export const REQUIRED_LIVE_CHECKS = Object.freeze([
  'UAT-L01',
  'UAT-L02',
  'UAT-L03',
  'UAT-L04',
  'UAT-L05',
  'UAT-L07',
]);
export const OPTIONAL_LIVE_CHECKS = Object.freeze(['UAT-L06']);
export const PROVISION_PARTS = Object.freeze([
  'tenant',
  'ownerTeam',
  'rollout',
  'user:maker',
  'user:reviewer',
  'subject:maker',
  'subject:reviewer',
  'grants:maker',
  'grants:reviewer',
  'fixturePack',
]);
const PROVISION_EXPECTED = Object.freeze({
  check: { mode: 'check', status: 'WOULD_CREATE' },
  apply: { mode: 'apply', status: 'CREATED' },
  reapply: { mode: 'apply', status: 'UNCHANGED' },
});

/** บรรทัดที่เป็น JSON object เท่านั้น (compose พิมพ์สถานะ container ปนมาได้) */
export function jsonLines(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

function byPrefix(checks, prefix) {
  return checks.find((entry) => entry.id === prefix || entry.id.startsWith(`${prefix} `));
}

export function assertSmoke(report) {
  const failures = [];
  if (report?.type !== 'u1.uat.readiness' || report.mode !== 'live') {
    return ['NOT_LIVE_READINESS_REPORT'];
  }
  const checks = Array.isArray(report.checks) ? report.checks : [];
  for (const id of REQUIRED_LIVE_CHECKS) {
    const entry = byPrefix(checks, id);
    if (entry?.status !== 'PASS') failures.push(`${id}:${entry?.status ?? 'MISSING'}`);
  }
  for (const id of OPTIONAL_LIVE_CHECKS) {
    const entry = byPrefix(checks, id);
    if (!['PASS', 'SKIPPED'].includes(entry?.status)) {
      failures.push(`${id}:${entry?.status ?? 'MISSING'}`);
    }
  }
  if (report.status !== 'PASS') failures.push(`status:${report.status}`);
  return failures;
}

export function assertProvision(lines, phase) {
  const expected = PROVISION_EXPECTED[phase];
  if (!expected) throw new Error(`unknown provision phase: ${phase}`);
  const failures = [];
  const records = lines.filter((line) => line.type === 'u1.uat.provision');
  const last = records[records.length - 1];
  if (last?.status !== 'PASS' || last.part !== undefined || last.mode !== expected.mode) {
    failures.push(`final:${last?.status ?? 'MISSING'}${last?.code ? `:${last.code}` : ''}`);
  }
  const parts = records.filter((line) => line.part !== undefined);
  const seen = parts.map((line) => line.part);
  if (JSON.stringify(seen) !== JSON.stringify(PROVISION_PARTS)) {
    failures.push(`parts:${seen.join(',') || 'NONE'}`);
  }
  for (const line of parts) {
    if (line.mode !== expected.mode || line.status !== expected.status) {
      failures.push(`${line.part}:${line.status}`);
    }
  }
  const pack = parts.find((line) => line.part === 'fixturePack');
  if (pack && !/^[0-9a-f]{64}$/.test(pack.digest ?? '')) failures.push('fixturePack:digest');
  // ก่อน apply ครั้งแรก preflight ของ pack ถูกข้าม (ข้อ 1–4 ยังไม่มี) — หลังจากนั้นต้องไม่ถูกข้าม
  if (phase === 'check' && pack && pack.preflight !== 'SKIPPED') failures.push('preflight');
  return failures;
}

export function assertAccounts(lines) {
  const summary = lines.filter((line) => line.type === 'u1.uat.keycloak').pop();
  if (!summary || summary.mode !== 'users' || !Array.isArray(summary.accounts)) {
    return ['NO_USERS_SUMMARY'];
  }
  const failures = [];
  const roles = summary.accounts.map((account) => account.role).sort();
  if (JSON.stringify(roles) !== JSON.stringify(['maker', 'reviewer'])) {
    failures.push(`roles:${roles.join(',')}`);
  }
  for (const account of summary.accounts) {
    if (!['CREATED', 'UPDATED'].includes(account.status)) {
      failures.push(`${account.role}:${account.status}`);
    }
    if (!account.keycloakId) failures.push(`${account.role}:keycloakId`);
  }
  if (new Set(summary.accounts.map((account) => account.dcUserId)).size !== 2) {
    failures.push('dcUserId:not-distinct');
  }
  return failures;
}

export function assertStep(lines, status) {
  const last = lines.filter((line) => line.type === 'u1.uat.deploy').pop();
  return last?.status === status ? [] : [`${last?.step ?? 'step'}:${last?.status ?? 'MISSING'}`];
}

export function main(
  argv = process.argv.slice(2),
  readText = (file) => readFileSync(file, 'utf8'),
) {
  const [kind, ...rest] = argv;
  switch (kind) {
    case 'smoke': {
      const lines = jsonLines(readText(rest[0]));
      return assertSmoke(lines[lines.length - 1]);
    }
    case 'provision':
      return assertProvision(jsonLines(readText(rest[1])), rest[0]);
    case 'accounts':
      return assertAccounts(jsonLines(readText(rest[0])));
    case 'step':
      return assertStep(jsonLines(readText(rest[1])), rest[0]);
    default:
      throw new Error('usage: u1-uat-ci-assert.mjs <smoke|provision|accounts|step> ...');
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const failures = main();
  const kind = process.argv[2];
  process.stdout.write(
    `${JSON.stringify({ type: 'u1.uat.ci-assert', kind, status: failures.length ? 'FAIL' : 'PASS', failures })}\n`,
  );
  if (failures.length) process.exitCode = 1;
}
