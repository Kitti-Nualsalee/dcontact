import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVISION_PARTS,
  REQUIRED_LIVE_CHECKS,
  assertAccounts,
  assertProvision,
  assertSmoke,
  assertStep,
  jsonLines,
} from './u1-uat-ci-assert.mjs';
import { buildCiFixture, buildSha } from './u1-uat-ci-fixture.mjs';
import { validateAccounts } from './u1-uat-keycloak-users.mjs';

// U1.10 (#507): helpers of the `uat-image-smoke` workflow - synthetic input and checking the result of each step

const environment = {
  UAT_TENANT_ID: '4f1d2c3b-5a6e-4f70-8a91-b2c3d4e5f607',
  UAT_TENANT_SLUG: 'uat-ci-4f1d2c3b',
  UAT_TENANT_NAME: 'UAT CI Tenant',
  UAT_ORGANIZATION_DOMAIN: 'uat.ci.invalid',
  UAT_FIXTURE_PACK_VERSION: 'ci-synthetic-1',
  SOURCE_SHA: 'a'.repeat(40),
  UAT_CI_MAKER_PASSWORD: 'b'.repeat(32),
  UAT_CI_REVIEWER_PASSWORD: 'c'.repeat(32),
};

test('fixture: the input binds the same tenant/team/account across the provision, the pack and the Keycloak accounts', () => {
  const { provision, accounts } = buildCiFixture({
    environment,
    baselineDocument: { schema: 'stub' },
  });
  assert.equal(provision.schema, 'UatProvisionV1');
  assert.deepEqual(provision.tenant, {
    id: environment.UAT_TENANT_ID,
    slug: environment.UAT_TENANT_SLUG,
    name: environment.UAT_TENANT_NAME,
  });
  const pack = provision.fixturePack;
  assert.equal(pack.tenantId, provision.tenant.id);
  assert.equal(pack.ownerTeamId, provision.ownerTeam.id);
  assert.equal(pack.makerSubjectId, provision.maker.dcUserId);
  assert.equal(pack.reviewerSubjectId, provision.reviewer.dcUserId);
  assert.equal(pack.packVersion, environment.UAT_FIXTURE_PACK_VERSION);
  assert.notEqual(provision.maker.dcUserId, provision.reviewer.dcUserId);
  assert.match(provision.maker.email, /@uat\.ci\.invalid$/);

  const validated = validateAccounts(accounts);
  assert.deepEqual(
    validated.map((account) => [account.role, account.dcUserId]),
    [
      ['maker', provision.maker.dcUserId],
      ['reviewer', provision.reviewer.dcUserId],
    ],
  );
  // an email may appear only on maker/reviewer (the U1.8 negative scan excepts only these two fields)
  const { maker: _m, reviewer: _r, ...rest } = provision;
  assert.doesNotMatch(JSON.stringify(rest), /@/);
  assert.doesNotMatch(JSON.stringify(provision), /b{32}|c{32}/);
});

test('fixture: a missing env = failure, and buildSha does not start like a phone number', () => {
  const { UAT_TENANT_ID: _unused, ...missing } = environment;
  assert.throws(
    () => buildCiFixture({ environment: missing, baselineDocument: {} }),
    /UAT_TENANT_ID/,
  );
  assert.throws(() => buildSha('abc'), /40/);
  assert.equal(buildSha('a'.repeat(40)), 'a'.repeat(40));
  const phoneLike = `0812345678${'f'.repeat(30)}`;
  assert.doesNotMatch(buildSha(phoneLike), /^0[1-9][0-9]{7,8}(?![0-9])/);
});

const liveReport = (overrides = {}) => ({
  type: 'u1.uat.readiness',
  mode: 'live',
  status: 'PASS',
  checks: [
    ...REQUIRED_LIVE_CHECKS.map((id) => ({ id: `${id} something`, status: 'PASS' })),
    { id: 'UAT-L06 journey', status: 'SKIPPED' },
  ],
  ...overrides,
});

test('assert smoke: L01-L05/L07 must PASS, L06 may be SKIPPED', () => {
  assert.deepEqual(assertSmoke(liveReport()), []);
  const failing = liveReport();
  failing.checks[4] = { id: 'UAT-L05 admin', status: 'FAIL' };
  assert.deepEqual(assertSmoke({ ...failing, status: 'FAIL' }), ['UAT-L05:FAIL', 'status:FAIL']);
  const missing = liveReport();
  missing.checks = missing.checks.filter((entry) => !entry.id.startsWith('UAT-L07'));
  assert.deepEqual(assertSmoke(missing), ['UAT-L07:MISSING']);
  assert.deepEqual(assertSmoke({ type: 'u1.uat.readiness', mode: 'static' }), [
    'NOT_LIVE_READINESS_REPORT',
  ]);
});

const provisionLines = (mode, status, extra = {}) => [
  ...PROVISION_PARTS.map((part) => ({
    type: 'u1.uat.provision',
    mode,
    part,
    status,
    ...(part === 'fixturePack' ? { digest: 'd'.repeat(64), ...extra } : {}),
  })),
  { type: 'u1.uat.provision', mode, status: 'PASS' },
];

test('assert provision: check = WOULD_CREATE (preflight SKIPPED), apply = CREATED, repeat = UNCHANGED', () => {
  assert.deepEqual(
    assertProvision(provisionLines('check', 'WOULD_CREATE', { preflight: 'SKIPPED' }), 'check'),
    [],
  );
  assert.deepEqual(assertProvision(provisionLines('apply', 'CREATED'), 'apply'), []);
  assert.deepEqual(assertProvision(provisionLines('apply', 'UNCHANGED'), 'reapply'), []);
  assert.ok(assertProvision(provisionLines('apply', 'CREATED'), 'reapply').length > 0);
  const failed = [
    { type: 'u1.uat.provision', mode: 'apply', status: 'FAIL', code: 'TENANT_CONFLICT' },
  ];
  assert.deepEqual(assertProvision(failed, 'apply'), ['final:FAIL:TENANT_CONFLICT', 'parts:NONE']);
});

test('assert accounts/step and jsonLines skip lines that are not JSON', () => {
  const lines = jsonLines(
    [
      ' Container dcontact-uat-keycloak-1  Running',
      JSON.stringify({
        type: 'u1.uat.keycloak',
        mode: 'users',
        accounts: [
          { role: 'maker', keycloakId: 'k1', dcUserId: 'u1', status: 'CREATED' },
          { role: 'reviewer', keycloakId: 'k2', dcUserId: 'u2', status: 'CREATED' },
        ],
      }),
    ].join('\n'),
  );
  assert.deepEqual(assertAccounts(lines), []);
  assert.deepEqual(assertAccounts([]), ['NO_USERS_SUMMARY']);
  const backup = [{ type: 'u1.uat.deploy', step: 'backup', status: 'SKIPPED' }];
  assert.deepEqual(assertStep(backup, 'SKIPPED'), []);
  assert.deepEqual(assertStep(backup, 'PASS'), ['backup:SKIPPED']);
});
