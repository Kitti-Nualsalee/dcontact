import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  UAT_CONSOLE_CLIENT_ID,
  UAT_REALM_TEMPLATE,
  applyRealmConfig,
  createKeycloakAdmin,
  renderRealm,
} from './u1-uat-keycloak-users.mjs';

/**
 * U1.7 (#435): acceptance gate ของ UAT first slice บน backend จริง ก่อนเปิด #416
 *
 * Authority: Phase Contract #374, evidence #379, first slice #372
 *
 * - stack รูปเดียวกับ UAT: API entry `uat-main` (`DCONTACT_API_PROFILE=uat`) ต่อ Postgres ด้วย app role
 *   (RLS), Keycloak จริง (realm จาก template ของ UAT: PKCE + password+TOTP + Organization), evidence store
 *   แบบ S3 (object storage ของ dev compose ใน CI) และ Console ผ่าน Vite ที่ proxy `/api/v1` แบบ same-origin
 * - Playwright ไม่ mock API เลย (`apps/console/e2e-uat/`); ข้อมูลตั้งต้นสร้างแบบเดียวกับ operator
 *   (`UatFixtureProvisioner`) และบัญชี Keycloak สุ่มใหม่ทุกรอบ (ไม่มี credential ของ dev)
 * - หลักฐาน = screenshot + manifest เท่านั้น (ห้าม trace/HAR/video ตาม #379) และ manifest ต้องผ่าน
 *   negative scan ของ server (bundle) และของ gate เอง
 * - marker `U1_ACCEPTANCE_GATE_PASSED` ออกเมื่อทุก check PASS บน `U1_EXPECTED_COMMIT_SHA` ที่ tree สะอาด
 *   เท่านั้น — marker นี้แปลว่า "พร้อมเปิด #416" ไม่ใช่ "UAT ผ่าน": #416 ยังต้องเดินบน URL จริงโดยทีม UAT
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const U1_MARKER = 'U1_ACCEPTANCE_GATE_PASSED';
export const U1_WORKFLOW = Object.freeze({ name: 'cxa-u1-acceptance', version: 1 });
export const U1_CONTEXT_POINTERS = Object.freeze(['#372', '#374', '#376', '#378', '#379', '#435']);
export const U1_EVIDENCE_SCOPE =
  'Pre-UAT gate on a UAT-shaped local stack only; uatAccepted=false — #416 must still be walked by the UAT team on the real UAT URL';
export const U1_OUTPUT_RELATIVE = 'artifacts/u1-acceptance';

/**
 * step catalog ที่ gate provision ลง fixture pack และ #416 อ้างอิง (docs/u1-uat-acceptance-checklist.md)
 * expected ตรึงใน pack; ผู้ทดสอบกรอกแค่ actual/ผล
 */
export const U1_STEP_CATALOG = Object.freeze([
  {
    stepId: 'RUN_OPENED',
    title: 'เปิดรอบ UAT',
    expected:
      'รอบนี้ ACTIVE พร้อม run ID, build SHA และ fixture digest จาก server; รอบก่อนหน้า (ถ้ามี) ปิดเป็น COMPLETED/ABANDONED และหลักฐานเดิมยังอ่านได้',
    stateLabel: 'REAL_STATE',
  },
  {
    stepId: 'MAKER_EDIT',
    title: 'Maker แก้ Journey ของรอบ',
    expected: 'แทรก WAIT ได้ EVENT_TRIGGER → SEND → WAIT → EXIT และบันทึกได้ revision ใหม่',
    stateLabel: 'REAL_STATE',
  },
  {
    stepId: 'DIAGNOSTIC_RECOVERY',
    title: 'แก้ diagnostic',
    expected:
      'graph ที่ไม่สมบูรณ์บันทึกได้แต่ validate พบ diagnostic ที่ชี้ node; แก้แล้ว validate ไม่พบข้อผิดพลาด',
    stateLabel: 'REAL_STATE',
  },
  {
    stepId: 'COMPILE',
    title: 'Compile ฉบับร่าง',
    expected: 'compile revision ล่าสุดได้ compile digest จาก server',
    stateLabel: 'REAL_STATE',
  },
  {
    stepId: 'SIMULATE',
    title: 'จำลองการทำงาน',
    expected:
      'จำลองด้วย fixture ที่ server ตรึง ผลติดป้าย SIMULATION_ONLY และแสดงเวลาเสมือน ไม่ใช่การส่งจริง',
    stateLabel: 'SIMULATION_ONLY',
  },
  {
    stepId: 'SUBMIT_REVIEW',
    title: 'ส่งตรวจ',
    expected: 'candidate เข้าสถานะ IN_REVIEW และ maker ไม่มีปุ่มตัดสินงานของตัวเอง',
    stateLabel: 'REAL_STATE',
  },
  {
    stepId: 'REVIEW_APPROVE',
    title: 'Reviewer อนุมัติ',
    expected:
      'reviewer คนละบัญชีหา candidate เองจากตัวกรองรอตรวจ เห็น compile digest เดียวกัน แล้วอนุมัติได้ APPROVED',
    stateLabel: 'REAL_STATE',
  },
  {
    stepId: 'PUBLISH',
    title: 'Publish',
    expected: 'maker publish ได้ version และ receipt ที่ server ยืนยัน',
    stateLabel: 'REAL_STATE',
  },
  {
    stepId: 'AUDIT',
    title: 'ตรวจ audit',
    expected:
      'ประวัติแสดง REVIEW_SUBMITTED, REVIEW_APPROVED และ JOURNEY_PUBLISHED ของ Journey รอบนี้',
    stateLabel: 'REAL_STATE',
  },
]);

