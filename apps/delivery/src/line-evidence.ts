/**
 * Owner: Delivery/Channels — evidence manifest ของ LINE in-memory simulation (S1.6, decision #102 §7)
 *
 * marker เดียวที่ออกได้คือ `LINE_IN_MEMORY_SIMULATION_ACCEPTED` พร้อม flag ทั้งสี่คงที่
 * ห้ามอ้างหรือออก `OUTBOUND_DELIVERY_LINE_PILOT_READY` จาก manifest นี้เด็ดขาด
 */
import { createHash } from 'node:crypto';
import { LINE_SIMULATION_PROFILE, PILOT_SCOPE } from './line-simulation-fixture.js';
import type { LineDeliveryEvidence } from './line-delivery-port.js';

export const LINE_SIMULATION_MARKER = 'LINE_IN_MEMORY_SIMULATION_ACCEPTED';
export const FORBIDDEN_PILOT_MARKER = 'OUTBOUND_DELIVERY_LINE_PILOT_READY';

export const LINE_SIMULATION_FLAGS = {
  simulationOnly: true,
  actualProviderTraffic: false,
  providerConformance: false,
  accountEvidence: false,
} as const;

/** dependency/credential/network token ที่ manifest/source ต้อง "ไม่พบ" เด็ดขาด */
const FORBIDDEN_TOKENS = [
  '@line/bot-sdk',
  'line-bot-sdk',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  "require('http')",
  'require("http")',
  "from 'node:http'",
  'from "node:http"',
  "from 'node:https'",
  "from 'node:net'",
  "from 'node:dns'",
  'fetch(',
  'XMLHttpRequest',
  FORBIDDEN_PILOT_MARKER,
] as const;

export interface LineNegativeScanResult {
  forbiddenTokensFound: string[];
  clean: boolean;
}

/** pure text scan — caller (test) ป้อน source ไฟล์จริงเข้ามาเอง ไม่มี fs I/O ในโมดูลนี้ */
export function scanForForbiddenTokens(sourceTexts: readonly string[]): LineNegativeScanResult {
  const found = new Set<string>();
  for (const text of sourceTexts) {
    for (const token of FORBIDDEN_TOKENS) {
      if (text.includes(token)) found.add(token);
    }
  }
  return { forbiddenTokensFound: [...found], clean: found.size === 0 };
}

export interface LineSimulationManifest {
  marker: typeof LINE_SIMULATION_MARKER;
  profile: string;
  baselineRef: string;
  scope: typeof PILOT_SCOPE;
  checkIds: string[];
  configDigest: string;
  evidenceHash: string;
  flags: typeof LINE_SIMULATION_FLAGS;
  negativeScan: LineNegativeScanResult;
  evidenceCount: number;
}

function digestOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export interface BuildLineManifestInput {
  baselineRef: string;
  checkIds: string[];
  evidence: LineDeliveryEvidence[];
  negativeScan: LineNegativeScanResult;
}

/**
 * evidenceHash ครอบ evidence ทุกใบแบบ sorted-by-deliveryId เพื่อให้ scenario เดิม
 * (seed/config เดิม) ให้ hash เดิมซ้ำได้ทุกครั้งไม่ว่าจะรันกี่รอบ — ดู #102 §5 restart/replay
 */
export function buildLineSimulationManifest(input: BuildLineManifestInput): LineSimulationManifest {
  if (!input.negativeScan.clean) {
    throw new Error(
      `ออก manifest ไม่ได้: negative scan พบ forbidden token ${input.negativeScan.forbiddenTokensFound.join(', ')}`,
    );
  }
  const sortedEvidence = [...input.evidence].sort((a, b) =>
    a.deliveryId.localeCompare(b.deliveryId),
  );
  return {
    marker: LINE_SIMULATION_MARKER,
    profile: LINE_SIMULATION_PROFILE,
    baselineRef: input.baselineRef,
    scope: PILOT_SCOPE,
    checkIds: input.checkIds,
    configDigest: digestOf({ profile: LINE_SIMULATION_PROFILE, scope: PILOT_SCOPE }),
    evidenceHash: digestOf(sortedEvidence),
    flags: LINE_SIMULATION_FLAGS,
    negativeScan: input.negativeScan,
    evidenceCount: sortedEvidence.length,
  };
}
