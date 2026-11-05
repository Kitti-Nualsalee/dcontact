/** #866: Redis/PostgreSQL แบบ disposable สำหรับทดสอบ shared limiter เท่านั้น */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const suffix = randomBytes(6).toString('hex');
const pg = `c360-866-pg-${suffix}`;
const redis = `c360-866-redis-${suffix}`;
const pgPassword = randomBytes(18).toString('hex');
const appPassword = randomBytes(18).toString('hex');
const owned = [];
const run = (exe, args, opts = {}) =>
  execFileSync(exe, args, { cwd: root, stdio: 'inherit', ...opts });
const capture = (exe, args) =>
  execFileSync(exe, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
async function ready(check) {
  for (let i = 0; i < 120; i++) {
    try {
      if (check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('isolated service readiness timeout');
}
try {
  run('docker', [
    'run',
    '-d',
    '--name',
    pg,
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_USER=dcontact',
    '-e',
    `POSTGRES_PASSWORD=${pgPassword}`,
    '-e',
    'POSTGRES_DB=dcontact_866',
    'postgres:15.4-alpine',
  ]);
  owned.push(pg);
  const pgPort = capture('docker', ['port', pg, '5432/tcp']).split(':').at(-1);
  await ready(() =>
    capture('docker', ['exec', pg, 'pg_isready', '-U', 'dcontact', '-d', 'dcontact_866']).includes(
      'accepting connections',
    ),
  );
  run('docker', ['run', '-d', '--name', redis, '-p', '127.0.0.1::6379', 'redis:7-alpine']);
  owned.push(redis);
  const redisPort = capture('docker', ['port', redis, '6379/tcp']).split(':').at(-1);
  await ready(() => capture('docker', ['exec', redis, 'redis-cli', 'ping']) === 'PONG');
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://dcontact:${pgPassword}@127.0.0.1:${pgPort}/dcontact_866`,
    APPLICATION_DATABASE_URL: `postgresql://dcontact_app:${appPassword}@127.0.0.1:${pgPort}/dcontact_866`,
    CXA_ACCEPTANCE_DATABASE_NAME: 'dcontact_866',
    C360_RATE_LIMIT_TEST_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    C360_RATE_LIMIT_TEST_REDIS_CONTAINER: redis,
  };
  run('pnpm', ['--filter', '@d-contact/api...', 'build'], { env });
  run('pnpm', ['--filter', '@d-contact/db', 'migrate:deploy'], { env });
  run('pnpm', ['--filter', '@d-contact/db', 'apply-rls'], { env });
  run('docker', [
    'exec',
    pg,
    'psql',
    '-U',
    'dcontact',
    '-d',
    'dcontact_866',
    '-c',
    `ALTER ROLE dcontact_app PASSWORD '${appPassword}'`,
  ]);
  run(
    'pnpm',
    [
      '--filter',
      '@d-contact/api',
      'exec',
      'tsx',
      '--test',
      '--test-concurrency=1',
      'src/shared-rate-limiter.integration.ts',
      'src/customer-360-read.integration.ts',
      'src/customer-360-read-sections.integration.ts',
      'src/customer-360-read-b2.integration.ts',
    ],
    { env },
  );
  console.log('C360_SHARED_RATE_LIMITER_PASS');
} catch (error) {
  console.error('C360 shared limiter integration failed', { exitCode: error?.status ?? null });
  process.exitCode = 1;
} finally {
  for (const container of owned.reverse()) {
    try {
      run('docker', ['rm', '-f', container]);
    } catch {}
  }
}
