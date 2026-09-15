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

/** SDK ที่ "ประกาศไว้" ก็นับว่าเลย boundary แล้ว เพราะติดตั้งอยู่จริงและ import ได้ทันที */
const FORBIDDEN_DEPENDENCY_PREFIXES = [
  'twilio',
  '@twilio/',
  'nexmo',
  '@vonage/',
  'plivo',
  '@sinch/',
  'telnyx',
  'bandwidth',
  'messagebird',
  'infobip',
  '@ringcentral',
  '@aws-sdk/client-connect',
  '@aws-sdk/client-chime',
  'asterisk-manager',
  'modesl',
  'esl',
  'esl-lite',
  'drachtio-srf',
  'sip.js',
  'jssip',
] as const;

export interface DialerDependencyScanResult {
  forbiddenDependenciesFound: string[];
  clean: boolean;
}

/**
 * ตรวจ dependency ที่ประกาศใน package.json — FORBIDDEN_TOKENS จับได้เฉพาะตอนมีคน
 * import จริง แต่แค่เพิ่ม dependency ก็เปิดทางไว้แล้ว จึงต้องตรวจอีกชั้น
 */
export function scanForForbiddenDependencies(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): DialerDependencyScanResult {
  const declared = Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  });
  const found = declared.filter((name) =>
    FORBIDDEN_DEPENDENCY_PREFIXES.some(
      (prefix) => name === prefix || name.startsWith(`${prefix}/`) || name.startsWith(prefix),
    ),
  );
  return { forbiddenDependenciesFound: found, clean: found.length === 0 };
}

/**
 * ไฟล์ที่ยกเว้นจาก negative scan ได้ — มีแค่โมดูลนี้กับ test ของมันเอง เพราะต้องเก็บ
 * denylist ไว้เป็น string ตรง ๆ ถ้าไม่ยกเว้นจะ match ตัวเองตลอด
 *
 * รายการนี้ต้องไม่โตขึ้น: ทุกไฟล์อื่นใน `apps/dialer/src` ต้องถูก scan เสมอ ไม่งั้นการ
 * เพิ่มไฟล์ใหม่จะกลายเป็นทางลัดข้าม boundary โดยไม่มีใครรู้
 */
export const NEGATIVE_SCAN_EXEMPT_FILES = [
  'dialer-originate-evidence.ts',
  'dialer-originate-evidence.test.ts',
] as const;
