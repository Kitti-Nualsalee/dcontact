#!/usr/bin/env node
/**
 * Keeps Thai text out of source code (owner decision, 25 Nov 2026).
 *
 * Code, comments, test names, error messages and scripts are written in English.
 * Thai stays only where it is data or human-facing documentation:
 * - translation catalogs (`locales/`, Keycloak `messages_*.properties`)
 * - Markdown, `docs/` and `mockups/`
 * - Prisma migrations that were already applied (editing them breaks `prisma migrate dev`)
 * - seed and CSV data
 * - single lines marked with an `allow-thai` comment (Thai test data on purpose)
 *
 * Existing Thai is tracked in `scripts/no-thai-baseline.json` (lines with Thai per file) while it is
 * being translated. A file fails when it has more Thai lines than its baseline; new files must have none.
 *
 *   node scripts/check-no-thai.mjs            check tracked files
 *   node scripts/check-no-thai.mjs --update   lower the baseline to the current counts (never raises it)
 *   node scripts/check-no-thai.mjs --init     write the baseline from scratch (one-off, at adoption)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const THAI = /[\u0E00-\u0E7F]/;

const EXEMPT = [
  /(^|\/)locales\//,
  /(^|\/)messages_[a-z]+\.properties$/,
  /\.md$/,
  /^docs\//,
  /^mockups\//,
  /^\.playwright-mcp\//,
  /^packages\/db\/prisma\/migrations\//,
  /^packages\/db\/prisma\/seed\.ts$/,
  /\.csv$/,
  /^scripts\/no-thai-baseline\.json$/,
];

const BINARY =
  /\.(png|jpe?g|gif|webp|ico|svgz|pdf|xlsx|docx|pptx|zip|gz|tgz|woff2?|ttf|otf|wav|mp3|ogg|jar)$/i;

export function isInScope(path) {
  return !BINARY.test(path) && !EXEMPT.some((pattern) => pattern.test(path));
}

/**
 * A line that ends with an `allow-thai` comment is Thai on purpose, e.g. test data for Thai
 * normalization, sorting or search. The comment says why: `// allow-thai: Thai name fixture`.
 */
const ALLOW = /(\/\/|#|--|\/\*)\s*allow-thai\b/;

export function countThaiLines(text) {
  let count = 0;
  for (const line of text.split('\n')) if (THAI.test(line) && !ALLOW.test(line)) count += 1;
  return count;
}

/** Files with more Thai lines than the baseline allows. */
export function findIncreases(counts, baseline) {
  const increases = [];
  for (const [path, count] of Object.entries(counts)) {
    const allowed = baseline[path] ?? 0;
    if (count > allowed) increases.push({ path, count, allowed });
  }
  return increases.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Baseline lowered to the current counts; entries for files without Thai are dropped. */
export function lowerBaseline(counts, baseline) {
  const next = {};
  for (const path of Object.keys(baseline).sort()) {
    const count = Math.min(counts[path] ?? 0, baseline[path]);
    if (count > 0) next[path] = count;
  }
  return next;
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .split('\0')
    .filter(Boolean);
}

export function scan(root) {
  const counts = {};
  for (const path of trackedFiles(root).filter(isInScope)) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    const count = countThaiLines(readFileSync(absolute, 'utf8'));
    if (count > 0) counts[path] = count;
  }
  return counts;
}

function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const baselinePath = join(root, 'scripts/no-thai-baseline.json');
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  const counts = scan(root);

  if (process.argv.includes('--init') || process.argv.includes('--update')) {
    const next = process.argv.includes('--init') ? counts : lowerBaseline(counts, baseline);
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    const total = Object.values(next).reduce((sum, count) => sum + count, 0);
    console.log(`Baseline: ${Object.keys(next).length} files, ${total} Thai lines`);
  }

  const increases = process.argv.includes('--init') ? [] : findIncreases(counts, baseline);
  if (increases.length > 0) {
    console.error('Thai text found in source code. Write code, comments and tests in English;');
    console.error('put user-facing Thai in a locales/ catalog.');
    for (const { path, count, allowed } of increases) {
      console.error(`  - ${path}: ${count} Thai lines (allowed ${allowed})`);
    }
    process.exit(1);
  }
  const lowered = Object.keys(baseline).filter((path) => (counts[path] ?? 0) < baseline[path]);
  if (lowered.length > 0 && !process.argv.includes('--update')) {
    console.log(
      `${lowered.length} files have less Thai than the baseline; run with --update to lower it.`,
    );
  }
  console.log('No new Thai text in source code');
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main();
}
