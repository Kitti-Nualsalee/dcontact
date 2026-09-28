import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * U1.10 (#507): input สังเคราะห์สำหรับ workflow `uat-image-smoke` — ไม่ใช่ข้อมูลของ UAT จริง
 *
 * พิมพ์ JSON หนึ่งก้อนทาง stdout: `{ provision, accounts }`
 * - `provision` = `UatProvisionV1` (U1.8 #502) พร้อม fixture pack ที่ `startNewRun` ยอมรับ
 *   (โครงเดียวกับ `apps/api/src/uat-provision.integration.ts`: baseline จาก `j1-schedule.json`)
 * - `accounts` = input ของ `scripts/u1-uat-keycloak-users.mjs --users` ที่ `dcUserId` ตรงกับ `provision`
 *
 * ค่า tenant มาจาก env ชุดเดียวกับ `uat.env` (`UAT_TENANT_ID`/`UAT_TENANT_SLUG`/`UAT_TENANT_NAME`/
 * `UAT_ORGANIZATION_DOMAIN`) เพื่อไม่ให้ CLI ตอบ `TENANT_ENV_MISMATCH`; รหัสผ่านชั่วคราวของบัญชีมาจาก
 * `UAT_CI_MAKER_PASSWORD`/`UAT_CI_REVIEWER_PASSWORD` (workflow สุ่มและ mask ไว้แล้ว) — script ไม่พิมพ์ค่าเหล่านี้
 * ที่อื่นนอกจาก stdout ซึ่ง workflow redirect ลงไฟล์ mode 600
 *
 * `--journey-from <dir>`: โฟลเดอร์ที่ resolve `@d-contact/journey` ได้ (ค่าเริ่มต้น `apps/api` ของ repo;
 * ใน ops image ใช้ `/app`) — ใช้ `importJourneyDefinition` ตัวเดียวกับที่ image ใช้จริง
 *
 * TODO(#506): เมื่อ U1.9 มี template input ของ UAT ที่ commit ไว้ ให้ workflow ใช้ template นั้นแทน script นี้
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURE = 'apps/journey/test/fixtures/j5/j1-schedule.json';
/** PHONE ของ negative scan U1.5 (`0[1-9]` ตามด้วยตัวเลข 7–8 ตัว) — buildSha ต้องไม่ขึ้นต้นแบบนั้น */
const PHONE_LIKE_PREFIX = /^0[1-9][0-9]{7,8}(?![0-9])/;

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function loadJourney(from) {
  const require = createRequire(join(resolve(from), 'package.json'));
  return import(pathToFileURL(require.resolve('@d-contact/journey')).href);
}

export function buildSha(sourceSha) {
  const sha = String(sourceSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('SOURCE_SHA ต้องเป็น commit SHA เต็ม 40 ตัว');
  return PHONE_LIKE_PREFIX.test(sha) ? sha.slice(1) : sha;
}

export function buildCiFixture({ environment, baselineDocument, ids = {} }) {
  const tenantId = required(environment, 'UAT_TENANT_ID');
  const tenantSlug = required(environment, 'UAT_TENANT_SLUG');
  const tenantName = required(environment, 'UAT_TENANT_NAME');
  const domain = required(environment, 'UAT_ORGANIZATION_DOMAIN');
  const packVersion = required(environment, 'UAT_FIXTURE_PACK_VERSION');
  const teamId = ids.teamId ?? randomUUID();
  const makerId = ids.makerId ?? randomUUID();
  const reviewerId = ids.reviewerId ?? randomUUID();
  const short = tenantId.slice(0, 8);
  const makerEmail = `maker-${short}@${domain}`;
  const reviewerEmail = `reviewer-${short}@${domain}`;

  const fixturePack = {
    schema: 'UatFixturePackV1',
    environment: 'uat',
    packVersion,
    buildSha: buildSha(required(environment, 'SOURCE_SHA')),
    tenantId,
    ownerTeamId: teamId,
    makerSubjectId: makerId,
    reviewerSubjectId: reviewerId,
    senderRef: 'sender-synthetic-ci',
    contentRef: 'content-synthetic-ci',
    baselineDocument,
    simulationFixture: {
      fixtureId: 'uat-ci-fx-1',
      startAt: '2026-09-01T00:00:00.000Z',
      seed: 'uat-ci-seed-1',
      context: {},
    },
    steps: [
      {
        stepId: 'LOGIN',
        title: 'Login',
        expected: 'เห็น Journey list',
        stateLabel: 'REAL_STATE',
      },
    ],
  };

  const provision = {
    schema: 'UatProvisionV1',
    tenant: { id: tenantId, slug: tenantSlug, name: tenantName },
    ownerTeam: { id: teamId, name: `CI Journey Owners ${short}` },
    maker: { dcUserId: makerId, email: makerEmail, displayName: `CI Maker ${short}` },
    reviewer: { dcUserId: reviewerId, email: reviewerEmail, displayName: `CI Reviewer ${short}` },
    rollout: {
      stage: 'INTERNAL_SYNTHETIC',
      canvasWriteEnabled: true,
      publishUiEnabled: true,
      templateCatalogEnabled: false,
      templateUpgradeEnabled: false,
      evidenceRef: 'u1-10-uat-image-smoke',
    },
    fixturePack,
  };

  const account = (role, dcUserId, email, password) => ({
    role,
    username: email,
    email,
    firstName: 'CI',
    lastName: role === 'maker' ? 'Maker' : 'Reviewer',
    dcUserId,
    temporaryPassword: password,
  });
  const accounts = {
    accounts: [
      account('maker', makerId, makerEmail, required(environment, 'UAT_CI_MAKER_PASSWORD')),
      account(
        'reviewer',
        reviewerId,
        reviewerEmail,
        required(environment, 'UAT_CI_REVIEWER_PASSWORD'),
      ),
    ],
  };
  return { provision, accounts };
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const journey = await loadJourney(
    option(argv, '--journey-from') ?? join(repositoryRoot, 'apps/api'),
  );
  const fixturePath = resolve(repositoryRoot, option(argv, '--fixture') ?? DEFAULT_FIXTURE);
  const source = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const ids = { teamId: randomUUID(), makerId: randomUUID(), reviewerId: randomUUID() };
  const baselineDocument = journey.importJourneyDefinition({ ...source, ownerTeamId: ids.teamId });
  return buildCiFixture({ environment, baselineDocument, ids });
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  main()
    .then((bundle) => process.stdout.write(`${JSON.stringify(bundle)}\n`))
    .catch((error) => {
      // ไม่พิมพ์ environment — ข้อความมาจาก script นี้/parser เท่านั้น
      process.stderr.write(
        `${JSON.stringify({ type: 'u1.uat.ci-fixture', status: 'FAIL', error: String(error?.message ?? error) })}\n`,
      );
      process.exitCode = 1;
    });
}
