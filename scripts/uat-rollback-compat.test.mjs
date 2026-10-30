import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const deploy = resolve('infra/uat/bin/uat-deploy.sh');
const oldSha = '158c8ccec29e37bd51ac1fe26676b8cf3123d7be';
const compatibleSha = '14ca86e2b55e7d8ef253f0d9727cef2ad49c09b5';

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
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'uat-rollback-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
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
elif [[ "$*" == inspect* ]]; then
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
    STUB_READY: join(root, 'ready'),
  };
  function run(sha = oldSha) {
    const result = spawnSync('bash', [deploy, 'rollback', sha], {
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    return { ...result, commands: readFileSync(log, 'utf8') };
  }
  return { root, run, log, env };
}

test('158 rollback หลัง skill scope ต้องหยุดก่อน up', (context) => {
  const result = fixture(context, { capability: 'UNSCOPED' }).run();
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /up -d|migrate|record/);
  assert.match(result.stderr, /ROLLBACK_SKILL_SCOPE_INCOMPATIBLE/);
});

for (const interruptPhase of ['ledger', 'capability']) {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    test(`${signal} ระหว่าง ${interruptPhase} cleanup เฉพาะ probe และไม่ up`, async (context) => {
      const setup = fixture(context, { interruptPhase, cleanupOwner: 'own' });
      const child = spawn('bash', [deploy, 'rollback', compatibleSha], {
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

test('explicit compatible target ผ่าน narrow capability ก่อน up', (context) => {
  const setup = fixture(context);
  const result = setup.run(compatibleSha);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.commands.indexOf('--entrypoint /usr/bin/timeout') < result.commands.indexOf('up -d'),
  );
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
  assert.equal(setup.run(compatibleSha).status, 0);
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

test('pre-skill ledger คง rollback เดิมโดยไม่รัน target capability', (context) => {
  const result = fixture(context, { ledger: 'ABSENT', capability: 'UNSCOPED' }).run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.commands, /up -d/);
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
  mkdirSync(join(setup.root, 'deployments'));
  writeFileSync(
    join(setup.root, 'deployments/previous.json'),
    JSON.stringify({ sourceSha: oldSha }),
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
