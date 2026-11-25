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

test('CG4-REG02: Dialer runtime does not write canonical Contact Governance state and does not see approval internals', async () => {
  for (const { file, content } of await runtimeSources()) {
    assert.doesNotMatch(
      content,
      /\.cg[A-Z][A-Za-z0-9]*\./,
      `${file} must not access Governance tables through Prisma`,
    );
    assert.doesNotMatch(
      content,
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?cg_/i,
      `${file} must not write Governance tables with SQL`,
    );
    assert.doesNotMatch(
      content,
      /Cg4Exception|Cg4Policy|Cg4Quorum|Cg4Authorization|approvalDigest|quorum/,
      `${file} must accept only the final Governance result, not approval/exception internals`,
    );
    assert.equal(
      content.includes('@d-contact/contact-governance'),
      false,
      `${file} must depend on the Governance port through composition, not a concrete app`,
    );
  }
});

test('CG4-REG02: admission/callback scheduling does not create a reservation; only the originate barrier calls authorizeAndReserve', async () => {
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
      `${file} must not request a reservation at admit/schedule`,
    );
  }
});
