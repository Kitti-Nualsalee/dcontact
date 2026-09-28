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

test('release ใน repo ตรงกับ integrity และ alias v1 ชี้ version ที่มีอยู่ของ major เดียวกัน', () => {
  assert.deepEqual(checkReleases(join(root, 'releases')), []);
  const index = loadIndex(join(root, 'releases'));
  assert.ok(index.versions[index.aliases.v1]);
});

test('ไฟล์ release ถูกแก้ = integrity ไม่ตรง (immutable)', () => {
  const { dir } = sandbox();
  writeFileSync(join(dir, '1.0.0', 'dphone-launcher.js'), 'tampered');
  assert.match(checkReleases(dir).join('\n'), /ไม่ตรงกับ integrity/);
});

test('alias: rollback ไป version ที่ release แล้วได้; version ที่ไม่มีหรือข้าม major ไม่ได้', () => {
  const { dir, run } = sandbox();
  // จำลอง 1.0.1 แล้วเลื่อน alias → rollback กลับ 1.0.0
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
