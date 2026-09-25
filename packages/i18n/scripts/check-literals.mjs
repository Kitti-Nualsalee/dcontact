#!/usr/bin/env node
/**
 * D1.14 (#453): ตรวจข้อความ hardcode ในหน้าที่ย้ายมาใช้ระบบภาษาแล้ว — acceptance ของ D1:
 * "ไม่มีข้อความ hardcode ในสองหน้าเป้าหมาย (lint)"
 *
 *   dc-i18n-literals <file-or-dir> [...]
 *
 * อ่าน TSX/TS ด้วย TypeScript AST แล้วรายงาน:
 * - JSX text ที่มีตัวอักษร (ไม่นับเครื่องหมายคั่นอย่าง `·`, `→`, `*`)
 * - string literal ใน attribute ที่ผู้ใช้เห็น (aria-label, title, placeholder, alt, label, …)
 * - string/template literal ที่มีอักษรไทยที่ไหนก็ได้ในโค้ด (ไม่นับ comment)
 *
 * ยกเว้นทั้งบรรทัดด้วย comment `i18n-ignore` เมื่อข้อความเป็นข้อมูล ไม่ใช่ข้อความของ UI
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const USER_FACING_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
  'description',
  'confirmLabel',
  'hint',
  'errorMessage',
]);
const LETTER = /\p{L}/u;
const THAI = /[฀-๿]/;

function files(target) {
  if (statSync(target).isDirectory()) {
    return readdirSync(target).flatMap((name) => files(join(target, name)));
  }
  const extension = extname(target);
  if (!['.ts', '.tsx'].includes(extension) || /\.(test|spec|d)\.tsx?$/.test(target)) return [];
  return [target];
}

export function checkLiterals(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const problems = [];
  const report = (node, what) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    if (lines[line]?.includes('i18n-ignore')) return;
    problems.push(
      `${file}:${line + 1} ${what}: ${JSON.stringify(node.getText(source).trim().slice(0, 60))}`,
    );
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const value = node.getText(source).trim();
      if (value && LETTER.test(value)) report(node, 'JSX text');
    } else if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      const name = node.name.getText(source);
      if (USER_FACING_ATTRIBUTES.has(name) && LETTER.test(node.initializer.text)) {
        report(node, `attribute ${name}`);
      }
    } else if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      THAI.test(node.text ?? '')
    ) {
      report(node, 'Thai literal');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error('ใช้: dc-i18n-literals <file-or-dir> [...]');
    process.exit(2);
  }
  const problems = targets.flatMap(files).flatMap(checkLiterals);
  if (problems.length > 0) {
    console.error(
      `พบข้อความ hardcode ${problems.length} จุด (ย้ายเข้า catalog หรือใส่ i18n-ignore ถ้าเป็นข้อมูล):`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`ไม่มีข้อความ hardcode (${targets.join(', ')})`);
}