export const U1_SIMULATION_FIXTURE = Object.freeze({
  fixtureId: 'u1-gate-fixture-1',
  startAt: '2026-09-01T02:00:00.000Z',
  seed: 'u1-gate-seed-1',
  context: { segment: 'synthetic-u1' },
  // ผลของ SEND ใน simulation เป็นค่าสมมติของ fixture (SIMULATION_ONLY) — node id มาจาก baseline ของ pack
  sendOutcomes: { 'send-1': 'SENT' },
});

function check(id, dimension, title) {
  return { id, dimension, title };
}

/**
 * checks ของ gate — check ที่มาจาก Playwright ผูกกับ test ที่ชื่อขึ้นต้นด้วย id นั้น (ไม่มี test = FAIL)
 * ลำดับ = ลำดับที่รายงาน
 */
export const U1_CHECKS = Object.freeze([
  check(
    'U1-SETUP',
    'environment',
    'Keycloak realm/บัญชี + fixture pack ผ่าน UatFixtureProvisioner',
  ),
  check('U1-PROFILE', 'environment', 'API บูตจาก uat-main ด้วย profile uat'),
  check('U1-MAKER', 'functional', 'maker: edit, diagnostic recovery, compile/simulate, submit'),
  check('U1-REVIEW', 'authorization', 'reviewer คนละบัญชีหา candidate จากตัวกรองรอตรวจแล้วอนุมัติ'),
  check('U1-PUBLISH', 'functional', 'publish + receipt + audit'),
  check(
    'U1-RERUN',
    'recovery',
    'เริ่มรอบใหม่ แล้ว rerun: รอบใหม่ ACTIVE, รอบเดิมปิด, หลักฐานเดิมอยู่',
  ),
  check('U1-NEG-SELF-APPROVAL', 'authorization', 'maker อนุมัติงานตัวเองไม่ได้'),
  check('U1-NEG-CROSS-TENANT', 'tenant-isolation', 'token ของ tenant อื่นแตะ run/Journey ไม่ได้'),
  check('U1-NEG-ABANDONED', 'recovery', 'candidate ของรอบที่ ABANDONED ส่งตรวจ/publish ไม่ได้'),
  check('U1-NEG-EGRESS', 'boundary', 'provider egress BLOCKED และ route นอก allowlist ถูกปิด'),
  check('U1-EVIDENCE', 'evidence', 'screenshot ผ่าน evidence API + bundle verdict/scan PASS'),
  check('U1-EVIDENCE-HYGIENE', 'evidence', 'ไม่มี trace/HAR/video และ manifest ผ่าน negative scan'),
]);

const PLAYWRIGHT_CHECKS = new Set([
  'U1-MAKER',
  'U1-REVIEW',
  'U1-PUBLISH',
  'U1-RERUN',
  'U1-NEG-SELF-APPROVAL',
  'U1-NEG-CROSS-TENANT',
  'U1-NEG-ABANDONED',
  'U1-NEG-EGRESS',
  'U1-EVIDENCE',
]);

