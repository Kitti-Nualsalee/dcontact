import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { guardMigrations } from './u1-uat-readiness.mjs';
const path =
  'packages/db/prisma/migrations/20261019140000_core_organization_provenance/migration.sql';
const sql = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('Core release: nullable provenance ตาม Phase Contract ผ่านเฉพาะ migration bytes ที่ review แล้ว', () => {
  assert.equal(guardMigrations([{ status: 'A', path, sql }]).status, 'PASS');
  for (const change of [
    { status: 'M', path, sql },
    { status: 'A', path: path.replace('140000', '150000'), sql },
    { status: 'A', path, sql: sql + '\nDROP TABLE tenants;' },
    {
      status: 'A',
      path,
      sql: sql.replace('bootstrap_template_version DROP NOT NULL', 'locale DROP NOT NULL'),
    },
  ])
    assert.equal(guardMigrations([change]).status, 'FAIL');
});

test('Core organization smoke: environment ไม่พร้อมต้องไม่สร้าง PASS', async () => {
  const { runOrganizationSmoke } = await import('./core-settings-organization-smoke.mjs');
  await assert.rejects(
    runOrganizationSmoke({ baseUrl: 'http://vm.example', accessToken: 'synthetic-token' }),
  );
  await assert.rejects(
    runOrganizationSmoke({
      baseUrl: 'https://user:password@vm.example',
      accessToken: 'synthetic-token',
    }),
  );
  await assert.rejects(runOrganizationSmoke({ baseUrl: 'https://vm.example' }));
});

test('Core organization smoke: ใช้ authenticated HTTP จริงและไม่พิมพ์ชื่อ/token ในรายงาน', async (t) => {
  const { runOrganizationSmoke } = await import('./core-settings-organization-smoke.mjs');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/runtime-profile')
      return res.end(
        JSON.stringify({
          profile: 'uat-workspace',
          providerEgress: 'BLOCKED',
          kafka: 'DISABLED',
          lineWebhook: 'DISABLED',
        }),
      );
    if (!req.headers.authorization) {
      res.statusCode = 401;
      return res.end('{}');
    }
    res.setHeader('Cache-Control', 'no-store');
    const data = {
      '/api/v1/tenant/core-settings/capabilities': { organization: { read: true, write: true } },
      '/api/v1/tenant/core-settings/organization': {
        organization: {
          id: 'synthetic-resource',
          displayName: 'ห้ามอยู่ใน report',
          defaults: null,
          revision: '0',
        },
      },
      '/api/v1/tenant/locale-defaults': { locale: null, timeZone: null },
      '/api/v1/me/navigation': {
        apps: [{ id: 'core-settings', path: '/?view=core-settings&page=organization' }],
        areas: [
          { sections: [{ items: [{ appId: 'core-settings', pages: [{ id: 'organization' }] }] }] },
        ],
      },
    }[req.url];
    res.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const result = await runOrganizationSmoke({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    accessToken: 'synthetic-never-log',
  });
  assert.equal(result.result, 'PASS');
  assert.equal(result.voiceSmoke, 'NOT_RUN');
  assert.equal(result.vmTrial, 'NOT_PROVEN');
  assert.ok(!JSON.stringify(result).includes('synthetic-never-log'));
  assert.ok(!JSON.stringify(result).includes('ห้ามอยู่ใน report'));
});
