import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const deploy = resolve('infra/uat/bin/uat-deploy.sh');
const oldSha = '158c8ccec29e37bd51ac1fe26676b8cf3123d7be';
const compatibleSha = '14ca86e2b55e7d8ef253f0d9727cef2ad49c09b5';
const recordImages = Object.fromEntries(
  ['api', 'console', 'ops', 'keycloak'].map((name) => [
    name,
    `example.test/${name}@sha256:${'a'.repeat(64)}`,
  ]),
);

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
  writeFileSync(
    join(root, 'deployments', 'current.json'),
    JSON.stringify({ schema: 'UatDeploymentRecordV1', action: 'deploy', sourceSha: compatibleSha }),
    { mode: 0o600 },
  );
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
    const content = JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: sha,
      images: recordImages,
    });
    writeFileSync(archive, content, { mode: 0o600 });
    writeFileSync(
      `${archive}.committed`,
      `${createHash('sha256').update(content).digest('hex')}\n`,
      { mode: 0o600 },
    );
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
    const result = spawnSync('bash', [deploy, 'rollback-target', sha], {
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
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
    const target = JSON.parse(
      readFileSync(join(root, 'deployments', `20200101T000000Z-${sha}.json`), 'utf8'),
    );
    const current = readFileSync(join(root, 'deployments', 'current.json'));
    writeFileSync(
      join(root, 'operator', 'uat-rollback.pending'),
      JSON.stringify({
        schema: 'UatRollbackPendingV1',
        targetSha: sha,
        targetRecordSha256: targetHash(sha),
        currentRecordSha256: createHash('sha256').update(current).digest('hex'),
        targetRecord: target,
      }),
      { mode: 0o600 },
    );
  }
  return { root, run, log, env, targetHash, seedPending };
}

test('158 rollback after the skill scope must stop before up', (context) => {
  const result = fixture(context, { capability: 'UNSCOPED' }).run();
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /up -d|migrate|record/);
  assert.match(result.stderr, /ROLLBACK_SKILL_SCOPE_INCOMPATIBLE/);
});

test('the B7 migration authority must stop rollback until compatibility is certified', (context) => {
  const result = fixture(context, { ledger: 'B7_AUTHORITY_APPLIED' }).run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_B7_COMPATIBILITY_NOT_CERTIFIED/);
  assert.doesNotMatch(result.commands, /up -d|migrate|record/);
});

test('rollback must stop before up if the unchanged Keycloak does not match the target', (context) => {
  const result = fixture(context, { badSourceService: 'keycloak' }).run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_RUNTIME_COMPONENT_MISMATCH/);
  assert.doesNotMatch(result.commands, /up -d/);
});

