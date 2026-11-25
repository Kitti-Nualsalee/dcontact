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

test('CG4-REG02: Journey runtime does not write canonical Contact Governance state or see approval internals', async () => {
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
      /Cg4Exception(?!s)|Cg4Policy(?!Id)|Cg4Quorum|Cg4Authorization|approvalDigest|quorum/,
      `${file} must accept only the final Governance result, not approval/exception internals`,
    );
  }
});

test('CG4-REG02: J2 internal actions do not call authorizeAndReserve; only direct SEND requests a reservation', async () => {
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
      `${file} (ENSURE_CASE/ADMIT_CAMPAIGN_TARGET/SCHEDULE_CALLBACK) must not create or hold a reservation`,
    );
  }
});

test('Journey runtime source has no direct import of the Contact Governance app', async () => {
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
      `${file} must depend on ContactAuthorizationPort instead of the concrete app`,
    );
  }
});
