import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPiiSafeEvidence, sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * S2.6 (#366): negative scans of the LINE pilot - `S2-LINE-OB02` (#360 §B/§E/§H)
 *
 * covers four layers: source, runtime log (the output of the suites readiness runs), artifact (manifest/bundle)
 * and the field name denylist of evidence. Any finding makes the check fail; there is no runtime waiver
 * a false positive can be excepted only by a reviewed `path + rule` in `S2_SCAN_ALLOWLIST` with a reason
 */
export const S2_PILOT_MARKER = 'OUTBOUND_DELIVERY_LINE_PILOT_READY';

/**
 * mirror of `LINE_FORBIDDEN_EVIDENCE_FIELDS` (packages/cxa-contracts/src/line-delivery.ts)
 * - a test checks that the two lists always match, because a script cannot read TypeScript directly
 */
export const S2_FORBIDDEN_FIELD_NAMES = Object.freeze([
  'userId',
  'recipient',
  'to',
  'text',
  'body',
  'messages',
  'replyToken',
  'quoteToken',
  'postbackData',
  'accessToken',
  'channelAccessToken',
  'channelSecret',
  'signature',
  'x-line-signature',
  'authorization',
]);

/** Values that must not appear in evidence/logs no matter which field name they sit under */
export const S2_LEAK_PATTERNS = Object.freeze([
  { rule: 'raw-line-id', pattern: /\b[UCR][0-9a-f]{32}\b/ },
  { rule: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9+/=._-]{16,}/ },
  { rule: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  // a LINE long-lived channel access token is a long base64 string, about 172 characters
  { rule: 'long-token', pattern: /[A-Za-z0-9+/]{100,}={0,2}/ },
  {
    rule: 'line-signature-value',
    pattern: /x-line-signature['"]?\s*[:=]\s*['"]?[A-Za-z0-9+/]{43}=/i,
  },
]);

/** Return the name of the rule found in the text - not the value found, so the report does not become a leak itself */
export function scanTextForS2Leaks(text) {
  return S2_LEAK_PATTERNS.filter(({ pattern }) => pattern.test(String(text))).map(
    ({ rule }) => rule,
  );
}

const forbiddenFields = new Set(S2_FORBIDDEN_FIELD_NAMES.map((name) => name.toLowerCase()));

/**
 * digests/SHAs/UUIDs are pure hex so they cannot carry PII, but a purely numeric tail can collide with the C1 phone number pattern
 * at random (~0.15% per value) - a manifest with dozens of digests would fail flakily, so mask them before passing to C1
 */
const OPAQUE_HEX =
  /^(?:[0-9a-f]{40}|[0-9a-f]{64}|(?:local-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function maskOpaqueHex(value) {
  if (Array.isArray(value)) return value.map(maskOpaqueHex);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, maskOpaqueHex(nested)]),
    );
  return typeof value === 'string' && OPAQUE_HEX.test(value) ? '[hex]' : value;
}

/**
 * Gate for artifacts/manifests/bundles: the C1 denylist (general PII) + forbidden LINE field names +
 * LINE ID/token patterns in every string value. Throws with the path only, never the value
 */
export function assertS2EvidenceSafe(value) {
  assertPiiSafeEvidence(maskOpaqueHex(value));
  const visit = (candidate, path) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (candidate && typeof candidate === 'object') {
      for (const [key, nested] of Object.entries(candidate)) {
        if (forbiddenFields.has(key.toLowerCase()))
          throw new TypeError(`S2 evidence has a forbidden field: ${path}.${key}`);
        visit(nested, `${path}.${key}`);
      }
      return;
    }
    if (typeof candidate === 'string' && scanTextForS2Leaks(candidate).length > 0)
      throw new TypeError(`S2 evidence has a LINE ID or credential at ${path}`);
  };
  visit(value, '$');
}

