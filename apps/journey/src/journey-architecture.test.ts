import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function runtimeSources(): Promise<Array<{ file: string; content: string }>> {
  const sourceDirectory = new URL('.', import.meta.url);
  const sourceFiles = (await readdir(sourceDirectory)).filter(
    (file) =>
      file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.integration.ts'),
  );
  return Promise.all(
    sourceFiles.map(async (file) => ({
      file,
      content: await readFile(new URL(file, sourceDirectory), 'utf8'),
    })),
  );
}

test('CG4-REG02: Journey runtime ไม่เขียน canonical Contact Governance state และไม่เห็น approval internals', async () => {
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
      /Cg4Exception(?!s)|Cg4Policy(?!Id)|Cg4Quorum|Cg4Authorization|approvalDigest|quorum/,
      `${file} ต้องรับเฉพาะ final Governance result ไม่ใช่ approval/exception internals`,
    );
  }
});

test('CG4-REG02: J2 internal actions ไม่เรียก authorizeAndReserve มีเพียง direct SEND ที่ขอ reservation', async () => {
  const sources = await runtimeSources();
  const reserving = sources
    .filter(({ content }) => /\.authorizeAndReserve\(/.test(content))
    .map(({ file }) => file)
    .sort();
  assert.deepEqual(reserving, ['journey-processor.ts', 'journey-send-executor.ts']);
  for (const { file, content } of sources.filter(({ file }) =>
    /^journey-(owner-|outcome-trigger)/.test(file),
  )) {
    assert.doesNotMatch(
      content,
      /authorizeAndReserve|reservationId/,
      `${file} (ENSURE_CASE/ADMIT_CAMPAIGN_TARGET/SCHEDULE_CALLBACK) ต้องไม่สร้างหรือถือ reservation`,
    );
  }
});

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
