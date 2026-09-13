import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = [
  /\bfetch\s*\(/,
  /from\s+['"](?:node:)?https?['"]/,
  /require\(\s*['"](?:node:)?https?['"]\s*\)/,
  /from\s+['"](?:node:)?net['"]/,
  /from\s+['"](?:node:)?child_process['"]/,
];

test('Customer 360 evaluator ไม่มี live CRM/network execution path', () => {
  const srcDir = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(srcDir).filter(
    (name) =>
      name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.integration.ts'),
  );
  for (const file of files) {
    const source = readFileSync(join(srcDir, file), 'utf8');
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(source, pattern, `${file} ต้องไม่แตะ network/child process: ${pattern}`);
    }
  }
});