export const S2_SCAN_ALLOWLIST = Object.freeze([
  {
    path: 'apps/delivery/src/line-evidence.ts',
    rule: 'hard-coded-marker',
    reason:
      'the S1 simulation denylist keeps the marker name to confirm that manifest must not issue a marker',
  },
  {
    path: 'apps/delivery/src/line-evidence.ts',
    rule: 'sdk-import',
    reason:
      'the S1 simulation denylist keeps the SDK name as a string to scan other files, it does not import it',
  },
  {
    path: 'apps/delivery/src/line-persistence-fixture.ts',
    rule: 'env-read',
    reason:
      'an integration test fixture (not in the build) reads only the database URL of the test role',
  },
  {
    path: 'apps/delivery/src/line-outbound-adapter.integration.ts',
    rule: 'secret-assignment',
    reason:
      'synthetic token of a provider double - not a real credential and never leaves the process',
  },
  {
    path: 'apps/delivery/src/line-pilot-wiring.integration.ts',
    rule: 'secret-assignment',
    reason:
      'synthetic token of the credential resolver double in a wiring test - not a real credential',
  },
  {
    path: 'apps/delivery/src/line-team-trial.integration.ts',
    rule: 'secret-assignment',
    reason:
      '#567: synthetic token of the credential resolver double in a trial integration - not a real credential',
  },
  {
    path: 'apps/delivery/src/line-pilot-cli.ts',
    rule: 'env-read',
    reason:
      'the capped pilot CLI reads only references (tenant/credential ref/sender/payload key ref) from env, no secret',
  },
  {
    path: 'apps/delivery/src/line-pilot-setup.ts',
    rule: 'env-read',
    reason:
      'pilot setup reads only references (tenant/sender/actor refs) from env; the token is read from the Keychain',
  },
  {
    path: 'apps/delivery/src/line-provider-runner.ts',
    rule: 'env-read',
    reason:
      'the protected runner CLI reads only references (tenant/credential ref/endpoint digest) from env, no secret',
  },
  {
    path: 'apps/delivery/src/line-pilot-runtime.ts',
    rule: 'env-read',
    reason:
      '#565: picks the secret source mode and the runner path/release SHA from env - the secret is read only from the Keychain or a file',
  },
  {
    path: 'apps/api/src/line-webhook-app.ts',
    rule: 'env-read',
    reason:
      '#565: the composition root of line-webhook (profile uat-line) reads the mode/references from env - the secret comes from a file, and it is scanned as a composition root',
  },
]);

