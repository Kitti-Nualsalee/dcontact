import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'scripts/core-settings-writer-cases.json');
// pnpm เป็น process boundary ภายนอก CLI: จำลอง TAP ที่สูญหาย/skip โดยไม่จำลอง DB guard
const fakePnpm = `#!/usr/bin/env node
const fs=require('node:fs');
const manifest=JSON.parse(fs.readFileSync(process.env.CORE_COVERAGE_FIXTURE,'utf8'));
const args=process.argv.slice(2),pkg=args[args.indexOf('--filter')+1];
const files=args.filter(x=>x.endsWith('.integration.ts'));
const target=manifest.files[0].requiredCases[0];
const cases=manifest.files.filter(x=>x.package===pkg&&files.includes(x.file)).flatMap(x=>x.requiredCases);
let count=0,passed=0,skipped=0;
console.log('TAP version 13');
for(const name of cases){
  if(name===target&&process.env.CORE_COVERAGE_FAULT==='missing')continue;
  count++;
  const skip=name===target&&process.env.CORE_COVERAGE_FAULT==='skip';
  console.log('ok '+count+' - '+name+(skip?' # SKIP fault fixture':''));
  if(skip)skipped++;else passed++;
}
console.log('1..'+count+'\\n# pass '+passed+'\\n# fail 0\\n# skipped '+skipped);
`;
for (const fault of ['none', 'missing', 'skip'])
  test(`writer discovery CLI: required case ${fault}`, (t) => {
    assert.ok(JSON.parse(readFileSync(manifestPath, 'utf8')).files.length > 0);
    const bin = mkdtempSync(join(tmpdir(), 'core-writer-cli-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(join(bin, 'pnpm'), fakePnpm, { mode: 0o755 });
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/core-settings-writer-tests.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          CORE_COVERAGE_FIXTURE: manifestPath,
          CORE_COVERAGE_FAULT: fault,
        },
        timeout: 30000,
      },
    );
    assert.ifError(result.error);
    if (fault === 'none') assert.equal(result.status, 0, result.stderr);
    else assert.notEqual(result.status, 0, 'ต้อง fail แม้ test อื่นยังผ่านและ process คืน exit0');
  });
