import assert from 'node:assert/strict';
import test from 'node:test';
import {
  U1_CHECKS,
  U1_MARKER,
  U1_STEP_CATALOG,
  createU1Manifest,
  flattenPlaywrightReport,
  forbiddenEvidenceFiles,
  playwrightCheckStatus,
  renderGateRealm,
  scanU1Evidence,
  u1ApiEnvironment,
  u1Environment,
  u1MarkerBlockers,
  u1Summary,
} from './u1-acceptance.mjs';

const SHA = 'a'.repeat(40);
const context = (overrides = {}) => ({
  ref: 'refs/heads/main',
  commitSha: SHA,
  expectedCommitSha: SHA,
  cleanTree: true,
  runId: '123',
  attempt: 1,
  runUrl: 'https://github.com/o/r/actions/runs/123/attempts/1',
  ...overrides,
});
const allPass = () => U1_CHECKS.map(({ id }) => ({ id, status: 'PASS' }));

test('U1.7 marker ออกเมื่อทุก check PASS บน expected SHA ที่ tree สะอาดเท่านั้น', () => {
  const summary = u1Summary(context(), allPass());
  assert.deepEqual(summary.markers, [U1_MARKER]);
  assert.equal(summary.status, 'PASS');
  assert.equal(summary.entryCondition, 'READY_TO_OPEN_416');
  // marker นี้ไม่ใช่การยืนยันว่า UAT ผ่าน
  assert.equal(summary.uatAccepted, false);
  assert.match(summary.evidenceScope, /#416/);

  const failed = allPass();
  failed[3] = { ...failed[3], status: 'FAIL' };
  assert.deepEqual(u1MarkerBlockers(context(), failed), ['CHECKS_NOT_ALL_PASS']);
  assert.deepEqual(u1Summary(context(), failed).markers, []);
  assert.deepEqual(u1MarkerBlockers(context(), allPass().slice(1)), ['CHECKS_NOT_ALL_PASS']);
  assert.deepEqual(u1MarkerBlockers(context({ expectedCommitSha: null }), allPass()), [
    'EXPECTED_SHA_MISSING',
  ]);
  assert.deepEqual(u1MarkerBlockers(context({ expectedCommitSha: 'b'.repeat(40) }), allPass()), [
    'NOT_EXPECTED_SHA',
  ]);
  assert.deepEqual(u1MarkerBlockers(context({ cleanTree: false }), allPass()), ['DIRTY_TREE']);
  const notReady = u1Summary(context({ cleanTree: false }), allPass());
  assert.equal(notReady.status, 'PASS');
  assert.deepEqual(notReady.markers, []);
  assert.equal(notReady.entryCondition, 'NOT_READY');
});

test('U1.7 สถานะ check มาจาก test ที่ชื่อขึ้นต้นด้วย id — ไม่มี test = FAIL, skipped/failed = FAIL', () => {
  const report = {
    suites: [
      {
        specs: [],
        suites: [
          {
            specs: [
              { title: 'U1-MAKER รอบที่ 1', tests: [{ results: [{ status: 'passed' }] }] },
              { title: 'U1-RERUN a', tests: [{ results: [{ status: 'passed' }] }] },
              { title: 'U1-RERUN b', tests: [{ results: [{ status: 'failed' }] }] },
              { title: 'U1-REVIEW x', tests: [{ results: [] }] },
            ],
          },
        ],
      },
    ],
  };
  const tests = flattenPlaywrightReport(report);
  assert.equal(tests.length, 4);
  assert.deepEqual(playwrightCheckStatus('U1-MAKER', tests), { status: 'PASS', tests: 1 });
  assert.equal(playwrightCheckStatus('U1-RERUN', tests).status, 'FAIL');
  assert.equal(playwrightCheckStatus('U1-REVIEW', tests).status, 'FAIL');
  assert.deepEqual(playwrightCheckStatus('U1-NEG-EGRESS', tests), {
    status: 'FAIL',
    detail: 'NO_TEST',
  });
  // prefix ต้องตรงทั้งคำ: U1-NEG-* ไม่นับเป็นของ U1-N
  assert.equal(playwrightCheckStatus('U1-MAK', tests).detail, 'NO_TEST');
  assert.deepEqual(flattenPlaywrightReport(null), []);
});

test('U1.7 negative scan ของ manifest จับ token/credential/อีเมล/OIDC code และค่าลับของรอบ', () => {
  const secret = 'U1gSecretPassword7a';
  const findings = scanU1Evidence(
    {
      ok: { digest: 'f'.repeat(64), note: 'รอบที่ 1 ACTIVE' },
      jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      bearer: 'Authorization: Bearer abcdefghijkl',
      email: 'maker@example.com',
      url: 'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact',
      callback: 'http://localhost:5176/?tenant=a&code=xyz',
      nested: [{ actual: `password is ${secret}` }],
      accessToken: 'x',
    },
    [secret],
  );
  assert.deepEqual(findings.map((finding) => finding.kind).sort(), [
    'BEARER',
    'CREDENTIAL_URL',
    'EMAIL',
    'JWT',
    'OIDC_CODE',
    'RUN_SECRET',
    'SENSITIVE_KEY',
  ]);
  // finding บอกตำแหน่งเท่านั้น ไม่คืนค่าที่ match
  assert.ok(findings.every((finding) => !JSON.stringify(finding).includes(secret)));
  assert.deepEqual(scanU1Evidence({ steps: U1_STEP_CATALOG }), []);
});

test('U1.7 ไฟล์หลักฐานต้องไม่มี trace/HAR/video', () => {
  assert.deepEqual(
    forbiddenEvidenceFiles([
      'artifacts/u1-acceptance/screenshots/run-1-PUBLISH.png',
      'artifacts/u1-acceptance/manifest-1.json',
      'test-results/x/trace.zip',
      'network.har',
      'video.webm',
      'test-results/u1-evidence-ไม่มี-trace-HAR-chromium/error-context.md',
    ]),
    ['test-results/x/trace.zip', 'network.har', 'video.webm'],
  );
});

test('U1.7 API ของ gate บูตด้วย profile uat จาก env ที่สร้างใหม่ ไม่สืบ LINE_/KAFKA_/SIP_ ของ runner', () => {
  const config = u1Environment({
    DATABASE_URL: 'postgresql://dcontact:dcontact@localhost:5433/dcontact?schema=public',
  });
  assert.equal(
    config.appDatabaseUrl,
    'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
  );
  const environment = u1ApiEnvironment(config, {
    PATH: '/bin',
    LINE_WEBHOOK_SECRET_SOURCE: 'disabled',
    KAFKA_BROKERS: 'localhost:9092',
    SIP_BROWSER_NODES_JSON: '[]',
  });
  assert.equal(environment.DCONTACT_API_PROFILE, 'uat');
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.DATABASE_URL, config.appDatabaseUrl);
  assert.equal(environment.S3_ENDPOINT, 'http://localhost:9000');
  assert.equal(environment.S3_BUCKET_UAT_EVIDENCE, 'uat-evidence');
  assert.ok(Object.keys(environment).every((name) => !/^(LINE_|KAFKA_BROKERS$|SIP_)/.test(name)));
});

