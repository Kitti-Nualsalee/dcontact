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
 * ไฟล์ของ S1 simulation (#102 §7) ระบุตรงตัว — S2 เพิ่ม provider boundary จริง (webhook server,
 * Keychain) ที่ขึ้นต้นด้วย `line-` เหมือนกัน ถ้าเลือกด้วย prefix scanner จะกวาดโค้ด S2 มาปนและ
 * ต้องผ่อน denylist ลง ซึ่งทำให้ guard ของ simulation อ่อนลงทั้งชุด
 *
 * ไม่รวม `line-evidence.ts` เอง — ไฟล์นั้นเป็น denylist/scanner ต้องเก็บ token ต้องห้าม
 * ไว้เป็น string literal เพื่อตรวจไฟล์อื่น การมี token เหล่านั้นในตัวเองไม่ใช่การใช้งานจริง
 */
const S1_SIMULATION_SOURCES = [
  'line-caps-tracker.ts',
  'line-cg3-facts.ts',
  'line-delivery-port.ts',
  'line-delivery-store.ts',
  'line-id-factory.ts',
  'line-manual-clock.ts',
  'line-rollout-gate.ts',
  'line-simulation-fixture.ts',
  'line-simulation-harness.ts',
] as const;

function readLineSimulationSourceFiles(): string[] {
  return S1_SIMULATION_SOURCES.map((name) => readFileSync(join(SRC_DIR, name), 'utf8'));
}

/** source ของ S2 ทุกไฟล์ (ไม่รวมเทสต์) — แตะ provider ได้ แต่ห้ามมี marker, SDK หรือ secret จาก env */
function readLineS2SourceFiles(): Array<[string, string]> {
  const simulation = new Set<string>([...S1_SIMULATION_SOURCES, 'line-evidence.ts']);
  return readdirSync(SRC_DIR)
    .filter(
      (name) =>
        name.startsWith('line-') &&
        name.endsWith('.ts') &&
        !name.includes('.test.') &&
        !name.includes('.integration.') &&
        !simulation.has(name),
    )
    .map((name) => [name, readFileSync(join(SRC_DIR, name), 'utf8')]);
}

test('S1 simulation list ยังชี้ไฟล์ที่มีอยู่จริงทุกไฟล์ ไม่มีไฟล์หายจาก scan เงียบ ๆ', () => {
  const present = new Set(readdirSync(SRC_DIR));
  for (const name of S1_SIMULATION_SOURCES) assert.ok(present.has(name), name);
});

test('S2 provider boundary ไม่มี pilot marker, LINE SDK หรือการอ่าน secret จาก env', () => {
  const sources = readLineS2SourceFiles();
  assert.ok(sources.some(([name]) => name === 'line-webhook-server.ts'));
  for (const [name, source] of sources) {
    assert.ok(!source.includes(FORBIDDEN_PILOT_MARKER), name);
    assert.doesNotMatch(source, /@line\/bot-sdk|line-bot-sdk/, name);
    // env มีได้แค่ชื่อ Keychain service (`*_KEYCHAIN_SERVICE`) ไม่ใช่ค่า secret/token
    assert.doesNotMatch(
      source,
      /env\.LINE_CHANNEL_(SECRET|ACCESS_TOKEN)(?!_KEYCHAIN_SERVICE)\b/,
      name,
    );
  }
});

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
