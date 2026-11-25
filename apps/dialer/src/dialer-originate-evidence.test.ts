import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DIALER_ORIGINATE_SIMULATION_FLAGS,
  NEGATIVE_SCAN_EXEMPT_FILES,
  scanForForbiddenDependencies,
  scanForForbiddenTelephonyTokens,
} from './dialer-originate-evidence.js';

const SOURCE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));

/**
 * Walks every file in the real folder instead of hardcoding a list — it used to scan only 3 hand-picked files,
 * so new files in `apps/dialer/src` were never checked, which left a gap for adding a path to the provider
 * with nothing to catch it.
 */
function scannedSourceFiles(): string[] {
  return readdirSync(SOURCE_DIRECTORY)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !NEGATIVE_SCAN_EXEMPT_FILES.includes(name as never))
    .sort();
}

function readSource(filename: string): string {
  return readFileSync(fileURLToPath(new URL(filename, import.meta.url)), 'utf8');
}

test('no file in apps/dialer/src has a provider SDK, credential or network primitive', () => {
  const files = scannedSourceFiles();
  // Guards against the glob silently breaking and passing because nothing was scanned
  assert.ok(files.length >= 10, `expected to scan at least 10 files but got ${files.length}`);

  const result = scanForForbiddenTelephonyTokens(files.map(readSource));
  assert.deepEqual(result.forbiddenTokensFound, []);
  assert.equal(result.clean, true);
});

test('the exemption list may contain only the evidence module and its own test', () => {
  assert.deepEqual([...NEGATIVE_SCAN_EXEMPT_FILES].sort(), [
    'dialer-originate-evidence.test.ts',
    'dialer-originate-evidence.ts',
  ]);
});

test('the scan really catches an injected marker (mutation test against false signals)', () => {
  const result = scanForForbiddenTelephonyTokens([
    ...scannedSourceFiles().map(readSource),
    "import twilio from 'twilio';",
  ]);
  assert.equal(result.clean, false);
  assert.ok(result.forbiddenTokensFound.includes('twilio'));
});

test('the scan really catches an injected network primitive', () => {
  const result = scanForForbiddenTelephonyTokens(["import { Socket } from 'node:net';"]);
  assert.equal(result.clean, false);
  assert.ok(result.forbiddenTokensFound.includes("from 'node:net'"));
});

test('the dialer package.json declares no provider SDK at all', () => {
  const manifest = JSON.parse(readSource('../package.json')) as {
    dependencies?: Record<string, string>;
  };
  const result = scanForForbiddenDependencies(manifest);
  assert.deepEqual(result.forbiddenDependenciesFound, []);
  assert.equal(result.clean, true);
});

test('the dependency scan catches a declared SDK even if nobody imports it yet', () => {
  const result = scanForForbiddenDependencies({
    dependencies: { '@d-contact/db': 'workspace:*', twilio: '^5.0.0' },
  });
  assert.equal(result.clean, false);
  assert.deepEqual(result.forbiddenDependenciesFound, ['twilio']);
});

test('simulation flags always keep actualProviderTraffic=false', () => {
  assert.equal(DIALER_ORIGINATE_SIMULATION_FLAGS.actualProviderTraffic, false);
  assert.equal(DIALER_ORIGINATE_SIMULATION_FLAGS.providerConformance, false);
  assert.equal(DIALER_ORIGINATE_SIMULATION_FLAGS.releaseEnabled, false);
});
