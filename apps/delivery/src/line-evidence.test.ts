/**
 * S1.6 acceptance: S1-LINE-SIM03 — negative source scan และ manifest/marker/flags ตาม #102 §7
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  FORBIDDEN_PILOT_MARKER,
  LINE_SIMULATION_FLAGS,
  LINE_SIMULATION_MARKER,
  buildLineSimulationManifest,
  scanForForbiddenTokens,
} from './line-evidence.js';
import type { LineDeliveryEvidence } from './line-delivery-port.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * ไม่รวม `line-evidence.ts` เอง — ไฟล์นั้นเป็น denylist/scanner ต้องเก็บ token ต้องห้าม
 * ไว้เป็น string literal เพื่อตรวจไฟล์อื่น การมี token เหล่านั้นในตัวเองไม่ใช่การใช้งานจริง
 */
function readLineSimulationSourceFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter(
      (name) =>
        name.startsWith('line-') &&
        name.endsWith('.ts') &&
        !name.includes('.test.') &&
        name !== 'line-evidence.ts',
    )
    .map((name) => readFileSync(join(SRC_DIR, name), 'utf8'));
}

test('LINE simulation source contains no SDK, credential, or network dependency', () => {
  const result = scanForForbiddenTokens(readLineSimulationSourceFiles());
  assert.deepEqual(result.forbiddenTokensFound, []);
  assert.equal(result.clean, true);
});

test('scanForForbiddenTokens flags the forbidden pilot-ready marker if it ever appears', () => {
  const result = scanForForbiddenTokens([`export const readiness = '${FORBIDDEN_PILOT_MARKER}';`]);
  assert.equal(result.clean, false);
  assert.deepEqual(result.forbiddenTokensFound, [FORBIDDEN_PILOT_MARKER]);
});

test('manifest carries the frozen flags and never the forbidden pilot-ready marker', () => {
  const evidence: LineDeliveryEvidence[] = [
    {
      tenantId: 'tenant-line-pilot',
      deliveryId: 'line-dlv_a',
      providerRequestKey: 'line-prq_a',
      reservationId: 'line-reservation-a',
      actionKey: 'line-action-a',
      channel: 'LINE',
      state: 'SETTLED',
      outcome: 'DELIVERED',
      outcomeRef: 'line-ocr_a',
      dryRun: false,
      createdAt: '2026-09-10T09:00:00.000Z',
      claimedAt: '2026-09-10T09:00:01.000Z',
      submittedAt: '2026-09-10T09:00:02.000Z',
      settledAt: '2026-09-10T09:00:03.000Z',
      correlationId: 'corr-a',
    },
  ];
  const scan = scanForForbiddenTokens(readLineSimulationSourceFiles());
  const manifest = buildLineSimulationManifest({
    baselineRef: 'main@deadbeef',
    checkIds: ['S1-LINE-SIM01', 'S1-LINE-SIM02', 'S1-LINE-SIM03'],
    evidence,
    negativeScan: scan,
  });

  assert.equal(manifest.marker, LINE_SIMULATION_MARKER);
  assert.deepEqual(manifest.flags, LINE_SIMULATION_FLAGS);
  assert.equal(manifest.flags.simulationOnly, true);
  assert.equal(manifest.flags.actualProviderTraffic, false);
  assert.equal(manifest.flags.providerConformance, false);
  assert.equal(manifest.flags.accountEvidence, false);
  assert.equal(JSON.stringify(manifest).includes(FORBIDDEN_PILOT_MARKER), false);
});

test('manifest evidenceHash is deterministic across identical evidence regardless of input order', () => {
  const a: LineDeliveryEvidence = {
    tenantId: 'tenant-line-pilot',
    deliveryId: 'line-dlv_a',
    providerRequestKey: 'line-prq_a',
    reservationId: 'line-reservation-a',
    actionKey: 'line-action-a',
    channel: 'LINE',
    state: 'SETTLED',
    outcome: 'DELIVERED',
    outcomeRef: 'line-ocr_a',
    dryRun: false,
    createdAt: '2026-09-10T09:00:00.000Z',
    claimedAt: null,
    submittedAt: null,
    settledAt: '2026-09-10T09:00:03.000Z',
    correlationId: 'corr-a',
  };
  const b: LineDeliveryEvidence = { ...a, deliveryId: 'line-dlv_b', outcomeRef: 'line-ocr_b' };

  const scan = { forbiddenTokensFound: [], clean: true };
  const first = buildLineSimulationManifest({
    baselineRef: 'main@deadbeef',
    checkIds: ['S1-LINE-SIM01'],
    evidence: [a, b],
    negativeScan: scan,
  });
  const second = buildLineSimulationManifest({
    baselineRef: 'main@deadbeef',
    checkIds: ['S1-LINE-SIM01'],
    evidence: [b, a],
    negativeScan: scan,
  });
  assert.equal(first.evidenceHash, second.evidenceHash);
});

test('manifest refuses to build when the negative scan is not clean', () => {
  const scan = scanForForbiddenTokens([FORBIDDEN_PILOT_MARKER]);
  assert.throws(() =>
    buildLineSimulationManifest({
      baselineRef: 'main@deadbeef',
      checkIds: ['S1-LINE-SIM03'],
      evidence: [],
      negativeScan: scan,
    }),
  );
});
