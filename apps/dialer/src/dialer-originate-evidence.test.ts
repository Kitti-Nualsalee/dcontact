import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DIALER_ORIGINATE_SIMULATION_FLAGS,
  NEGATIVE_SCAN_EXEMPT_FILES,
  scanForForbiddenDependencies,
  scanForForbiddenTelephonyTokens,
} from './dialer-originate-evidence.js';

const SOURCE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));

/**
 * ไล่ทุกไฟล์ในโฟลเดอร์จริง แทนการ hardcode รายชื่อ — เดิม scan แค่ 3 ไฟล์ที่เลือกด้วยมือ
 * ทำให้ไฟล์ใหม่ใน `apps/dialer/src` ไม่เคยถูกตรวจเลย ซึ่งเป็นช่องให้เพิ่มทางไปหา provider
 * ได้โดยไม่มีอะไรจับ
 */
function scannedSourceFiles(): string[] {
  return readdirSync(SOURCE_DIRECTORY)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !NEGATIVE_SCAN_EXEMPT_FILES.includes(name as never))
    .sort();
}

function readSource(filename: string): string {
  return readFileSync(fileURLToPath(new URL(filename, import.meta.url)), 'utf8');
}

test('ทุกไฟล์ใน apps/dialer/src ไม่มี provider SDK, credential หรือ network primitive', () => {
  const files = scannedSourceFiles();
  // กันกรณี glob พังเงียบ ๆ แล้วผ่านเพราะไม่ได้ scan อะไรเลย
  assert.ok(files.length >= 10, `คาดว่าจะ scan อย่างน้อย 10 ไฟล์ แต่ได้ ${files.length}`);

  const result = scanForForbiddenTelephonyTokens(files.map(readSource));
  assert.deepEqual(result.forbiddenTokensFound, []);
  assert.equal(result.clean, true);
});

test('รายการยกเว้นมีได้แค่ evidence module กับ test ของมันเอง', () => {
  assert.deepEqual([...NEGATIVE_SCAN_EXEMPT_FILES].sort(), [
    'dialer-originate-evidence.test.ts',
    'dialer-originate-evidence.ts',
  ]);
});

test('scan จับ marker ที่ inject เข้าไปได้จริง (mutation test กันสัญญาณลวง)', () => {
  const result = scanForForbiddenTelephonyTokens([
    ...scannedSourceFiles().map(readSource),
    "import twilio from 'twilio';",
  ]);
  assert.equal(result.clean, false);
  assert.ok(result.forbiddenTokensFound.includes('twilio'));
});

test('scan จับ network primitive ที่ inject เข้าไปได้จริง', () => {
  const result = scanForForbiddenTelephonyTokens(["import { Socket } from 'node:net';"]);
  assert.equal(result.clean, false);
  assert.ok(result.forbiddenTokensFound.includes("from 'node:net'"));
});

test('package.json ของ dialer ไม่ประกาศ provider SDK ไว้เลย', () => {
  const manifest = JSON.parse(readSource('../package.json')) as {
    dependencies?: Record<string, string>;
  };
  const result = scanForForbiddenDependencies(manifest);
  assert.deepEqual(result.forbiddenDependenciesFound, []);
  assert.equal(result.clean, true);
});

test('dependency scan จับ SDK ที่ประกาศไว้แม้ยังไม่มีใคร import', () => {
  const result = scanForForbiddenDependencies({
    dependencies: { '@d-contact/db': 'workspace:*', twilio: '^5.0.0' },
  });
  assert.equal(result.clean, false);
  assert.deepEqual(result.forbiddenDependenciesFound, ['twilio']);
});

test('simulation flags คง actualProviderTraffic=false เสมอ', () => {
  assert.equal(DIALER_ORIGINATE_SIMULATION_FLAGS.actualProviderTraffic, false);
  assert.equal(DIALER_ORIGINATE_SIMULATION_FLAGS.providerConformance, false);
  assert.equal(DIALER_ORIGINATE_SIMULATION_FLAGS.releaseEnabled, false);
});
