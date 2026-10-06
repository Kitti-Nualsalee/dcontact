import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'dcontact-k8s-uat-render-'));
const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const image = (name) => `ghcr.io/example/${name}@sha256:${digest}`;
const tenant = join(root, 'tenant.env');
const platform = join(root, 'platform.env');

function releaseFiles({ tenantSha = sha, platformSha = sha, apiImage = image('tenant-api') } = {}) {
  writeFileSync(
    tenant,
    `SOURCE_SHA=${tenantSha}\nAPI_IMAGE=${apiImage}\nOPS_IMAGE=${image('ops')}\nCONSOLE_IMAGE=${image('tenant-console')}\n`,
  );
  writeFileSync(
    platform,
    `SOURCE_SHA=${platformSha}\nPLATFORM_API_IMAGE=${image('platform-api')}\nPLATFORM_CONSOLE_IMAGE=${image('platform-console')}\nPLATFORM_KEYCLOAK_IMAGE=${image('keycloak')}\n`,
  );
}

function render(...args) {
  return spawnSync(process.execPath, ['scripts/k8s-uat-render.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
}

function releaseArgs(phase) {
  return [
    '--phase', phase,
    '--tenant-release', tenant,
    '--platform-release', platform,
    '--storage-class', 'uat-rwo',
  ];
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test('สาม phase แยก one-shot Jobs และ public exposure ออกจาก foundation/application', () => {
  releaseFiles();
  for (const phase of ['foundation', 'applications', 'exposure']) {
    const result = render(...releaseArgs(phase));
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /REPLACE_WITH_|__[A-Z_]+__/);
    assert.doesNotMatch(result.stdout, /kind: Job/);
    assert.match(result.stdout, /namespace: dcontact-uat/);
    if (phase !== 'exposure') assert.doesNotMatch(result.stdout, /kind: Ingress/);
    else {
      assert.match(result.stdout, /dcontact-uat\.osd\.co\.th/);
      assert.match(result.stdout, /dcontact-platform-uat\.osd\.co\.th/);
      assert.match(result.stdout, /secretName: dcontact-uat-wildcard-tls/);
      assert.doesNotMatch(result.stdout, /\b(?:rustfs|mailpit|keycloak|tenant-api|platform-api)\b\s*\n\s*port:/);
    }
  }
});

test('ทุก one-shot Job render ได้แต่ไม่รวมใน phase ปกติ', () => {
  releaseFiles();
  for (const job of [
    'migrate', 'object-storage-init', 'tenant-keycloak-config', 'platform-keycloak-config',
    'platform-catalog-seed', 'tenant-keycloak-users', 'tenant-provision', 'platform-operator',
  ]) {
    const result = render(...releaseArgs(`job:${job}`));
    assert.equal(result.status, 0, `${job}: ${result.stderr}`);
    assert.match(result.stdout, /kind: Job/);
    assert.match(result.stdout, /namespace: dcontact-uat/);
  }
});

test('หยุดเมื่อ release ไม่ใช่ SHA เดียว, image ไม่ตรึง digest หรือ StorageClass ยังไม่ทราบ', () => {
  releaseFiles({ platformSha: 'c'.repeat(40) });
  let result = render(...releaseArgs('applications'), '--check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SOURCE_SHA/);

  releaseFiles({ apiImage: 'ghcr.io/example/tenant-api:latest' });
  result = render(...releaseArgs('applications'), '--check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GHCR image digest/);

  releaseFiles();
  result = render('--phase', 'foundation', '--tenant-release', tenant, '--platform-release', platform, '--check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /storage-class/);
});
