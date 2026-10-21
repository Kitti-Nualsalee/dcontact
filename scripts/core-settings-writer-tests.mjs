import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Manifest เป็น required case IDs ที่ review แล้ว ไม่ derive expectations จากไฟล์ test ตอนรัน
const manifest = JSON.parse(
  readFileSync(resolve(root, 'scripts/core-settings-writer-cases.json'), 'utf8'),
);
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length)
  throw new Error('Core writer manifest ไม่ถูกต้อง');
const files = new Set();
for (const suite of manifest.files) {
  if (
    !/^@d-contact\/[a-z-]+$/.test(suite.package) ||
    !/^src\/[a-z0-9-]+\.integration\.ts$/.test(suite.file) ||
    !(suite.pattern === null || typeof suite.pattern === 'string') ||
    !Array.isArray(suite.requiredCases) ||
    !suite.requiredCases.length
  )
    throw new Error('Core writer manifest entry ไม่ถูกต้อง');
  const key = suite.package + ':' + suite.file;
  if (files.has(key)) throw new Error('Core writer manifest file ซ้ำ: ' + key);
  files.add(key);
  const cases = new Set(suite.requiredCases);
  if (cases.size !== suite.requiredCases.length)
    throw new Error('Core writer manifest case ซ้ำ: ' + key);
  for (const name of cases) {
    if (typeof name !== 'string' || !name.length)
      throw new Error('Core writer case ID ไม่ถูกต้อง: ' + key);
    const race = /^(.*) (writer-first|deactivate-first)$/.exec(name);
    if (
      race &&
      !cases.has(race[1] + ' ' + (race[2] === 'writer-first' ? 'deactivate-first' : 'writer-first'))
    )
      throw new Error('Core writer case ขาดลำดับตรงข้าม: ' + name);
  }
}
let passed = 0;
for (const suite of manifest.files) {
  const args = [
    '--filter',
    suite.package,
    'exec',
    'tsx',
    '--test',
    '--test-concurrency=1',
    '--test-timeout=30000',
    '--test-reporter=tap',
    ...(suite.pattern ? [`--test-name-pattern=${suite.pattern}`] : []),
    suite.file,
  ];
  process.stdout.write(`\n# Core Settings writer file: ${suite.package}/${suite.file}\n`);
  const result = spawnSync('pnpm', args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  const observed = new Map();
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const item = /^(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line);
    if (!item) continue;
    const entries = observed.get(item[2]) ?? [];
    entries.push({ passed: item[1] === 'ok' && !item[3] });
    observed.set(item[2], entries);
  }
  for (const name of suite.requiredCases) {
    const entries = observed.get(name) ?? [];
    if (entries.length !== 1 || !entries[0].passed) {
      process.stderr.write(
        `required case ขาด/ซ้ำ/skip/fail: ${suite.package}/${suite.file}: ${name}\n`,
      );
      process.exit(1);
    }
    passed++;
  }
  // case ใหม่ที่เลือกมารันต้องเพิ่ม manifest ให้ reviewer เห็น coverage change ด้วย
  for (const [name, entries] of observed)
    if (entries.some((x) => x.passed) && !suite.requiredCases.includes(name)) {
      process.stderr.write(`case ที่รันยังไม่มีใน required manifest: ${suite.file}: ${name}\n`);
      process.exit(1);
    }
}
process.stdout.write(
  `\n# Core Settings writer coverage: PASS ${passed} required cases / ${files.size} files; ไม่ใช่ VM UAT signoff\n`,
);
