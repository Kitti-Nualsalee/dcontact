import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('workspace ติดตั้ง optional dependency สำหรับ macOS ทั้ง Intel และ Apple Silicon', async () => {
  const workspace = await readFile(resolve('pnpm-workspace.yaml'), 'utf8');

  assert.match(workspace, /supportedArchitectures:/);
  assert.match(workspace, /- darwin/);
  assert.match(workspace, /- arm64/);
  assert.match(workspace, /- x64/);
});