function list(directory, pattern, keep = () => true) {
  const absolute = resolve(repositoryRoot, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((name) => pattern.test(name) && keep(name))
    .map((name) => `${directory}/${name}`)
    .sort();
}

const isTest = (name) => /\.(test|integration)\.ts$/.test(name);

export function s2ScanTargets() {
  return {
    sources: [
      ...list('apps/delivery/src', /^line-.*\.ts$/, (name) => !isTest(name)),
      ...list('apps/api/src', /^line-webhook.*\.ts$/, (name) => !isTest(name)),
      'packages/cxa-contracts/src/line-delivery.ts',
    ],
    tests: [
      ...list('apps/delivery/src', /^line-.*\.(test|integration)\.ts$/),
      ...list('apps/api/src', /^line-webhook.*\.integration\.ts$/),
      ...list('apps/contact-governance/src', /^correlated-touch\.integration\.ts$/),
      ...list('packages/cxa-contracts/src', /^line-delivery\.test\.ts$/),
    ],
    readiness: list('scripts', /^cxa-s2-.*\.mjs$/, (name) => !name.endsWith('.test.mjs')),
    workflows: list('.github/workflows', /^ci\.yml$/),
    // S2.6b (#403): the place that assembles the real binding must not accept a LINE secret from env (#362 §9)
    // #565: line-webhook on UAT is the second composition root of the real binding
    compositionRoots: ['apps/api/src/main.ts', 'apps/api/src/line-webhook-app.ts', '.env.example'],
  };
}

const RULES = {
  'credential-literal': (text) =>
    scanTextForS2Leaks(text)
      .filter((rule) => rule !== 'raw-line-id')
      .map((rule) => `credential pattern: ${rule}`),
  'raw-line-id': (text) =>
    scanTextForS2Leaks(text).includes('raw-line-id') ? ['raw LINE user/group/room ID'] : [],
  'secret-assignment': (text) =>
    /\b(?:channelSecret|accessToken|channelAccessToken)\s*[:=]\s*['"`][^'"`]{8,}['"`]/.test(text)
      ? ['secret literal assignment']
      : [],
  'env-read': (text) => (/process\.env\b/.test(text) ? ['reads process.env'] : []),
  'sdk-import': (text) => (/@line\/bot-sdk|line-bot-sdk/.test(text) ? ['LINE SDK dependency'] : []),
  'hard-coded-marker': (text) => (text.includes(S2_PILOT_MARKER) ? ['S2 marker literal'] : []),
  'skipped-test': (text) =>
    /\b(?:test|it|describe)\.(?:only|skip|todo)\s*\(|\{\s*(?:skip|todo|only)\s*:\s*true/.test(text)
      ? ['skipped/only/todo']
      : [],
  'line-secret-env': (text) =>
    /LINE_CHANNEL_SECRET|LINE_CHANNEL_ACCESS_TOKEN|LINE_WEBHOOK_PAYLOAD_KEY(?!_REF)/.test(text)
      ? ['LINE secret via env']
      : [],
  // secrets must not be passed as a workflow input/secret; the runner reads the Keychain on its own machine
  'workflow-secret': (text) =>
    /secrets\.LINE_|LINE_CHANNEL_(?:ACCESS_TOKEN|SECRET)/.test(text)
      ? ['LINE credential via GitHub Actions']
      : [],
};

export function cxaS2NegativeScan(options = {}) {
  const read = options.read ?? ((path) => readFileSync(resolve(repositoryRoot, path), 'utf8'));
  const targets = options.targets ?? s2ScanTargets();
  const allowlist = options.allowlist ?? S2_SCAN_ALLOWLIST;
  const allow = new Set(allowlist.map(({ path, rule }) => `${path}|${rule}`));
  const plan = [
    [
      targets.sources,
      [
        'credential-literal',
        'raw-line-id',
        'secret-assignment',
        'env-read',
        'sdk-import',
        'hard-coded-marker',
      ],
    ],
    [targets.tests, ['skipped-test', 'credential-literal', 'secret-assignment', 'sdk-import']],
    [targets.readiness, ['credential-literal', 'raw-line-id', 'secret-assignment']],
    [targets.workflows, ['workflow-secret', 'credential-literal']],
    [targets.compositionRoots ?? [], ['line-secret-env', 'credential-literal']],
  ];
  const violations = [];
  const scanned = new Map();
  for (const [paths, rules] of plan) {
    for (const path of paths) {
      const text = read(path);
      scanned.set(path, sha256(text));
      for (const rule of rules) {
        if (allow.has(`${path}|${rule}`)) continue;
        for (const detail of RULES[rule](text)) violations.push({ path, rule, detail });
      }
    }
  }

  // an incoming artifact (an earlier bundle/manifest) must pass the same evidence guard as the manifest
  const artifacts = (options.artifacts ?? []).map(({ path, value }) => {
    try {
      assertS2EvidenceSafe(value);
      return { path, status: 'PASS' };
    } catch (error) {
      violations.push({ path, rule: 'artifact-evidence', detail: error.message });
      return { path, status: 'FAIL' };
    }
  });

  const requiredGroups = ['sources', 'tests', 'readiness', 'workflows', 'compositionRoots'];
  const empty = requiredGroups.filter((group) => (targets[group] ?? []).length === 0);
  return {
    type: 'negative-scan.readiness',
    workflow: 'cxa-s2-negative-scan',
    status: violations.length === 0 && empty.length === 0 ? 'PASS' : 'FAIL',
    files: scanned.size,
    filesSha256: sha256([...scanned.entries()].sort(([a], [b]) => a.localeCompare(b))),
    layers: {
      source: targets.sources.length,
      tests: targets.tests.length,
      workflows: targets.workflows.length,
      compositionRoots: (targets.compositionRoots ?? []).length,
      artifacts: artifacts.length,
    },
    emptyGroups: empty,
    allowlist: allowlist.map(({ path, rule }) => ({ path, rule })),
    violations: violations.slice(0, 50),
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const summary = cxaS2NegativeScan();
  process.stdout.write(`CXA_S2_SCAN_EVIDENCE:${JSON.stringify(summary)}\n`);
  if (summary.status !== 'PASS') {
    for (const { path, rule, detail } of summary.violations)
      process.stderr.write(`${path}: ${rule}: ${detail}\n`);
    if (summary.emptyGroups.length > 0)
      process.stderr.write(`no files found in the group: ${summary.emptyGroups.join(', ')}\n`);
    process.exitCode = 1;
  }
}
