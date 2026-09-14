import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function runtimeSources(): Promise<Array<{ file: string; content: string }>> {
  const sourceDirectory = new URL('.', import.meta.url);
  const sourceFiles = (await readdir(sourceDirectory)).filter(
    (file) =>
      file.endsWith('.ts') &&
      !file.endsWith('.test.ts') &&
      !file.endsWith('.integration.ts') &&
      file !== 'campaign-fixtures.ts',
  );
  return Promise.all(
    sourceFiles.map(async (file) => ({
      file,
      content: await readFile(new URL(file, sourceDirectory), 'utf8'),
    })),
  );
}

test('CG4-REG02: Dialer runtime ไม่เขียน canonical Contact Governance state และไม่เห็น approval internals', async () => {
  for (const { file, content } of await runtimeSources()) {
    assert.doesNotMatch(
      content,
      /\.cg[A-Z][A-Za-z0-9]*\./,
      `${file} ต้องไม่เข้าถึง Governance table ผ่าน Prisma`,
    );
    assert.doesNotMatch(
      content,
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?cg_/i,
      `${file} ต้องไม่เขียน Governance table ด้วย SQL`,
    );
    assert.doesNotMatch(
      content,
      /Cg4Exception|Cg4Policy|Cg4Quorum|Cg4Authorization|approvalDigest|quorum/,
      `${file} ต้องรับเฉพาะ final Governance result ไม่ใช่ approval/exception internals`,
    );
    assert.equal(
      content.includes('@d-contact/contact-governance'),
      false,
      `${file} ต้องพึ่ง Governance port ผ่าน composition ไม่ใช่ concrete app`,
    );
  }
});

test('CG4-REG02: admission/callback scheduling ไม่สร้าง reservation มีเพียง originate barrier ที่เรียก authorizeAndReserve', async () => {
  const sources = await runtimeSources();
  const reserving = sources
    .filter(({ content }) => /\.authorizeAndReserve\(/.test(content))
    .map(({ file }) => file);
  assert.deepEqual(reserving, ['dialer-originate-barrier.ts']);
  for (const { file, content } of sources.filter(({ file }) =>
    /^dialer-(admit-campaign-target|callback)-service\.ts$/.test(file),
  )) {
    assert.doesNotMatch(
      content,
      /authorizeAndReserve/,
      `${file} ต้องไม่ขอ reservation ตอน admit/schedule`,
    );
  }
});