test('rollback must not use a release.env whose digest differs from the target record', (context) => {
  const setup = fixture(context);
  const target = join(setup.root, 'deployments', `20200101T000000Z-${compatibleSha}.json`);
  writeFileSync(
    target,
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: compatibleSha,
      images: { ...recordImages, api: `example.test/api@sha256:${'f'.repeat(64)}` },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    `${target}.committed`,
    `${createHash('sha256').update(readFileSync(target)).digest('hex')}\n`,
    { mode: 0o600 },
  );
  const result = spawnSync(
    'bash',
    [deploy, 'rollback', compatibleSha, setup.targetHash(compatibleSha)],
    {
      encoding: 'utf8',
      env: setup.env,
      timeout: 10000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_TARGET_RELEASE_MISMATCH/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('rollback stops before switching the runtime if the transaction is not yet certified', (context) => {
  const setup = fixture(context);
  const result = setup.run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_ROLLBACK_TRANSACTION_NOT_CERTIFIED/);
  assert.doesNotMatch(result.commands, /up -d/);
  assert.throws(() => readFileSync(join(setup.root, 'operator', 'uat-rollback.pending')), {
    code: 'ENOENT',
  });
});

test('rollback stops before changing the runtime when the target record changed after it was selected', (context) => {
  const setup = fixture(context);
  const selectedHash = setup.targetHash(compatibleSha);
  const target = join(setup.root, 'deployments', `20200101T000000Z-${compatibleSha}.json`);
  const record = JSON.parse(readFileSync(target, 'utf8'));
  record.note = 'changed after selection';
  writeFileSync(target, JSON.stringify(record), { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha, selectedHash], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_TARGET_CHANGED/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('rollback can select a previous that has the same SHA as an archive but is a different record', (context) => {
  const setup = fixture(context);
  writeFileSync(
    join(setup.root, 'deployments', 'previous.json'),
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: compatibleSha,
      images: recordImages,
      note: 'previous deployment',
    }),
    { mode: 0o600 },
  );
  const previous = readFileSync(join(setup.root, 'deployments', 'previous.json'));
  const oldArchive = join(setup.root, 'deployments', `20190101T000000Z-${compatibleSha}.json`);
  writeFileSync(oldArchive, previous, { mode: 0o600 });
  writeFileSync(
    `${oldArchive}.committed`,
    `${createHash('sha256').update(previous).digest('hex')}\n`,
    { mode: 0o600 },
  );
  const selected = spawnSync('bash', [deploy, 'rollback-target'], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.equal(selected.status, 0, selected.stderr);
  const hash = createHash('sha256').update(selected.stdout).digest('hex');
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha, hash], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_ROLLBACK_TRANSACTION_NOT_CERTIFIED/);
  assert.doesNotMatch(readFileSync(setup.log, 'utf8'), /up -d/);
});

test('when there is a pending item, no other mutation is allowed until reconcile', (context) => {
  const setup = fixture(context);
  setup.seedPending();
  const marker = JSON.parse(
    readFileSync(join(setup.root, 'operator', 'uat-rollback.pending'), 'utf8'),
  );
  assert.equal(marker.schema, 'UatRollbackPendingV1');
  assert.equal(marker.targetSha, compatibleSha);
  assert.match(marker.currentRecordSha256, /^[0-9a-f]{64}$/);
  for (const action of [
    'deploy',
    'migrate',
    'keycloak',
    'rollback',
    'e1-enable',
    'e1-disable',
    'line-reload',
  ]) {
    const next = spawnSync(
      'bash',
      [deploy, action, compatibleSha, join(setup.root, 'unused.json')],
      {
        encoding: 'utf8',
        env: setup.env,
        timeout: 10000,
      },
    );
    assert.notEqual(next.status, 0, action);
    assert.match(next.stderr, /UAT_ROLLBACK_PENDING/, action);
  }
});

test('a rollback record that claims a smoke PASS by itself still cannot clear pending', (context) => {
  const setup = fixture(context);
  setup.seedPending();
  const input = join(setup.root, 'rollback.json');
  writeFileSync(
    input,
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'rollback',
      sourceSha: compatibleSha,
      images: recordImages,
      rollbackOf: { recordedAt: null, runUrl: null },
      smoke: { status: 'PASS' },
    }),
    { mode: 0o600 },
  );
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_ROLLBACK_SMOKE_RECEIPT_AND_RECOVERY_REQUIRED/);
  assert.ok(readFileSync(join(setup.root, 'operator', 'uat-rollback.pending')));
});

test('a rollback record whose smoke did not pass must keep the original pending and current', (context) => {
  const setup = fixture(context);
  setup.seedPending();
  const current = join(setup.root, 'deployments', 'current.json');
  const before = readFileSync(current, 'utf8');
  const input = join(setup.root, 'rollback.json');
  writeFileSync(
    input,
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'rollback',
      sourceSha: compatibleSha,
      images: recordImages,
      rollbackOf: { recordedAt: null, runUrl: null },
      smoke: { status: 'FAIL' },
    }),
    { mode: 0o600 },
  );
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_ROLLBACK_PENDING_MISMATCH/);
  assert.equal(readFileSync(current, 'utf8'), before);
  assert.ok(readFileSync(join(setup.root, 'operator', 'uat-rollback.pending')));
});

