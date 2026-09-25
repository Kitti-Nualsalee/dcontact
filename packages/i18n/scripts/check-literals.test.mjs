import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLiterals } from './check-literals.mjs';

function file(name, content) {
  const path = join(mkdtempSync(join(tmpdir(), 'dc-literals-')), name);
  writeFileSync(path, content);
  return path;
}

test('จับ JSX text, attribute ที่ผู้ใช้เห็น และอักษรไทยใน string', () => {
  const problems = checkLiterals(
    file(
      'page.tsx',
      `export const Page = () => (
  <section aria-label="Queue list" data-kind="panel">
    <h1>Journeys</h1>
    <p>{'บันทึกแล้ว'}</p>
    <span> · </span>
  </section>
);`,
    ),
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0], /attribute aria-label/);
  assert.match(problems[1], /JSX text: "Journeys"/);
  assert.match(problems[2], /Thai literal/);
});

test('ไม่นับ t(), เครื่องหมายคั่น, attribute ที่ไม่ใช่ข้อความ, comment และบรรทัด i18n-ignore', () => {
  const problems = checkLiterals(
    file(
      'ok.tsx',
      `// คำอธิบายภาษาไทยใน comment
export const Ok = ({ t }: { t: (k: string) => string }) => (
  <div className="j5-panel" role="group" aria-label={t('list.filterLabel')}>
    {t('list.title')} · →
    <code>{'SYSTEM'}</code>
    <p>{'ข้อมูลจาก server'}</p> {/* i18n-ignore */}
  </div>
);`,
    ),
  );
  assert.deepEqual(problems, []);
});

test('ไฟล์ .ts ไม่ถูกอ่านเป็น JSX (generic ไม่ใช่ข้อความ)', () => {
  const problems = checkLiterals(
    file(
      'api.ts',
      `export const call = <T,>(path: string) => fetch(path) as unknown as Promise<T>;`,
    ),
  );
  assert.deepEqual(problems, []);
});
