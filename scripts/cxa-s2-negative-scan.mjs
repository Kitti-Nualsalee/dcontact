import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPiiSafeEvidence, sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * S2.6 (#366): negative scans ของ LINE pilot — `S2-LINE-OB02` (#360 §B/§E/§H)
 *
 * ครอบสี่ชั้น: source, runtime log (output ของ suite ที่ readiness รัน), artifact (manifest/bundle)
 * และ field name denylist ของ evidence. พบรายการใดให้ check ล้ม ไม่มี runtime waiver
 * false positive ยกเว้นได้เฉพาะ `path + rule` ที่ review แล้วใน `S2_SCAN_ALLOWLIST` พร้อมเหตุผล
 */
export const S2_PILOT_MARKER = 'OUTBOUND_DELIVERY_LINE_PILOT_READY';

/**
 * mirror ของ `LINE_FORBIDDEN_EVIDENCE_FIELDS` (packages/cxa-contracts/src/line-delivery.ts)
 * — test ตรวจว่าสองรายการนี้ตรงกันเสมอ เพราะ script อ่าน TypeScript ตรง ๆ ไม่ได้
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

/** ค่าที่ห้ามปรากฏใน evidence/log ไม่ว่าจะอยู่ใต้ field ชื่ออะไร */
export const S2_LEAK_PATTERNS = Object.freeze([
  { rule: 'raw-line-id', pattern: /\b[UCR][0-9a-f]{32}\b/ },
  { rule: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9+/=._-]{16,}/ },
  { rule: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  // long-lived channel access token ของ LINE เป็น base64 ยาว ~172 ตัว
  { rule: 'long-token', pattern: /[A-Za-z0-9+/]{100,}={0,2}/ },
  {
    rule: 'line-signature-value',
    pattern: /x-line-signature['"]?\s*[:=]\s*['"]?[A-Za-z0-9+/]{43}=/i,
  },
]);

/** คืนชื่อ rule ที่พบใน text — ไม่คืนค่าที่พบ เพื่อไม่ให้รายงานกลายเป็นช่องรั่วเสียเอง */
export function scanTextForS2Leaks(text) {
  return S2_LEAK_PATTERNS.filter(({ pattern }) => pattern.test(String(text))).map(
    ({ rule }) => rule,
  );
}

const forbiddenFields = new Set(S2_FORBIDDEN_FIELD_NAMES.map((name) => name.toLowerCase()));

/**
 * digest/SHA/UUID เป็น hex ล้วนจึงพา PII ไม่ได้ แต่ท้ายค่าที่เป็นเลขล้วนชน pattern เบอร์โทรของ C1
 * ได้แบบสุ่ม (~0.15% ต่อค่า) — manifest ที่มี digest หลายสิบตัวจะล้มแบบ flaky จึง mask ก่อนส่งเข้า C1
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
 * ด่านของ artifact/manifest/bundle: denylist ของ C1 (PII ทั่วไป) + ชื่อ field ต้องห้ามของ LINE +
 * pattern ของ LINE ID/token ในทุก string value. throw พร้อม path เท่านั้น ไม่มีค่า
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
          throw new TypeError(`S2 evidence มี field ต้องห้าม: ${path}.${key}`);
        visit(nested, `${path}.${key}`);
      }
      return;
    }
    if (typeof candidate === 'string' && scanTextForS2Leaks(candidate).length > 0)
      throw new TypeError(`S2 evidence มี LINE ID หรือ credential ที่ตำแหน่ง ${path}`);
  };
  visit(value, '$');
}

export const S2_SCAN_ALLOWLIST = Object.freeze([
  {
    path: 'apps/delivery/src/line-evidence.ts',
    rule: 'hard-coded-marker',
    reason:
      'denylist ของ S1 simulation เก็บชื่อ marker ไว้เพื่อยืนยันว่า manifest นั้นห้ามออก marker',
  },
  {
    path: 'apps/delivery/src/line-evidence.ts',
    rule: 'sdk-import',
    reason:
      'denylist ของ S1 simulation เก็บชื่อ SDK ไว้เป็น string เพื่อสแกนไฟล์อื่น ไม่ได้ import',
  },
  {
    path: 'apps/delivery/src/line-persistence-fixture.ts',
    rule: 'env-read',
    reason: 'fixture ของ integration test (ไม่อยู่ใน build) อ่านแค่ database URL ของ test role',
  },
  {
    path: 'apps/delivery/src/line-outbound-adapter.integration.ts',
    rule: 'secret-assignment',
    reason: 'token สังเคราะห์ของ provider double — ไม่ใช่ credential จริงและไม่ออกนอก process',
  },
  {
    path: 'apps/delivery/src/line-pilot-wiring.integration.ts',
    rule: 'secret-assignment',
    reason:
      'token สังเคราะห์ของ credential resolver double ใน wiring test — ไม่ใช่ credential จริง',
  },
  {
    path: 'apps/delivery/src/line-pilot-cli.ts',
    rule: 'env-read',
    reason:
      'CLI ของ capped pilot อ่านเฉพาะ reference (tenant/credential ref/sender/payload key ref) จาก env ไม่มี secret',
  },
  {
    path: 'apps/delivery/src/line-provider-runner.ts',
    rule: 'env-read',
    reason:
      'CLI ของ protected runner อ่านเฉพาะ reference (tenant/credential ref/endpoint digest) จาก env ไม่มี secret',
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
    // S2.6b (#403): ที่ประกอบ binding จริงต้องไม่รับ LINE secret จาก env (#362 §9)
    compositionRoots: ['apps/api/src/main.ts', '.env.example'],
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
      ? ['LINE secret ผ่าน env']
      : [],
  // ข้อมูลลับต้องไม่ถูกส่งเป็น input/secret ของ workflow; runner อ่าน Keychain บนเครื่องเอง
  'workflow-secret': (text) =>
    /secrets\.LINE_|LINE_CHANNEL_(?:ACCESS_TOKEN|SECRET)/.test(text)
      ? ['LINE credential ผ่าน GitHub Actions']
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

  // artifact ที่ส่งเข้ามา (bundle/manifest ก่อนหน้า) ต้องผ่าน evidence guard เดียวกับ manifest
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
      process.stderr.write(`ไม่พบไฟล์ในกลุ่ม: ${summary.emptyGroups.join(', ')}\n`);
    process.exitCode = 1;
  }
}