test('a release-changing command must stop if a reconciliation holds the lock', async (context) => {
  const setup = fixture(context);
  mkdirSync(join(setup.root, 'operator'), { mode: 0o700 });
  const lock = join(setup.root, 'operator', 'b714-cutover.lock');
  writeFileSync(lock, '', { mode: 0o600 });
  const holder = spawn(
    'python3',
    [
      '-c',
      'import fcntl,sys; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("READY",flush=True); sys.stdin.read()',
      lock,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  context.after(() => holder.kill());
  await Promise.race([
    new Promise((resolveReady, reject) => {
      holder.stdout.once('data', resolveReady);
      holder.once('error', reject);
    }),
    delay(5000).then(() => {
      throw new Error('lock holder timeout');
    }),
  ]);
  for (const action of ['rollback', 'deploy', 'migrate', 'keycloak', 'record']) {
    const result = spawnSync(
      'bash',
      [deploy, action, compatibleSha, join(setup.root, 'unused.json')],
      {
        encoding: 'utf8',
        env: setup.env,
        timeout: 10000,
      },
    );
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /UAT_MUTATION_LOCK_BUSY/, action);
    assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
  }
  holder.stdin.end();
});

test('even with an exact SHA, rollback from an uncertified reconciliation is forbidden', (context) => {
  const setup = fixture(context);
  writeFileSync(
    join(setup.root, 'deployments', 'current.json'),
    JSON.stringify({ action: 'reconciliation', rollbackEligible: false }),
    { mode: 0o600 },
  );
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_RECONCILIATION_REQUIRES_CERTIFICATION/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('a corrupt current record must stop before ordering a rollback', (context) => {
  const setup = fixture(context);
  writeFileSync(join(setup.root, 'deployments', 'current.json'), '{broken', { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_CURRENT_RECORD_INVALID/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('a current record that is a symlink must stop before ordering a rollback', (context) => {
  const setup = fixture(context);
  const other = join(setup.root, 'other.json');
  writeFileSync(other, JSON.stringify({ action: 'deploy' }), { mode: 0o600 });
  rmSync(join(setup.root, 'deployments', 'current.json'));
  symlinkSync(other, join(setup.root, 'deployments', 'current.json'));
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_CURRENT_RECORD_INVALID/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('a 3VM rollback with no current record must stop before ordering a container', (context) => {
  const setup = fixture(context);
  rmSync(join(setup.root, 'deployments', 'current.json'));
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_CURRENT_RECORD_REQUIRED/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('a pending reconciliation must stop rollback even when the lock is free', (context) => {
  const setup = fixture(context);
  mkdirSync(join(setup.root, 'operator'), { mode: 0o700 });
  writeFileSync(join(setup.root, 'operator', 'b714-reconciliation.pending'), '{}', { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'rollback', compatibleSha], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_RECONCILIATION_PENDING/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('a pending record transaction must stop mutation even when the lock is free', (context) => {
  const setup = fixture(context);
  mkdirSync(join(setup.root, 'operator', 'uat-record-transaction'), {
    recursive: true,
    mode: 0o700,
  });
  for (const action of ['deploy', 'migrate', 'keycloak', 'record', 'rollback']) {
    const result = spawnSync(
      'bash',
      [deploy, action, compatibleSha, join(setup.root, 'input.json')],
      {
        encoding: 'utf8',
        env: setup.env,
        timeout: 10000,
      },
    );
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /UAT_RECORD_TRANSACTION_PENDING/, action);
  }
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('a pending record retirement must stop mutation even when the journal was moved', (context) => {
  const setup = fixture(context);
  mkdirSync(join(setup.root, 'operator'), { recursive: true, mode: 0o700 });
  writeFileSync(join(setup.root, 'operator', 'uat-record-retirement.pending'), '{}', {
    mode: 0o600,
  });
  for (const action of ['deploy', 'migrate', 'keycloak', 'record', 'rollback']) {
    const result = spawnSync(
      'bash',
      [deploy, action, compatibleSha, join(setup.root, 'input.json')],
      {
        encoding: 'utf8',
        env: setup.env,
        timeout: 10000,
      },
    );
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /UAT_RECORD_RETIREMENT_PENDING/, action);
  }
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('the deploy workflow must stop before changing the runtime when current is a reconciliation', (context) => {
  const setup = fixture(context);
  const current = join(setup.root, 'deployments', 'current.json');
  const original = JSON.stringify({ action: 'reconciliation', rollbackEligible: false });
  writeFileSync(current, original, { mode: 0o600 });
  const input = join(setup.root, 'input.json');
  writeFileSync(
    input,
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: compatibleSha,
      images: recordImages,
    }),
    { mode: 0o600 },
  );
  for (const action of ['migrate', 'keycloak', 'deploy', 'record']) {
    const result = spawnSync('bash', [deploy, action, compatibleSha, input], {
      encoding: 'utf8',
      env: setup.env,
      timeout: 10000,
    });
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /RECORD_RECONCILIATION_REQUIRES_REVIEW/, action);
    assert.equal(readFileSync(current, 'utf8'), original);
    assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
  }
});

test('an old release that has a record must pass the rollback guard, not a direct deploy', (context) => {
  const setup = fixture(context);
  writeFileSync(join(setup.root, 'deployments', `20261101T000000Z-${oldSha}.json`), '{}', {
    mode: 0o600,
  });
  for (const action of ['migrate', 'keycloak', 'deploy']) {
    const result = spawnSync('bash', [deploy, action, oldSha], {
      encoding: 'utf8',
      env: setup.env,
      timeout: 10000,
    });
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /UAT_PREVIOUS_RELEASE_REQUIRES_ROLLBACK/, action);
    assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
  }
});

test('a target with no history and no compatibility evidence yet must stop before migrate', (context) => {
  const setup = fixture(context);
  rmSync(join(setup.root, 'deployments', `20200101T000000Z-${oldSha}.json`));
  for (const action of ['migrate', 'keycloak', 'deploy']) {
    const result = spawnSync('bash', [deploy, action, oldSha], {
      encoding: 'utf8',
      env: setup.env,
      timeout: 10000,
    });
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /UAT_TARGET_COMPATIBILITY_EVIDENCE_REQUIRED/, action);
    assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
  }
});

test('the original deploy source still passes the target gate', (context) => {
  const setup = fixture(context);
  const result = spawnSync('bash', [deploy, 'deploy', compatibleSha], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(readFileSync(setup.log, 'utf8'), /up -d/);
});

test('a missing current record with deployment history must not be treated as an initial deploy', (context) => {
  const setup = fixture(context);
  rmSync(join(setup.root, 'deployments', 'current.json'));
  writeFileSync(join(setup.root, 'deployments', `20261101T000000Z-${oldSha}.json`), '{}', {
    mode: 0o600,
  });
  const result = spawnSync('bash', [deploy, 'deploy', compatibleSha], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UAT_CURRENT_RECORD_REQUIRED/);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('a record must not be written when the API runtime is from a different source', (context) => {
  const setup = fixture(context, { runtimeSha: oldSha });
  const current = join(setup.root, 'deployments', 'current.json');
  const original = readFileSync(current, 'utf8');
  const input = join(setup.root, 'input.json');
  writeFileSync(
    input,
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: compatibleSha,
      images: recordImages,
    }),
    { mode: 0o600 },
  );
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_RUNTIME_COMPONENT_MISMATCH/);
  assert.equal(readFileSync(current, 'utf8'), original);
});

test('a record must not be written when the proxy image digest does not match the release', (context) => {
  const setup = fixture(context, { badService: 'console' });
  const current = join(setup.root, 'deployments', 'current.json');
  const original = readFileSync(current, 'utf8');
  const input = join(setup.root, 'input.json');
  writeFileSync(
    input,
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: compatibleSha,
      images: recordImages,
    }),
    { mode: 0o600 },
  );
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_IMAGE_DIGEST_MISMATCH/);
  assert.equal(readFileSync(current, 'utf8'), original);
});

test('a record must not claim an ops digest that differs from the release', (context) => {
  const setup = fixture(context);
  const current = join(setup.root, 'deployments', 'current.json');
  const original = readFileSync(current, 'utf8');
  const input = join(setup.root, 'input.json');
  writeFileSync(
    input,
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: compatibleSha,
      images: { ...recordImages, ops: `example.test/ops@sha256:${'f'.repeat(64)}` },
    }),
    { mode: 0o600 },
  );
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_CONTENT_MISMATCH/);
  assert.equal(readFileSync(current, 'utf8'), original);
  assert.throws(() => readFileSync(setup.log), { code: 'ENOENT' });
});

test('a record checks the sandbox when E1 is enabled', (context) => {
  const setup = fixture(context, { badSourceService: 'e1-sandbox' });
  const release = join(setup.root, 'releases', compatibleSha);
  mkdirSync(join(release, 'e1-freeswitch'));
  writeFileSync(join(release, 'e1-freeswitch', 'entrypoint.sh'), '#!/bin/sh\n', { mode: 0o700 });
  writeFileSync(join(release, 'docker-compose.uat.e1.yml'), 'services: {}\n');
  writeFileSync(join(release, 'Caddyfile.3vm.e1'), '');
  writeFileSync(join(setup.root, 'e1-acceptance.enabled'), '');
  const input = join(setup.root, 'input.json');
  writeFileSync(
    input,
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: compatibleSha,
      images: recordImages,
    }),
    { mode: 0o600 },
  );
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_RUNTIME_COMPONENT_MISMATCH/);
});

test('a record can be written when the API source matches and the previous is kept', (context) => {
  const setup = fixture(context);
  const current = join(setup.root, 'deployments', 'current.json');
  const original = readFileSync(current, 'utf8');
  const input = join(setup.root, 'input.json');
  const next = `${JSON.stringify({
    schema: 'UatDeploymentRecordV1',
    action: 'deploy',
    sourceSha: compatibleSha,
    images: recordImages,
  })}\n\n `;
  writeFileSync(input, next, { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(current, 'utf8'), next);
  assert.equal(readFileSync(join(setup.root, 'deployments', 'previous.json'), 'utf8'), original);
  const archive = join(setup.root, JSON.parse(result.stdout).file);
  assert.equal(readFileSync(archive, 'utf8'), next);
  assert.equal(statSync(archive).mode & 0o777, 0o600);
});

test('a record uses the bytes that were checked even if the input changed during the runtime check', (context) => {
  const setup = fixture(context);
  const input = join(setup.root, 'input.json');
  const next = JSON.stringify({
    schema: 'UatDeploymentRecordV1',
    action: 'deploy',
    sourceSha: compatibleSha,
    images: recordImages,
  });
  writeFileSync(input, next, { mode: 0o600 });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: { ...setup.env, STUB_MUTATE_INPUT: input },
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(input, 'utf8'), '{"tampered":true}');
  assert.equal(readFileSync(join(setup.root, 'deployments', 'current.json'), 'utf8'), next);
});

for (const hasPrevious of [false, true]) {
  for (const phase of [
    'journal',
    'ready',
    'archive',
    'previous',
    'current',
    'marker-empty',
    'marker',
  ]) {
    test(`a record interrupted after ${phase} (previous ${hasPrevious}) must keep the journal`, (context) => {
      const setup = fixture(context);
      chmodSync(join(setup.root, 'deployments'), 0o700);
      const current = join(setup.root, 'deployments', 'current.json');
      const original = readFileSync(current, 'utf8');
      const previous = JSON.stringify({
        schema: 'UatDeploymentRecordV1',
        action: 'deploy',
        sourceSha: oldSha,
      });
      if (hasPrevious)
        writeFileSync(join(setup.root, 'deployments', 'previous.json'), previous, { mode: 0o600 });
      const input = join(setup.root, 'input.json');
      const desired = JSON.stringify({
        schema: 'UatDeploymentRecordV1',
        action: 'deploy',
        sourceSha: compatibleSha,
        images: recordImages,
      });
      writeFileSync(input, desired, { mode: 0o600 });
      const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf8',
      });
      assert.equal(python.status, 0, python.stderr);
      const anchors = {
        journal: 'save("desired.json", desired)',
        ready: 'syncdir(transaction)',
        archive: '        os.link(staging, target, follow_symlinks=False)',
        previous: "    replace(directory / 'previous.json', current.read_bytes())",
        current: 'replace(current, pathlib.Path(archive).read_bytes())',
        'marker-empty':
          'fd = os.open(marker_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)',
        marker:
          "    stream.write((hashlib.sha256(pathlib.Path(archive).read_bytes()).hexdigest() + '\\n').encode())\n    stream.flush()\n    os.fsync(stream.fileno())",
      };
      const injector = `#!${python.stdout.trim()}
import os, sys
if sys.argv[1:2] in (['-'], ['-c']):
    inline = sys.argv[1] == '-c'
    program = sys.argv[2] if inline else sys.stdin.read()
    extra = sys.argv[3:] if inline else sys.argv[2:]
    anchor = ${JSON.stringify(anchors[phase])}
    if anchor in program:
        assert program.count(anchor) == 1
        program = program.replace(anchor, anchor + ${JSON.stringify(phase === 'previous' ? '\n    os._exit(97)' : phase === 'archive' ? '\n        os._exit(97)' : '\nos._exit(97)')})
    os.execv(sys.executable, [sys.executable, '-c', program, *extra])
os.execv(sys.executable, [sys.executable, *sys.argv[1:]])
`;
      const shim = join(setup.root, 'bin', 'python3');
      writeFileSync(shim, injector, { mode: 0o700 });
      const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
        encoding: 'utf8',
        env: setup.env,
        timeout: 10000,
      });
      assert.equal(result.status, 97, result.stderr);
      const journal = join(setup.root, 'operator', 'uat-record-transaction');
      assert.equal(readFileSync(join(journal, 'current.json'), 'utf8'), original);
      assert.equal(readFileSync(join(journal, 'desired.json'), 'utf8'), desired);
      if (hasPrevious) assert.equal(readFileSync(join(journal, 'previous.json'), 'utf8'), previous);
      else assert.throws(() => readFileSync(join(journal, 'previous.json')), { code: 'ENOENT' });
      const inspected = spawnSync(
        'python3',
        [resolve('infra/uat/operator/b868-record-recovery-inspect.py'), '--root', setup.root],
        {
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      const state = JSON.parse(inspected.stdout);
      if (['journal', 'marker-empty'].includes(phase)) {
        assert.equal(inspected.status, 1);
        assert.equal(state.status, 'INVALID_OR_INCOMPLETE');
        if (phase === 'marker-empty') {
          const intent = JSON.parse(readFileSync(join(journal, 'intent.json'), 'utf8'));
          assert.equal(
            statSync(join(setup.root, 'deployments', `${intent.archive}.committed`)).size,
            0,
          );
          assert.equal(readFileSync(current, 'utf8'), desired);
        }
      } else {
        assert.equal(inspected.status, 0, inspected.stderr);
        assert.equal(
          state.current,
          ['ready', 'archive', 'previous'].includes(phase) ? 'original' : 'desired',
        );
        assert.equal(
          state.previous,
          ['ready', 'archive'].includes(phase) ? 'original' : 'current-before',
        );
        assert.equal(state.archivePresent, phase !== 'ready');
        assert.equal(state.markerPresent, phase === 'marker');
      }
      assert.equal(state.recoveryAuthorized, false);
      const retry = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
        encoding: 'utf8',
        env: setup.env,
        timeout: 10000,
      });
      assert.match(retry.stderr, /UAT_RECORD_TRANSACTION_PENDING/);
    });
  }
}

