/** CSV import (#909): ตรวจ HTTP→PostgreSQL/RLS ด้วย PostgreSQL ชั่วคราวตัวเดียว ไม่แตะฐาน dcontact ร่วม */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const suffix = randomBytes(6).toString('hex');
const pg = `i909-pg-${suffix}`;
const dbName = 'dcontact_909_test';
const dbPassword = randomBytes(18).toString('hex');
const appPassword = randomBytes(18).toString('hex');
const run = (exe, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: root, stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${exe} exit ${code}`)),
    );
  });
const capture = (exe, args) =>
  execFileSync(exe, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  }).trim();
let completed = false;
try {
  await run('docker', [
    'run',
    '-d',
    '--name',
    pg,
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_USER=dcontact',
    '-e',
    `POSTGRES_PASSWORD=${dbPassword}`,
    '-e',
    `POSTGRES_DB=${dbName}`,
    'postgres:15.4-alpine',
  ]);
  for (let i = 0; ; i++) {
    try {
      if (
        capture('docker', ['exec', pg, 'pg_isready', '-U', 'dcontact', '-d', dbName]).includes(
          'accepting connections',
        )
      )
        break;
    } catch {
      /* ยังไม่พร้อม */
    }
    if (i > 60) throw new Error('postgres readiness timeout');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const port = capture('docker', ['port', pg, '5432/tcp']).split(':').at(-1);
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://dcontact:${dbPassword}@127.0.0.1:${port}/${dbName}`,
    APPLICATION_DATABASE_URL: `postgresql://dcontact_app:${appPassword}@127.0.0.1:${port}/${dbName}`,
    CXA_ACCEPTANCE_DATABASE_NAME: dbName,
  };
  await run('pnpm', ['--filter', '@d-contact/api^...', '--if-present', 'build'], env);
  await run('pnpm', ['--filter', '@d-contact/db', 'migrate:deploy'], env);
  await run('pnpm', ['--filter', '@d-contact/db', 'apply-rls'], env);
  await run(
    'docker',
    [
      'exec',
      pg,
      'psql',
      '-U',
      'dcontact',
      '-d',
      dbName,
      '-c',
      `ALTER ROLE dcontact_app PASSWORD '${appPassword}'`,
    ],
    env,
  );
  await run(
    'pnpm',
    [
      '--filter',
      '@d-contact/api',
      'exec',
      'tsx',
      '--test',
      '--test-concurrency=1',
      'src/customer-360-import.integration.ts',
    ],
    env,
  );
  await run(
    'pnpm',
    [
      '--filter',
      '@d-contact/customer-360',
      'exec',
      'tsx',
      '--test',
      '--test-concurrency=1',
      'src/import-duplicate-authority.integration.ts',
    ],
    env,
  );
  completed = true;
} catch (error) {
  console.error('CSV import DB trial failed', { message: String(error?.message ?? error) });
  process.exitCode = 1;
} finally {
  try {
    execFileSync('docker', ['rm', '-f', pg], { stdio: 'ignore', timeout: 10000 });
  } catch {
    /* ตรวจด้านล่าง */
  }
  try {
    execFileSync('docker', ['inspect', pg], { stdio: 'pipe', timeout: 5000 });
    console.error('sandbox cleanup ไม่สำเร็จ', pg);
    process.exitCode = 1;
  } catch {
    /* ไม่พบ container = ลบแล้ว */
  }
  if (completed && !process.exitCode) console.log('CSV_IMPORT_DB_TRIAL_PASS');
}
