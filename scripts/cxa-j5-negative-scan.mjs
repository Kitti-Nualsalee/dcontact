import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * J5-AU02/J5-OB01 (#333 §9): J5 negative scans - any finding makes the check fail
 *
 * a false positive can be excepted only by a reviewed `path + rule` in `J5_SCAN_ALLOWLIST` with a reason;
 * there is no runtime waiver
 */
export const J5_SCAN_ALLOWLIST = Object.freeze([
  {
    path: 'apps/journey/src/journey-template-repository.integration.ts',
    rule: 'credential-literal',
    reason:
      'a negative test sends a fake secret to prove the binder rejects an undeclared parameter',
  },
  {
    path: 'apps/journey/src/journey-template.test.ts',
    rule: 'pii-literal',
    reason:
      'a negative test sends a synthetic email-shaped value to prove the binder rejects PII in a parameter',
  },
  {
    path: 'apps/api/src/journey-authoring-api.integration.ts',
    rule: 'credential-literal',
    reason:
      'a negative test confirms the error does not echo back a binding value that is a fake secret',
  },
]);

const JOURNEY_SOURCES = [
  'apps/journey/src',
  /^journey-(authoring|template)[a-z-]*\.ts$/,
  (name) => !/\.(test|integration)\.ts$/.test(name),
];
const J5_TESTS = [
  ['apps/journey/src', /^journey-(authoring|template)[a-z-]*\.(test|integration)\.ts$/],
  ['apps/api/src', /^journey-authoring-api\.integration\.ts$/],
  ['apps/console/src', /^journey-authoring\.test\.ts$/],
  ['apps/console/e2e', /^journey-authoring\.spec\.ts$/],
  ['packages/cxa-contracts/src', /^journey-(authoring|template)[a-z0-9-]*\.test\.ts$/],
];

function list(directory, pattern, keep = () => true) {
  const absolute = resolve(repositoryRoot, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((name) => pattern.test(name) && keep(name))
    .map((name) => `${directory}/${name}`)
    .sort();
}

function walk(directory, pattern) {
  const absolute = resolve(repositoryRoot, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .flatMap((name) => {
      const path = `${directory}/${name}`;
      return statSync(resolve(repositoryRoot, path)).isDirectory()
        ? walk(path, pattern)
        : pattern.test(name)
          ? [path]
          : [];
    })
    .sort();
}

export function j5ScanTargets() {
  const [journeyDirectory, journeyPattern, journeyKeep] = JOURNEY_SOURCES;
  return {
    journeySources: list(journeyDirectory, journeyPattern, journeyKeep),
    apiSources: list('apps/api/src', /^journey-(authoring|template)-api\.ts$/),
    consoleSources: walk('apps/console/src/journey-authoring', /\.(ts|tsx)$/),
    tests: J5_TESTS.flatMap(([directory, pattern]) => list(directory, pattern)),
    fixtures: [
      ...walk('apps/journey/test/fixtures/j5', /\.json$/),
      ...walk('apps/journey/templates/builtin', /\.json$/),
    ],
    bundle: walk('apps/console/dist/assets', /\.js$/),
    readiness: walk('scripts', /^cxa-j5-.*\.mjs$/),
  };
}

const CREDENTIAL =
  /\b(?:sk-(?:live|test)-[A-Za-z0-9-]+|Bearer\s+ey[A-Za-z0-9._-]+|AKIA[0-9A-Z]{16})\b/;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(?:com|net|org|co|io|th)\b/;
const PHONE = /(?<![\w-])(?:\+66|0)[689]\d{8}(?!\w)/;
const WRITE =
  /\b(?:tx|transaction|this\.database|database)\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g;

/** Each rule returns the file violations - a rule unrelated to that file group is not called */
const RULES = {
  'dynamic-code': (text) =>
    /\beval\s*\(|new\s+Function\s*\(/.test(text) ? ['eval/new Function'] : [],
  'credential-literal': (text) => (CREDENTIAL.test(text) ? ['credential/token literal'] : []),
  'pii-literal': (text) =>
    [EMAIL.test(text) ? 'email literal' : null, PHONE.test(text) ? 'phone literal' : null].filter(
      Boolean,
    ),
  'cross-owner-write': (text) =>
    [...text.matchAll(WRITE)]
      .filter(([, model]) => !/^(jr|iam)[A-Z]/.test(model))
      .map(([, model, operation]) => `${model}.${operation}`),
  'network-primitive': (text) =>
    /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|from\s+'node:(?:http|https|net)'|from\s+'kafkajs'|@d-contact\/kafka/.test(
      text,
    )
      ? ['network/provider primitive']
      : [],
  'absolute-url': (text) => (/['"`]https?:\/\//.test(text) ? ['absolute URL literal'] : []),
  'db-import-in-adapter': (text) =>
    /from '@d-contact\/db'/.test(text) ? ['direct DB import'] : [],
  'skipped-test': (text) =>
    /\b(?:test|it|describe)\.(?:only|skip|todo|fixme)\s*\(|\{\s*(?:skip|todo|only)\s*:\s*true|retries\s*:/.test(
      text,
    )
      ? ['skipped/only/todo/retry']
      : [],
  'hard-coded-marker': (text) =>
    text.includes('JOURNEY_J5_ACCEPTED') ? ['J5 marker literal'] : [],
  'toast-only-blocker': (text) =>
    /\b(?:use)?[Tt]oast\s*\(|<Toast\b|\btoast\.\w+\(/.test(text) ? ['toast notification'] : [],
};

/** UI contract that must really exist in the source: not drag-only, no mutation on a narrow screen, an outline for every command */
function consoleContract(read) {
  const failures = [];
  const canvas = read('apps/console/src/journey-authoring/canvas.tsx');
  const outline = read('apps/console/src/journey-authoring/outline.tsx');
  const root = read('apps/console/src/journey-authoring/journey-authoring.tsx');
  if (!/onKeyDown=/.test(canvas) || !/tabIndex=/.test(canvas))
    failures.push('canvas must have a keyboard handler and a roving tabindex');
  for (const kind of ['ADD_NODE', 'CONNECT', 'DISCONNECT', 'DELETE_NODE', 'REORDER']) {
    if (!outline.includes(`'${kind}'`))
      failures.push(`outline must be able to command ${kind} without dragging`);
  }
  if (!root.includes("'(min-width: 960px)'"))
    failures.push('root must cut over to read-only at 960px per Phase Spec §8');
  return failures;
}

export function cxaJ5NegativeScan(options = {}) {
  const read = options.read ?? ((path) => readFileSync(resolve(repositoryRoot, path), 'utf8'));
  const targets = options.targets ?? j5ScanTargets();
  const allow = new Set(
    (options.allowlist ?? J5_SCAN_ALLOWLIST).map(({ path, rule }) => `${path}|${rule}`),
  );
  const plan = [
    [
      targets.journeySources,
      [
        'dynamic-code',
        'credential-literal',
        'pii-literal',
        'cross-owner-write',
        'hard-coded-marker',
      ],
    ],
    [
      targets.journeySources.filter((path) => /simulator|compiler|validator|canonical/.test(path)),
      ['network-primitive'],
    ],
    [
      targets.apiSources,
      ['dynamic-code', 'db-import-in-adapter', 'hard-coded-marker', 'credential-literal'],
    ],
    [
      targets.consoleSources,
      [
        'dynamic-code',
        'credential-literal',
        'pii-literal',
        'hard-coded-marker',
        'toast-only-blocker',
      ],
    ],
    [targets.consoleSources.filter((path) => !path.endsWith('/api.ts')), ['network-primitive']],
    [targets.consoleSources.filter((path) => path.endsWith('/api.ts')), ['absolute-url']],
    [targets.tests, ['skipped-test', 'credential-literal', 'pii-literal', 'hard-coded-marker']],
    [targets.fixtures, ['credential-literal', 'pii-literal']],
    [targets.bundle, ['dynamic-code', 'credential-literal', 'hard-coded-marker']],
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
  for (const detail of options.consoleContract === false ? [] : consoleContract(read)) {
    violations.push({ path: 'apps/console/src/journey-authoring', rule: 'ui-contract', detail });
  }
  const requiredGroups = ['journeySources', 'apiSources', 'consoleSources', 'tests', 'fixtures'];
  const empty = requiredGroups.filter((group) => (targets[group] ?? []).length === 0);
  return {
    type: 'negative-scan.readiness',
    workflow: 'cxa-j5-negative-scan',
    status: violations.length === 0 && empty.length === 0 ? 'PASS' : 'FAIL',
    files: scanned.size,
    filesSha256: sha256([...scanned.entries()].sort(([a], [b]) => a.localeCompare(b))),
    bundleScanned: targets.bundle.length > 0,
    emptyGroups: empty,
    allowlist: (options.allowlist ?? J5_SCAN_ALLOWLIST).map(({ path, rule }) => ({ path, rule })),
    violations: violations.slice(0, 50),
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const summary = cxaJ5NegativeScan();
  process.stdout.write(`CXA_J5_SCAN_EVIDENCE:${JSON.stringify(summary)}\n`);
  if (summary.status !== 'PASS') {
    for (const { path, rule, detail } of summary.violations)
      process.stderr.write(`${relative('.', path)}: ${rule}: ${detail}\n`);
    if (summary.emptyGroups.length > 0)
      process.stderr.write(`no files found in the group: ${summary.emptyGroups.join(', ')}\n`);
    process.exitCode = 1;
  }
}