export function sha256(value) {
  return createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
}

// ── Context ──────────────────────────────────────────────────────────────────

function runGit(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) throw new Error(`git ${arguments_.join(' ')} ล้มเหลว`);
  return String(result.stdout).trim();
}

export function createU1Context(environment = process.env) {
  const commitSha = runGit(['rev-parse', 'HEAD']);
  const runId = environment.GITHUB_RUN_ID ?? `local-${randomUUID()}`;
  const attempt = Number(environment.GITHUB_RUN_ATTEMPT ?? 1);
  const repository = environment.GITHUB_REPOSITORY ?? null;
  const runUrl =
    environment.GITHUB_RUN_ID && repository
      ? `${environment.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${runId}/attempts/${attempt}`
      : null;
  return {
    repository,
    ref: environment.GITHUB_REF ?? `refs/heads/${runGit(['rev-parse', '--abbrev-ref', 'HEAD'])}`,
    commitSha,
    expectedCommitSha: environment.U1_EXPECTED_COMMIT_SHA ?? null,
    cleanTree: runGit(['status', '--porcelain', '--untracked-files=no']) === '',
    runId,
    attempt,
    runUrl,
  };
}

// ── Checks / summary / manifest (pure) ───────────────────────────────────────

/** สถานะ check จากผล Playwright: ทุก test ของ id ต้อง passed และต้องมีอย่างน้อยหนึ่ง test */
export function playwrightCheckStatus(id, tests) {
  const owned = tests.filter((entry) => entry.title.startsWith(`${id} `));
  if (owned.length === 0) return { status: 'FAIL', detail: 'NO_TEST' };
  const failed = owned.filter((entry) => entry.status !== 'passed');
  return failed.length === 0
    ? { status: 'PASS', tests: owned.length }
    : { status: 'FAIL', tests: owned.length, failed: failed.map((entry) => entry.title) };
}

/** รวบรวม test จาก Playwright JSON report (suite ซ้อนได้หลายชั้น) */
export function flattenPlaywrightReport(report) {
  const tests = [];
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      const results = (spec.tests ?? []).flatMap((entry) => entry.results ?? []);
      const last = results.at(-1);
      tests.push({ title: spec.title, status: last?.status ?? 'skipped' });
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);
  return tests;
}

export function u1MarkerBlockers(context, checks) {
  const blockers = [];
  if (
    checks.length !== U1_CHECKS.length ||
    U1_CHECKS.some(({ id }) => checks.find((item) => item.id === id)?.status !== 'PASS')
  )
    blockers.push('CHECKS_NOT_ALL_PASS');
  if (!context.expectedCommitSha) blockers.push('EXPECTED_SHA_MISSING');
  else if (context.commitSha !== context.expectedCommitSha) blockers.push('NOT_EXPECTED_SHA');
  if (!context.cleanTree) blockers.push('DIRTY_TREE');
  return blockers;
}

export function u1Summary(context, checks, startedAt = new Date()) {
  const blockers = u1MarkerBlockers(context, checks);
  const allPassed = !blockers.includes('CHECKS_NOT_ALL_PASS');
  const markers = blockers.length === 0 ? [U1_MARKER] : [];
  return {
    type: 'readiness.summary',
    workflow: U1_WORKFLOW.name,
    workflowVersion: U1_WORKFLOW.version,
    status: allPassed ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: checks.filter(({ status }) => status === 'PASS').length,
    failed: checks.filter(({ status }) => status !== 'PASS').length,
    markers,
    markerBlockers: blockers,
    candidateOnly: markers.length === 0,
    uatAccepted: false,
    entryCondition: markers.length > 0 ? 'READY_TO_OPEN_416' : 'NOT_READY',
    evidenceScope: U1_EVIDENCE_SCOPE,
  };
}

const SENSITIVE_KEY =
  /^(?:(?:access|refresh|id)_token|accessToken|authorization|cookie|password|passwd|secret|client_secret|totp|otp)$/i;
