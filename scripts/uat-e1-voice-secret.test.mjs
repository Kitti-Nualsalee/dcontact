import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('E1 secret provisioning ไม่พิมพ์ secret ไม่เปิด rollout และ apply ซ้ำไม่เปลี่ยนไฟล์', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'uat-e1-secret-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'uat.env');
  const original =
    'UAT_TENANT_ID=00000000-0000-4000-8000-000000000001\nUAT_E1_OUTBOUND_VOICE_ENABLED=false\n';
  writeFileSync(path, original, { mode: 0o600 });
  const run = (mode) =>
    spawnSync('python3', ['infra/uat/operator/vm2-e1-voice-secret.py', mode, '--env-file', path], {
      encoding: 'utf8',
    });
  assert.notEqual(run('--check').status, 0);
  const applied = run('--apply');
  assert.equal(applied.status, 0, applied.stderr);
  const updated = readFileSync(path, 'utf8');
  const secret = /UAT_E1_VOICE_COMMAND_SECRET=([a-f0-9]{64})/.exec(updated)?.[1];
  assert.ok(secret);
  assert.ok(updated.startsWith(original));
  assert.equal(applied.stdout.includes(secret), false);
  assert.equal(run('--check').status, 0);
  assert.equal(run('--apply').status, 0);
  assert.equal(readFileSync(path, 'utf8'), updated);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const backup = readdirSync(directory).find((name) => name.includes('before-e1-voice'));
  assert.ok(backup);
  assert.equal(readFileSync(join(directory, backup), 'utf8'), original);
  assert.equal(statSync(join(directory, backup)).mode & 0o777, 0o600);
});
