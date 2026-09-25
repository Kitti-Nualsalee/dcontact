import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PLATFORM_DEV_DEFAULTS, platformDevEnv, platformDevProcesses } from './platform-dev.mjs';
import { PLATFORM_CONSOLE_REDIRECT } from './keycloak-platform-setup.mjs';

const SUBJECT = '8d7a1c2e-4b5f-4c6d-9e0f-112233445566';

test('ค่า default ต่อ infra dev: Console ↔ API :3019 ↔ Keycloak realm dcontact', () => {
  const envs = platformDevEnv({ operatorSubject: SUBJECT });
  assert.equal(envs.api.PLATFORM_OIDC_ISSUER, 'http://localhost:8081/realms/dcontact');
  assert.equal(envs.console.VITE_KC_ISSUER, envs.api.PLATFORM_OIDC_ISSUER);
  assert.equal(envs.console.VITE_PLATFORM_API_URL, 'http://localhost:3019');
  assert.equal(envs.api.PLATFORM_API_PORT, '3019');
  assert.equal(envs.console.VITE_KC_CLIENT_ID, 'platform-console');
});

test('API และ worker เปิด provisioning ตรงกัน และ allowlist เป็น subject ของ operator', () => {
  const envs = platformDevEnv({ operatorSubject: SUBJECT });
  for (const env of [envs.api, envs.worker]) {
    assert.equal(env.PLATFORM_PROVISIONING_ENABLED, 'true');
    assert.equal(env.PLATFORM_OPERATOR_ALLOWLIST, SUBJECT);
    assert.equal(env.PLATFORM_DATABASE_URL, PLATFORM_DEV_DEFAULTS.platformDatabaseUrl);
  }
  assert.equal(envs.worker.PROVISIONER_DATABASE_URL, PLATFORM_DEV_DEFAULTS.provisionerDatabaseUrl);
});

test('ค่าจาก shell ชนะ default', () => {
  const envs = platformDevEnv({
    operatorSubject: SUBJECT,
    env: {
      PLATFORM_API_PORT: '4000',
      PLATFORM_PROVISIONING_ENABLED: 'false',
      PLATFORM_DATABASE_URL: 'postgresql://other',
    },
  });
  assert.equal(envs.console.VITE_PLATFORM_API_URL, 'http://localhost:4000');
  assert.equal(envs.worker.PLATFORM_PROVISIONING_ENABLED, 'false');
  assert.equal(envs.api.PLATFORM_DATABASE_URL, 'postgresql://other');
});

test('Console รันที่ origin เดียวกับ redirect URI ของ Keycloak และ CORS ของ API', () => {
  const envs = platformDevEnv({ operatorSubject: SUBJECT });
  const consoleProcess = platformDevProcesses(envs).find(({ name }) => name === 'console');
  assert.ok(consoleProcess.command.includes('--strictPort'));
  const port = consoleProcess.command[consoleProcess.command.indexOf('--port') + 1];
  assert.equal(`http://localhost:${port}`, PLATFORM_CONSOLE_REDIRECT);
  assert.equal(envs.api.PLATFORM_CONSOLE_ORIGIN, PLATFORM_CONSOLE_REDIRECT);
});

test('คำสั่ง pnpm ชี้ script ที่มีอยู่จริงของแต่ละ package', () => {
  const scriptsOf = (path) =>
    JSON.parse(readFileSync(new URL(`../${path}/package.json`, import.meta.url), 'utf8')).scripts;
  const byName = Object.fromEntries(
    platformDevProcesses(platformDevEnv({ operatorSubject: SUBJECT })).map((entry) => [
      entry.name,
      entry.command,
    ]),
  );
  assert.ok(scriptsOf('apps/platform-api')[byName.api.at(-1)]);
  assert.ok(scriptsOf('apps/platform-control')[byName.worker.at(-1)]);
});
