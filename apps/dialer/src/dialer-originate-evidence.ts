/**
 * J2.9 — negative-scan evidence for the Dialer originate barrier (mirrors
 * `apps/delivery/src/line-evidence.ts`'s pattern). Proves that the source of the barrier/
 * transport has no telephony provider SDK, ESL client, credential env var or
 * any network primitive — the hard boundary `actualProviderTraffic=false`
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

/** Pure text scan — the caller (a test) feeds in the real file source itself; there is no fs I/O in this module */
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

/** An SDK that is merely "declared" already crosses the boundary, because it is really installed and importable at once */
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
 * Checks dependencies declared in package.json — FORBIDDEN_TOKENS only catches when someone
 * really imports, but merely adding a dependency already opens the way, so another layer of checking is needed
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
 * Files that may be exempt from the negative scan — only this module and its own test, because they must keep
 * the denylist as literal strings; without the exemption they would always match themselves
 *
 * This list must not grow: every other file in `apps/dialer/src` must always be scanned, otherwise
 * adding a new file becomes a shortcut across the boundary that nobody notices
 */
export const NEGATIVE_SCAN_EXEMPT_FILES = [
  'dialer-originate-evidence.ts',
  'dialer-originate-evidence.test.ts',
] as const;
