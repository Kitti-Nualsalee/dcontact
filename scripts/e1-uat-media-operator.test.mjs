import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  assert.match(result.stderr, /Ran 31 tests/);
});

test('#657: voice-on ปิด switch/ตรวจ idle และ snapshot ก่อนเปิด runtime', () => {
  const source = readFileSync(resolve(root, 'infra/uat/bin/uat-deploy.sh'), 'utf8');
  const voice = source.slice(source.indexOf('  e1-voice-control|e1-voice-on|e1-voice-off)'));
  const guard = voice.indexOf('--verify-snapshot --source-sha "$sha"');
  const sharedLock = voice.indexOf('flock -s -n 8');
  assert.ok(sharedLock > voice.indexOf('exec 8</var/lib/dcontact-uat-e1-media/lock'));
  assert.ok(sharedLock < guard);
  assert.equal(voice.includes('exec 8<&-'), false);
  assert.ok(guard > voice.indexOf('e1-voice-control-main.js idle'));
  assert.ok(guard < voice.indexOf('e1-voice-control-main.js on "$actor"'));
  assert.ok(guard < voice.indexOf('UAT_E1_OUTBOUND_VOICE_ENABLED=true'));
});