const SENSITIVE_VALUE = [
  ['JWT', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/],
  ['BEARER', /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i],
  ['EMAIL', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['CREDENTIAL_URL', /(?:postgres(?:ql)?|redis|https?):\/\/[^:\s/@]+:[^@\s/]+@/i],
  ['OIDC_CODE', /[?&](?:code|state|session_state)=/],
];

/**
 * negative scan ของ manifest ฝั่ง gate: token/credential/อีเมล/OIDC code และค่าลับของรอบนี้
 * (รหัสผ่าน/TOTP secret ที่สุ่มให้บัญชี) ต้องไม่อยู่ในหลักฐาน — คืน findings (ไม่คืนค่าที่ match)
 */
export function scanU1Evidence(value, secrets = []) {
  const findings = [];
  const visit = (candidate, path) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (candidate && typeof candidate === 'object') {
      for (const [key, nested] of Object.entries(candidate)) {
        if (SENSITIVE_KEY.test(key))
          findings.push({ kind: 'SENSITIVE_KEY', path: `${path}.${key}` });
        visit(nested, `${path}.${key}`);
      }
      return;
    }
    if (typeof candidate !== 'string') return;
    for (const [kind, pattern] of SENSITIVE_VALUE) {
      if (pattern.test(candidate)) findings.push({ kind, path });
    }
    if (secrets.some((secret) => secret && candidate.includes(secret)))
      findings.push({ kind: 'RUN_SECRET', path });
  };
  visit(value, '$');
  return findings;
}

/** ไฟล์ที่ห้ามเป็นหลักฐาน (#379): Playwright trace, HAR, video, network log */
export function forbiddenEvidenceFiles(paths) {
  // ตรวจชื่อไฟล์เท่านั้น — ชื่อโฟลเดอร์ของ Playwright มาจากชื่อ test ซึ่งอาจมีคำว่า trace
  return paths.filter((path) => {
    const name = path.split(/[\\/]/).at(-1) ?? '';
    return /\.(?:zip|har|webm|mp4|trace|network|log)$/i.test(name) || /^trace/i.test(name);
  });
}

export function createU1Manifest({ context, checks, summary, evidence, startedAt }) {
  return {
    schema: 'U1AcceptanceGateManifestV1',
    workflow: U1_WORKFLOW,
    contextPointers: U1_CONTEXT_POINTERS,
    marker: {
      name: U1_MARKER,
      emitted: summary.markers.includes(U1_MARKER),
      meaning: 'U1 first slice passed the automated real-backend gate; ready to open #416',
      uatAccepted: false,
      blockers: summary.markerBlockers,
    },
    evidenceScope: U1_EVIDENCE_SCOPE,
    run: {
      id: context.runId,
      attempt: context.attempt,
      url: context.runUrl,
      startedAt: startedAt.toISOString(),
    },
    refProof: {
      ref: context.ref,
      commitSha: context.commitSha,
      expectedCommitSha: context.expectedCommitSha,
      cleanTree: context.cleanTree,
    },
    stepCatalog: U1_STEP_CATALOG.map(({ stepId, title, stateLabel }) => ({
      stepId,
      title,
      stateLabel,
    })),
    checks,
    summary,
    evidence,
  };
}

// ── Environment ──────────────────────────────────────────────────────────────

export function u1Environment(environment = process.env) {
  const ownerDatabaseUrl =
    environment.DATABASE_URL ??
    'postgresql://dcontact:dcontact@localhost:5433/dcontact?schema=public';
  const appUrl = new URL(ownerDatabaseUrl);
  appUrl.username = 'dcontact_app';
  appUrl.password = 'dcontact_app';
  const apiPort = Number(environment.U1_API_PORT ?? 3017);
  const consolePort = Number(environment.U1_CONSOLE_PORT ?? 5176);
  const keycloakUrl = (environment.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081').replace(
    /\/$/,
    '',
  );
  const realm = environment.U1_KEYCLOAK_REALM ?? 'dcontact-u1-gate';
  return {
    ownerDatabaseUrl,
    appDatabaseUrl: environment.U1_APP_DATABASE_URL ?? appUrl.toString(),
    keycloakUrl,
    keycloakAdminUsername: environment.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
    keycloakAdminPassword: environment.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin',
    realm,
    issuer: `${keycloakUrl}/realms/${realm}`,
    objectStorage: {
      endpoint: environment.S3_ENDPOINT ?? environment.MINIO_ENDPOINT ?? 'http://localhost:9000',
      accessKey: environment.S3_ACCESS_KEY ?? environment.MINIO_ACCESS_KEY ?? 'dcontact',
      secretKey: environment.S3_SECRET_KEY ?? environment.MINIO_SECRET_KEY ?? 'dcontact-secret',
      bucket:
        environment.S3_BUCKET_UAT_EVIDENCE ?? environment.UAT_EVIDENCE_BUCKET ?? 'uat-evidence',
    },
    apiPort,
    apiUrl: `http://localhost:${apiPort}`,
    consolePort,
    consoleOrigin: `http://localhost:${consolePort}`,
    packVersion: environment.U1_PACK_VERSION ?? 'u1-gate-1',
    playwrightConfig: environment.U1_PLAYWRIGHT_CONFIG ?? 'e2e-uat/playwright.config.ts',
  };
}

