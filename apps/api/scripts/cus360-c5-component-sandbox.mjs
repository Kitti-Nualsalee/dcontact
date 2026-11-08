/** Local dev trial แยก: Chrome/Edge + Keycloak จริง + Redis + PostgreSQL/RLS */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const suffix = randomBytes(6).toString('hex');
const pg = `c5-dev-pg-${suffix}`;
const redis = `c5-dev-redis-${suffix}`;
const keycloak = `c5-dev-keycloak-${suffix}`;
const dbName = 'dcontact_795_test';
const dbPassword = randomBytes(18).toString('hex');
const appPassword = randomBytes(18).toString('hex');
const identityPassword = randomBytes(18).toString('hex');
const owned = [];
let child;
let interrupted;
let interruptedChildPid;
let escalation;
let completed = false;
// คง event loop ระหว่าง fetch readiness และ top-level await แม้ socket ของ runtime ถูก unref
const keepAlive = setInterval(() => {}, 1000);
const stopGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {
    /* process อาจจบแล้ว */
  }
};
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = signal;
    if (child?.pid) {
      interruptedChildPid = child.pid;
      stopGroup(interruptedChildPid, 'SIGTERM');
      escalation = setTimeout(() => stopGroup(interruptedChildPid, 'SIGKILL'), 2000);
    }
  });
const run = (exe, args, env) =>
  new Promise((resolve, reject) => {
    if (interrupted) return reject(new Error('interrupted'));
    child = spawn(exe, args, { cwd: root, stdio: 'inherit', env, detached: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      child = undefined;
      if (code === 0 && !interrupted) resolve();
      else reject(Object.assign(new Error('sandbox command failed'), { status: code, signal }));
    });
  });
const capture = (exe, args) =>
  execFileSync(exe, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  }).trim();
const port = (name, internal) =>
  capture('docker', ['port', name, `${internal}/tcp`])
    .split(':')
    .at(-1);
async function ready(check, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    if (interrupted) throw new Error('interrupted');
    try {
      if (await check()) return;
    } catch {
      /* service ยังไม่พร้อม */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('sandbox service readiness timeout');
}

try {
  owned.push(pg);
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
  await ready(() =>
    capture('docker', ['exec', pg, 'pg_isready', '-U', 'dcontact', '-d', dbName]).includes(
      'accepting connections',
    ),
  );
  owned.push(redis);
  await run('docker', ['run', '-d', '--name', redis, '-p', '127.0.0.1::6379', 'redis:7-alpine']);
  await ready(() => capture('docker', ['exec', redis, 'redis-cli', 'ping']) === 'PONG');
  owned.push(keycloak);
  await run('docker', [
    'run',
    '-d',
    '--name',
    keycloak,
    '-p',
    '127.0.0.1::8080',
    '-e',
    'KC_BOOTSTRAP_ADMIN_USERNAME=admin',
    '-e',
    `KC_BOOTSTRAP_ADMIN_PASSWORD=${identityPassword}`,
    process.env.C360_TEST_KEYCLOAK_IMAGE ?? 'quay.io/keycloak/keycloak:26.7.5',
    'start-dev',
  ]);
  const identityUrl = `http://127.0.0.1:${port(keycloak, 8080)}`;
  await ready(
    async () =>
      (await fetch(`${identityUrl}/realms/master`, { signal: AbortSignal.timeout(1500) })).ok,
    180,
  );
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://dcontact:${dbPassword}@127.0.0.1:${port(pg, 5432)}/${dbName}`,
    APPLICATION_DATABASE_URL: `postgresql://dcontact_app:${appPassword}@127.0.0.1:${port(pg, 5432)}/${dbName}`,
    CXA_ACCEPTANCE_DATABASE_NAME: dbName,
    CORE_IDENTITY_SANDBOX_URL: identityUrl,
    CORE_IDENTITY_SANDBOX_ADMIN_PASSWORD: identityPassword,
    C360_C4_TEST_REDIS_URL: `redis://127.0.0.1:${port(redis, 6379)}`,
  };
  await run('pnpm', ['--filter', '@d-contact/api^...', '--if-present', 'build'], env);
  await run('pnpm', ['--filter', '@d-contact/workspace^...', '--if-present', 'build'], env);
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
      'src/customer-360-work-auth.integration.ts',
      'src/customer-360-work.integration.ts',
      'src/customer-360-work-socket.integration.ts',
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
      'src/customer-360-work-auth.boundary.ts',
    ],
    env,
  );
  await run('pnpm', ['--filter', '@d-contact/workspace', 'test'], env);
  console.log('C360_C5_SIP_AUDIO_TRIAL_NOT_RUN');
  completed = true;
} catch (error) {
  console.error('C360 C5 local dev trial failed', {
    exitCode: error?.status ?? null,
    interrupted: interrupted ?? null,
  });
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
} finally {
  if (interruptedChildPid) stopGroup(interruptedChildPid, 'SIGKILL');
  if (escalation) clearTimeout(escalation);
  clearInterval(keepAlive);
  const cleanupFailures = [];
  for (const name of owned.reverse()) {
    try {
      execFileSync('docker', ['rm', '-f', name], { cwd: root, stdio: 'ignore', timeout: 5000 });
    } catch {
      /* ตรวจสถานะซ้ำด้านล่าง: container อาจถูกลบแล้ว */
    }
    try {
      execFileSync('docker', ['inspect', name], { cwd: root, stdio: 'pipe', timeout: 5000 });
      cleanupFailures.push(name);
    } catch (error) {
      if (!/No such (object|container)/i.test(String(error?.stderr ?? '')))
        cleanupFailures.push(name);
    }
  }
  if (cleanupFailures.length) {
    console.error('C360 sandbox cleanup ไม่สำเร็จ', { containers: cleanupFailures });
    if (!interrupted) process.exitCode = 1;
  } else if (completed && !interrupted) console.log('C360_C5_COMPONENT_TRIAL_PASS');
}
