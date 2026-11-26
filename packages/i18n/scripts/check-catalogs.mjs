#!/usr/bin/env node
/**
 * D1.11 (#450): checks that message catalogs have every key in both `th` and `en` — CI fails when either language is missing
 *
 *   dc-i18n-check <locales-dir> [<locales-dir> ...]
 *
 * Expected layout: `<locales-dir>/th/<namespace>.json` and `<locales-dir>/en/<namespace>.json`
 *
 * typed keys (`CustomTypeOptions`) only catch keys that the code calls but the base catalog lacks; they cannot tell that
 * the other language's catalog is missing a key — this check closes that gap.
 *
 * plural: Thai has one form (`_other`) while English has `_one`/`_other`, so keys are compared after stripping the plural suffix
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

/** Returns the list of problems — empty means pass */
export function checkCatalogs(localesDir) {
  const problems = [];
  const byLocale = new Map(LOCALES.map((locale) => [locale, namespaces(join(localesDir, locale))]));
  const allNamespaces = [...new Set([...byLocale.values()].flat())].sort();
  if (allNamespaces.length === 0) problems.push(`${localesDir}: no catalog found`);

  for (const namespace of allNamespaces) {
    const keys = new Map();
    for (const locale of LOCALES) {
      const file = join(localesDir, locale, `${namespace}.json`);
      if (!existsSync(file)) {
        problems.push(`${locale}/${namespace}.json: file is missing (present in another language)`);
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        problems.push(`${locale}/${namespace}.json: invalid JSON (${error.message})`);
        continue;
      }
      const flat = flatten(parsed, '', new Map());
      for (const [key, value] of flat) {
        if (typeof value !== 'string' || value.trim() === '') {
          problems.push(`${locale}/${namespace}.json: "${key}" must be a non-empty message`);
        }
      }
      keys.set(locale, flat);
    }
    for (const locale of keys.keys()) {
      for (const other of keys.keys()) {
        if (locale === other) continue;
        for (const key of keys.get(locale).keys()) {
          if (!keys.get(other).has(key)) {
            problems.push(
              `${other}/${namespace}.json: missing key "${key}" (present in ${locale})`,
            );
          }
        }
      }
    }
  }
  return problems;
}

// Invoked through a pnpm bin → argv[1] is a symlink in node_modules/.bin, so compare realpaths
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('usage: dc-i18n-check <locales-dir> [<locales-dir> ...]');
    process.exit(2);
  }
  const problems = dirs.flatMap((dir) => checkCatalogs(dir).map((p) => `${dir}/${p}`));
  if (problems.length > 0) {
    console.error(`catalog incomplete in ${problems.length} place(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`catalog complete for ${LOCALES.join('/')} (${dirs.join(', ')})`);
}
