import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DIALER_ORIGINATE_SIMULATION_FLAGS,
  scanForForbiddenTelephonyTokens,
} from './dialer-originate-evidence.js';

const SCANNED_FILES = [
  'dialer-originate-barrier.ts',
  'dialer-telephony-test-transport.ts',
  'dialer-owner-barrier-gate.ts',
];

function readSource(filename: string): string {
  const path = fileURLToPath(new URL(filename, import.meta.url));
  return readFileSync(path, 'utf8');
}

test('source ของ originate barrier/transport/gate ไม่มี provider SDK, credential หรือ network primitive', () => {
  const sources = SCANNED_FILES.map(readSource);
  const result = scanForForbiddenTelephonyTokens(sources);
  assert.deepEqual(result.forbiddenTokensFound, []);
  assert.equal(result.clean, true);
});

test('scan จับ marker ที่ inject เข้าไปได้จริง (mutation test กันสัญญาณลวง)', () => {
  const sources = [...SCANNED_FILES.map(readSource), "import twilio from 'twilio';"];
  const result = scanForForbiddenTelephonyTokens(sources);
  assert.equal(result.clean, false);
  assert.ok(result.forbiddenTokensFound.includes('twilio'));
});

test('simulation flags คง actualProviderTraffic=false เสมอ', () => {
  assert.equal(DIALER_ORIGINATE_SIMULATION_FLAGS.actualProviderTraffic, false);
  assert.equal(DIALER_ORIGINATE_SIMULATION_FLAGS.providerConformance, false);
  assert.equal(DIALER_ORIGINATE_SIMULATION_FLAGS.releaseEnabled, false);
});
