import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  CONTACT_POINT_BRIDGE_PROBE,
  CONTACT_POINT_LEDGER_SQL,
  decideContactPointRollback,
} from './cus360-contact-point-rollback-guard.mjs';

test('ตัดสินแบบ fail closed: มี contact point แล้วต้อง rollback ไป image ที่มี bridge เท่านั้น', () => {
  assert.deepEqual(decideContactPointRollback({ points: 'NONE' }), { status: 'PASS' });
  assert.deepEqual(decideContactPointRollback({ points: 'NONE', bridge: 'UNBRIDGED' }), {
    status: 'PASS',
  });
  assert.deepEqual(decideContactPointRollback({ points: 'PRESENT', bridge: 'BRIDGED' }), {
    status: 'PASS',
  });
  assert.deepEqual(decideContactPointRollback({ points: 'PRESENT', bridge: 'UNBRIDGED' }), {
    status: 'FAIL',
    reason: 'ROLLBACK_CONTACT_POINT_BRIDGE_REQUIRED',
  });
  for (const bridge of [undefined, '', 'unexpected output'])
    assert.deepEqual(decideContactPointRollback({ points: 'PRESENT', bridge }), {
      status: 'FAIL',
      reason: 'ROLLBACK_CONTACT_POINT_PROBE_FAILED',
    });
  assert.deepEqual(decideContactPointRollback({ points: 'ROLE_INSUFFICIENT', bridge: 'BRIDGED' }), {
    status: 'FAIL',
    reason: 'ROLLBACK_CONTACT_POINT_ROLE_INSUFFICIENT',
  });
  for (const points of ['', 'ERROR: relation', undefined])
    assert.equal(decideContactPointRollback({ points }).status, 'FAIL');
});

test('ledger SQL อ่านอย่างเดียวและไม่มีค่าจาก input', () => {
  assert.match(CONTACT_POINT_LEDGER_SQL, /^BEGIN READ ONLY;/);
  assert.doesNotMatch(CONTACT_POINT_LEDGER_SQL, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
});

function probe(modulePath, ...consumers) {
  return spawnSync(process.execPath, ['-e', CONTACT_POINT_BRIDGE_PROBE, modulePath, ...consumers], {
    encoding: 'utf8',
  });
}

test('bridge probe: image ที่ไม่มี bridge = UNBRIDGED; โหลดไม่ได้ = ไม่มีผลลัพธ์ที่ถือว่าผ่าน', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c360-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = join(root, 'old-db');
  mkdirSync(old);
  // @d-contact/db ของ release ก่อน S4: มี tenant helpers แต่ไม่มี bridge
  writeFileSync(
    join(old, 'index.js'),
    'exports.withTenantDatabaseTransaction = () => undefined; exports.lockTeamReferences = () => undefined;\n',
  );
  const unbridged = probe(old);
  assert.equal(unbridged.status, 0);
  assert.equal(unbridged.stdout, 'UNBRIDGED');
  // db ใหม่แต่ consumer ใน image ไม่เรียก bridge = UNBRIDGED; consumer ที่ไม่มีไฟล์ถูกข้าม
  const fresh = join(root, 'new-db');
  mkdirSync(fresh);
  writeFileSync(
    join(fresh, 'index.js'),
    'exports.legacyIdentityEligibility = () => 0; exports.eligibleLegacyIdentityByKey = () => 0;\n',
  );
  const consumer = join(root, 'click-to-call.js');
  writeFileSync(consumer, 'regexp_replace(value, digits)\n');
  assert.equal(probe(fresh, `${consumer}=eligibleLegacyIdentityByKey`).stdout, 'UNBRIDGED');
  writeFileSync(consumer, 'await eligibleLegacyIdentityByKey(tx)\n');
  assert.equal(
    probe(fresh, `${consumer}=eligibleLegacyIdentityByKey`, `${join(root, 'absent.js')}=x`).stdout,
    'BRIDGED',
  );
  // ไม่เจอ consumer สักไฟล์ (path ใน image เปลี่ยน) = UNBRIDGED ไม่ใช่ผ่านจาก export ของ db อย่างเดียว
  assert.equal(
    probe(fresh, `${join(root, 'renamed.js')}=eligibleLegacyIdentityByKey`).stdout,
    'UNBRIDGED',
  );
  const missing = probe(join(root, 'absent'));
  assert.notEqual(missing.status, 0);
  assert.equal(
    decideContactPointRollback({ points: 'PRESENT', bridge: missing.stdout }).status,
    'FAIL',
  );
});

test(
  'bridge probe กับ @d-contact/db ของ release นี้ = BRIDGED',
  {
    skip:
      !process.env.CUS360_GUARD_DB_BUILT &&
      'ต้อง build packages/db ก่อน (ตั้ง CUS360_GUARD_DB_BUILT=1)',
  },
  () => {
    const result = probe(
      resolve('packages/db'),
      `${resolve('packages/journey-composition/dist/index.js')}=legacyIdentityEligibility`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'BRIDGED');
  },
);

test(
  'ledger SQL บน PostgreSQL จริง: NONE ก่อนมีแถว และ PRESENT หลังมี contact point',
  {
    skip:
      !process.env.CUS360_GUARD_PSQL_CONTAINER &&
      'ตั้ง CUS360_GUARD_PSQL_CONTAINER และ CUS360_GUARD_DATABASES=<db ว่าง>,<db ที่มี point>',
  },
  () => {
    const [empty, populated] = (process.env.CUS360_GUARD_DATABASES ?? '').split(',');
    const run = (database, user = 'dcontact') => {
      const result = spawnSync(
        'docker',
        [
          'exec',
          '-i',
          process.env.CUS360_GUARD_PSQL_CONTAINER,
          'psql',
          '-U',
          user,
          '-d',
          database,
          '-X',
          '-qAt',
          '-v',
          'ON_ERROR_STOP=1',
          '-f',
          '-',
        ],
        { input: CONTACT_POINT_LEDGER_SQL, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.equal(run(empty), 'NONE');
    assert.equal(run(populated), 'PRESENT');
    // role ที่ติด tenant RLS เห็น 0 แถว: ต้องไม่ตอบ NONE (fail open)
    assert.equal(run(populated, 'dcontact_app'), 'ROLE_INSUFFICIENT');
  },
);
