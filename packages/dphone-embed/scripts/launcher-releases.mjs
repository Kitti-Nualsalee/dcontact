#!/usr/bin/env node
/**
 * E1.15 (#489): release และ alias ของ `<dphone-launcher>` (E1.7 #463 ข้อ 1, 5)
 *
 * - `release`  : คัดลอก `dist-launcher/dphone-launcher.js` เป็น `releases/<version>/` (immutable) + SRI sha384
 *                version เดิมที่เนื้อหาต่างกัน = ล้ม (ต้องเพิ่ม version) — ไม่เลื่อน alias เอง
 * - `alias`    : ชี้ `v<major>` ไปยัง version ที่ release แล้ว (เลื่อนหรือ rollback) — ต้อง major เดียวกัน
 * - `check`    : ทุกไฟล์ตรงกับ integrity ใน index และทุก alias ชี้ version ที่มีอยู่ของ major เดียวกัน
 *
 * ก่อนเลื่อน alias ต้องผ่าน contract test (`pnpm test:e1-embed-contract`) และ e2e บน host อ้างอิง
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
    if (!VERSION.test(version)) problems.push(`version ผิดรูป: ${version}`);
    const file = join(dir, version, FILE);
    if (!existsSync(file)) {
      problems.push(`ไม่พบไฟล์ของ ${version}`);
      continue;
    }
    if (integrityOf(readFileSync(file)) !== entry.integrity) {
      problems.push(`ไฟล์ของ ${version} ไม่ตรงกับ integrity (release เป็น immutable)`);
    }
  }
  for (const [alias, version] of Object.entries(index.aliases)) {
    const major = /^v(\d+)$/.exec(alias)?.[1];
    if (!major) problems.push(`alias ผิดรูป: ${alias}`);
    if (!index.versions[version]) problems.push(`alias ${alias} ชี้ version ที่ไม่มี: ${version}`);
    else if (VERSION.exec(version)?.[1] !== major) {
      problems.push(`alias ${alias} ชี้ข้าม major: ${version}`);
    }
  }
  return problems;
}

function release() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!VERSION.test(version)) throw new Error(`version ของ package ผิดรูป: ${version}`);
  const built = readFileSync(join(root, 'dist-launcher', FILE));
  const target = join(releasesDir, version, FILE);
  const index = loadIndex();
  if (existsSync(target)) {
    if (integrityOf(readFileSync(target)) !== integrityOf(built)) {
      throw new Error(
        `${version} ถูก release แล้วด้วยเนื้อหาอื่น — เพิ่ม version ของ package ก่อน`,
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
      if (!major) return [`alias ผิดรูป: ${name}`];
      if (!draft.versions[version]) return [`ยังไม่ได้ release ${version}`];
      if (VERSION.exec(version)?.[1] !== major) return [`${name} ชี้ข้าม major ไม่ได้: ${version}`];
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
    } else throw new Error('ใช้: launcher-releases.mjs release | alias <vN> <X.Y.Z> | check');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