// ── Identity (Keycloak) ──────────────────────────────────────────────────────

/** รหัสผ่านตาม password policy ของ realm UAT (ยาว, ตัวใหญ่/เล็ก/ตัวเลข) — สุ่มใหม่ทุกรอบ ไม่เก็บ */
function randomPassword() {
  return `U1g${randomBytes(12).toString('base64url')}7a`;
}

/**
 * realm ของ gate = template ของ UAT ที่ render ด้วย renderer เดียวกับ U1.6 แล้วเปลี่ยนเฉพาะชื่อ realm,
 * origin ของ Console (localhost) และเพิ่ม Organization ของ tenant ที่สอง — flow/OTP/PKCE/mapper เหมือน UAT
 */
export function renderGateRealm({ realm, consoleOrigin, tenants }) {
  const template = JSON.parse(readFileSync(resolve(repositoryRoot, UAT_REALM_TEMPLATE), 'utf8'));
  const [first] = tenants;
  const rendered = renderRealm(template, {
    UAT_HOST: 'u1-gate.invalid',
    UAT_TENANT_ID: first.id,
    UAT_TENANT_SLUG: first.slug,
    UAT_TENANT_NAME: first.name,
    UAT_ORGANIZATION_DOMAIN: `${first.slug}.u1-gate.invalid`,
  });
  rendered.realm = realm;
  rendered.displayName = 'D-Contact (U1 acceptance gate)';
  const redirects = tenants.map((tenant) => `${consoleOrigin}/?tenant=${tenant.slug}`);
  const client = rendered.clients.find((entry) => entry.clientId === UAT_CONSOLE_CLIENT_ID);
  client.redirectUris = redirects;
  client.webOrigins = [consoleOrigin];
  client.attributes['post.logout.redirect.uris'] = redirects.join('##');
  const organization = rendered.organizations[0];
  rendered.organizations = tenants.map((tenant) => ({
    ...organization,
    name: tenant.name,
    alias: tenant.slug,
    domains: [{ name: `${tenant.slug}.u1-gate.invalid`, verified: true }],
    attributes: { tenant_id: [tenant.id], tenant_slug: [tenant.slug] },
  }));
  return rendered;
}

async function createGateAccount(admin, realm, organizations, account) {
  const base = `/admin/realms/${realm}`;
  await admin.call(`${base}/users`, {
    method: 'POST',
    body: {
      username: account.username,
      email: `${account.username}@u1-gate.invalid`,
      firstName: 'U1',
      lastName: account.role,
      enabled: true,
      emailVerified: true,
      attributes: {
        tenant_id: [account.tenantId],
        tenant_slug: [account.tenantSlug],
        dc_user_id: [account.dcUserId],
      },
      requiredActions: [],
      credentials: [
        { type: 'password', value: account.password, temporary: false },
        {
          type: 'otp',
          userLabel: 'u1 gate authenticator',
          secretData: JSON.stringify({ value: account.totpSecret }),
          credentialData: JSON.stringify({
            subType: 'totp',
            digits: 6,
            counter: 0,
            period: 30,
            algorithm: 'HmacSHA1',
          }),
        },
      ],
    },
  });
  const [user] = await admin.call(
    `${base}/users?${new URLSearchParams({ username: account.username, exact: 'true' })}`,
  );
  if (!user) throw new Error(`Keycloak user ของ ${account.role} ไม่ถูกสร้าง`);
  // required action ค่าเริ่มต้นของ realm (CONFIGURE_TOTP) ไม่ต้องใช้ — มี OTP credential แล้ว
  await admin.call(`${base}/users/${user.id}`, {
    method: 'PUT',
    body: { ...user, requiredActions: [] },
  });
  const organization = organizations.find((entry) => entry.alias === account.tenantSlug);
  await admin.call(`${base}/organizations/${organization.id}/members`, {
    method: 'POST',
    rawBody: user.id,
  });
}

