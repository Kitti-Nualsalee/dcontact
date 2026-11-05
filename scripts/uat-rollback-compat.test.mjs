import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const deploy = resolve('infra/uat/bin/uat-deploy.sh');
const oldSha = '158c8ccec29e37bd51ac1fe26676b8cf3123d7be';
const compatibleSha = '14ca86e2b55e7d8ef253f0d9727cef2ad49c09b5';
const recordImages = Object.fromEntries(['api', 'console', 'ops', 'keycloak'].map(
  (name) => [name, `example.test/${name}@sha256:${'a'.repeat(64)}`],
));

function fixture(
  context,
  {
    ledger = 'APPLIED',
    capability = 'SCOPED',
    queryFailure = false,
    capabilityFailure = false,
    cleanupOwner = 'absent',
    cleanupFailure = '',
    interruptPhase = '',
    runtimeSha = compatibleSha,
    badService = '',
    badSourceService = '',
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'uat-rollback-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'deployments'));
  writeFileSync(join(root, 'deployments', 'current.json'),
    JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha: compatibleSha }),
    { mode: 0o600 });
  writeFileSync(join(root, 'uat.env'), 'PRIVATE_VALUE=not-for-output\n', { mode: 0o600 });
  for (const sha of [oldSha, compatibleSha]) {
    const directory = join(root, 'releases', sha);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'docker-compose.uat.yml'), 'services: {}\n');
    writeFileSync(join(directory, 'docker-compose.uat.3vm.yml'), 'services: {}\n');
    writeFileSync(
      join(directory, 'release.env'),
      `SOURCE_SHA=${sha}\n` +
        ['API', 'CONSOLE', 'OPS', 'KEYCLOAK']
          .map(
            (name) => `${name}_IMAGE=example.test/${name.toLowerCase()}@sha256:${'a'.repeat(64)}\n`,
          )
          .join(''),
    );
    const archive = join(root, 'deployments', `20200101T000000Z-${sha}.json`);
    const content = JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha: sha, images: recordImages });
    writeFileSync(archive, content, { mode: 0o600 });
    writeFileSync(`${archive}.committed`, `${createHash('sha256').update(content).digest('hex')}\n`, { mode: 0o600 });
  }
  const log = join(root, 'commands');
  const stub = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$STUB_LOG"
if [[ "$*" == *'run --rm -T --no-deps'* ]]; then
  for argument in "$@"; do
    if [[ "$argument" == com.dcontact.rollback-probe=* ]]; then
      printf '%s' "\${argument#*=}" > "$STUB_OWNER_FILE"
    fi
  done
  cat > "$STUB_SQL"
  if [[ "$STUB_INTERRUPT" == ledger ]]; then touch "$STUB_READY"; sleep 30; fi
  [[ "$STUB_FAILURE" == false ]] || { echo 'PRIVATE_DB_ERROR' >&2; exit 1; }
  printf '%s\\n' "$STUB_LEDGER"
elif [[ "$*" == *'--entrypoint /usr/bin/timeout'* ]]; then
  for argument in "$@"; do
    if [[ "$argument" == com.dcontact.rollback-probe=* ]]; then
      printf '%s' "\${argument#*=}" > "$STUB_OWNER_FILE"
    fi
  done
  printf '%s' "\${@: -1}" > "$STUB_CODE"
  if [[ "$STUB_INTERRUPT" == capability ]]; then touch "$STUB_READY"; sleep 30; fi
  [[ "$STUB_CAPABILITY_FAILURE" == false ]] || { echo 'PRIVATE_IMAGE_ERROR' >&2; exit 1; }
  printf '%s\\n' "$STUB_CAPABILITY"
elif [[ "$*" == 'inspect dcontact-uat-'* ]]; then
  python3 - "$@" <<'PY'
import json, os, sys
ids = {'api': 'a', 'proxy': 'b', 'keycloak': 'c', 'e1-sandbox': 'a'}
if os.environ.get('STUB_MUTATE_INPUT'):
    with open(os.environ['STUB_MUTATE_INPUT'], 'w') as stream:
        stream.write('{"tampered":true}')
rows = []
for name in sys.argv[2:]:
    service = name[len('dcontact-uat-'):-2]
    revision = 'f' * 40 if service == os.environ['STUB_BAD_SOURCE_SERVICE'] else os.environ['STUB_RUNTIME_SHA']
    rows.append({'Name': '/' + name, 'Image': 'sha256:' + ids[service] * 64,
                 'Config': {'Labels': {'org.opencontainers.image.revision': revision,
                                       'com.docker.compose.project': 'dcontact-uat'}},
                 'State': {'Running': True}})
