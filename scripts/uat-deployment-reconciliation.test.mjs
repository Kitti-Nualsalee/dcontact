import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildDeploymentRecord, main, renderSummary } from './u1-uat-readiness.mjs';

test('#714 Python record-only tests ผ่านโดยไม่เรียก VM/Docker จริง', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('infra/uat/operator/b714-deployment-reconciliation.test.py')],
    { encoding: 'utf8', timeout: 30000 },
  );
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
  );
  const run = () =>
    spawnSync('bash', [resolve('infra/uat/bin/uat-deploy.sh'), 'rollback-target', sourceSha], {
      encoding: 'utf8',
      env: { ...process.env, UAT_ROOT: root },
    });
  assert.notEqual(run().status, 0);
  writeFileSync(
    resolve(root, `deployments/20261031T040000Z-${sourceSha}.json`),
    JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha }),
  );
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'deploy');
});