export async function setupU1Identity(config, fixture) {
  const admin = createKeycloakAdmin({
    baseUrl: config.keycloakUrl,
    username: config.keycloakAdminUsername,
    password: config.keycloakAdminPassword,
  });
  await admin.login();
  const tenants = [fixture.tenants.a, fixture.tenants.b].map((tenant, index) => ({
    ...tenant,
    name: `U1 gate ${fixture.tag} ${index === 0 ? 'A' : 'B'}`,
  }));
  const rendered = renderGateRealm({
    realm: config.realm,
    consoleOrigin: config.consoleOrigin,
    tenants,
  });
  const realmResult = await applyRealmConfig(admin, rendered);
  const organizations = await admin.call(`/admin/realms/${config.realm}/organizations?max=1000`);
  const accounts = {};
  for (const [role, user] of Object.entries(fixture.users)) {
    const tenant = fixture.tenants[user.tenant];
    const account = {
      role,
      username: `u1g-${fixture.tag}-${role}`,
      password: randomPassword(),
      totpSecret: randomBytes(15).toString('base64url'),
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      dcUserId: user.id,
    };
    await createGateAccount(admin, config.realm, organizations, account);
    accounts[role] = account;
  }
  return { realm: realmResult, accounts };
}

// ── Processes ────────────────────────────────────────────────────────────────

const API_FORBIDDEN_ENV = [/^LINE_/, /^KAFKA_BROKERS$/, /^SIP_/];

/** env ของ API สร้างใหม่ทั้งชุด — ไม่สืบ env ของ runner ที่อาจมี LINE_/KAFKA_/SIP_ (profile uat จะไม่บูต) */
export function u1ApiEnvironment(config, base = process.env) {
  const inherited = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SystemRoot']
      .filter((name) => base[name] !== undefined)
      .map((name) => [name, base[name]]),
  );
  const environment = {
    ...inherited,
    NODE_ENV: 'production',
    DCONTACT_API_PROFILE: 'uat',
    PORT: String(config.apiPort),
    DATABASE_URL: config.appDatabaseUrl,
    KEYCLOAK_ISSUER: config.issuer,
    KEYCLOAK_AUDIENCE: 'dcontact-api',
    KEYCLOAK_JWKS_URI: `${config.issuer}/protocol/openid-connect/certs`,
    J5_CANVAS_WRITE_ENABLED: 'true',
    J5_PUBLISH_UI_ENABLED: 'true',
    J5_TEMPLATE_CATALOG_ENABLED: 'false',
    J5_TEMPLATE_UPGRADE_ENABLED: 'false',
    S3_ENDPOINT: config.objectStorage.endpoint,
    S3_ACCESS_KEY: config.objectStorage.accessKey,
    S3_SECRET_KEY: config.objectStorage.secretKey,
    S3_BUCKET_UAT_EVIDENCE: config.objectStorage.bucket,
  };
  const conflicting = Object.keys(environment).filter((name) =>
    API_FORBIDDEN_ENV.some((pattern) => pattern.test(name)),
  );
  if (conflicting.length > 0) throw new Error(`env ขัดกับ profile uat: ${conflicting.join(', ')}`);
  return environment;
}

async function waitFor(check, { timeoutMs, intervalMs = 500, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // ยังไม่พร้อม
    }
    if (Date.now() > deadline) throw new Error(`${label} ไม่พร้อมภายใน ${timeoutMs}ms`);
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
}

