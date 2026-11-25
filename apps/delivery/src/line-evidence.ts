/**
 * Owner: Delivery/Channels — evidence manifest of the LINE in-memory simulation (S1.6, decision #102 §7)
 *
 * The only marker that may be emitted is `LINE_IN_MEMORY_SIMULATION_ACCEPTED` with all four flags constant.
 * Never claim or emit `OUTBOUND_DELIVERY_LINE_PILOT_READY` from this manifest
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

/** dependency/credential/network tokens that the manifest/source must absolutely "not contain" */
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

/** pure text scan — the caller (test) feeds in the real source files itself, no fs I/O in this module */
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
 * evidenceHash covers all evidence sorted by deliveryId so the same scenario
 * (same seed/config) yields the same hash every time however many runs — see #102 §5 restart/replay
 */
export function buildLineSimulationManifest(input: BuildLineManifestInput): LineSimulationManifest {
  if (!input.negativeScan.clean) {
    throw new Error(
      `cannot emit a manifest: negative scan found forbidden token ${input.negativeScan.forbiddenTokensFound.join(', ')}`,
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
