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
    '--phase',
    phase,
    '--tenant-release',
    tenant,
    '--platform-release',
    platform,
    '--storage-class',
    'uat-rwo',
  ];
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test('bootstrap สร้างเฉพาะ namespace แยกจาก Applications ของ Argo CD', () => {
  const result = spawnSync('kubectl', ['kustomize', 'infra/k8s/uat/bootstrap'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kind: Namespace/);
  assert.match(result.stdout, /name: dcontact-uat/);
  assert.doesNotMatch(result.stdout, /kind: (?:Deployment|Service|Secret|Ingress)/);
});

test('สาม phase แยก one-shot Jobs และ public exposure ออกจาก foundation/application', () => {
  releaseFiles();
  for (const phase of ['foundation', 'applications', 'exposure']) {
    const result = render(...releaseArgs(phase));
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /REPLACE_WITH_|__[A-Z_]+__/);
    assert.doesNotMatch(result.stdout, /kind: Job/);
    assert.match(result.stdout, /namespace: dcontact-uat/);
    assert.doesNotMatch(result.stdout, /kind: Namespace/);
    if (phase !== 'exposure') assert.doesNotMatch(result.stdout, /kind: Ingress/);
    else {
      assert.match(result.stdout, /dcontact-uat\.osd\.co\.th/);
      assert.match(result.stdout, /dcontact-platform-uat\.osd\.co\.th/);
      assert.match(result.stdout, /secretName: dcontact-uat-wildcard-tls/);
      assert.doesNotMatch(
        result.stdout,
        /\b(?:rustfs|mailpit|keycloak|tenant-api|platform-api)\b\s*\n\s*port:/,
      );
    }
  }
});

test('ทุก one-shot Job render ได้แต่ไม่รวมใน phase ปกติ', () => {
  releaseFiles();
  for (const job of [
    'migrate',
    'object-storage-init',
    'tenant-keycloak-config',
    'platform-keycloak-config',
    'platform-catalog-seed',
    'tenant-keycloak-users',
    'tenant-provision',
    'platform-operator',
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
  result = render(
    '--phase',
    'foundation',
    '--tenant-release',
    tenant,
    '--platform-release',
    platform,
    '--check',
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /storage-class/);
});

const privilegedSecrets = new Map([
  ['DATABASE_URL_OWNER', 'dcontact-uat-db-owner'],
  ['RUSTFS_ACCESS_KEY', 'dcontact-uat-s3-root'],
  ['RUSTFS_SECRET_KEY', 'dcontact-uat-s3-root'],
  ['KC_BOOTSTRAP_ADMIN_USERNAME', 'dcontact-uat-keycloak-admin'],
  ['KC_BOOTSTRAP_ADMIN_PASSWORD', 'dcontact-uat-keycloak-admin'],
]);

/**
 * คู่ Secret/key ที่ manifest อ้าง ทั้ง env (`secretKeyRef`) และ volume (`secret.items`).
 * อ่านเป็น block ตาม indentation เพราะ `kubectl kustomize` เรียง field ใหม่ (key ก่อน name)
 */
function secretReferences(manifest) {
  const lines = manifest.split('\n');
  const references = [];
  lines.forEach((line, index) => {
    const head = /^(\s*)(?:- )?(secretKeyRef|secret):\s*$/.exec(line);
    if (!head) return;
    const block = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() && /^\s*/.exec(next)[0].length <= head[1].length) break;
      block.push(next);
    }
    const text = block.join('\n');
    const secret = /^\s*(?:name|secretName): (\S+)$/m.exec(
      head[2] === 'secret' ? text.replace(/^\s*(?:- )?(?:key|path): .*$/gm, '') : text,
    )?.[1];
    for (const key of text.matchAll(/^\s*(?:- )?key: (\S+)$/gm)) {
      references.push({ secret, key: key[1] });
    }
  });
  return references;
}

test('credential ระดับ owner/root/admin อยู่ใน Secret แยกและ runtime applications ไม่อ้าง', () => {
  releaseFiles();
  const phases = [
    'foundation',
    'applications',
    ...[
      'migrate',
      'object-storage-init',
      'tenant-keycloak-config',
      'platform-keycloak-config',
      'platform-catalog-seed',
      'tenant-keycloak-users',
      'tenant-provision',
      'platform-operator',
    ].map((job) => `job:${job}`),
  ];
  const dedicated = new Set(privilegedSecrets.values());
  for (const phase of phases) {
    const result = render(...releaseArgs(phase));
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    const references = secretReferences(result.stdout);
    for (const { secret, key } of references) {
      if (privilegedSecrets.has(key)) {
        assert.equal(secret, privilegedSecrets.get(key), `${phase}: ${key} ต้องมาจาก Secret แยก`);
      } else {
        assert.ok(!dedicated.has(secret), `${phase}: ${secret} มีเฉพาะ credential ระดับสูง`);
      }
    }
    if (phase === 'applications') {
      assert.ok(references.length > 0);
      assert.ok(
        references.every(({ secret }) => !dedicated.has(secret)),
        'API/Console/worker ห้ามอ้าง Secret ของ owner/root/admin',
      );
    }
  }
});

test('Job ตั้งค่า Keycloak ตรงกับ Compose UAT (#645 browser flow, AC6 branding)', () => {
  releaseFiles();
  for (const job of ['platform-keycloak-config', 'platform-operator']) {
    const result = render(...releaseArgs(`job:${job}`));
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /keycloak-account-service-setup\.mjs --keep-realm-browser-flow/,
      `${job} ต้องไม่ผูก browser flow ทับ flow OTP ของ realm`,
    );
  }
  const tenant = render(...releaseArgs('job:tenant-keycloak-config'));
  assert.equal(tenant.status, 0, tenant.stderr);
  assert.match(
    tenant.stdout,
    /u1-uat-keycloak-users\.mjs --config && node scripts\/keycloak-dphone-embedded-setup\.mjs && node scripts\/keycloak-branding-setup\.mjs/,
  );
  assert.match(
    tenant.stdout,
    /name: DPHONE_EMBED_ORIGIN\n\s+value: https:\/\/dcontact-uat\.osd\.co\.th\n/,
  );
  assert.match(
    tenant.stdout,
    /name: DPHONE_EMBED_TEMPLATE_CLIENT\n\s+value: dcontact-uat-console\n/,
  );
});
