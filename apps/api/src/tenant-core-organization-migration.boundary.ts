/** ซ้อมจาก image ops/schema รุ่นก่อน → legacy data + backup/restore → additive schema/RLS ปัจจุบัน */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@d-contact/db';
const image = process.env.CORE_COMPAT_OLD_OPS_IMAGE;
function docker(args: string[], options: { input?: Buffer; env?: NodeJS.ProcessEnv } = {}) {
  return execFileSync('docker', args, {
    ...options,
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
test(
  'องค์กร migration: old ops สร้าง legacy จริงก่อน migration พร้อม backup/restore และ data conservation',
  {
    skip: !image ? 'NOT_RUN: ต้องระบุ CORE_COMPAT_OLD_OPS_IMAGE/owned PostgreSQL container' : false,
    timeout: 120_000,
  },
  async (t) => {
    assert.ok(image);
    const pg = process.env.CORE_COMPAT_POSTGRES_CONTAINER;
    assert.ok(pg);
    const ownerUrl = new URL(process.env.DATABASE_URL!);
    assert.ok(['127.0.0.1', 'localhost'].includes(ownerUrl.hostname));
    const source = docker([
      'image',
      'inspect',
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      image,
    ])
      .toString()
      .trim();
    assert.match(source, /^[a-f0-9]{40}$/);
    if (process.env.CORE_COMPAT_EXPECTED_OLD_SHA)
      assert.equal(source, process.env.CORE_COMPAT_EXPECTED_OLD_SHA);
    const id = docker(['image', 'inspect', '--format', '{{.Id}}', image]).toString().trim();
    const suffix = randomUUID().replaceAll('-', ''),
      dbName = `core726_rehearsal_${suffix}`,
      restoredName = `core726_restore_${suffix}`,
      network = `core726-migration-${suffix}`;
    const user = decodeURIComponent(ownerUrl.username);
    docker(['exec', pg, 'createdb', '-U', user, dbName]);
    docker(['exec', pg, 'createdb', '-U', user, restoredName]);
    docker(['network', 'create', network]);
    docker(['network', 'connect', '--alias', 'core-db', network, pg]);
    const url = new URL(ownerUrl);
    url.pathname = '/' + dbName;
    const restoredUrl = new URL(ownerUrl);
    restoredUrl.pathname = '/' + restoredName;
    const db = new PrismaClient({ datasources: { db: { url: url.toString() } } }),
      restored = new PrismaClient({ datasources: { db: { url: restoredUrl.toString() } } });
    t.after(async () => {
      await db.$disconnect();
      await restored.$disconnect();
      docker(['network', 'disconnect', network, pg]);
      docker(['network', 'rm', network]);
      docker(['exec', pg, 'dropdb', '-U', user, dbName]);
      docker(['exec', pg, 'dropdb', '-U', user, restoredName]);
    });
    const internal = new URL(url);
    internal.hostname = 'core-db';
    internal.port = '5432';
    docker(
      [
        'run',
        '--rm',
        '--network',
        network,
        '--env',
        'DATABASE_URL',
        id,
        'prisma',
        'migrate',
        'deploy',
        '--schema',
        'prisma/schema.prisma',
      ],
      { env: { ...process.env, DATABASE_URL: internal.toString() } },
    );
    const legacy = randomUUID(),
      missing = randomUUID(),
      requestId = randomUUID();
    for (const tenantId of [legacy, missing])
      await db.tenant.create({
        data: {
          id: tenantId,
          name: 'Legacy before migration',
          slug: `legacy-${tenantId}`,
          sipDomain: `${tenantId}.core.test`,
        },
      });
    await db.$executeRaw`INSERT INTO tenant_settings(tenant_id,locale,timezone,bootstrap_template_version,bootstrap_template_digest,provisioning_request_id,updated_at) VALUES(${legacy}::uuid,'legacy-locale','legacy-zone','fixture-v1',${'b'.repeat(64)},${requestId}::uuid,now())`;
    const before =
      await db.$queryRaw`SELECT tenant_id,locale,timezone,bootstrap_template_version,bootstrap_template_digest,provisioning_request_id FROM tenant_settings WHERE tenant_id=${legacy}::uuid`;
    const backup = docker(['exec', pg, 'pg_dump', '-U', user, '-Fc', dbName]);
    docker(
      [
        'exec',
        '-i',
        pg,
        'pg_restore',
        '-U',
        user,
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '-d',
        restoredName,
      ],
      { input: backup },
    );
    assert.deepEqual(
      await restored.$queryRaw`SELECT tenant_id,locale,timezone,bootstrap_template_version,bootstrap_template_digest,provisioning_request_id FROM tenant_settings WHERE tenant_id=${legacy}::uuid`,
      before,
    );
    execFileSync('pnpm', ['--filter', '@d-contact/db', 'migrate:deploy'], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let pass = 0; pass < 2; pass++)
      execFileSync('pnpm', ['db:rls'], {
        cwd: resolve('../..'),
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    assert.deepEqual(
      await db.$queryRaw`SELECT tenant_id,locale,timezone,bootstrap_template_version,bootstrap_template_digest,provisioning_request_id FROM tenant_settings WHERE tenant_id=${legacy}::uuid`,
      before,
    );
    const actual = await db.tenantSettings.findUniqueOrThrow({ where: { tenantId: legacy } });
    assert.equal(actual.initializationSource, 'PROVISIONING');
    assert.equal(actual.initializedByCommandId, null);
    assert.equal(actual.initializedByUserId, null);
    assert.equal(await db.tenantSettings.findUnique({ where: { tenantId: missing } }), null);
    assert.equal(await db.tenantCoreProfileRevision.count(), 0);
    const directory = resolve('../../artifacts/core-settings');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, 'migration-config.json'),
      JSON.stringify(
        {
          oldSourceSha: source,
          oldOpsImageId: id,
          backupSha256: createHash('sha256').update(backup).digest('hex'),
          backupBytes: backup.length,
          restoreVerified: true,
          legacyConserved: true,
          missingDefaultsRemainNull: true,
          rlsReruns: 2,
          vmUat: 'NOT_RUN',
        },
        null,
        2,
      ),
    );
  },
);
