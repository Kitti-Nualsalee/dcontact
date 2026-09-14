import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg4LegacyBackfill, CG4_BACKFILL_KILL_REASONS } from './cg4-legacy-backfill.js';

/**
 * CG4.10 (#193) PR-A: `CG4-MG01` drill — fresh migration และ upgrade จาก CG3 baseline
 * `b634dc7` บน database แยกที่สร้างและลบในรอบ test
 *
 * upgrade drill ใส่ข้อมูล CG3 จริงก่อน migrate จึงพิสูจน์ได้ว่า migration ของ CG4 ทั้งหมดรันบน
 * database ที่มีข้อมูลเดิม ไม่ใช่เฉพาะ database ว่าง แล้วจึง backfill ผ่าน application role
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CG3_BASELINE = 'b634dc738e4e1544e06711d165e58cfe453c68e2';
const CURRENT_SCHEMA = join(REPO, 'packages/db/prisma/schema.prisma');
const CURRENT_RLS = join(REPO, 'packages/db/prisma/rls.sql');
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://dcontact:dcontact@localhost:5433/dcontact?schema=public';
const APPLICATION_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function prisma(args: string[], databaseUrl: string): string {
  const result = spawnSync('pnpm', ['exec', 'prisma', ...args], {
    cwd: join(REPO, 'packages/db'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `prisma ${args.join(' ')} ล้มเหลว:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

async function scratchDatabase(t: TestContext, label: string) {
  const name = `dcontact_cg410_${label}_${process.pid}_${Date.now()}`;
  const admin = new PrismaClient();
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const clients: PrismaClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
    await admin.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
    );
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.$disconnect();
  });
  const client = (url: string) => {
    const created = new PrismaClient({ datasources: { db: { url: withDatabase(url, name) } } });
    clients.push(created);
    return created;
  };
  return { name, ownerUrl: withDatabase(OWNER_URL, name), client };
}

async function appliedMigrations(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*) AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  return Number(rows[0]!.count);
}

const currentMigrationCount = () =>
  readdirSync(join(REPO, 'packages/db/prisma/migrations'), { withFileTypes: true }).filter(
    (entry) => entry.isDirectory(),
  ).length;

test(
  'CG4-MG01: fresh database รับ migration ปัจจุบันทั้งหมดและ RLS ได้',
  { timeout: 300_000 },
  async (t) => {
    const database = await scratchDatabase(t, 'fresh');
    prisma(['migrate', 'deploy', '--schema', CURRENT_SCHEMA], database.ownerUrl);
    prisma(['db', 'execute', '--file', CURRENT_RLS, '--schema', CURRENT_SCHEMA], database.ownerUrl);
    assert.equal(await appliedMigrations(database.client(OWNER_URL)), currentMigrationCount());
  },
);

test(
  'CG4-MG01: upgrade จาก CG3 baseline b634dc7 ที่มีข้อมูลจริง แล้ว backfill โดยไม่แตะประวัติ CG3',
  { timeout: 300_000 },
  async (t) => {
    const baseline = mkdtempSync(join(tmpdir(), 'cg410-baseline-'));
    t.after(() => rmSync(baseline, { recursive: true, force: true }));
    const archive = spawnSync('git', ['archive', CG3_BASELINE, 'packages/db/prisma'], {
      cwd: REPO,
      maxBuffer: 256 * 1024 * 1024,
    });
    assert.equal(
      archive.status,
      0,
      `ต้องมี commit ${CG3_BASELINE} ใน checkout (fetch-depth 0) เพื่อพิสูจน์ upgrade: ${archive.stderr}`,
    );
    const extract = spawnSync('tar', ['-x', '-C', baseline], { input: archive.stdout });
    assert.equal(extract.status, 0, String(extract.stderr));
    const baselineSchema = join(baseline, 'packages/db/prisma/schema.prisma');
    const baselineRls = join(baseline, 'packages/db/prisma/rls.sql');

    const database = await scratchDatabase(t, 'upgrade');
    prisma(['migrate', 'deploy', '--schema', baselineSchema], database.ownerUrl);
    prisma(['db', 'execute', '--file', baselineRls, '--schema', baselineSchema], database.ownerUrl);

    // ข้อมูล CG3 สังเคราะห์ใส่ด้วย SQL ตาม schema ของ baseline (client ปัจจุบันรู้จัก column ที่ยังไม่มี)
    const owner = database.client(OWNER_URL);
    const tenant = randomUUID();
    const clean = randomUUID();
    const ambiguousA = randomUUID();
    const ambiguousB = randomUUID();
    const draft = randomUUID();
    const policy = (
      id: string,
      channel: string,
      purpose: string,
      status: string,
      publishedAt: string | null,
    ) => `
    INSERT INTO cg_policies (id, tenant_id, policy_id, version, purpose, channel, timezone_fallback,
      quiet_hours, callback_mode, overridable_rules, status, content_digest, maker_actor_ref,
      checker_actor_ref, approval_ref, effective_from, published_at)
    VALUES ('${id}', '${tenant}', '${randomUUID()}', 1, '${purpose}', '${channel}'::"ChannelType",
      'Asia/Bangkok', '[{"daysOfWeek":[1,2,3,4,5,6,7],"startLocal":"21:00","endLocal":"08:00"}]'::jsonb,
      'SCOPED_OVERRIDE'::"CgCallbackMode", '[]'::jsonb, '${status}'::"CgPolicyStatus", '${'a'.repeat(64)}',
      'legacy-maker', ${publishedAt ? "'legacy-checker'" : 'NULL'}, ${publishedAt ? "'legacy-approval'" : 'NULL'},
      '2026-01-01T00:00:00Z', ${publishedAt ? `'${publishedAt}'` : 'NULL'})`;
    await owner.$executeRawUnsafe(
      `INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenant}', 'CG4.10 upgrade drill', 'cg410-drill-${tenant}', '${tenant}.drill.test')`,
    );
    await owner.$executeRawUnsafe(
      policy(clean, 'LINE', 'MARKETING', 'PUBLISHED', '2026-01-01T00:00:00Z'),
    );
    await owner.$executeRawUnsafe(
      policy(ambiguousA, 'EMAIL', 'MARKETING', 'PUBLISHED', '2026-02-01T00:00:00Z'),
    );
    await owner.$executeRawUnsafe(
      policy(ambiguousB, 'EMAIL', 'MARKETING', 'PUBLISHED', '2026-03-01T00:00:00Z'),
    );
    await owner.$executeRawUnsafe(policy(draft, 'VOICE', 'SERVICE', 'DRAFT', null));
    const baselineMigrations = await appliedMigrations(owner);

    // upgrade: migration ปัจจุบันทั้งหมดต้องรันทับข้อมูลเดิมได้โดยไม่ต้อง reset
    prisma(['migrate', 'deploy', '--schema', CURRENT_SCHEMA], database.ownerUrl);
    prisma(['db', 'execute', '--file', CURRENT_RLS, '--schema', CURRENT_SCHEMA], database.ownerUrl);
    assert.equal(await appliedMigrations(owner), currentMigrationCount());
    assert.ok(currentMigrationCount() > baselineMigrations);

    const cg3Before = await owner.$queryRawUnsafe<Array<{ id: string; status: string }>>(
      `SELECT id, status::text AS status FROM cg_policies WHERE tenant_id = '${tenant}' ORDER BY id`,
    );
    assert.equal(cg3Before.length, 4);

    const application = database.client(APPLICATION_URL);
    const backfill = () =>
      new Cg4LegacyBackfill(application, { now: () => new Date('2026-09-14T00:00:00.000Z') }).run({
        tenantId: tenant,
        operatorRef: 'operator-drill',
      });
    const report = await backfill();
    assert.deepEqual(
      report.legacyActive.map((entry) => entry.scopeKey),
      ['channel=LINE|contactKind=*|purpose=MARKETING|sourceType=*'],
    );
    assert.deepEqual(
      report.killedScopes.map((entry) => [entry.scopeKey, entry.reason]),
      [
        [
          'channel=EMAIL|contactKind=*|purpose=MARKETING|sourceType=*',
          CG4_BACKFILL_KILL_REASONS.AMBIGUOUS_SCOPE,
        ],
      ],
    );
    assert.equal(report.drafts.length, 1);

    const rerun = await backfill();
    assert.equal(rerun.legacyActive.length, 0);
    assert.equal(rerun.drafts.length, 0);
    assert.equal(rerun.alreadyRecorded, 2);

    // ไม่มี history drop หรือ direct edit ของ CG3
    const cg3After = await owner.$queryRawUnsafe<Array<{ id: string; status: string }>>(
      `SELECT id, status::text AS status FROM cg_policies WHERE tenant_id = '${tenant}' ORDER BY id`,
    );
    assert.deepEqual(cg3After, cg3Before);
  },
);
