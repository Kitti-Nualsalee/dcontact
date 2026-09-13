/**
 * J2.9 — negative-scan evidence สำหรับ Dialer originate barrier (mirrors
 * `apps/delivery/src/line-evidence.ts`'s pattern). พิสูจน์ว่า source ของ barrier/
 * transport ไม่มี telephony provider SDK, ESL client, credential env var หรือ
 * network primitive ใด ๆ — hard boundary `actualProviderTraffic=false`
 */
export const DIALER_ORIGINATE_SIMULATION_FLAGS = {
  simulationOnly: true,
  actualProviderTraffic: false,
  providerConformance: false,
  releaseEnabled: false,
} as const;

const FORBIDDEN_TOKENS = [
  // real telephony/ESL client libraries
  'modesl',
  'esl-lite',
  "require('esl')",
  'require("esl")',
  "from 'esl'",
  'from "esl"',
  // common telephony provider SDKs
  'twilio',
  'plivo',
  'vonage',
  '@ringcentral',
  // credential-shaped env vars
  'FREESWITCH_ESL_PASSWORD',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_ACCOUNT_SID',
  // raw network primitives
  "require('net')",
  'require("net")',
  "from 'node:net'",
  "from 'node:dgram'",
  "from 'node:dns'",
  "from 'node:http'",
  "from 'node:https'",
  'fetch(',
  'XMLHttpRequest',
] as const;

export interface DialerNegativeScanResult {
  forbiddenTokensFound: string[];
  clean: boolean;
}

/** pure text scan — caller (test) ป้อน source ไฟล์จริงเข้ามาเอง ไม่มี fs I/O ในโมดูลนี้ */
export function scanForForbiddenTelephonyTokens(
  sourceTexts: readonly string[],
): DialerNegativeScanResult {
  const found = new Set<string>();
  for (const text of sourceTexts) {
    for (const token of FORBIDDEN_TOKENS) {
      if (text.includes(token)) found.add(token);
    }
  }
  return { forbiddenTokensFound: [...found], clean: found.size === 0 };
}
