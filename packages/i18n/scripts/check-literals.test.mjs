import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLiterals } from './check-literals.mjs';

const THAI_SAMPLE = 'บันทึกแล้ว'; // allow-thai: Thai text is what the checker must detect

function file(name, content) {
  const path = join(mkdtempSync(join(tmpdir(), 'dc-literals-')), name);
  writeFileSync(path, content);
  return path;
}

test('flags JSX text, user-visible attributes and Thai characters in strings', () => {
  const problems = checkLiterals(
    file(
      'page.tsx',
      `export const Page = () => (
  <section aria-label="Queue list" data-kind="panel">
    <h1>Journeys</h1>
    <p>{'${THAI_SAMPLE}'}</p>
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

test('ignores t(), separators, non-text attributes, comments and i18n-ignore lines', () => {
  const problems = checkLiterals(
    file(
      'ok.tsx',
      `// ${THAI_SAMPLE}
export const Ok = ({ t }: { t: (k: string) => string }) => (
  <div className="j5-panel" role="group" aria-label={t('list.filterLabel')}>
    {t('list.title')} · →
    <code>{'SYSTEM'}</code>
    <p>{'${THAI_SAMPLE}'}</p> {/* i18n-ignore */}
  </div>
);`,
    ),
  );
  assert.deepEqual(problems, []);
});

test('.ts files are not parsed as JSX (a generic is not text)', () => {
  const problems = checkLiterals(
    file(
      'api.ts',
      `export const call = <T,>(path: string) => fetch(path) as unknown as Promise<T>;`,
    ),
  );
  assert.deepEqual(problems, []);
});
