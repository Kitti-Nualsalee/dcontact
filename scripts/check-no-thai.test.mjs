import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findThaiLines, isInScope, PERSISTED } from './check-no-thai.mjs';

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
  assert.equal(isInScope('.github/ISSUE_TEMPLATE/uat-defect.yml'), false);
  assert.equal(isInScope('packages/db/prisma/migrations/20261101_init/migration.sql'), false);
  assert.equal(isInScope('packages/db/prisma/seed.ts'), false);
  assert.equal(isInScope('packages/dphone-embed/releases/1.0.1/dphone-launcher.js'), false);
  assert.equal(isInScope('examples/sales-demo/customers.csv'), false);
  assert.equal(isInScope('data-platform-framework.png'), false);
});

test('persisted files are out of scope and each says why', () => {
  for (const [path, reason] of Object.entries(PERSISTED)) {
    assert.equal(isInScope(path), false, path);
    assert.ok(reason.length > 0, path);
  }
});

test('reports the lines that contain Thai characters', () => {
  assert.deepEqual(
    findThaiLines('const a = 1;\n// \u0E17\u0E14\u0E2A\u0E2D\u0E1A\nconst b = "\u0E01";\n'),
    [2, 3],
  );
  assert.deepEqual(findThaiLines('English only\n'), []);
});

test('lines marked allow-thai are not reported', () => {
  const thai = '\u0E2A\u0E21';
  const text = [
    `const name = '${thai}'; // allow-thai: Thai name fixture`,
    `const other = '${thai}';`,
    `-- ${thai} allow-thai (the marker must follow a comment token)`,
  ].join('\n');
  assert.deepEqual(findThaiLines(text), [2, 3]);
});