test('a record does not overwrite an archive with a duplicate name and does not change current', (context) => {
  const setup = fixture(context);
  const current = join(setup.root, 'deployments', 'current.json');
  const archive = join(setup.root, 'deployments', `20200101T000000Z-${compatibleSha}.json`);
  const beforeCurrent = readFileSync(current, 'utf8');
  const beforeArchive = readFileSync(archive, 'utf8');
  const input = join(setup.root, 'input.json');
  writeFileSync(
    input,
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: compatibleSha,
      images: recordImages,
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(setup.root, 'bin', 'date'), '#!/bin/sh\nprintf "20200101T000000Z\\n"\n', {
    mode: 0o700,
  });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECORD_ARCHIVE_EXISTS/);
  assert.equal(readFileSync(current, 'utf8'), beforeCurrent);
  assert.equal(readFileSync(archive, 'utf8'), beforeArchive);
  assert.throws(
    () => readFileSync(join(setup.root, 'operator', 'uat-record-transaction', 'intent.json')),
    { code: 'ENOENT' },
  );
});

test('an archive that cannot be written must keep the snapshots and reject the next mutation', (context) => {
  const setup = fixture(context);
  const deployments = join(setup.root, 'deployments');
  const current = readFileSync(join(deployments, 'current.json'), 'utf8');
  const input = join(setup.root, 'input.json');
  const desired = JSON.stringify({
    schema: 'UatDeploymentRecordV1',
    action: 'deploy',
    sourceSha: compatibleSha,
    images: recordImages,
  });
  writeFileSync(input, desired, { mode: 0o600 });
  chmodSync(deployments, 0o500);
  context.after(() => {
    try {
      chmodSync(deployments, 0o700);
    } catch {}
  });
  const result = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  const journal = join(setup.root, 'operator', 'uat-record-transaction');
  assert.equal(readFileSync(join(journal, 'current.json'), 'utf8'), current);
  assert.equal(readFileSync(join(journal, 'desired.json'), 'utf8'), desired);
  const retry = spawnSync('bash', [deploy, 'record', compatibleSha, input], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 10000,
  });
  assert.match(retry.stderr, /UAT_RECORD_TRANSACTION_PENDING/);
  chmodSync(deployments, 0o700);
});

