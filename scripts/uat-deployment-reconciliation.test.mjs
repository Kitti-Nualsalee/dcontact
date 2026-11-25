import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildDeploymentRecord, main, renderSummary } from './u1-uat-readiness.mjs';

test('#868 the inspect journal checks the pending state without certifying the runtime', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-record-recovery-inspect.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('#868 the recovery runtime checks the image without authorizing recovery itself', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-record-recovery-runtime.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('#868 the retire journal keeps a fully committed transaction without changing the pointer', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-record-journal-retire.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('#868 forward commit recovers the pointer order while keeping the journal as a gate', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-record-commit.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('#868 forward recovery checks the approved evidence and the live ledger before keeping the journal', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-record-forward-recovery.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('#868 the legacy inventory separates the marker from provenance', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-legacy-inventory.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('#868 media observation checks the mount and digest without certifying rollback', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-media-source-inspect.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('#868 the media Git comparison checks the tree without certifying the deployment', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-media-git-compare.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

function markCommitted(path) {
  writeFileSync(
    `${path}.committed`,
    `${createHash('sha256').update(readFileSync(path)).digest('hex')}\n`,
    { mode: 0o600 },
  );
}

test('#714 the Python record-only tests pass without calling a real VM/Docker', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b714-deployment-reconciliation.test.py')],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 checks the record and runtime without calling a real VM/Docker', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/release-record-inspect.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 binds the migration ledger to the runtime and the protected services', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/release-evidence-observe.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 rejects a candidate whose evidence is stale or whose hash does not match', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/release-candidate-validate.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 switches the API in a sandbox and recovers from Docker state when the command is interrupted', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-api-rehearsal-switch.test.py')],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 the People drain must be DRAINED again after settle, and the fence is checked through the proxy', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-people-drain-observe.test.py')],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 identity evidence binds the API and Keycloak runtime', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-identity-evidence-observe.test.py')],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 a single-use authorization opens a deploy candidate over a reconciliation', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-forward-authorize.test.py')],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#901 a lightweight authorization opens a deploy of a release whose migration is additive over a deploy record', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/uat-additive-authorize.test.py')],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 switches the API image on the VM with pending, a smoke through the proxy, and a receipt', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-api-switch.test.py')],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 the data fingerprint before/after the API switch separates the groups that must stay unchanged', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-protected-data-fingerprint.test.py')],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 builds a proposal from bound evidence without allowing a record write', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-composite-proposal.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 observation reconciliation keeps the legacy layout and the original previous', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b868-record-reconcile.test.py')],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('reconciliation must have a real manifest and does not create a fake config receipt', async () => {
  assert.throws(() => buildDeploymentRecord({ action: 'reconciliation' }), /manifest/);
  await assert.rejects(
    main([
      '--deployment-record',
      '--action',
      'reconciliation',
      '--reconciliation-manifest',
      '/nonexistent/manifest.json',
    ]),
    /evidence/,
  );
});

test('rollback does not accept a reconciliation record as a certification', () => {
  assert.throws(
    () =>
      buildDeploymentRecord({
        action: 'rollback',
        rollbackOf: {
          action: 'reconciliation',
          sourceSha: 'a'.repeat(40),
          images: {},
        },
      }),
    /not a rollback certification/,
  );
});

test('the summary separates unknown deploy time/observation and keeps the SKIPPED/B trial', () => {
  const summary = renderSummary({
    action: 'reconciliation',
    environment: 'uat',
    sourceSha: 'a'.repeat(40),
    images: {},
    realmConfigDigest: null,
    migration: { applied: false },
    deployedAt: null,
    observedAt: '2026-10-30T04:00:00Z',
    recordedAt: '2026-10-30T04:01:00Z',
    businessTrial: 'NOT_EVALUATED',
    smoke: { status: 'PASS', checks: [{ id: 'UAT-L06', status: 'SKIPPED' }] },
  });
  assert.match(summary, /unknown/);
  assert.match(summary, /NOT_EVALUATED/);
  assert.match(summary, /SKIPPED/);
  assert.match(summary, /historical only/);
  assert.doesNotMatch(summary, /1970/);
});

test('the rollback resolver rejects a reconciliation but can pick a newer genuine deploy', (context) => {
  const root = mkdtempSync(resolve(tmpdir(), 'reconciliation-record-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'deployments'));
  writeFileSync(resolve(root, 'uat.env'), 'UAT_ENVIRONMENT=uat\n');
  chmodSync(resolve(root, 'uat.env'), 0o600);
  const sourceSha = 'a'.repeat(40);
  const record = {
    schema: 'UatDeploymentReconciliationV1',
    action: 'reconciliation',
    sourceSha,
    rollbackEligible: false,
  };
  writeFileSync(
    resolve(root, `deployments/20261030T040000Z-uuid-${sourceSha}.json`),
    JSON.stringify(record),
    { mode: 0o600 },
  );
  markCommitted(resolve(root, `deployments/20261030T040000Z-uuid-${sourceSha}.json`));
  const run = () =>
    spawnSync('bash', [resolve('infra/uat/bin/uat-deploy.sh'), 'rollback-target', sourceSha], {
      encoding: 'utf8',
      env: { ...process.env, UAT_ROOT: root },
    });
  assert.notEqual(run().status, 0);
  writeFileSync(
    resolve(root, `deployments/20261031T040000Z-${sourceSha}.json`),
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha,
      images: Object.fromEntries(
        ['api', 'console', 'ops', 'keycloak'].map((name) => [
          name,
          `example.test/${name}@sha256:${'b'.repeat(64)}`,
        ]),
      ),
    }),
    { mode: 0o600 },
  );
  markCommitted(resolve(root, `deployments/20261031T040000Z-${sourceSha}.json`));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'deploy');
});