/** บูต API จาก entry ของ UAT (`dist/uat-main.js`) แล้วรอ `/api/v1/runtime-profile` */
export async function startU1Api(config) {
  const log = [];
  const child = spawn(process.execPath, ['dist/uat-main.js'], {
    cwd: resolve(repositoryRoot, 'apps/api'),
    env: u1ApiEnvironment(config),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const remember = (chunk) => {
    // เก็บเฉพาะชื่อ event ของ log แบบ JSON — ไม่เก็บข้อความดิบที่อาจมี config
    for (const line of String(chunk).split('\n')) {
      const match = line.match(/"event":"([a-z0-9._]+)"/);
      if (match) log.push(match[1]);
    }
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });
  const profile = await waitFor(
    async () => {
      if (exited !== null) throw new Error('exited');
      const response = await fetch(`${config.apiUrl}/api/v1/runtime-profile`);
      return response.ok ? response.json() : null;
    },
    { timeoutMs: 60_000, label: 'UAT API' },
  ).catch((error) => {
    throw new Error(
      `API profile uat บูตไม่ผ่าน (${[...new Set(log)].join(', ')}): ${error.message}`,
    );
  });
  return { child, profile, events: log };
}

function stop(child) {
  if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runU1Acceptance(options = {}) {
  const environment = options.environment ?? process.env;
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const startedAt = new Date();
  const context = createU1Context(environment);
  const config = u1Environment(environment);
  const outputRoot = resolve(repositoryRoot, U1_OUTPUT_RELATIVE);
  const screenshotDir = resolve(outputRoot, 'screenshots');
  // state ของรอบ (มีรหัสผ่าน/TOTP secret ที่สุ่ม) อยู่นอก artifacts และลบทิ้งเมื่อจบ
  const scratch = mkdtempSync(join(tmpdir(), 'u1-gate-'));
  const statePath = join(scratch, 'state.json');
  const reportPath = join(scratch, 'playwright-report.json');
  const playwrightOutput = join(scratch, 'test-results');
  rmSync(screenshotDir, { recursive: true, force: true });
  mkdirSync(screenshotDir, { recursive: true });

  const checks = [];
  const record = (id, status, detail = {}) => {
    const definition = U1_CHECKS.find((entry) => entry.id === id);
    const item = {
      id,
      dimension: definition.dimension,
      title: definition.title,
      status,
      ...detail,
    };
    checks.push(item);
    emit({ type: 'readiness.check', id, status, ...detail });
  };

  let api;
  const secrets = [];
  let bundles = [];
  let screenshots = [];
  let profileReport = null;
  try {
    let fixture;
    let identity;
    try {
      const { provisionU1AcceptanceFixture } = await import(
        pathToFileURL(resolve(repositoryRoot, 'apps/api/scripts/u1-acceptance-fixture.mjs')).href
      );
      fixture = await provisionU1AcceptanceFixture({
        ownerDatabaseUrl: config.ownerDatabaseUrl,
        buildSha: context.commitSha,
        packVersion: config.packVersion,
        steps: U1_STEP_CATALOG,
        simulationFixture: U1_SIMULATION_FIXTURE,
      });
      identity = await setupU1Identity(config, fixture);
      for (const account of Object.values(identity.accounts)) {
        secrets.push(account.password, account.totpSecret);
      }
      record('U1-SETUP', 'PASS', {
        fixturePack: fixture.fixturePack,
        realmConfigDigest: identity.realm.realmConfigDigest,
      });
    } catch (error) {
      record('U1-SETUP', 'FAIL', { detail: String(error?.message ?? error).slice(0, 300) });
      throw error;
    }

    try {
      api = await startU1Api(config);
      profileReport = api.profile;
      const ok =
        api.profile.profile === 'uat' &&
        api.profile.providerEgress === 'BLOCKED' &&
        api.profile.kafka === 'DISABLED' &&
        api.profile.lineWebhook === 'DISABLED';
      record('U1-PROFILE', ok ? 'PASS' : 'FAIL', { profile: api.profile });
      if (!ok) throw new Error('runtime profile ไม่ใช่ uat ที่ปิด side effect');
    } catch (error) {
      if (!checks.some((item) => item.id === 'U1-PROFILE'))
        record('U1-PROFILE', 'FAIL', { detail: String(error?.message ?? error).slice(0, 300) });
      throw error;
    }

    writeFileSync(
      statePath,
      JSON.stringify({
        keycloakUrl: config.keycloakUrl,
        issuer: config.issuer,
        apiUrl: config.apiUrl,
        consoleOrigin: config.consoleOrigin,
        buildSha: context.commitSha,
        fixture,
        accounts: identity.accounts,
        stepCatalog: U1_STEP_CATALOG,
        simulationFixture: U1_SIMULATION_FIXTURE,
        screenshotDir,
        outputDir: scratch,
      }),
      { mode: 0o600 },
    );

    const playwright = spawnSync(
      pnpm,
      [
        '--filter',
        '@d-contact/console',
        'exec',
        'playwright',
        'test',
        '--config',
        config.playwrightConfig,
        '--output',
        playwrightOutput,
      ],
      {
        cwd: repositoryRoot,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...environment,
          U1_GATE_STATE: statePath,
          U1_PLAYWRIGHT_REPORT: reportPath,
          U1_CONSOLE_PORT: String(config.consolePort),
          U1_API_URL: config.apiUrl,
          VITE_KC_ISSUER: config.issuer,
          VITE_KC_CLIENT_ID: UAT_CONSOLE_CLIENT_ID,
          VITE_CONSOLE_DEFAULT_VIEW: 'journeys',
          VITE_UAT_ENVIRONMENT: 'uat',
          VITE_UAT_PACK_VERSION: config.packVersion,
        },
      },
    );
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
    const tests = flattenPlaywrightReport(report);
    emit({
      type: 'readiness.suite',
      id: 'u1-console-e2e-uat',
      status: playwright.status === 0 ? 'PASS' : 'FAIL',
      tests: tests.length,
    });
    for (const { id } of U1_CHECKS.filter((entry) => PLAYWRIGHT_CHECKS.has(entry.id))) {
      const result = playwrightCheckStatus(id, tests);
      const { status, ...detail } = result;
      record(id, status, detail);
    }
    const evidencePath = join(scratch, 'evidence.json');
    const gathered = existsSync(evidencePath)
      ? JSON.parse(readFileSync(evidencePath, 'utf8'))
      : { bundles: [] };
    bundles = gathered.bundles ?? [];
    screenshots = listFiles(screenshotDir)
      .sort()
      .map((path) => ({
        path: relative(repositoryRoot, path),
        sha256: sha256(readFileSync(path)),
        sizeBytes: statSync(path).size,
      }));
  } catch (error) {
    emit({ type: 'readiness.error', message: String(error?.message ?? error).slice(0, 300) });
  } finally {
    stop(api?.child);
  }

  try {
    return finish();
  } finally {
    // state ของรอบมีรหัสผ่าน/TOTP secret — ลบเสมอแม้สรุปผลล้ม
    rmSync(scratch, { recursive: true, force: true });
  }

  function finish() {
    for (const { id } of U1_CHECKS) {
      if (id !== 'U1-EVIDENCE-HYGIENE' && !checks.some((item) => item.id === id))
        record(id, 'FAIL', { detail: 'NOT_RUN' });
    }
    const ordered = U1_CHECKS.map(({ id }) => checks.findLast((item) => item.id === id));
    const evidence = {
      runtimeProfile: profileReport,
      bundles,
      screenshots,
    };
    // hygiene: ไฟล์ที่ Playwright/gate เขียนต้องไม่มี trace/HAR/video และ manifest ต้องผ่าน scan
    const produced = [...listFiles(join(scratch, 'test-results')), ...listFiles(outputRoot)].map(
      (path) => relative(repositoryRoot, path),
    );
    const forbidden = forbiddenEvidenceFiles(produced);
    const hygieneIndex = U1_CHECKS.findIndex((item) => item.id === 'U1-EVIDENCE-HYGIENE');
    const draft = { checks: ordered.filter(Boolean), evidence };
    const findings = scanU1Evidence(draft, secrets);
    const hygiene = {
      id: 'U1-EVIDENCE-HYGIENE',
      dimension: 'evidence',
      title: U1_CHECKS[hygieneIndex].title,
      status:
        forbidden.length === 0 && findings.length === 0 && screenshots.length > 0 ? 'PASS' : 'FAIL',
      forbiddenFiles: forbidden,
      scanFindings: findings,
      screenshots: screenshots.length,
    };
    ordered[hygieneIndex] = hygiene;
    emit({ type: 'readiness.check', id: hygiene.id, status: hygiene.status });

    const summary = u1Summary(context, ordered, startedAt);
    const manifest = createU1Manifest({ context, checks: ordered, summary, evidence, startedAt });
    mkdirSync(outputRoot, { recursive: true });
    const manifestPath = resolve(outputRoot, `manifest-${context.runId}.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    emit(summary);
    emit({
      type: 'evidence.manifest',
      path: relative(repositoryRoot, manifestPath),
      sha256: sha256(readFileSync(manifestPath)),
      markers: summary.markers,
      uatAccepted: false,
    });
    return { context, checks: ordered, summary, manifest, manifestPath };
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  runU1Acceptance()
    .then((result) => {
      if (result.summary.status !== 'PASS') process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
