#!/usr/bin/env node
/**
 * D1.14 (#453): checks for hardcoded text in screens that already moved to the i18n system. D1 acceptance:
 * "no hardcoded text in the two target screens (lint)"
 *
 *   dc-i18n-literals <file-or-dir> [...]
 *
 * Reads TSX/TS with the TypeScript AST and reports:
 * - JSX text that contains letters (separators such as `·`, `→`, `*` are ignored)
 * - string literals in user-visible attributes (aria-label, title, placeholder, alt, label, …)
 * - string/template literals containing Thai characters anywhere in code (comments are ignored)
 *
 * A whole line can be exempted with an `i18n-ignore` comment when the text is data, not UI text.
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
const THAI = /[฀-๿]/; // allow-thai: the Thai Unicode range

function files(target) {
  if (statSync(target).isDirectory()) {
    return readdirSync(target).flatMap((name) => files(join(target, name)));
  }
  const extension = extname(target);
  if (
    !['.ts', '.tsx'].includes(extension) ||
    /\.(test|spec|boundary|integration|d)\.tsx?$/.test(target) ||
    // e2e-only harness controls (`e2e-*.tsx`) are not product UI
    /(^|\/)e2e-[^/]*\.tsx?$/.test(target)
  )
    return [];
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
    console.error('usage: dc-i18n-literals <file-or-dir> [...]');
    process.exit(2);
  }
  const problems = targets.flatMap(files).flatMap(checkLiterals);
  if (problems.length > 0) {
    console.error(
      `found ${problems.length} hardcoded text occurrence(s) (move them into a catalog, or add i18n-ignore if it is data):`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`no hardcoded text (${targets.join(', ')})`);
}
