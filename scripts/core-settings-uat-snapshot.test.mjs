import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

test('snapshot v2: live Keycloak configuration/transport/freshness ไม่ใช้ record แทน authority', () => {
  const result = spawnSync(
    'python3',
    [resolve(import.meta.dirname, 'core-settings-uat-runtime-test.py')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 10 tests/);
});