print(json.dumps(rows))
PY
elif [[ "$*" == 'image inspect '* ]]; then
  python3 - "$@" <<'PY'
import json, os, sys
names = {'a': 'api', 'b': 'console', 'c': 'keycloak'}
rows = []
for ref in sys.argv[3:]:
    name = names[ref[-1]] if ref.startswith('sha256:') else 'ops'
    digest = 'b' if os.environ['STUB_BAD_SERVICE'] == name else 'a'
    rows.append({'Id': ref, 'RepoDigests': ['example.test/' + name + '@sha256:' + digest * 64],
                 'Config': {'Labels': {'org.opencontainers.image.revision': os.environ['STUB_RUNTIME_SHA']}}})
print(json.dumps(rows))
PY
elif [[ "$*" == inspect* ]]; then
  if [[ "$*" == *org.opencontainers.image.revision* ]]; then printf '%s\n' "$STUB_RUNTIME_SHA"; exit 0; fi
  [[ "$STUB_CLEANUP_FAILURE" != inspect ]] || exit 1
  if [[ "$STUB_OWNER_MODE" == absent ]]; then exit 1; fi
  printf '%s|' '${'b'.repeat(64)}'
  if [[ "$STUB_OWNER_MODE" == own ]]; then cat "$STUB_OWNER_FILE"; else echo foreign; fi
elif [[ "$*" == 'rm -f'* ]]; then
  [[ "$STUB_CLEANUP_FAILURE" != rm ]] || exit 1
  rm -f "$STUB_OWNER_FILE"
elif [[ "$*" == 'ps -aq'* ]]; then
  [[ "$STUB_CLEANUP_FAILURE" != ps ]] || exit 1
  if [[ -f "$STUB_OWNER_FILE" && "$STUB_OWNER_MODE" != absent ]]; then echo '${'b'.repeat(64)}'; fi
fi
`;
  for (const name of ['docker-compose', 'docker']) {
    writeFileSync(join(root, 'bin', name), stub);
    chmodSync(join(root, 'bin', name), 0o700);
  }
  writeFileSync(
    join(root, 'bin', 'timeout'),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "timeout $*" >> "$STUB_TIMEOUT_LOG"
shift 3
exec "$@"
`,
  );
  chmodSync(join(root, 'bin', 'timeout'), 0o700);
  const env = {
    ...process.env,
    UAT_ROOT: root,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    STUB_LOG: log,
    STUB_SQL: join(root, 'query.sql'),
    STUB_LEDGER: ledger,
    STUB_CAPABILITY: capability,
    STUB_FAILURE: String(queryFailure),
    STUB_CODE: join(root, 'capability.js'),
    STUB_CAPABILITY_FAILURE: String(capabilityFailure),
    STUB_OWNER_FILE: join(root, 'owner'),
    STUB_OWNER_MODE: cleanupOwner,
    STUB_CLEANUP_FAILURE: cleanupFailure,
    STUB_TIMEOUT_LOG: join(root, 'deadlines'),
    STUB_INTERRUPT: interruptPhase,
    STUB_RUNTIME_SHA: runtimeSha,
    STUB_BAD_SERVICE: badService,
    STUB_BAD_SOURCE_SERVICE: badSourceService,
    STUB_READY: join(root, 'ready'),
  };
  function targetHash(sha) {
    const result = spawnSync('bash', [deploy, 'rollback-target', sha], { encoding: 'utf8', env, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return createHash('sha256').update(result.stdout).digest('hex');
  }
  function run(sha = oldSha) {
    const result = spawnSync('bash', [deploy, 'rollback', sha, targetHash(sha)], {
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    return { ...result, commands: readFileSync(log, 'utf8') };
  }
  function seedPending(sha = compatibleSha) {
    mkdirSync(join(root, 'operator'), { mode: 0o700, recursive: true });
    const target = JSON.parse(readFileSync(join(root, 'deployments', `20200101T000000Z-${sha}.json`), 'utf8'));
    const current = readFileSync(join(root, 'deployments', 'current.json'));
    writeFileSync(join(root, 'operator', 'uat-rollback.pending'), JSON.stringify({
      schema: 'UatRollbackPendingV1', targetSha: sha, targetRecordSha256: targetHash(sha),
      currentRecordSha256: createHash('sha256').update(current).digest('hex'), targetRecord: target,
    }), { mode: 0o600 });
  }
  return { root, run, log, env, targetHash, seedPending };
}

test('158 rollback หลัง skill scope ต้องหยุดก่อน up', (context) => {
  const result = fixture(context, { capability: 'UNSCOPED' }).run();
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /up -d|migrate|record/);
  assert.match(result.stderr, /ROLLBACK_SKILL_SCOPE_INCOMPATIBLE/);
});

test('migration authority ของ B7 ต้องหยุด rollback จนกว่าจะรับรอง compatibility', (context) => {
  const result = fixture(context, { ledger: 'B7_AUTHORITY_APPLIED' }).run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_B7_COMPATIBILITY_NOT_CERTIFIED/);
  assert.doesNotMatch(result.commands, /up -d|migrate|record/);
});

test('rollback ต้องหยุดก่อน up หาก Keycloak ที่ไม่เปลี่ยนไม่ตรง target', (context) => {
  const result = fixture(context, { badSourceService: 'keycloak' }).run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_RUNTIME_COMPONENT_MISMATCH/);
  assert.doesNotMatch(result.commands, /up -d/);
});

