#!/usr/bin/env node
/**
 * สร้าง src/tokens.generated.ts จาก src/tokens.css
 *
 * tokens.css เป็นแหล่งความจริงเดียว ไฟล์ TS เป็นของที่ถูกสร้างขึ้นเพื่อให้โค้ดที่
 * ต้องใช้ค่าสีนอก CSS (canvas, chart, inline style ของ waveform) อ้างค่าเดียวกันได้
 * ห้ามแก้ไฟล์ที่ถูกสร้างด้วยมือ
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
  if (seen.has(name)) continue; // ค่าที่ประกาศซ้ำใน media query ไม่นับ
  seen.add(name);
  entries.push([name, value.trim().replace(/\s*\/\*[\s\S]*$/, '').trim()]);
}

const camel = (name) =>
  name.replace(/^--dc-/, '').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

const body = entries.map(([name, value]) => `  ${camel(name)}: ${JSON.stringify(value)},`).join('\n');
const varBody = entries.map(([name]) => `  ${camel(name)}: '${name}',`).join('\n');

writeFileSync(
  outPath,
  `/* สร้างอัตโนมัติจาก tokens.css โดย scripts/generate-tokens.mjs — ห้ามแก้ด้วยมือ */

/** ค่าจริงของ token — ใช้เมื่อต้องส่งสีให้ canvas หรือไลบรารีที่รับ CSS ไม่ได้ */
export const tokens = {
${body}
} as const;

/** ชื่อ custom property ของแต่ละ token — ใช้เมื่อเขียน inline style ได้ */
const cssNames = {
${varBody}
} as const;

export type TokenName = keyof typeof tokens;

/** เช่น cssVar('brand700') === 'var(--dc-brand-700)' */
export function cssVar(name: TokenName): string {
  return 'var(' + cssNames[name] + ')';
}
`,
  'utf8',
);

console.log(`เขียน ${entries.length} token ลง src/tokens.generated.ts`);
