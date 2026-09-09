import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /require\(\s*['"]node:vm['"]\s*\)/,
  /require\(\s*['"]vm['"]\s*\)/,
  /from\s+['"]node:vm['"]/,
  /from\s+['"]vm['"]/,
  /require\(\s*['"]child_process['"]\s*\)/,
  /from\s+['"]child_process['"]/,
  /require\(\s*['"]node:fs['"]\s*\)/,
  /from\s+['"]node:fs['"]/,
  /require\(\s*['"]fs['"]\s*\)/,
  /from\s+['"]fs['"]/,
  /require\(\s*['"]net['"]\s*\)/,
  /from\s+['"]net['"]/,
  /require\(\s*['"]http['"]\s*\)/,
  /from\s+['"]http['"]/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bprocess\.binding\b/,
];

test('implementation source never touches an execution, filesystem, network, or timer API', () => {
  const srcDir = __dirname;
  const files = readdirSync(srcDir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  assert.ok(files.length > 0, 'expected at least one implementation file to scan');
  for (const file of files) {
    const source = readFileSync(join(srcDir, file), 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.ok(!pattern.test(source), `${file} must not match forbidden pattern ${pattern}`);
    }
  }
});
