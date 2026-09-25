#!/usr/bin/env node
/**
 * D1.11 (#450): ตรวจว่า message catalog มี key ครบทั้ง `th` และ `en` — CI ล้มเมื่อขาดภาษาใดภาษาหนึ่ง
 *
 *   dc-i18n-check <locales-dir> [<locales-dir> ...]
 *
 * โครงที่คาด: `<locales-dir>/th/<namespace>.json` และ `<locales-dir>/en/<namespace>.json`
 *
 * typed keys (`CustomTypeOptions`) จับได้แค่ key ที่โค้ดเรียกแต่ไม่มีใน catalog ต้นแบบ แต่จับไม่ได้ว่า
 * catalog อีกภาษาขาด key — ตัวนี้ปิดช่องนั้น
 *
 * plural: ไทยมีรูปเดียว (`_other`) ส่วนอังกฤษมี `_one`/`_other` จึงเทียบ key หลังตัด suffix ของ plural
 */
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCALES = ['th', 'en'];
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flatten(value, prefix, out) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.set(prefix.replace(PLURAL_SUFFIX, ''), value);
  }
  return out;
}

function namespaces(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => basename(file, '.json'))
        .sort()
    : [];
}

/** คืนรายการปัญหา — ว่างแปลว่าผ่าน */
export function checkCatalogs(localesDir) {
  const problems = [];
  const byLocale = new Map(LOCALES.map((locale) => [locale, namespaces(join(localesDir, locale))]));
  const allNamespaces = [...new Set([...byLocale.values()].flat())].sort();
  if (allNamespaces.length === 0) problems.push(`${localesDir}: ไม่พบ catalog`);

  for (const namespace of allNamespaces) {
    const keys = new Map();
    for (const locale of LOCALES) {
      const file = join(localesDir, locale, `${namespace}.json`);
      if (!existsSync(file)) {
        problems.push(`${locale}/${namespace}.json: ไม่มีไฟล์ (มีในภาษาอื่น)`);
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        problems.push(`${locale}/${namespace}.json: JSON ไม่ถูกต้อง (${error.message})`);
        continue;
      }
      const flat = flatten(parsed, '', new Map());
      for (const [key, value] of flat) {
        if (typeof value !== 'string' || value.trim() === '') {
          problems.push(`${locale}/${namespace}.json: "${key}" ต้องเป็นข้อความที่ไม่ว่าง`);
        }
      }
      keys.set(locale, flat);
    }
    for (const locale of keys.keys()) {
      for (const other of keys.keys()) {
        if (locale === other) continue;
        for (const key of keys.get(locale).keys()) {
          if (!keys.get(other).has(key)) {
            problems.push(`${other}/${namespace}.json: ขาด key "${key}" (มีใน ${locale})`);
          }
        }
      }
    }
  }
  return problems;
}

// เรียกผ่าน bin ของ pnpm → argv[1] เป็น symlink ใน node_modules/.bin จึงต้องเทียบ realpath
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('ใช้: dc-i18n-check <locales-dir> [<locales-dir> ...]');
    process.exit(2);
  }
  const problems = dirs.flatMap((dir) => checkCatalogs(dir).map((p) => `${dir}/${p}`));
  if (problems.length > 0) {
    console.error(`catalog ไม่ครบ ${problems.length} จุด:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`catalog ครบทั้ง ${LOCALES.join('/')} (${dirs.join(', ')})`);
}