test('the rollback resolver rejects a proposal and a record whose source does not match the file name', (context) => {
  const root = mkdtempSync(resolve(tmpdir(), 'rollback-proposal-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'deployments'));
  writeFileSync(resolve(root, 'uat.env'), 'UAT_ENVIRONMENT=uat\n', { mode: 0o600 });
  const sourceSha = 'a'.repeat(40);
  const path = resolve(root, `deployments/20261105T000000Z-${sourceSha}.json`);
  const run = () =>
    spawnSync('bash', [resolve('infra/uat/bin/uat-deploy.sh'), 'rollback-target', sourceSha], {
      encoding: 'utf8',
      env: { ...process.env, UAT_ROOT: root },
    });
  writeFileSync(
    path,
    JSON.stringify({ schema: 'UatCompositeReconciliationProposalV1', sourceSha }),
    { mode: 0o600 },
  );
  markCommitted(path);
  assert.notEqual(run().status, 0);
  writeFileSync(
    path,
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: 'b'.repeat(40),
      images: Object.fromEntries(
        ['api', 'console', 'ops', 'keycloak'].map((name) => [
          name,
          `example.test/${name}@sha256:${'c'.repeat(64)}`,
        ]),
      ),
    }),
    { mode: 0o600 },
  );
  markCommitted(path);
  const wrongSource = run();
  assert.notEqual(wrongSource.status, 0);
  assert.match(wrongSource.stderr, /ROLLBACK_TARGET_INVALID/);
  rmSync(path);
  const other = resolve(root, 'other.json');
  writeFileSync(
    other,
    JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha }),
    { mode: 0o600 },
  );
  symlinkSync(other, path);
  const symlink = run();
  assert.notEqual(symlink.status, 0);
  assert.match(symlink.stderr, /ROLLBACK_ARCHIVE_NOT_COMMITTED/);
});

test('the rollback resolver must not pick an archive that has no commit marker yet or was edited after commit', (context) => {
  const root = mkdtempSync(resolve(tmpdir(), 'rollback-uncommitted-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'deployments'));
  writeFileSync(resolve(root, 'uat.env'), 'UAT_ENVIRONMENT=uat\n', { mode: 0o600 });
  const sha = 'a'.repeat(40);
  const path = resolve(root, `deployments/20261105T000000Z-${sha}.json`);
  const content = JSON.stringify({
    schema: 'UatDeploymentRecordV1',
    action: 'deploy',
    sourceSha: sha,
    images: Object.fromEntries(
      ['api', 'console', 'ops', 'keycloak'].map((name) => [
        name,
        `example.test/${name}@sha256:${'c'.repeat(64)}`,
      ]),
    ),
  });
  writeFileSync(path, content, { mode: 0o600 });
  const run = () =>
    spawnSync('bash', [resolve('infra/uat/bin/uat-deploy.sh'), 'rollback-target', sha], {
      encoding: 'utf8',
      env: { ...process.env, UAT_ROOT: root },
    });
  assert.match(run().stderr, /ROLLBACK_ARCHIVE_NOT_COMMITTED/);
  markCommitted(path);
  assert.equal(run().status, 0);
  writeFileSync(path, `${content} `, { mode: 0o600 });
  assert.match(run().stderr, /ROLLBACK_ARCHIVE_NOT_COMMITTED/);
});

test('a previous with no committed archive must not be a rollback target', (context) => {
  const root = mkdtempSync(resolve(tmpdir(), 'rollback-pointer-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'deployments'));
  writeFileSync(resolve(root, 'uat.env'), 'UAT_ENVIRONMENT=uat\n', { mode: 0o600 });
  const sha = 'a'.repeat(40);
  const content = JSON.stringify({
    schema: 'UatDeploymentRecordV1',
    action: 'deploy',
    sourceSha: sha,
    images: Object.fromEntries(
      ['api', 'console', 'ops', 'keycloak'].map((name) => [
        name,
        `example.test/${name}@sha256:${'c'.repeat(64)}`,
      ]),
    ),
  });
  const archive = resolve(root, `deployments/20261105T000000Z-${sha}.json`);
  writeFileSync(archive, content, { mode: 0o600 });
  writeFileSync(resolve(root, 'deployments/previous.json'), content, { mode: 0o600 });
  const run = () =>
    spawnSync('bash', [resolve('infra/uat/bin/uat-deploy.sh'), 'rollback-target'], {
      encoding: 'utf8',
      env: { ...process.env, UAT_ROOT: root },
    });
  assert.match(run().stderr, /ROLLBACK_POINTER_NOT_COMMITTED/);
  markCommitted(archive);
  assert.equal(run().status, 0);
});
