import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkReleases, integrityOf, loadIndex } from './launcher-releases.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'launcher-releases.mjs');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dphone-launcher-'));
  cpSync(join(root, 'releases'), dir, { recursive: true });
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, DPHONE_LAUNCHER_RELEASES_DIR: dir },
      encoding: 'utf8',
    });
  return { dir, run };
}

test('the release in the repo matches the integrity and the alias v1 points at an existing version of the same major', () => {
  assert.deepEqual(checkReleases(join(root, 'releases')), []);
  const index = loadIndex(join(root, 'releases'));
  assert.ok(index.versions[index.aliases.v1]);
});

test('a modified release file = integrity mismatch (immutable)', () => {
  const { dir } = sandbox();
  writeFileSync(join(dir, '1.0.0', 'dphone-launcher.js'), 'tampered');
  assert.match(checkReleases(dir).join('\n'), /does not match the integrity/);
});

test('alias: can roll back to an already released version; a missing version or crossing a major is not allowed', () => {
  const { dir, run } = sandbox();
  // simulate 1.0.1, then move the alias → roll back to 1.0.0
  const content = 'export {};\n';
  cpSync(join(dir, '1.0.0'), join(dir, '1.0.1'), { recursive: true });
  writeFileSync(join(dir, '1.0.1', 'dphone-launcher.js'), content);
  const index = loadIndex(dir);
  index.versions['1.0.1'] = { integrity: integrityOf(content) };
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));

  assert.equal(run('alias', 'v1', '1.0.1').status, 0);
  assert.equal(loadIndex(dir).aliases.v1, '1.0.1');
  const rollback = run('alias', 'v1', '1.0.0');
  assert.equal(rollback.status, 0);
  assert.deepEqual(JSON.parse(rollback.stdout), {
    status: 'ALIASED',
    alias: 'v1',
    version: '1.0.0',
    previous: '1.0.1',
  });

  assert.notEqual(run('alias', 'v1', '9.9.9').status, 0);
  assert.notEqual(run('alias', 'v2', '1.0.0').status, 0);
  assert.equal(loadIndex(dir).aliases.v1, '1.0.0');
  assert.equal(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).aliases.v2, undefined);
});
