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

test('decides fail-closed: when a contact point exists, rollback is allowed only to an image that has the bridge', () => {
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

test('ledger SQL is read-only and has no value from input', () => {
  assert.match(CONTACT_POINT_LEDGER_SQL, /^BEGIN READ ONLY;/);
  assert.doesNotMatch(CONTACT_POINT_LEDGER_SQL, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
});

function probe(modulePath, ...consumers) {
  return spawnSync(process.execPath, ['-e', CONTACT_POINT_BRIDGE_PROBE, modulePath, ...consumers], {
    encoding: 'utf8',
  });
}

test('bridge probe: an image without the bridge = UNBRIDGED; a load failure = no result that counts as passing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c360-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = join(root, 'old-db');
  mkdirSync(old);
  // @d-contact/db of the release before S4: has tenant helpers but no bridge
  writeFileSync(
    join(old, 'index.js'),
    'exports.withTenantDatabaseTransaction = () => undefined; exports.lockTeamReferences = () => undefined;\n',
  );
  const unbridged = probe(old);
  assert.equal(unbridged.status, 0);
  assert.equal(unbridged.stdout, 'UNBRIDGED');
  // new db but the consumer in the image does not call the bridge = UNBRIDGED; a consumer with no file is skipped
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
  // no consumer found at all (path in the image changed) = UNBRIDGED, not a pass from the db export alone
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
  'bridge probe against the @d-contact/db of this release = BRIDGED',
  {
    skip:
      !process.env.CUS360_GUARD_DB_BUILT && 'build packages/db first (set CUS360_GUARD_DB_BUILT=1)',
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
  'ledger SQL on real PostgreSQL: NONE before any row and PRESENT after a contact point',
  {
    skip:
      !process.env.CUS360_GUARD_PSQL_CONTAINER &&
      'set CUS360_GUARD_PSQL_CONTAINER and CUS360_GUARD_DATABASES=<empty db>,<db with a point>',
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
    // a role under tenant RLS sees 0 rows: it must not answer NONE (fail open)
    assert.equal(run(populated, 'dcontact_app'), 'ROLE_INSUFFICIENT');
  },
);
