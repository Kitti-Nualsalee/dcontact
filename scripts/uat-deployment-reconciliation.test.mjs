import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildDeploymentRecord, main, renderSummary } from './u1-uat-readiness.mjs';

test('#868 inspect journal ตรวจสถานะค้างโดยไม่รับรอง runtime', () => {
  const result = spawnSync('python3', ['-B', resolve('infra/uat/operator/b868-record-recovery-inspect.test.py')], {
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('#868 legacy inventory แยก marker จาก provenance', () => {
  const result = spawnSync('python3', ['-B', resolve('infra/uat/operator/b868-legacy-inventory.test.py')], {
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
});

function markCommitted(path) {
  writeFileSync(`${path}.committed`, `${createHash('sha256').update(readFileSync(path)).digest('hex')}\n`, { mode: 0o600 });
}

test('#714 Python record-only tests ผ่านโดยไม่เรียก VM/Docker จริง', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b714-deployment-reconciliation.test.py')],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 ตรวจ record และ runtime โดยไม่เรียก VM/Docker จริง', () => {
  const result = spawnSync('python3', ['-B', resolve('infra/uat/operator/release-record-inspect.test.py')], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 ผูก migration ledger กับ runtime และ protected services', () => {
  const result = spawnSync('python3', ['-B', resolve('infra/uat/operator/release-evidence-observe.test.py')], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 ปฏิเสธ candidate ที่หลักฐานเก่าหรือไม่ตรง hash', () => {
  const result = spawnSync('python3', ['-B', resolve('infra/uat/operator/release-candidate-validate.test.py')], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('#868 สร้าง proposal จากหลักฐานที่ผูกกันโดยไม่อนุญาตเขียน record', () => {
  const result = spawnSync('python3', ['-B', resolve('infra/uat/operator/b868-composite-proposal.test.py')], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('reconciliation ต้องมี manifest จริง ไม่สร้าง config receipt เทียม', async () => {
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

test('rollback ไม่รับ reconciliation record เป็น certification', () => {
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
    /ไม่ใช่ rollback certification/,
  );
});

test('summary แยก unknown deploy time/observation และคง SKIPPED/B trial', () => {
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
  assert.match(summary, /ไม่ทราบ/);
  assert.match(summary, /NOT_EVALUATED/);
  assert.match(summary, /SKIPPED/);
  assert.match(summary, /historical เท่านั้น/);
  assert.doesNotMatch(summary, /1970/);
});

test('rollback resolver ปฏิเสธ reconciliation แต่เลือก genuine deploy ที่ใหม่กว่าได้', (context) => {
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
    JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha,
      images: Object.fromEntries(['api', 'console', 'ops', 'keycloak'].map(
        (name) => [name, `example.test/${name}@sha256:${'b'.repeat(64)}`],
      )) }),
    { mode: 0o600 },
  );
  markCommitted(resolve(root, `deployments/20261031T040000Z-${sourceSha}.json`));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'deploy');
});

test('rollback resolver ปฏิเสธ proposal และ record ที่ source ไม่ตรงชื่อไฟล์', (context) => {
  const root = mkdtempSync(resolve(tmpdir(), 'rollback-proposal-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'deployments'));
  writeFileSync(resolve(root, 'uat.env'), 'UAT_ENVIRONMENT=uat\n', { mode: 0o600 });
  const sourceSha = 'a'.repeat(40);
  const path = resolve(root, `deployments/20261105T000000Z-${sourceSha}.json`);
  const run = () => spawnSync('bash', [resolve('infra/uat/bin/uat-deploy.sh'), 'rollback-target', sourceSha], {
    encoding: 'utf8', env: { ...process.env, UAT_ROOT: root },
  });
  writeFileSync(path, JSON.stringify({ schema: 'UatCompositeReconciliationProposalV1', sourceSha }), { mode: 0o600 });
  markCommitted(path);
  assert.notEqual(run().status, 0);
  writeFileSync(path, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: 'b'.repeat(40), images: Object.fromEntries(['api', 'console', 'ops', 'keycloak'].map(
      (name) => [name, `example.test/${name}@sha256:${'c'.repeat(64)}`],
    )) }), { mode: 0o600 });
  markCommitted(path);
  const wrongSource = run();
  assert.notEqual(wrongSource.status, 0);
  assert.match(wrongSource.stderr, /ROLLBACK_TARGET_INVALID/);
  rmSync(path);
  const other = resolve(root, 'other.json');
  writeFileSync(other, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha }), { mode: 0o600 });
  symlinkSync(other, path);
  const symlink = run();
  assert.notEqual(symlink.status, 0);
  assert.match(symlink.stderr, /ROLLBACK_ARCHIVE_NOT_COMMITTED/);
});

test('rollback resolver ห้ามเลือก archive ที่ยังไม่มี commit marker หรือถูกแก้หลัง commit', (context) => {
  const root = mkdtempSync(resolve(tmpdir(), 'rollback-uncommitted-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'deployments'));
  writeFileSync(resolve(root, 'uat.env'), 'UAT_ENVIRONMENT=uat\n', { mode: 0o600 });
  const sha = 'a'.repeat(40);
  const path = resolve(root, `deployments/20261105T000000Z-${sha}.json`);
  const content = JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha: sha,
    images: Object.fromEntries(['api', 'console', 'ops', 'keycloak'].map(
      (name) => [name, `example.test/${name}@sha256:${'c'.repeat(64)}`],
    )) });
  writeFileSync(path, content, { mode: 0o600 });
  const run = () => spawnSync('bash', [resolve('infra/uat/bin/uat-deploy.sh'), 'rollback-target', sha], {
    encoding: 'utf8', env: { ...process.env, UAT_ROOT: root },
  });
  assert.match(run().stderr, /ROLLBACK_ARCHIVE_NOT_COMMITTED/);
  markCommitted(path);
  assert.equal(run().status, 0);
  writeFileSync(path, `${content} `, { mode: 0o600 });
  assert.match(run().stderr, /ROLLBACK_ARCHIVE_NOT_COMMITTED/);
});

test('previous ที่ไม่มี archive ซึ่ง commit แล้วต้องไม่เป็น rollback target', (context) => {
  const root = mkdtempSync(resolve(tmpdir(), 'rollback-pointer-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'deployments'));
  writeFileSync(resolve(root, 'uat.env'), 'UAT_ENVIRONMENT=uat\n', { mode: 0o600 });
  const sha = 'a'.repeat(40);
  const content = JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha: sha,
    images: Object.fromEntries(['api', 'console', 'ops', 'keycloak'].map(
      (name) => [name, `example.test/${name}@sha256:${'c'.repeat(64)}`],
    )) });
  const archive = resolve(root, `deployments/20261105T000000Z-${sha}.json`);
  writeFileSync(archive, content, { mode: 0o600 });
  writeFileSync(resolve(root, 'deployments/previous.json'), content, { mode: 0o600 });
  const run = () => spawnSync('bash', [resolve('infra/uat/bin/uat-deploy.sh'), 'rollback-target'], {
    encoding: 'utf8', env: { ...process.env, UAT_ROOT: root },
  });
  assert.match(run().stderr, /ROLLBACK_POINTER_NOT_COMMITTED/);
  markCommitted(archive);
  assert.equal(run().status, 0);
});
