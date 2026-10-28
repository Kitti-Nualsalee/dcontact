import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('#657: VM2 media operator — rule ownership/guards/idempotency/stale IP/rollback', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve(root, 'infra/uat/operator/vm2-e1-media-uat.test.py')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(Number(/Ran (\d+) tests/.exec(result.stderr)?.[1]) >= 43, result.stderr);
});

test('#657: voice-on ปิด switch/ตรวจ idle และ snapshot ก่อนเปิด runtime', () => {
  const source = readFileSync(resolve(root, 'infra/uat/bin/uat-deploy.sh'), 'utf8');
  const voice = source.slice(source.indexOf('  e1-voice-control|e1-voice-on|e1-voice-off)'));
  const guard = voice.indexOf('python3 "$media_operator" "${media_arguments[@]}"');
  const sharedLock = voice.indexOf('flock -s -n 8');
  assert.ok(sharedLock > voice.indexOf('exec 8</var/lib/dcontact-uat-e1-media/lock'));
  assert.ok(sharedLock < guard);
  assert.equal(voice.includes('exec 8<&-'), false);
  assert.ok(guard > voice.indexOf('e1-voice-control-main.js idle'));
  assert.ok(guard < voice.indexOf('e1-voice-control-main.js on "$actor"'));
  assert.ok(guard < voice.indexOf('UAT_E1_OUTBOUND_VOICE_ENABLED=true'));
});

function voiceRunner(
  context,
  { explicit = true, operator, missing = false, failVerify = false } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'e1-media-candidate-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidate = 'a'.repeat(40),
    operatorSha = operator ?? 'b'.repeat(40);
  const release = join(directory, 'releases', candidate),
    bin = join(directory, 'fake-bin');
  mkdirSync(join(release, 'e1-freeswitch'), { recursive: true });
  mkdirSync(join(directory, 'bin'), { recursive: true });
  mkdirSync(bin);
  for (const filename of [
    'docker-compose.uat.yml',
    'docker-compose.uat.3vm.yml',
    'docker-compose.uat.e1.yml',
    'Caddyfile.3vm.e1',
  ])
    writeFileSync(join(release, filename), '');
  writeFileSync(join(release, 'release.env'), `SOURCE_SHA=${candidate}\n`);
  writeFileSync(join(release, 'e1-freeswitch/entrypoint.sh'), '#!/bin/sh\n', { mode: 0o700 });
  writeFileSync(join(directory, 'e1-acceptance.enabled'), '');
  writeFileSync(join(directory, 'uat.env'), '', { mode: 0o600 });
  const lock = join(directory, 'media.lock');
  writeFileSync(lock, '');
  const log = join(directory, 'commands.jsonl');
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
  });
  assert.equal(python.status, 0, python.stderr);
  const record = [
    'import json, os, sys',
    'try: os.fstat(8); held = True',
    'except OSError: held = False',
    'args = sys.argv[1:]',
    'with open(os.environ["TEST_LOG"], "a") as log: log.write(json.dumps({"tool": TOOL, "args": args, "held": held}) + chr(10))',
  ].join('\n');
  function executable(filename, tool, body = '') {
    writeFileSync(
      filename,
      `#!${python.stdout.trim()}\n${record.replace('TOOL', JSON.stringify(tool))}\n${body}\n`,
    );
    chmodSync(filename, 0o700);
  }
  executable(
    join(bin, 'docker'),
    'docker',
    `if args[0] != "inspect": sys.exit(1)\nsys.stdout.write(${JSON.stringify(candidate)} + chr(10))`,
  );
  executable(join(bin, 'flock'), 'flock', 'if not held: sys.exit(1)');
  executable(
    join(bin, 'python3'),
    'verify',
    'if os.environ.get("TEST_FAIL_VERIFY") == "true": sys.exit(1)',
  );
  executable(join(directory, 'bin/docker-compose'), 'compose');
  if (!missing && /^[a-f0-9]{40}$/.test(operatorSha)) {
    const helper = join(directory, 'releases', explicit ? operatorSha : candidate, 'operator');
    mkdirSync(helper, { recursive: true });
    writeFileSync(join(helper, 'vm2-e1-media-uat.py'), '# immutable operator fixture\n');
  }
  const runner = join(directory, 'runner.sh');
  writeFileSync(
    runner,
    readFileSync(resolve(root, 'infra/uat/bin/uat-deploy.sh'), 'utf8').replaceAll(
      '/var/lib/dcontact-uat-e1-media/lock',
      lock,
    ),
  );
  const environment = {
    ...process.env,
    UAT_ROOT: directory,
    TEST_LOG: log,
    TEST_FAIL_VERIFY: String(failVerify),
    PATH: `${bin}${delimiter}${process.env.PATH}`,
  };
  delete environment.UAT_E1_MEDIA_OPERATOR_SHA;
  if (explicit) environment.UAT_E1_MEDIA_OPERATOR_SHA = operatorSha;
  const result = spawnSync('bash', [runner, 'e1-voice-on', candidate, 'operator:fixture'], {
    encoding: 'utf8',
    env: environment,
  });
  const commands = (() => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch {
      return [];
    }
  })();
  return { result, commands, directory, candidate, operatorSha };
}

test('#790: voice-on ใช้ operator artifact ที่ pin แยกและถือ outer lock ตลอด verify→enable', (context) => {
  const { result, commands, directory, candidate, operatorSha } = voiceRunner(context);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const index = commands.findIndex((c) => c.tool === 'verify');
  assert.deepEqual(commands[index].args, [
    join(directory, 'releases', operatorSha, 'operator/vm2-e1-media-uat.py'),
    '--verify-snapshot',
    '--source-sha',
    candidate,
    '--candidate-sha',
    candidate,
    '--operator-sha',
    operatorSha,
  ]);
  assert.equal(commands[index].held, true);
  const enable = commands.findIndex((c) => c.tool === 'compose' && c.args.includes('on'));
  assert.ok(enable > index);
  assert.equal(commands[enable].held, true);
  assert.equal(commands.at(-1).held, true);
});

test('#790: default recorded flow ไม่ส่ง candidate selector', (context) => {
  const { result, commands, directory, candidate } = voiceRunner(context, { explicit: false });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(commands.find((c) => c.tool === 'verify').args, [
    join(directory, 'releases', candidate, 'operator/vm2-e1-media-uat.py'),
    '--verify-snapshot',
    '--source-sha',
    candidate,
  ]);
});

test('#790: operator SHA ผิดหรือไฟล์หายไม่เปิด switch/runtime', (context) => {
  for (const options of [{ operator: '../untrusted' }, { missing: true }]) {
    const { result, commands } = voiceRunner(context, options);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /E1_MEDIA_OPERATOR_(SHA_INVALID|MISSING)/);
    assert.equal(
      commands.some((c) => c.tool === 'verify' || c.args.includes('on') || c.args.includes('up')),
      false,
    );
  }
});

test('#790: verify ล้มต้องไม่เปิด switch หรือ recreate runtime', (context) => {
  const { result, commands } = voiceRunner(context, { failVerify: true });
  assert.notEqual(result.status, 0);
  assert.equal(
    commands.some((c) => c.tool === 'verify'),
    true,
  );
  assert.equal(
    commands.some((c) => c.args.includes('on') || c.args.includes('up')),
    false,
  );
});
