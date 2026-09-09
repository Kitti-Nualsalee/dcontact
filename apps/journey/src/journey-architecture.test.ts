import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

test('Journey runtime source ไม่มี import ไปยังแอป Contact Governance โดยตรง', async () => {
  const sourceDirectory = new URL('.', import.meta.url);
  const sourceFiles = (await readdir(sourceDirectory)).filter(
    (file) =>
      file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.integration.ts'),
  );
  const source = await Promise.all(
    sourceFiles.map(async (file) => ({
      file,
      content: await readFile(new URL(file, sourceDirectory), 'utf8'),
    })),
  );

  for (const { file, content } of source) {
    assert.equal(
      content.includes('@d-contact/contact-governance'),
      false,
      `${file} ต้องพึ่งพา ContactAuthorizationPort แทน concrete app`,
    );
  }
});