for (const interruptPhase of ['ledger', 'capability']) {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    test(`${signal} during ${interruptPhase} cleans up only the probe and does not up`, async (context) => {
      const setup = fixture(context, { interruptPhase, cleanupOwner: 'own' });
      const child = spawn(
        'bash',
        [deploy, 'rollback', compatibleSha, setup.targetHash(compatibleSha)],
        {
          env: setup.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
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

test('an explicit compatible target passes the narrow capability and stops before up', (context) => {
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

test('a capability process failure is rejected without revealing stderr', (context) => {
  const result = fixture(context, { capabilityFailure: true }).run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_CAPABILITY_QUERY_FAILED/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_IMAGE_ERROR/);
  assert.doesNotMatch(result.commands, /up -d/);
});

test('the real predicate checks both generated models and the required mapped tenant field', (context) => {
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

test('a pre-skill ledger does not run the target capability and stops before up', (context) => {
  const result = fixture(context, {
    ledger: 'ABSENT',
    capability: 'UNSCOPED',
    runtimeSha: oldSha,
  }).run();
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
  test(`ledger ${JSON.stringify(ledger)} is rejected before changing the runtime`, (context) => {
    const result = fixture(context, { ledger }).run(compatibleSha);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_LEDGER_INVALID/);
    assert.doesNotMatch(result.commands, /up -d|--entrypoint \/usr\/bin\/timeout|migrate|record/);
  });
}

test('a query error does not reveal stderr/credentials and does not up', (context) => {
  const result = fixture(context, { queryFailure: true }).run(compatibleSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK_LEDGER_QUERY_FAILED/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_DB_ERROR|not-for-output/);
  assert.doesNotMatch(result.commands, /up -d|--entrypoint \/usr\/bin\/timeout/);
  assert.doesNotMatch(result.commands, /rm -f/);
});

test('query failure cleans up only the exact owned probe', (context) => {
  const result = fixture(context, { queryFailure: true, cleanupOwner: 'own' }).run();
  assert.notEqual(result.status, 0);
  assert.match(result.commands, new RegExp(`rm -f ${'b'.repeat(64)}`));
  assert.doesNotMatch(result.commands, /up -d|prune/);
});

for (const cleanupFailure of ['inspect', 'rm', 'ps']) {
  test(`cleanup ${cleanupFailure} failure must report reconciliation and not up`, (context) => {
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

test('capability failure cleanup must use the ownership of the capability itself', (context) => {
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

test('a target from a previous record must still pass the same guard', (context) => {
  const setup = fixture(context, { capability: 'UNSCOPED' });
  mkdirSync(join(setup.root, 'deployments'), { recursive: true });
  writeFileSync(
    join(setup.root, 'deployments/previous.json'),
    JSON.stringify({
      schema: 'UatDeploymentRecordV1',
      action: 'deploy',
      sourceSha: oldSha,
      images: recordImages,
    }),
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
