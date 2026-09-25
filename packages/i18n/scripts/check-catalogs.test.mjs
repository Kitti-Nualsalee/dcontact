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

test('catalog ครบสองภาษาผ่าน โดยนับ plural ของไทย (_other) เท่ากับของอังกฤษ (_one/_other)', () => {
  const dir = fixture({
    'th/common.json': { nav: { home: 'หน้าแรก' }, item_other: '{{count}} รายการ' },
    'en/common.json': { nav: { home: 'Home' }, item_one: '1 item', item_other: '{{count}} items' },
  });
  assert.deepEqual(checkCatalogs(dir), []);
});

test('รายงาน key ที่ขาด, ไฟล์ที่ขาด และข้อความว่าง', () => {
  const dir = fixture({
    'th/common.json': { nav: { home: 'หน้าแรก', queue: 'คิว' } },
    'en/common.json': { nav: { home: '' }, extra: 'Extra' },
    'th/journeys.json': { title: 'เส้นทาง' },
  });
  const problems = checkCatalogs(dir);
  assert.ok(problems.some((p) => p.includes('en/common.json: ขาด key "nav.queue"')));
  assert.ok(problems.some((p) => p.includes('th/common.json: ขาด key "extra"')));
  assert.ok(
    problems.some((p) => p.includes('en/common.json: "nav.home" ต้องเป็นข้อความที่ไม่ว่าง')),
  );
  assert.ok(problems.some((p) => p.includes('en/journeys.json: ไม่มีไฟล์')));
});

test('CLI จบด้วย exit code 1 เมื่อ key ขาด เพื่อให้ CI ล้ม', () => {
  const dir = fixture({
    'th/common.json': { a: 'ก', b: 'ข' },
    'en/common.json': { a: 'A' },
  });
  const script = fileURLToPath(new URL('./check-catalogs.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ขาด key "b"/);
});