test('rollback ห้ามใช้ release.env ที่ digest ต่างจาก record ของ target', (context) => {
  const setup = fixture(context);
  const target = join(setup.root, 'deployments', `20200101T000000Z-${compatibleSha}.json`);
  writeFileSync(target, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: compatibleSha, images: { ...recordImages, api: `example.test/api@sha256:${'f'.repeat(64)}` } }),
  { mode: 0o600 });
  writeFileSync(`${target}.committed`, `${createHash('sha256').update(readFileSync(target)).digest('hex')}\n`, { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha, setup.targetHash(compatibleSha)], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_TARGET_RELEASE_MISMATCH/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('rollback หยุดก่อนสลับ runtime หาก transaction ยังไม่รับรอง', (context) => {
  const setup = fixture(context);
  const result = setup.run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_ROLLBACK_TRANSACTION_NOT_CERTIFIED/);
  assert.doesNotMatch(result.commands, /up -d/);
  assert.throws(() => readFileSync(join(setup.root, 'operator', 'uat-rollback.pending')), { code: 'ENOENT' });
});

test('rollback หยุดก่อนเปลี่ยน runtime เมื่อ record เป้าหมายเปลี่ยนหลังเลือก', (context) => {
  const setup = fixture(context);
  const selectedHash = setup.targetHash(compatibleSha);
  const target = join(setup.root, 'deployments', `20200101T000000Z-${compatibleSha}.json`);
  const record = JSON.parse(readFileSync(target, 'utf8'));
  record.note = 'changed after selection';
  writeFileSync(target, JSON.stringify(record), { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha, selectedHash], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_TARGET_CHANGED/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('rollback เลือก previous ที่มี SHA เดียวกับ archive แต่เป็นคนละ record ได้', (context) => {
  const setup = fixture(context);
  writeFileSync(join(setup.root, 'deployments', 'previous.json'), JSON.stringify({
    schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha: compatibleSha,
    images: recordImages, note: 'previous deployment',
  }), { mode: 0o600 });
  const previous = readFileSync(join(setup.root, 'deployments', 'previous.json'));
  const oldArchive = join(setup.root, 'deployments', `20190101T000000Z-${compatibleSha}.json`);
  writeFileSync(oldArchive, previous, { mode: 0o600 });
  writeFileSync(`${oldArchive}.committed`, `${createHash('sha256').update(previous).digest('hex')}\n`, { mode: 0o600 });
  const selected = spawnSync('bash', [deploy, 'rollback-target'], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.equal(selected.status, 0, selected.stderr);
  const hash = createHash('sha256').update(selected.stdout).digest('hex');
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha, hash], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_ROLLBACK_TRANSACTION_NOT_CERTIFIED/);
  assert.doesNotMatch(readFileSync(setup.log, 'utf8'), /up -d/);
});

test('เมื่อมี pending ห้าม mutation อื่นจน reconcile', (context) => {
  const setup = fixture(context);
  setup.seedPending();
  const marker = JSON.parse(readFileSync(join(setup.root, 'operator', 'uat-rollback.pending'), 'utf8'));
  assert.equal(marker.schema, 'UatRollbackPendingV1');
  assert.equal(marker.targetSha, compatibleSha);
  assert.match(marker.currentRecordSha256, /^[0-9a-f]{64}$/);
  for (const action of ['deploy', 'migrate', 'keycloak', 'rollback', 'e1-enable', 'e1-disable', 'line-reload']) {
    const next = spawnSync('bash', [deploy, action, compatibleSha, join(setup.root, 'unused.json')], {
      encoding: 'utf8', env: setup.env, timeout: 10000,
    });
    assert.notEqual(next.status, 0, action);
    assert.match(next.stderr, /UAT_ROLLBACK_PENDING/, action);
  }
});

test('record rollback ที่อ้าง smoke PASS เองยังปลด pending ไม่ได้', (context) => {
  const setup = fixture(context);
  setup.seedPending();
  const input = join(setup.root, 'rollback.json');
  writeFileSync(input, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'rollback',
    sourceSha: compatibleSha, images: recordImages,
    rollbackOf: { recordedAt: null, runUrl: null }, smoke: { status: 'PASS' } }), { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_ROLLBACK_SMOKE_RECEIPT_AND_RECOVERY_REQUIRED/);
  assert.ok(readFileSync(join(setup.root, 'operator', 'uat-rollback.pending')));
});

test('record rollback ที่ smoke ไม่ผ่านต้องคง pending และ current เดิม', (context) => {
  const setup = fixture(context);
  setup.seedPending();
  const current = join(setup.root, 'deployments', 'current.json');
  const before = readFileSync(current, 'utf8');
  const input = join(setup.root, 'rollback.json');
  writeFileSync(input, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'rollback',
    sourceSha: compatibleSha, images: recordImages,
    rollbackOf: { recordedAt: null, runUrl: null }, smoke: { status: 'FAIL' } }), { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_ROLLBACK_PENDING_MISMATCH/);
  assert.equal(readFileSync(current, 'utf8'), before);
  assert.ok(readFileSync(join(setup.root, 'operator', 'uat-rollback.pending')));
});