test('U1.7 realm ของ gate มาจาก template ของ UAT: PKCE/OTP เหมือนเดิม เปลี่ยนแค่ realm/origin/Organization', () => {
  const tenants = [
    { id: '11111111-1111-4111-8111-111111111111', slug: 'u1g-x-a', name: 'A' },
    { id: '22222222-2222-4222-8222-222222222222', slug: 'u1g-x-b', name: 'B' },
  ];
  const realm = renderGateRealm({
    realm: 'dcontact-u1-gate',
    consoleOrigin: 'http://localhost:5176',
    tenants,
  });
  assert.equal(realm.realm, 'dcontact-u1-gate');
  assert.equal(realm.browserFlow, 'uat browser password otp');
  const client = realm.clients.find((entry) => entry.clientId === 'dcontact-uat-console');
  assert.equal(client.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.deepEqual(client.redirectUris, [
    'http://localhost:5176/?tenant=u1g-x-a',
    'http://localhost:5176/?tenant=u1g-x-b',
  ]);
  assert.deepEqual(
    realm.organizations.map((organization) => [
      organization.alias,
      organization.attributes.tenant_id[0],
    ]),
    tenants.map((tenant) => [tenant.slug, tenant.id]),
  );
  assert.equal(JSON.stringify(realm).includes('${env.'), false);
});

test('U1.7 manifest บอกขอบเขตว่าไม่ใช่ UAT acceptance และไม่มี marker เมื่อไม่ผ่าน', () => {
  const checks = allPass();
  checks[0].status = 'FAIL';
  const summary = u1Summary(context(), checks);
  const manifest = createU1Manifest({
    context: context(),
    checks,
    summary,
    evidence: { bundles: [], screenshots: [] },
    startedAt: new Date('2026-09-28T00:00:00Z'),
  });
  assert.equal(manifest.marker.emitted, false);
  assert.equal(manifest.marker.uatAccepted, false);
  assert.deepEqual(manifest.summary.markers, []);
  assert.deepEqual(
    manifest.stepCatalog.map((step) => step.stepId),
    U1_STEP_CATALOG.map((step) => step.stepId),
  );
});
