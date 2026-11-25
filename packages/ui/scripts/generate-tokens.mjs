#!/usr/bin/env node
/**
 * Generates src/tokens.generated.ts from src/tokens.css
 *
 * tokens.css is the single source of truth; the TS file is generated so that code which
 * needs color values outside CSS (canvas, chart, inline style of the waveform) can reference the same values
 * Do not edit the generated file by hand
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, '..', 'src', 'tokens.css');
const outPath = join(here, '..', 'src', 'tokens.generated.ts');

const css = readFileSync(cssPath, 'utf8');
const entries = [];
const seen = new Set();
for (const [, name, value] of css.matchAll(/(--dc-[a-z0-9-]+):\s*([^;]+);/g)) {
  if (seen.has(name)) continue; // value declared more than once in a media query is not counted
  seen.add(name);
  entries.push([
    name,
    value
      .trim()
      .replace(/\s*\/\*[\s\S]*$/, '')
      .trim(),
  ]);
}

const camel = (name) =>
  name.replace(/^--dc-/, '').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

// The generated file is still under prettier --check, so it must choose quotes the way prettier does:
// single quote by default, but switch to double quote when the value has more ' than " (fewer escapes)
const quote = (value) => {
  const singles = (value.match(/'/g) ?? []).length;
  const doubles = (value.match(/"/g) ?? []).length;
  const q = singles > doubles ? '"' : "'";
  const escaped = value.replace(/\\/g, '\\\\').split(q).join(`\\${q}`);
  return `${q}${escaped}${q}`;
};

const body = entries.map(([name, value]) => `  ${camel(name)}: ${quote(value)},`).join('\n');
const varBody = entries.map(([name]) => `  ${camel(name)}: ${quote(name)},`).join('\n');

writeFileSync(
  outPath,
  `/* generated from tokens.css by scripts/generate-tokens.mjs — do not edit by hand */

/** actual token values — use when passing a color to a canvas or a library that cannot take CSS */
export const tokens = {
${body}
} as const;

/** custom property name of each token — use when writing an inline style */
const cssNames = {
${varBody}
} as const;

export type TokenName = keyof typeof tokens;

/** e.g. cssVar('brand700') === 'var(--dc-brand-700)' */
export function cssVar(name: TokenName): string {
  return 'var(' + cssNames[name] + ')';
}
`,
  'utf8',
);

console.log(`wrote ${entries.length} tokens to src/tokens.generated.ts`);
