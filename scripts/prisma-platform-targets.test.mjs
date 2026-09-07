import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const schemaPath = resolve('packages/db/prisma/schema.prisma');

test('Prisma Client รองรับ macOS ทั้ง Intel และ Apple Silicon', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  const binaryTargets = schema.match(/binaryTargets\s*=\s*\[([^\]]+)\]/s)?.[1] ?? '';

  assert.match(binaryTargets, /"darwin"/);
  assert.match(binaryTargets, /"darwin-arm64"/);
});