test('คำสั่งเปลี่ยน release ต้องหยุดถ้า reconciliation กำลังถือ lock', async (context) => {
  const setup = fixture(context);
  mkdirSync(join(setup.root, 'operator'), { mode: 0o700 });
  const lock = join(setup.root, 'operator', 'b714-cutover.lock');
  writeFileSync(lock, '', { mode: 0o600 });
  const holder = spawn('python3', ['-c',
    'import fcntl,sys; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("READY",flush=True); sys.stdin.read()', lock],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  context.after(() => holder.kill());
  await Promise.race([
    new Promise((resolveReady, reject) => {
      holder.stdout.once('data', resolveReady);
      holder.once('error', reject);
    }),
    delay(5000).then(() => { throw new Error('lock holder timeout'); }),
  ]);
  for (const action of ['rollback', 'deploy', 'migrate', 'keycloak', 'record']) {
    const result = spawnSync('bash', [deploy, action, compatibleSha, join(setup.root, 'unused.json')], {
      encoding: 'utf8', env: setup.env, timeout: 10000,
    });
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /UAT_MUTATION_LOCK_BUSY/, action);
    assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
  }
  holder.stdin.end();
});

test('ระบุ SHA ตรงก็ห้าม rollback จาก reconciliation ที่ยังไม่รับรอง', (context) => {
  const setup = fixture(context);
  writeFileSync(join(setup.root, 'deployments', 'current.json'),
    JSON.stringify({ action: 'reconciliation', rollbackEligible: false }), { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_RECONCILIATION_REQUIRES_CERTIFICATION/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('current record เสียต้องหยุดก่อนสั่ง rollback', (context) => {
  const setup = fixture(context);
  writeFileSync(join(setup.root, 'deployments', 'current.json'), '{broken', { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_CURRENT_RECORD_INVALID/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('current record ที่เป็น symlink ต้องหยุดก่อนสั่ง rollback', (context) => {
  const setup = fixture(context);
  const other = join(setup.root, 'other.json');
  writeFileSync(other, JSON.stringify({ action: 'deploy' }), { mode: 0o600 });
  rmSync(join(setup.root, 'deployments', 'current.json'));
  symlinkSync(other, join(setup.root, 'deployments', 'current.json'));
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_CURRENT_RECORD_INVALID/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('3VM rollback ที่ไม่มี current record ต้องหยุดก่อนสั่ง container', (context) => {
  const setup = fixture(context);
  rmSync(join(setup.root, 'deployments', 'current.json'));
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_CURRENT_RECORD_REQUIRED/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('reconciliation ค้างต้องหยุด rollback แม้ lock ว่างแล้ว', (context) => {
  const setup = fixture(context);
  mkdirSync(join(setup.root, 'operator'), { mode: 0o700 });
  writeFileSync(join(setup.root, 'operator', 'b714-reconciliation.pending'), '{}', { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_RECONCILIATION_PENDING/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('record transaction ค้างต้องหยุด mutation แม้ lock ว่างแล้ว', (context) => {
  const setup = fixture(context);
  mkdirSync(join(setup.root, 'operator', 'uat-record-transaction'), { recursive: true, mode: 0o700 });
  for (const action of ['deploy', 'migrate', 'keycloak', 'record', 'rollback']) {
    const result = spawnSync('bash', [deploy, action, compatibleSha, join(setup.root, 'input.json')], {
      encoding: 'utf8', env: setup.env, timeout: 10000,
    });
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /UAT_RECORD_TRANSACTION_PENDING/, action);
  }
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('deploy workflow ต้องหยุดก่อนเปลี่ยน runtime เมื่อ current เป็น reconciliation', (context) => {
  const setup = fixture(context);
  const current = join(setup.root, 'deployments', 'current.json');
  const original = JSON.stringify({ action: 'reconciliation', rollbackEligible: false });
  writeFileSync(current, original, { mode: 0o600 });
  const input = join(setup.root, 'input.json');
  writeFileSync(input, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: compatibleSha, images: recordImages }), { mode: 0o600 });
  for (const action of ['migrate', 'keycloak', 'deploy', 'record']) {
    const result = spawnSync('bash', [deploy, action, compatibleSha, input], {
      encoding: 'utf8', env: setup.env, timeout: 10000,
    });
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /RECORD_RECONCILIATION_REQUIRES_REVIEW/, action);
    assert.equal(readFileSync(current, 'utf8'), original);
    assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
  }
});

test('release เก่าที่มี record ต้องผ่าน rollback guard ไม่ใช่ deploy ตรง', (context) => {
  const setup = fixture(context);
  writeFileSync(join(setup.root, 'deployments', `20261101T000000Z-${oldSha}.json`), '{}', { mode: 0o600 });
  for (const action of ['migrate', 'keycloak', 'deploy']) {
    const result = spawnSync('bash', [deploy, action, oldSha], {
      encoding: 'utf8', env: setup.env, timeout: 10000,
    });
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /UAT_PREVIOUS_RELEASE_REQUIRES_ROLLBACK/, action);
    assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
  }
});

test('target ที่ไม่มีประวัติและยังไม่มีหลักฐาน compatibility ต้องหยุดก่อน migrate', (context) => {
  const setup = fixture(context);
  rmSync(join(setup.root, 'deployments', `20200101T000000Z-${oldSha}.json`));
  for (const action of ['migrate', 'keycloak', 'deploy']) {
    const result = spawnSync('bash', [deploy, action, oldSha], {
      encoding: 'utf8', env: setup.env, timeout: 10000,
    });
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /UAT_TARGET_COMPATIBILITY_EVIDENCE_REQUIRED/, action);
    assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
  }
});

test('deploy source เดิมยังผ่าน target gate', (context) => {
  const setup = fixture(context);
  const result = spawnSync('bash', [deploy, 'deploy', compatibleSha], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(readFileSync(setup.log, 'utf8'), /up -d/);
});

test('current record หายแต่มีประวัติ deployment ต้องไม่ถือเป็น initial deploy', (context) => {
  const setup = fixture(context);
  rmSync(join(setup.root, 'deployments', 'current.json'));
  writeFileSync(join(setup.root, 'deployments', `20261101T000000Z-${oldSha}.json`), '{}', { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'deploy', compatibleSha], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_CURRENT_RECORD_REQUIRED/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('record ห้ามเขียนเมื่อ API runtime เป็นคนละ source', (context) => {
  const setup = fixture(context, { runtimeSha: oldSha });
  const current = join(setup.root, 'deployments', 'current.json');
  const original = readFileSync(current, 'utf8');
  const input = join(setup.root, 'input.json');
  writeFileSync(input, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: compatibleSha, images: recordImages }), { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_RUNTIME_COMPONENT_MISMATCH/);
  assert.equal(readFileSync(current, 'utf8'), original);
});

test('record ห้ามเขียนเมื่อ proxy image digest ไม่ตรง release', (context) => {
  const setup = fixture(context, { badService: 'console' });
  const current = join(setup.root, 'deployments', 'current.json');
  const original = readFileSync(current, 'utf8');
  const input = join(setup.root, 'input.json');
  writeFileSync(input, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: compatibleSha, images: recordImages }), { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_IMAGE_DIGEST_MISMATCH/);
  assert.equal(readFileSync(current, 'utf8'), original);
});

test('record ห้ามอ้าง ops digest ที่ต่างจาก release', (context) => {
  const setup = fixture(context);
  const current = join(setup.root, 'deployments', 'current.json');
  const original = readFileSync(current, 'utf8');
  const input = join(setup.root, 'input.json');
  writeFileSync(input, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: compatibleSha, images: { ...recordImages, ops: `example.test/ops@sha256:${'f'.repeat(64)}` } }),
  { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_CONTENT_MISMATCH/);
  assert.equal(readFileSync(current, 'utf8'), original);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('record ตรวจ sandbox เมื่อเปิด E1', (context) => {
  const setup = fixture(context, { badSourceService: 'e1-sandbox' });
  const release = join(setup.root, 'releases', compatibleSha);
  mkdirSync(join(release, 'e1-freeswitch'));
  writeFileSync(join(release, 'e1-freeswitch', 'entrypoint.sh'), '#!/bin/sh\n', { mode: 0o700 });
  writeFileSync(join(release, 'docker-compose.uat.e1.yml'), 'services: {}\n');
  writeFileSync(join(release, 'Caddyfile.3vm.e1'), '');
  writeFileSync(join(setup.root, 'e1-acceptance.enabled'), '');
  const input = join(setup.root, 'input.json');
  writeFileSync(input, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: compatibleSha, images: recordImages }), { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_RUNTIME_COMPONENT_MISMATCH/);
});

test('record เขียนได้เมื่อ API source ตรงและเก็บ previous', (context) => {
  const setup = fixture(context);
  const current = join(setup.root, 'deployments', 'current.json');
  const original = readFileSync(current, 'utf8');
  const input = join(setup.root, 'input.json');
  const next = `${JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: compatibleSha, images: recordImages })}\n\n `;
  writeFileSync(input, next, { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(current, 'utf8'), next);
  assert.equal(readFileSync(join(setup.root, 'deployments', 'previous.json'), 'utf8'), original);
  const archive = join(setup.root, JSON.parse(result.stdout).file);
  assert.equal(readFileSync(archive, 'utf8'), next);
  assert.equal(statSync(archive).mode & 0o777, 0o600);
});

test('record ใช้ bytes ที่ตรวจแล้วแม้ input ถูกเปลี่ยนระหว่างตรวจ runtime', (context) => {
  const setup = fixture(context);
  const input = join(setup.root, 'input.json');
  const next = JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: compatibleSha, images: recordImages });
  writeFileSync(input, next, { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: { ...setup.env, STUB_MUTATE_INPUT: input }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(input, 'utf8'), '{"tampered":true}');
  assert.equal(readFileSync(join(setup.root, 'deployments', 'current.json'), 'utf8'), next);
});

test('record ไม่เขียนทับ archive ชื่อซ้ำและไม่เปลี่ยน current', (context) => {
  const setup = fixture(context);
  const current = join(setup.root, 'deployments', 'current.json');
  const archive = join(setup.root, 'deployments', `20200101T000000Z-${compatibleSha}.json`);
  const beforeCurrent = readFileSync(current, 'utf8');
  const beforeArchive = readFileSync(archive, 'utf8');
  const input = join(setup.root, 'input.json');
  writeFileSync(input, JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: compatibleSha, images: recordImages }), { mode: 0o600 });
  writeFileSync(join(setup.root, 'bin', 'date'), '#!/bin/sh\nprintf "20200101T000000Z\\n"\n', { mode: 0o700 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_ARCHIVE_EXISTS/);
  assert.equal(readFileSync(current, 'utf8'), beforeCurrent);
  assert.equal(readFileSync(archive, 'utf8'), beforeArchive);
  assert.throws(() => readFileSync(join(setup.root, 'operator', 'uat-record-transaction', 'intent.json')), { code: 'ENOENT' });
});

test('archive เขียนไม่ได้ต้องเก็บ snapshots และปฏิเสธ mutation ถัดไป', (context) => {
  const setup = fixture(context);
  const deployments = join(setup.root, 'deployments');
  const current = readFileSync(join(deployments, 'current.json'), 'utf8');
  const input = join(setup.root, 'input.json');
  const desired = JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy',
    sourceSha: compatibleSha, images: recordImages });
  writeFileSync(input, desired, { mode: 0o600 });
  chmodSync(deployments, 0o500);
  context.after(() => { try { chmodSync(deployments, 0o700); } catch {} });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  const journal = join(setup.root, 'operator', 'uat-record-transaction');
  assert.equal(readFileSync(join(journal, 'current.json'), 'utf8'), current);
  assert.equal(readFileSync(join(journal, 'desired.json'), 'utf8'), desired);
  const retry = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8', env: setup.env, timeout: 10000,
  });
  assert.match(retry.stderr, /UAT_RECORD_TRANSACTION_PENDING/);
  chmodSync(deployments, 0o700);
});

for (const interruptPhase of ['ledger', 'capability']) {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    test(`${signal} ระหว่าง ${interruptPhase} cleanup เฉพาะ probe และไม่ up`, async (context) => {
      const setup = fixture(context, { interruptPhase, cleanupOwner: 'own' });
      const child = spawn('bash', [deploy, 'rollback', compatibleSha, setup.targetHash(compatibleSha)], {
        env: setup.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const closed = new Promise((resolveClose) =>
        child.on('close', (code, stoppedBy) => resolveClose({ code, stoppedBy })),
      );
      try {
        for (let attempt = 0; attempt < 334; attempt++) {
          try {
            readFileSync(join(setup.root, 'ready'));
            break;
          } catch {
            await delay(30);
          }
        }
        assert.ok(readFileSync(join(setup.root, 'ready')));
        process.kill(-child.pid, signal);
        const result = await Promise.race([
          closed,
          delay(5000).then(() => {
            throw new Error('shutdown timeout');
          }),
        ]);
        assert.ok(result.code !== 0 || result.stoppedBy);
        const commands = readFileSync(setup.log, 'utf8');
        assert.match(commands, new RegExp(`rm -f ${'b'.repeat(64)}`));
        assert.doesNotMatch(commands, /up -d/);
        assert.doesNotMatch(stderr, /CLEANUP_UNKNOWN/);
      } finally {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
    });
  }
}

test('explicit compatible target ผ่าน narrow capability แล้วหยุดก่อน up', (context) => {
  const setup = fixture(context);
  const result = setup.run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_ROLLBACK_TRANSACTION_NOT_CERTIFIED/);
  assert.doesNotMatch(result.commands, /up -d/);
  assert.match(result.commands, /--network none --read-only/);
  assert.match(result.commands, /run --rm -T --no-deps/);
  assert.match(result.commands, /--no-deps --pull never/);
  assert.match(result.commands, /PGCONNECT_TIMEOUT=5/);
  assert.match(result.commands, /default_transaction_read_only=on/);
  assert.match(result.commands, /20s node -e/);
  const sql = readFileSync(join(setup.root, 'query.sql'), 'utf8');
  assert.match(sql, /BEGIN READ ONLY/);
  assert.match(sql, /current_database\(\)='dcontact_uat' AND current_user='dcontact_uat_owner'/);
  assert.match(sql, /finished_at IS NULL AND rolled_back_at IS NULL/);
  assert.match(sql, /5e281f7a38bace24cf114dde5a0484a41a0e01d2b317ea95293fce41a8f825c9/);
  const deadlines = readFileSync(join(setup.root, 'deadlines'), 'utf8');
  assert.match(deadlines, /timeout --signal=TERM --kill-after=5s 45s/);
  assert.match(deadlines, /timeout --signal=TERM --kill-after=5s 30s/);
  assert.doesNotMatch(result.stdout + result.stderr, /not-for-output|PRIVATE_DB_ERROR/);
});

test('capability process failure ปฏิเสธโดยไม่เผย stderr', (context) => {
  const result = fixture(context, { capabilityFailure: true }).run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_CAPABILITY_QUERY_FAILED/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_IMAGE_ERROR/);
  assert.doesNotMatch(result.commands, /up -d/);
});

test('predicate จริงตรวจทั้งสอง generated models และ required mapped tenant field', (context) => {
  const setup = fixture(context);
  assert.match(setup.run(compatibleSha).stderr, /UAT_ROLLBACK_TRANSACTION_NOT_CERTIFIED/);
  const code = readFileSync(join(setup.root, 'capability.js'), 'utf8');
  const model = (name) => ({
    name,
    fields: [
      { name: 'tenantId', dbName: 'tenant_id', type: 'String', isRequired: true, kind: 'scalar' },
    ],
  });
  for (const [models, expected] of [
    [[model('AgentSkill'), model('QueueSkill')], 'SCOPED'],
    [
      [
        { name: 'AgentSkill', fields: [] },
        { name: 'QueueSkill', fields: [] },
      ],
      'UNSCOPED',
    ],
    [[model('AgentSkill')], 'UNSCOPED'],
    [
      [
        model('AgentSkill'),
        { name: 'QueueSkill', fields: [{ ...model('QueueSkill').fields[0], isRequired: false }] },
      ],
      'UNSCOPED',
    ],
  ]) {
    let output = '';
    runInNewContext(
      code,
      {
        require: (path) => {
          assert.equal(path, '/app/node_modules/@d-contact/db');
          return { Prisma: { dmmf: { datamodel: { models } } } };
        },
        process: {
          stdout: {
            write: (value) => {
              output += value;
            },
          },
        },
      },
      { timeout: 1000 },
    );
    assert.equal(output, expected);
  }
});

test('pre-skill ledger ไม่รัน target capability และหยุดก่อน up', (context) => {
  const result = fixture(context, { ledger: 'ABSENT', capability: 'UNSCOPED', runtimeSha: oldSha }).run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_ROLLBACK_TRANSACTION_NOT_CERTIFIED/);
  assert.doesNotMatch(result.commands, /up -d/);
  assert.doesNotMatch(result.commands, /--entrypoint \/usr\/bin\/timeout/);
});

for (const ledger of [
  '',
  'APPLIED\nABSENT',
  'INVALID_LEDGER',
  'INVALID_CHECKSUM',
  'AMBIGUOUS_LEDGER',
  'INVALID_SCOPE',
]) {
  test(`ledger ${JSON.stringify(ledger)} ปฏิเสธก่อนเปลี่ยน runtime`, (context) => {
    const result = fixture(context, { ledger }).run(compatibleSha);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_LEDGER_INVALID/);
    assert.doesNotMatch(result.commands, /up -d|--entrypoint \/usr\/bin\/timeout|migrate|record/);
  });
}

test('query error ไม่เผย stderr/credentials และไม่ up', (context) => {
  const result = fixture(context, { queryFailure: true }).run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_LEDGER_QUERY_FAILED/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_DB_ERROR|not-for-output/);
  assert.doesNotMatch(result.commands, /up -d|--entrypoint \/usr\/bin\/timeout/);
  assert.doesNotMatch(result.commands, /rm -f/);
});

test('query failure cleanup เฉพาะ exact owned probe', (context) => {
  const result = fixture(context, { queryFailure: true, cleanupOwner: 'own' }).run();
  assert.notEqual(result.status, 0);
  assert.match(result.commands, new RegExp(`rm -f ${'b'.repeat(64)}`));
  assert.doesNotMatch(result.commands, /up -d|prune/);
});

for (const cleanupFailure of ['inspect', 'rm', 'ps']) {
  test(`cleanup ${cleanupFailure} failure ต้องรายงาน reconciliation ไม่ up`, (context) => {
    const result = fixture(context, {
      queryFailure: true,
      cleanupOwner: 'own',
      cleanupFailure,
    }).run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RECONCILIATION_REQUIRED/);
    assert.match(result.stderr, /ROLLBACK_PROBE_CLEANUP_UNKNOWN/);
    assert.doesNotMatch(result.commands, /up -d/);
  });
}

test('capability failure cleanup ต้องใช้ ownership ของ capability เอง', (context) => {
  const result = fixture(context, { capabilityFailure: true, cleanupOwner: 'own' }).run();
  assert.notEqual(result.status, 0);
  assert.match(result.commands, /-capability/);
  assert.equal(result.commands.match(/rm -f/g).length, 2);
  assert.doesNotMatch(result.stderr, /CLEANUP_UNKNOWN/);
  assert.doesNotMatch(result.commands, /up -d/);
});

test('unknown capability output fail-closed', (context) => {
  const result = fixture(context, { capability: 'unexpected' }).run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /up -d/);
});

test('target จาก previous record ยังต้องผ่าน guard เดียวกัน', (context) => {
  const setup = fixture(context, { capability: 'UNSCOPED' });
  mkdirSync(join(setup.root, 'deployments'), { recursive: true });
  writeFileSync(
    join(setup.root, 'deployments/previous.json'),
    JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha: oldSha, images: recordImages }),
    { mode: 0o600 },
  );
  const selected = spawnSync('bash', [deploy, 'rollback-target'], {
    encoding: 'utf8',
    env: { ...process.env, UAT_ROOT: setup.root },
  });
  assert.equal(selected.status, 0, selected.stderr);
  const result = setup.run(JSON.parse(selected.stdout).sourceSha);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /up -d/);
});
