import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countThaiLines, findIncreases, isInScope, lowerBaseline } from './check-no-thai.mjs';

test('source files are in scope; catalogs, docs, applied migrations and data are not', () => {
  assert.equal(isInScope('apps/console/src/console-app.tsx'), true);
  assert.equal(isInScope('scripts/solo-uat.sh'), true);
  assert.equal(isInScope('.github/workflows/ci.yml'), true);
  assert.equal(isInScope('packages/db/prisma/schema.prisma'), true);

  assert.equal(isInScope('apps/console/src/i18n/locales/th/common.json'), false);
  assert.equal(
    isInScope('infra/keycloak/themes/dcontact/login/messages/messages_th.properties'),
    false,
  );
  assert.equal(isInScope('docs/adr/038-voice.md'), false);
  assert.equal(isInScope('apps/api/README.md'), false);
  assert.equal(isInScope('mockups/people.html'), false);
  assert.equal(isInScope('packages/db/prisma/migrations/20261101_init/migration.sql'), false);
  assert.equal(isInScope('packages/db/prisma/seed.ts'), false);
  assert.equal(isInScope('examples/sales-demo/customers.csv'), false);
  assert.equal(isInScope('data-platform-framework.png'), false);
});

test('counts lines that contain Thai characters', () => {
  assert.equal(countThaiLines('const a = 1;\n// ทดสอบ\nconst b = "ก";\n'), 2);
  assert.equal(countThaiLines('English only\n'), 0);
});

test('fails files above the baseline and new files with Thai', () => {
  const increases = findIncreases({ 'a.ts': 3, 'b.ts': 2, 'c.ts': 1 }, { 'a.ts': 3, 'b.ts': 1 });
  assert.deepEqual(increases, [
    { path: 'b.ts', count: 2, allowed: 1 },
    { path: 'c.ts', count: 1, allowed: 0 },
  ]);
});

test('update only lowers the baseline and drops cleaned files', () => {
  assert.deepEqual(
    lowerBaseline({ 'a.ts': 1, 'b.ts': 9, 'new.ts': 4 }, { 'a.ts': 3, 'b.ts': 2, 'gone.ts': 5 }),
    {
      'a.ts': 1,
      'b.ts': 2,
    },
  );
});
