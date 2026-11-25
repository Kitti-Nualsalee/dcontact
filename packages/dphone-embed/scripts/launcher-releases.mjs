#!/usr/bin/env node
/**
 * E1.15 (#489): releases and aliases of `<dphone-launcher>` (E1.7 #463 items 1, 5)
 *
 * - `release`  : copy `dist-launcher/dphone-launcher.js` to `releases/<version>/` (immutable) + SRI sha384
 *                an existing version with different content = failure (the version must be bumped) — it does not move aliases itself
 * - `alias`    : point `v<major>` at an already released version (move or rollback) — must be the same major
 * - `check`    : every file matches the integrity in the index and every alias points at an existing version of the same major
 *
 * Before moving an alias the contract test (`pnpm test:e1-embed-contract`) and the e2e on the reference host must pass
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releasesDir = process.env.DPHONE_LAUNCHER_RELEASES_DIR ?? join(root, 'releases');
const indexPath = join(releasesDir, 'index.json');
const FILE = 'dphone-launcher.js';
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function integrityOf(content) {
  return `sha384-${createHash('sha384').update(content).digest('base64')}`;
}

export function loadIndex(dir = releasesDir) {
  const path = join(dir, 'index.json');
  if (!existsSync(path)) return { versions: {}, aliases: {} };
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveIndex(index) {
  mkdirSync(releasesDir, { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

export function checkReleases(dir = releasesDir) {
  const index = loadIndex(dir);
  const problems = [];
  for (const [version, entry] of Object.entries(index.versions)) {
    if (!VERSION.test(version)) problems.push(`malformed version: ${version}`);
    const file = join(dir, version, FILE);
    if (!existsSync(file)) {
      problems.push(`file for ${version} not found`);
      continue;
    }
    if (integrityOf(readFileSync(file)) !== entry.integrity) {
      problems.push(`file for ${version} does not match the integrity (a release is immutable)`);
    }
  }
  for (const [alias, version] of Object.entries(index.aliases)) {
    const major = /^v(\d+)$/.exec(alias)?.[1];
    if (!major) problems.push(`malformed alias: ${alias}`);
    if (!index.versions[version])
      problems.push(`alias ${alias} points at a version that does not exist: ${version}`);
    else if (VERSION.exec(version)?.[1] !== major) {
      problems.push(`alias ${alias} points across majors: ${version}`);
    }
  }
  return problems;
}

function release() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!VERSION.test(version)) throw new Error(`package version is malformed: ${version}`);
  const built = readFileSync(join(root, 'dist-launcher', FILE));
  const target = join(releasesDir, version, FILE);
  const index = loadIndex();
  if (existsSync(target)) {
    if (integrityOf(readFileSync(target)) !== integrityOf(built)) {
      throw new Error(
        `${version} was already released with other content — bump the package version first`,
      );
    }
    console.log(JSON.stringify({ status: 'UNCHANGED', version }));
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, built);
  index.versions[version] = { integrity: integrityOf(built) };
  saveIndex(index);
  console.log(
    JSON.stringify({ status: 'RELEASED', version, integrity: index.versions[version].integrity }),
  );
}

function alias(name, version) {
  const index = loadIndex();
  index.aliases[name] = version;
  const problems = checkReleases().concat(
    (() => {
      const draft = { ...index };
      const major = /^v(\d+)$/.exec(name)?.[1];
      if (!major) return [`malformed alias: ${name}`];
      if (!draft.versions[version]) return [`${version} has not been released yet`];
      if (VERSION.exec(version)?.[1] !== major)
        return [`${name} cannot point across majors: ${version}`];
      return [];
    })(),
  );
  if (problems.length) throw new Error(problems.join('\n'));
  const previous = loadIndex().aliases[name] ?? null;
  saveIndex(index);
  console.log(JSON.stringify({ status: 'ALIASED', alias: name, version, previous }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'release') release();
    else if (command === 'alias') alias(args[0], args[1]);
    else if (command === 'check') {
      const problems = checkReleases();
      if (problems.length) throw new Error(problems.join('\n'));
      console.log(JSON.stringify({ status: 'PASS', ...loadIndex().aliases }));
    } else throw new Error('Usage: launcher-releases.mjs release | alias <vN> <X.Y.Z> | check');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
