/** #841: สร้าง PostgreSQL/Keycloak ของ runner เอง ไม่ใช้ DB/realm/VM ร่วม */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const suffix = randomBytes(6).toString('hex');
const postgres = `m3-841-pg-${suffix}`,
  keycloak = `m3-841-kc-${suffix}`;
const password = randomBytes(18).toString('hex'),
  appPassword = randomBytes(18).toString('hex'),
  adminPassword = randomBytes(18).toString('hex');
const kcImage =
  'docker.io/keycloak/keycloak:26.7.5@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85';
const owned = [];
const run = (exe, args, options = {}) =>
  execFileSync(exe, args, { cwd: root, stdio: 'inherit', ...options });
const capture = (exe, args) =>
  execFileSync(exe, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
async function ready(check) {
  for (let i = 0; i < 120; i++) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('isolated service readiness timeout');
}
try {
  run('docker', [
    'run',
    '-d',
    '--name',
    postgres,
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_USER=dcontact',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=dcontact_841',
    'postgres:15.4-alpine',
  ]);
  owned.push(postgres);
  const pgPort = capture('docker', ['port', postgres, '5432/tcp']).split(':').at(-1);
  await ready(() =>
    capture('docker', [
      'exec',
      postgres,
      'pg_isready',
      '-U',
      'dcontact',
      '-d',
      'dcontact_841',
    ]).includes('accepting connections'),
  );
  run('docker', [
    'run',
    '-d',
    '--name',
    keycloak,
    '-p',
    '127.0.0.1::8080',
    '-e',
    'KC_BOOTSTRAP_ADMIN_USERNAME=fixture-admin',
    '-e',
    `KC_BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}`,
    kcImage,
    'start-dev',
    '--http-enabled=true',
    '--hostname-strict=false',
  ]);
  owned.push(keycloak);
  const kcPort = capture('docker', ['port', keycloak, '8080/tcp']).split(':').at(-1),
    kcUrl = `http://127.0.0.1:${kcPort}`;
  await ready(
    async () => (await fetch(`${kcUrl}/realms/master/.well-known/openid-configuration`)).ok,
  );
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://dcontact:${password}@127.0.0.1:${pgPort}/dcontact_841`,
    APPLICATION_DATABASE_URL: `postgresql://dcontact_app:${appPassword}@127.0.0.1:${pgPort}/dcontact_841`,
    CXA_ACCEPTANCE_DATABASE_NAME: 'dcontact_841',
    M3_KEYCLOAK_URL: kcUrl,
    M3_KEYCLOAK_ADMIN_PASSWORD: adminPassword,
  };
  run('pnpm', ['--filter', '@d-contact/api...', 'build'], { env });
  run('pnpm', ['--filter', '@d-contact/db', 'migrate:deploy'], { env });
  run('pnpm', ['--filter', '@d-contact/db', 'apply-rls'], { env });
  run('docker', [
    'exec',
    postgres,
    'psql',
    '-U',
    'dcontact',
    '-d',
    'dcontact_841',
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
      'src/customer-360-service.integration.ts',
      'src/customer-360-service-oidc.integration.ts',
      'src/customer-360-operator.integration.ts',
      'src/customer-360-api.integration.ts',
    ],
    { env },
  );
  console.log(
    JSON.stringify({
      result: 'PASS',
      keycloakImage: kcImage,
      postgresVersion: capture('docker', [
        'exec',
        postgres,
        'psql',
        '-U',
        'dcontact',
        '-d',
        'dcontact_841',
        '-Atc',
        'SHOW server_version',
      ]),
    }),
  );
} catch (error) {
  console.error('M3 isolated boundary FAILED', { exitCode: error?.status ?? null });
  process.exitCode = 1;
} finally {
  for (const container of owned.reverse())
    try {
      run('docker', ['rm', '-f', container]);
    } catch {}
}
