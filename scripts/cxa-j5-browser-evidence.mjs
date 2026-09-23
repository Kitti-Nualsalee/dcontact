import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * J5-F04/J5-OB01 (#333 §5): browser/accessibility evidence ของ Console — เก็บ digest ของ trace และ
 * screenshot ที่ Playwright (Chromium) เขียนไว้หลัง suite `test:e2e --trace=on` พร้อม matrix ของ state
 * ที่ spec ครอบ artifact ดิบไม่ถูกใส่ใน manifest เพราะ trace อาจใหญ่ — manifest ถือ digest เท่านั้น
 */
export const J5_BROWSER_MATRIX = Object.freeze([
  { state: 'desktop keyboard-only authoring', test: 'keyboard-only authoring' },
  {
    state: 'diagnostic focus + modal trap/Escape/return focus',
    test: 'diagnostics ลิงก์กลับ node',
  },
  { state: 'conflict compare/reload/keep-copy', test: '409 เปิด compare/reload/keep-copy' },
  { state: 'session recovery', test: 'session recovery ของแท็บ' },
  { state: 'unknown publish acknowledgement', test: 'publish ที่ไม่รู้ผล (202)' },
  { state: 'templates + upgrade', test: 'templates: instantiate' },
  { state: '960px full / 959px read-only', test: '960px แก้ได้เต็ม' },
  { state: 'axe WCAG 2.2 AA + 200% zoom + reduced motion', test: 'a11y: editor' },
]);

const SPEC = 'apps/console/e2e/journey-authoring.spec.ts';
/** trace ของ J5 อยู่นอก `test-results` เพราะ e2e รอบอื่นในรันเดียวกันล้างโฟลเดอร์นั้นก่อนถึงขั้นอัปโหลด */
export const J5_BROWSER_OUTPUT = 'artifacts/cxa-j5/browser';
/** path เดียวกันเมื่อมองจาก `apps/console` ซึ่งเป็น cwd ของ `pnpm --filter … exec playwright` */
export const J5_BROWSER_OUTPUT_RELATIVE = '../../artifacts/cxa-j5/browser';

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

export function cxaJ5BrowserEvidence(options = {}) {
  const root = options.root ?? repositoryRoot;
  const spec = options.spec ?? readFileSync(resolve(root, SPEC), 'utf8');
  const resultFiles = (options.files ?? files(resolve(root, J5_BROWSER_OUTPUT)))
    .filter((path) => /journey-authoring-/.test(path) && /\.(zip|png)$/.test(path))
    .sort();
  const digest = (path) =>
    options.digest?.(path) ?? createHash('sha256').update(readFileSync(path)).digest('hex');
  const artifacts = resultFiles.map((path) => ({
    kind: path.endsWith('.zip') ? 'trace' : 'screenshot',
    sha256: digest(path),
  }));
  const traces = artifacts.filter(({ kind }) => kind === 'trace').length;
  const missing = J5_BROWSER_MATRIX.filter(({ test }) => !spec.includes(`'${test}`));
  const axe = /AxeBuilder/.test(spec) && /serious', 'critical/.test(spec);
  const passed = missing.length === 0 && axe && traces >= J5_BROWSER_MATRIX.length;
  return {
    type: 'browser.readiness',
    workflow: 'cxa-j5-browser-evidence',
    status: passed ? 'PASS' : 'FAIL',
    browser: 'PLAYWRIGHT_CHROMIUM',
    matrix: J5_BROWSER_MATRIX.map(({ state }) => state),
    missingStates: missing.map(({ state }) => state),
    axeWcag22: axe,
    traces,
    artifactsSha256: sha256(artifacts),
    specSha256: sha256(spec),
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const summary = cxaJ5BrowserEvidence();
  process.stdout.write(`CXA_J5_BROWSER_EVIDENCE:${JSON.stringify(summary)}\n`);
  if (summary.status !== 'PASS') process.exitCode = 1;
}
