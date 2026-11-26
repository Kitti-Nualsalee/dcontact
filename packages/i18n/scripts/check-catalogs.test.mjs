import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCatalogs } from './check-catalogs.mjs';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-i18n-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('complete two-language catalog passes, counting Thai plural (_other) equal to English (_one/_other)', () => {
  const dir = fixture({
    'th/common.json': { nav: { home: 'หน้าแรก' }, item_other: '{{count}} รายการ' }, // allow-thai: Thai catalog fixture
    'en/common.json': { nav: { home: 'Home' }, item_one: '1 item', item_other: '{{count}} items' },
  });
  assert.deepEqual(checkCatalogs(dir), []);
});

test('reports missing keys, missing files and empty messages', () => {
  const dir = fixture({
    'th/common.json': { nav: { home: 'หน้าแรก', queue: 'คิว' } }, // allow-thai: Thai catalog fixture
    'en/common.json': { nav: { home: '' }, extra: 'Extra' },
    'th/journeys.json': { title: 'เส้นทาง' }, // allow-thai: Thai catalog fixture
  });
  const problems = checkCatalogs(dir);
  assert.ok(problems.some((p) => p.includes('en/common.json: missing key "nav.queue"')));
  assert.ok(problems.some((p) => p.includes('th/common.json: missing key "extra"')));
  assert.ok(
    problems.some((p) => p.includes('en/common.json: "nav.home" must be a non-empty message')),
  );
  assert.ok(problems.some((p) => p.includes('en/journeys.json: file is missing')));
});

test('CLI exits with code 1 when a key is missing so CI fails', () => {
  const dir = fixture({
    'th/common.json': { a: 'ก', b: 'ข' }, // allow-thai: Thai catalog fixture
    'en/common.json': { a: 'A' },
  });
  const script = fileURLToPath(new URL('./check-catalogs.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing key "b"/);
});
