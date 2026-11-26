#!/usr/bin/env node
/**
 * Keeps Thai text out of source code (owner decision, 25 Nov 2026).
 *
 * Code, comments, test names, error messages and scripts are written in English.
 * Thai stays only where it is data or human-facing documentation:
 * - translation catalogs (`locales/`, Keycloak `messages_*.properties`)
 * - Markdown, `docs/`, `mockups/` and GitHub issue templates
 * - Prisma migrations that were already applied (editing them breaks `prisma migrate dev`)
 * - seed and CSV data, and published D-Phone embed releases (immutable)
 * - the persisted files listed in `PERSISTED`, each with its reason
 * - single lines marked with an `allow-thai` comment (Thai test data on purpose)
 *
 * Any other tracked line with Thai fails the check.
 *
 *   node scripts/check-no-thai.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
  /^\.github\/ISSUE_TEMPLATE\//,
  /^packages\/db\/prisma\/migrations\//,
  /^packages\/db\/prisma\/seed\.ts$/,
  /^packages\/dphone-embed\/releases\//,
  /\.csv$/,
];

/**
 * Files whose Thai is persisted or compared byte for byte, and whose format has no comment to mark a
 * single line. Remove an entry once the file is translated.
 */
export const PERSISTED = {
  'infra/uat/fixtures/uat-first-slice.v1.template.json':
    'fixture pack template; its digest is recorded',
  'infra/keycloak/realm-dcontact.dev.json': 'realm import; JSON has no comments',
  'infra/keycloak/realm-dcontact.uat.json':
    'imported UAT realm; covered by the realm config digest',
  'infra/uat/operator/vm1-nginx-line-webhook.sh':
    'nginx heredoc compared with VM1 by --check; translate at the next UAT apply',
  'infra/uat/operator/vm1-nginx-uat.sh':
    'nginx heredoc compared with VM1 by --check; translate at the next UAT apply',
  'infra/uat/operator/vm1-nginx-websocket-uat.sh':
    'nginx heredoc compared with VM1 by --check; translate at the next UAT apply',
  'infra/uat/operator/vm1-nginx-workspace-uat.sh':
    'nginx heredoc compared with VM1 by --check; translate at the next UAT apply',
  'infra/uat/operator/vm1-platform-nginx-uat.sh':
    'nginx heredoc compared with VM1 by --check; translate at the next UAT apply',
};

const BINARY =
  /\.(png|jpe?g|gif|webp|ico|svgz|pdf|xlsx|docx|pptx|zip|gz|tgz|woff2?|ttf|otf|wav|mp3|ogg|jar)$/i;

export function isInScope(path) {
  return (
    !BINARY.test(path) && !EXEMPT.some((pattern) => pattern.test(path)) && !(path in PERSISTED)
  );
}

/**
 * A line that ends with an `allow-thai` comment is Thai on purpose, e.g. test data for Thai
 * normalization, sorting or search. The comment says why: `// allow-thai: Thai name fixture`.
 */
const ALLOW = /(\/\/|#|--|\/\*)\s*allow-thai\b/;

/** 1-based numbers of the lines with Thai that are not marked `allow-thai`. */
export function findThaiLines(text) {
  const lines = [];
  text.split('\n').forEach((line, index) => {
    if (THAI.test(line) && !ALLOW.test(line)) lines.push(index + 1);
  });
  return lines;
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

/** Files in scope with Thai lines, as `{ path: [line numbers] }`. */
export function scan(root) {
  const found = {};
  for (const path of trackedFiles(root).filter(isInScope)) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    const lines = findThaiLines(readFileSync(absolute, 'utf8'));
    if (lines.length > 0) found[path] = lines;
  }
  return found;
}

function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const missing = Object.keys(PERSISTED).filter((path) => !existsSync(join(root, path)));
  const found = scan(root);
  const paths = Object.keys(found).sort();

  if (missing.length > 0) {
    console.error(
      'PERSISTED lists files that no longer exist; remove them from scripts/check-no-thai.mjs:',
    );
    for (const path of missing) console.error(`  - ${path}`);
  }
  if (paths.length > 0) {
    console.error('Thai text found in source code. Write code, comments and tests in English;');
    console.error(
      'put user-facing Thai in a locales/ catalog, or end a line of Thai test data with',
    );
    console.error('an `allow-thai: <reason>` comment.');
    for (const path of paths) console.error(`  - ${path}: lines ${found[path].join(', ')}`);
  }
  if (missing.length > 0 || paths.length > 0) process.exit(1);
  console.log('No Thai text in source code');
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main();
}
