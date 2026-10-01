import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * U1.6 (#434): readiness ของ UAT deployment (VM + Docker Compose) — ไม่มี dependency นอกจาก Node
 *
 * - `--static`: ตรวจ artifact ใน repo (compose, Dockerfile, Caddyfile, realm, workflow) + negative
 *   secret scan — รันใน CI ได้โดยไม่ต้องมี network
 * - `--live`: smoke กับ UAT ที่ deploy แล้ว (`UAT_BASE_URL`, `UAT_CONNECT_HOST`, `UAT_SMOKE_ACCESS_TOKEN`)
 * - `--migration-guard --base <sha> | --initial`: migration ใหม่ต้อง additive (ไม่มี DROP, ไม่แก้ไฟล์เดิม)
 * - `--deployment-record` / `--summary`: สร้าง/แสดง deployment record ของ workflow `uat-preview`
 *
 * ผลเป็น JSON บรรทัดเดียว; มี check ใด FAIL = exit code ไม่เป็นศูนย์ ไม่พิมพ์ token/secret ใด ๆ
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const UAT_FILES = Object.freeze({
  compose: 'infra/uat/docker-compose.uat.yml',
  caddyfile: 'infra/uat/Caddyfile',
  compose3vm: 'infra/uat/docker-compose.uat.3vm.yml',
  caddyfile3vm: 'infra/uat/Caddyfile.3vm',
  dbRelayConfig: 'infra/uat/haproxy-db-relay.cfg',
  // #565 (ADR-031): overlay `uat-line` ที่เปิดด้วย flag บน VM2
  composeLine: 'infra/uat/docker-compose.uat.line.yml',
  caddyfileLine: 'infra/uat/Caddyfile.3vm.line',
  lineEgressConfig: 'infra/uat/haproxy-line-egress.cfg',
  lineSecretsScript: 'infra/uat/operator/vm2-line-secrets.sh',
  envExample: 'infra/uat/uat.env.example',
  deployScript: 'infra/uat/bin/uat-deploy.sh',
  dbRolesScript: 'infra/uat/bin/db-roles.sh',
  dbRoles3vmScript: 'infra/uat/bin/db-roles-3vm.sh',
  objectStorageEntrypoint: 'infra/uat/bin/object-storage-entrypoint.sh',
  sshSetupScript: 'infra/uat/bin/ci-ssh-setup.sh',
  apiDockerfile: 'apps/api/Dockerfile',
  consoleDockerfile: 'apps/console/Dockerfile',
  keycloakDockerfile: 'infra/keycloak/Dockerfile',
  dockerignore: '.dockerignore',
  realm: 'infra/keycloak/realm-dcontact.uat.json',
  workflow: '.github/workflows/uat-preview.yml',
  smokeWorkflow: '.github/workflows/uat-image-smoke.yml',
  runbook: 'docs/u1-uat-deployment.md',
  keycloakScript: 'scripts/u1-uat-keycloak-users.mjs',
  readinessScript: 'scripts/u1-uat-readiness.mjs',
  // U1.9 (#506): fixture pack ของ UAT first slice (template + renderer) และ input ตัวอย่างของ provision
  fixtureTemplate: 'infra/uat/fixtures/uat-first-slice.v1.template.json',
  fixtureRenderer: 'scripts/u1-uat-fixture-render.mjs',
  provisionExample: 'infra/uat/uat-provision.example.json',
});

/** service ที่ UAT first slice ต้องไม่มี (#374): Journey worker/runtime, voice, event backbone, Redis */
export const FORBIDDEN_SERVICE_PATTERNS = Object.freeze([
  ['JOURNEY_WORKER', /journey(?!-?authoring)|apps\/journey|dcontact-journey/i],
  ['FREESWITCH', /freeswitch/i],
  ['KAFKA', /kafka|redpanda|zookeeper/i],
  ['REDIS', /redis|valkey/i],
]);
export const ALLOWED_PUBLIC_SERVICE = 'proxy';
/** #515/#522: theme ที่ realm UAT ตั้งไว้ต้องอยู่ใน image ของ Keycloak (infra/keycloak/Dockerfile) */
export const UAT_LOGIN_THEME = 'dcontact';
export const ALLOWED_PUBLIC_PORTS = Object.freeze(['443', '80']);
/** env ของ api ที่ขัดกับ profile `uat` (ตรงกับ UAT_FORBIDDEN_ENV ใน apps/api/src/runtime-profile.ts) */
export const API_FORBIDDEN_ENV = Object.freeze([/^LINE_/, /^KAFKA_BROKERS$/, /^SIP_/]);
const SECRETISH_KEY =
  /(PASSWORD|SECRET|TOKEN|CREDENTIAL|PRIVATE|ACCESS_KEY|ADMIN_USERNAME|ROOT_USER|MC_HOST)/i;
/** ค่า credential ของ dev/seed ที่ห้ามโผล่ใน artifact ของ UAT */
const DEV_CREDENTIAL_LITERALS = [
  'dcontact-secret',
  'admin1234',
  'agent1234',
  'ClueCon',
  'dcontact_app:dcontact_app',
  'dcontact:dcontact@',
  'dcontact-events-demo-secret',
];
/** port ที่ต้องปิดบน host ของ UAT (มีแค่ 80/443 ของ proxy ที่เปิด) */
export const FORBIDDEN_PORTS = Object.freeze([
  3000, 5060, 5432, 5433, 6379, 8021, 8022, 8080, 8081, 8443, 9000, 9001, 9092, 29092,
]);

// ── helpers ─────────────────────────────────────────────────────────────────

function check(id, failures, detail = {}) {
  return failures.length === 0
    ? { id, status: 'PASS', ...detail }
    : { id, status: 'FAIL', failures, ...detail };
}

function read(path, root = repositoryRoot) {
  const absolute = resolve(root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripYamlComment(line) {
  // comment ของ YAML = ` #` นอก quote — compose ของเราไม่มี `#` ในค่า
  const index = line.search(/(^|\s)#/);
  return index === -1 ? line : line.slice(0, index);
}

/**
 * อ่านโครงของ compose แบบเบา (indentation ของ Compose ทั่วไป 2 ช่อง): services → image/ports/
 * environment/command/profiles — พอสำหรับตรวจ policy โดยไม่ต้องพึ่ง YAML parser ภายนอก
 */
export function parseComposeServices(text) {
  const services = {};
  let inServices = false;
  let current = null;
  let key = null;
  for (const raw of text.split('\n')) {
    const line = stripYamlComment(raw).replace(/\s+$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = /^services:\s*$/.test(line);
      current = null;
      continue;
    }
    if (!inServices) continue;
    if (indent === 2) {
      const match = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
      current = match
        ? (services[match[1]] = {
            name: match[1],
            image: null,
            ports: [],
            environment: {},
            command: [],
            profiles: [],
            raw: [],
          })
        : null;
      key = null;
      continue;
    }
    if (!current) continue;
    current.raw.push(line);
    if (indent === 4) {
      const match = /^ {4}([A-Za-z0-9_<-]+):\s*(.*)$/.exec(line);
      if (!match) continue;
      key = match[1];
      const value = match[2];
      if (key === 'image') current.image = unquote(value);
      if (key === 'command' && value) current.command.push(unquote(value));
      if (key === 'profiles' && value) {
        current.profiles.push(
          ...value
            .replace(/[[\]']/g, '')
            .split(',')
            .map((v) => v.trim()),
        );
      }
      if (key === 'ports' && value && value !== '[]') current.ports.push(value);
      continue;
    }
    if (indent >= 6 && key) {
      const item = line.trim();
      if (key === 'ports' && item.startsWith('-')) current.ports.push(unquote(item.slice(1)));
      if (key === 'command' && item.startsWith('-')) current.command.push(unquote(item.slice(1)));
      if (key === 'environment' && indent === 6) {
        const mapped = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(item);
        const listed = /^-\s*([A-Za-z0-9_]+)(?:=(.*))?$/.exec(item);
        if (mapped) current.environment[mapped[1]] = unquote(mapped[2]);
        else if (listed) current.environment[listed[1]] = unquote(listed[2] ?? '');
      }
    }
  }
  return services;
}

// ── static checks ───────────────────────────────────────────────────────────

export function checkComposeServices(compose) {
  const services = parseComposeServices(compose);
  const failures = [];
  for (const service of Object.values(services)) {
    const haystack = `${service.name} ${service.image ?? ''} ${service.command.join(' ')}`;
    for (const [kind, pattern] of FORBIDDEN_SERVICE_PATTERNS) {
      if (pattern.test(haystack)) failures.push({ service: service.name, kind });
    }
  }
  for (const required of ['proxy', 'api', 'keycloak', 'postgres', 'object-storage']) {
    if (!services[required]) failures.push({ service: required, kind: 'MISSING' });
  }
  const code = compose.split('\n').map(stripYamlComment).join('\n');
  if (/KAFKA_BROKERS|redpanda|freeswitch|REDIS_URL/i.test(code)) {
    failures.push({ kind: 'FORBIDDEN_REFERENCE' });
  }
  return check('UAT-S01 compose ไม่มี worker/FreeSWITCH/Kafka/Redis', failures, {
    services: Object.keys(services).sort(),
  });
}

export function checkComposePorts(compose) {
  const services = parseComposeServices(compose);
  const failures = [];
  for (const service of Object.values(services)) {
    if (service.ports.length === 0) continue;
    if (service.name !== ALLOWED_PUBLIC_SERVICE) {
      failures.push({ service: service.name, kind: 'PUBLISHES_PORT' });
      continue;
    }
    for (const port of service.ports) {
      const parts = port.split(':');
      const published = parts.length >= 2 ? parts[parts.length - 2] : null;
      if (!published || !ALLOWED_PUBLIC_PORTS.includes(published)) {
        failures.push({ service: service.name, kind: 'UNEXPECTED_PORT', port });
      }
    }
  }
  if (!services[ALLOWED_PUBLIC_SERVICE]?.ports.some((port) => /(^|:)443:/.test(port))) {
    failures.push({ service: ALLOWED_PUBLIC_SERVICE, kind: 'HTTPS_NOT_PUBLISHED' });
  }
  if (/network_mode:\s*['"]?host/.test(compose)) failures.push({ kind: 'HOST_NETWORK' });
  return check('UAT-S02 มีแค่ proxy ที่เปิดพอร์ต (443/80)', failures);
}

export function checkNoStartDev(files) {
  const failures = Object.entries(files)
    .filter(([, text]) => text !== null && /\bstart-dev\b/.test(text))
    .map(([path]) => ({ path, kind: 'START_DEV' }));
  return check('UAT-S03 Keycloak ไม่ใช้ start-dev', failures);
}

export function checkKeycloakProductionMode(compose) {
  const keycloak = parseComposeServices(compose).keycloak;
  const failures = [];
  if (!keycloak) return check('UAT-S04 Keycloak production mode หลัง proxy', [{ kind: 'MISSING' }]);
  if (!keycloak.command.includes('start')) failures.push({ kind: 'NOT_START' });
  const env = keycloak.environment;
  if (!/^https:\/\//.test(env.KC_HOSTNAME ?? '')) failures.push({ kind: 'KC_HOSTNAME_NOT_HTTPS' });
  if (env.KC_PROXY_HEADERS !== 'xforwarded' && env.KC_PROXY_HEADERS !== 'forwarded') {
    failures.push({ kind: 'KC_PROXY_HEADERS' });
  }
  if (env.KC_HTTP_ENABLED !== 'true') failures.push({ kind: 'KC_HTTP_ENABLED' });
  if (keycloak.ports.length > 0) failures.push({ kind: 'ADMIN_PORT_PUBLISHED' });
  return check('UAT-S04 Keycloak production mode หลัง proxy', failures);
}

/**
 * #515/#522: realm UAT ตั้ง login/email theme `dcontact` — Keycloak ต้องรันจาก image ของเรา (มี theme)
 * ไม่ใช่ image ตรงของ Keycloak ไม่งั้นหน้า login ของ realm ล้มทั้งหมด
 */
export function checkKeycloakTheme(compose, realmText, dockerfile) {
  const id = 'UAT-S19 Keycloak image มี login/email theme ที่ realm UAT ใช้';
  const failures = [];
  const keycloak = parseComposeServices(compose).keycloak;
  if (!/^\$\{KEYCLOAK_IMAGE:\?[^}]*\}$/.test(keycloak?.image ?? '')) {
    failures.push({ kind: 'KEYCLOAK_IMAGE_NOT_OURS' });
  }
  let realm = {};
  try {
    realm = JSON.parse(realmText ?? '');
  } catch {
    failures.push({ kind: 'REALM_INVALID_JSON' });
  }
  for (const key of ['loginTheme', 'emailTheme']) {
    if (realm[key] !== UAT_LOGIN_THEME) failures.push({ kind: 'REALM_THEME', key });
  }
  if (dockerfile === null) failures.push({ kind: 'NO_KEYCLOAK_DOCKERFILE' });
  else {
    if (
      !/^\s*COPY\s+[^\n]*infra\/keycloak\/themes\/?\s+\/opt\/keycloak\/themes\/?\s*$/m.test(
        dockerfile,
      )
    )
      failures.push({ kind: 'THEMES_NOT_COPIED' });
    if (!/keycloak-theme-build\.mjs/.test(dockerfile)) failures.push({ kind: 'THEME_NOT_BUILT' });
  }
  return check(id, failures);
}

export function checkComposeCredentials(compose) {
  const services = parseComposeServices(compose);
  const failures = [];
  for (const service of Object.values(services)) {
    for (const [name, value] of Object.entries(service.environment)) {
      const credentialInUrl = /:\/\/[^/\s]*:[^@\s]*@/.test(value);
      if (!SECRETISH_KEY.test(name) && !credentialInUrl) continue;
      const references = [...value.matchAll(/\$\{([A-Z0-9_]+)(:\?[^}]*)?(:?-[^}]*)?\}/g)];
      if (credentialInUrl) {
        const userinfo = /:\/\/([^@]*)@/.exec(value)?.[1] ?? '';
        const password = userinfo.slice(userinfo.indexOf(':') + 1);
        if (!/^\$\{[A-Z0-9_]+:\?[^}]*\}$/.test(password)) {
          failures.push({ service: service.name, name, kind: 'LITERAL_PASSWORD_IN_URL' });
        }
      } else if (references.length === 0) {
        failures.push({ service: service.name, name, kind: 'LITERAL_CREDENTIAL' });
      }
      for (const reference of references) {
        if (!reference[2] || reference[3]) {
          failures.push({ service: service.name, name, kind: 'NOT_REQUIRED_FORM' });
        }
      }
    }
  }
  for (const match of compose.matchAll(/\$\{([A-Z0-9_]+):?-[^}]*\}/g)) {
    failures.push({ name: match[1], kind: 'DEFAULT_VALUE' });
  }
  for (const literal of DEV_CREDENTIAL_LITERALS) {
    if (compose.includes(literal)) failures.push({ kind: 'DEV_CREDENTIAL_LITERAL' });
  }
  return check('UAT-S05 ไม่มี default credential (ทุก secret เป็น ${VAR:?})', failures);
}

export function checkComposeImages(compose) {
  const failures = [];
  for (const service of Object.values(parseComposeServices(compose))) {
    const image = service.image;
    if (!image) {
      failures.push({ service: service.name, kind: 'NO_IMAGE' });
    } else if (/^\$\{[A-Z0-9_]+_IMAGE:\?[^}]*\}$/.test(image)) {
      continue;
    } else if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
      failures.push({ service: service.name, kind: 'NOT_DIGEST_PINNED', image });
    }
  }
  if (/^\s*build:/m.test(compose)) failures.push({ kind: 'BUILD_ON_VM' });
  return check('UAT-S06 image ทุกตัวอ้างด้วย digest', failures);
}

/** ทุก `FROM` ต้อง pin digest (ตรงหรือผ่าน ARG default) หรืออ้าง stage ก่อนหน้า; ห้าม `:latest` */
export function checkDockerfilePins(dockerfiles) {
  const failures = [];
  for (const [path, text] of Object.entries(dockerfiles)) {
    if (text === null) {
      failures.push({ path, kind: 'MISSING' });
      continue;
    }
    const args = {};
    const stages = new Set();
    let froms = 0;
    for (const line of text.split('\n')) {
      const arg = /^\s*ARG\s+([A-Za-z0-9_]+)=(\S+)/.exec(line);
      if (arg) args[arg[1]] = arg[2];
      const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
      if (!from) continue;
      froms += 1;
      const reference = from[1].replace(
        /^\$\{?([A-Za-z0-9_]+)\}?$/,
        (_m, name) => args[name] ?? '',
      );
      if (stages.has(from[1])) {
        // stage ก่อนหน้า
      } else if (!/@sha256:[0-9a-f]{64}$/.test(reference) || /:latest(@|$)/.test(reference)) {
        failures.push({ path, kind: 'UNPINNED_FROM', from: from[1] });
      }
      if (from[2]) stages.add(from[2]);
    }
    if (froms === 0) failures.push({ path, kind: 'NO_FROM' });
    if (!/^\s*USER\s+(?!root|0\b)\S+/m.test(text))
      failures.push({ path, kind: 'NO_NON_ROOT_USER' });
    if (!/org\.opencontainers\.image\.revision=\$SOURCE_SHA/.test(text)) {
      failures.push({ path, kind: 'NO_REVISION_LABEL' });
    }
  }
  return check('UAT-S07 Dockerfile pin digest, non-root, revision label', failures);
}

export function checkRealm(realmText) {
  const failures = [];
  let realm;
  try {
    realm = JSON.parse(realmText ?? '');
  } catch {
    return check('UAT-S08 realm UAT ไม่มี user/secret และบังคับ password+TOTP', [
      { kind: 'INVALID_JSON' },
    ]);
  }
  if (Array.isArray(realm.users) ? realm.users.length > 0 : realm.users !== undefined) {
    failures.push({ kind: 'USERS_PRESENT' });
  }
  const walk = (value, path) => {
    if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (/^(secret|credentials|password|privateKey|client_secret)$/i.test(key)) {
          failures.push({ kind: 'SECRET_FIELD', path: `${path}.${key}` });
        }
        walk(entry, `${path}.${key}`);
      }
    }
  };
  walk(realm, '$');
  if (/localhost|127\.0\.0\.1|http:\/\//.test(realmText)) failures.push({ kind: 'DEV_URL' });
  if (/demo\.local|dev-readiness|events-demo/.test(realmText))
    failures.push({ kind: 'DEV_ARTIFACT' });
  for (const client of realm.clients ?? []) {
    if (client.publicClient === false && !client.bearerOnly) {
      failures.push({ kind: 'CONFIDENTIAL_CLIENT', clientId: client.clientId });
    }
    if (client.directAccessGrantsEnabled) {
      failures.push({ kind: 'PASSWORD_GRANT', clientId: client.clientId });
    }
    for (const uri of [...(client.redirectUris ?? []), ...(client.webOrigins ?? [])]) {
      if (uri.includes('*') || uri === '+' || !uri.startsWith('https://')) {
        failures.push({ kind: 'NON_EXACT_REDIRECT', clientId: client.clientId });
      }
    }
  }
  const console = (realm.clients ?? []).find(
    (client) => client.clientId === 'dcontact-uat-console',
  );
  if (!console || (console.redirectUris ?? []).length === 0)
    failures.push({ kind: 'NO_CONSOLE_CLIENT' });
  if (console?.attributes?.['pkce.code.challenge.method'] !== 'S256') {
    failures.push({ kind: 'NO_PKCE' });
  }
  if (!Array.isArray(realm.organizations) || realm.organizations.length !== 1) {
    failures.push({ kind: 'NO_TENANT_ORGANIZATION' });
  } else if (!realm.organizations[0].attributes?.tenant_id) {
    failures.push({ kind: 'ORGANIZATION_WITHOUT_TENANT_ID' });
  }
  if (realm.otpPolicyType !== 'totp') failures.push({ kind: 'OTP_POLICY' });
  const browser = (realm.authenticationFlows ?? []).find(
    (flow) => flow.alias === realm.browserFlow,
  );
  const forms = (realm.authenticationFlows ?? []).find((flow) =>
    browser?.authenticationExecutions?.some((execution) => execution.flowAlias === flow.alias),
  );
  const required = (authenticator) =>
    forms?.authenticationExecutions?.some(
      (execution) =>
        execution.authenticator === authenticator && execution.requirement === 'REQUIRED',
    );
  if (!browser || !required('auth-username-password-form') || !required('auth-otp-form')) {
    failures.push({ kind: 'OTP_NOT_REQUIRED_IN_BROWSER_FLOW' });
  }
  const totp = (realm.requiredActions ?? []).find((action) => action.alias === 'CONFIGURE_TOTP');
  if (!totp?.enabled || !totp.defaultAction) failures.push({ kind: 'CONFIGURE_TOTP_NOT_DEFAULT' });
  if (realm.registrationAllowed) failures.push({ kind: 'REGISTRATION_ALLOWED' });
  if (realm.sslRequired === 'none' || realm.sslRequired === 'NONE')
    failures.push({ kind: 'SSL_NOT_REQUIRED' });
  return check('UAT-S08 realm UAT ไม่มี user/secret และบังคับ password+TOTP', failures);
}

export function checkApiEnvironment(compose) {
  const api = parseComposeServices(compose).api;
  if (!api) return check('UAT-S09 env ของ api ผ่าน fail-closed profile uat', [{ kind: 'MISSING' }]);
  const failures = [];
  for (const name of Object.keys(api.environment)) {
    if (API_FORBIDDEN_ENV.some((pattern) => pattern.test(name))) {
      failures.push({ name, kind: 'CONFLICTS_WITH_UAT_PROFILE' });
    }
  }
  if (api.environment.DCONTACT_API_PROFILE !== 'uat') failures.push({ kind: 'PROFILE_NOT_UAT' });
  if (/env_file:/.test(api.raw.join('\n'))) failures.push({ kind: 'ENV_FILE_UNREVIEWED' });
  if (!/^postgresql:\/\/dcontact_app:/.test(api.environment.DATABASE_URL ?? '')) {
    failures.push({ kind: 'NOT_APPLICATION_ROLE' });
  }
  return check('UAT-S09 env ของ api ผ่าน fail-closed profile uat', failures);
}

const REQUIRED_REFERENCE = /^\$\{([A-Z0-9_]+):\?[^}]*\}$/;

/**
 * U1.5 (#433) + #540 (ADR-029): object storage ของหลักฐาน UAT บน SeaweedFS
 * - api ต่อ endpoint ภายใน ด้วย credential ของ user เฉพาะ (ไม่ใช่ root) แบบ `:?` และรอ object-storage-init จบก่อน
 * - storage ไม่ publish พอร์ต ไม่ใช้ `weed mini` (admin/worker gRPC ไม่มี mTLS) และมี lifecycle runner
 * - entrypoint สร้าง s3.json: ไม่มี identity anonymous, API ใช้ policy แบบ AWS ที่จำกัด bucket/prefix เท่านั้น
 */
export function checkEvidenceStorage(compose, entrypointScript) {
  const id = 'UAT-S15 evidence storage: object storage user เฉพาะของ API, bucket private';
  const services = parseComposeServices(compose);
  const api = services.api;
  const storage = services['object-storage'];
  const init = services['object-storage-init'];
  const lifecycle = services['object-storage-lifecycle'];
  if (!api || !storage || !init || !lifecycle) return check(id, [{ kind: 'MISSING_SERVICE' }]);
  const failures = [];
  const env = api.environment;
  if (env.S3_ENDPOINT !== 'http://object-storage:8333') {
    failures.push({ kind: 'S3_ENDPOINT_NOT_INTERNAL' });
  }
  for (const name of ['S3_ACCESS_KEY', 'S3_SECRET_KEY']) {
    const reference = REQUIRED_REFERENCE.exec(env[name] ?? '');
    if (!reference) failures.push({ name, kind: 'NOT_REQUIRED_FORM' });
    else if (/ROOT/.test(reference[1])) failures.push({ name, kind: 'API_USES_ROOT_CREDENTIAL' });
  }
  if (env.S3_BUCKET_UAT_EVIDENCE !== 'uat-evidence') failures.push({ kind: 'EVIDENCE_BUCKET' });
  // api ต่อ http://object-storage:8333 ได้เพราะอยู่ network เดียวกัน (internal ไม่มีทางออก)
  for (const service of [api, storage, init, lifecycle]) {
    if (!/^\s+- internal$/m.test(service.raw.join('\n'))) {
      failures.push({ service: service.name, kind: 'NOT_ON_INTERNAL_NETWORK' });
    }
  }
  if (
    !/object-storage-init:\s*\n\s+condition:\s*service_completed_successfully/.test(
      api.raw.join('\n'),
    )
  ) {
    failures.push({ kind: 'API_DOES_NOT_WAIT_FOR_OBJECT_STORAGE_INIT' });
  }
  if (init.profiles.length > 0) failures.push({ kind: 'OBJECT_STORAGE_INIT_IN_PROFILE' });
  if (storage.ports.length > 0) failures.push({ kind: 'OBJECT_STORAGE_PUBLISHES_PORT' });
  const storageText = storage.raw.join('\n');
  if (
    !/entrypoint:\s*\[[^\]]*object-storage-entrypoint\.sh'?\s*\]/.test(storageText) ||
    /\bmini\b/.test(storageText)
  ) {
    failures.push({ kind: 'OBJECT_STORAGE_ENTRYPOINT' });
  }
  if (!/s3\.lifecycle\.run-shard[^\n]*-refresh/.test(lifecycle.raw.join('\n'))) {
    failures.push({ kind: 'NO_LIFECYCLE_RUNNER' });
  }
  const initText = [init, storage].map((service) => service.raw.join('\n')).join('\n');
  if (/PutBucketPolicy|PutBucketAcl|anonymous/i.test(initText)) {
    failures.push({ kind: 'ANONYMOUS_POLICY' });
  }
  if (entrypointScript === null) {
    failures.push({ kind: 'OBJECT_STORAGE_ENTRYPOINT_MISSING' });
  } else {
    const code = entrypointScript
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    if (/\bmini\b/.test(code) || !/weed[^\n]*\bserver\b/.test(code) || !/-s3\b/.test(code)) {
      failures.push({ kind: 'OBJECT_STORAGE_MINI_MODE' });
    }
    if (/"anonymous"/.test(code)) failures.push({ kind: 'ANONYMOUS_IDENTITY' });
    const apiIdentity = /"name":\s*"uat-evidence-api"[\s\S]*?\n\s{4}\}/.exec(code)?.[0] ?? '';
    if (!/"policyNames":\s*\["uat-evidence-api"\]/.test(apiIdentity)) {
      failures.push({ kind: 'POLICY_NOT_ATTACHED' });
    }
    if (/"actions"/.test(apiIdentity)) failures.push({ kind: 'API_COARSE_ACTIONS' });
    const resources = [...code.matchAll(/arn:aws:s3:::([^\\"]*)/g)].map((match) => match[1]);
    const allowed = new Set(['${bucket}', '${bucket}/uat-evidence/*']);
    if (resources.length === 0 || resources.some((resource) => !allowed.has(resource))) {
      failures.push({ kind: 'POLICY_NOT_BUCKET_SCOPED' });
    }
    if (/s3:\*|"Action":\s*"\*"/.test(code)) failures.push({ kind: 'POLICY_TOO_BROAD' });
    if (!/API_USES_ROOT_CREDENTIAL/.test(code)) failures.push({ kind: 'NO_ROOT_GUARD' });
    if (!/INVALID_CREDENTIAL_CHARSET/.test(code))
      failures.push({ kind: 'NO_CREDENTIAL_CHARSET_GUARD' });
    if (!/^bucket=uat-evidence$/m.test(code)) failures.push({ kind: 'EVIDENCE_BUCKET' });
  }
  return check(id, failures);
}

/**
 * U1.8 (#502): provision tenant/บัญชี/fixture pack ทำผ่าน one-shot `uat-provision` ใน profile ops เท่านั้น
 * ด้วย connection ของ owner (ไม่ใช่ `dcontact_app`), image ops ที่มี CLI จริง และไฟล์ input ส่งทาง stdin
 */
export function checkUatProvision(compose, apiDockerfile, deployScript) {
  const id = 'UAT-S16 provision UAT เป็น one-shot ของ ops ด้วย owner connection';
  const service = parseComposeServices(compose)['uat-provision'];
  if (!service) return check(id, [{ kind: 'MISSING_SERVICE' }]);
  const failures = [];
  if (!service.profiles.includes('ops')) failures.push({ kind: 'NOT_OPS_PROFILE' });
  if (!/^\$\{OPS_IMAGE:\?[^}]*\}$/.test(service.image ?? ''))
    failures.push({ kind: 'NOT_OPS_IMAGE' });
  // owner = POSTGRES_USER ของ container postgres (เหมือน service `migrate`) ไม่ใช่ role ของ application
  const owner =
    /^postgresql:\/\/\$\{([A-Z0-9_]+):\?[^}]*\}:\$\{([A-Z0-9_]+):\?[^}]*\}@postgres:5432\/dcontact\b/.exec(
      service.environment.DATABASE_URL ?? '',
    );
  if (owner?.[1] !== 'UAT_POSTGRES_USER' || owner?.[2] !== 'UAT_POSTGRES_PASSWORD') {
    failures.push({ kind: 'NOT_OWNER_CONNECTION' });
  }
  if (/dcontact_app|UAT_APP_DB_PASSWORD/.test(service.raw.join('\n'))) {
    failures.push({ kind: 'APPLICATION_ROLE' });
  }
  if (
    !/entrypoint:\s*\[\s*'node',\s*'\/app\/dist\/uat-provision-main\.js'\s*\]/.test(
      service.raw.join('\n'),
    )
  ) {
    failures.push({ kind: 'ENTRYPOINT' });
  }
  if (/^\s+- edge$/m.test(service.raw.join('\n'))) failures.push({ kind: 'ON_EDGE_NETWORK' });
  const ops =
    /FROM\s+runtime-base\s+AS\s+ops\b([^]*?)(?=^FROM\s|(?![^]))/m.exec(apiDockerfile ?? '')?.[1] ??
    '';
  if (!/^COPY --from=build \/out\/api \/app$/m.test(ops))
    failures.push({ kind: 'OPS_IMAGE_WITHOUT_CLI' });
  if (!/test -f \/out\/api\/dist\/uat-provision-main\.js/.test(apiDockerfile ?? '')) {
    failures.push({ kind: 'CLI_NOT_BUILT' });
  }
  const provision = /^ {2}provision\)\n([^]*?)^ {4};;/m.exec(deployScript ?? '')?.[1] ?? '';
  if (!/run --rm -T uat-provision .*--input - <"\$file"/.test(provision)) {
    failures.push({ kind: 'DEPLOY_NOT_VIA_STDIN' });
  }
  if (!/PROVISION_INPUT_PERMISSIONS/.test(provision)) failures.push({ kind: 'INPUT_PERMISSIONS' });
  return check(id, failures);
}

/** field ของ template ที่ผูกกับ deployment — ต้องเป็น placeholder เสมอ (ค่าจริงเติมตอน render) */
export const FIXTURE_TEMPLATE_PLACEHOLDERS = Object.freeze({
  environment: '__UAT_ENVIRONMENT__',
  packVersion: '__UAT_FIXTURE_PACK_VERSION__',
  buildSha: '__UAT_BUILD_SHA__',
  tenantId: '__UAT_TENANT_ID__',
  ownerTeamId: '__UAT_OWNER_TEAM_ID__',
  makerSubjectId: '__UAT_MAKER_SUBJECT_ID__',
  reviewerSubjectId: '__UAT_REVIEWER_SUBJECT_ID__',
});
/** field ของ example ที่มาจาก secret store — ต้องเป็น placeholder `__UAT_*__` ที่ CLI ปฏิเสธ */
export const PROVISION_EXAMPLE_PLACEHOLDER_FIELDS = Object.freeze([
  'tenant.id',
  'tenant.slug',
  'tenant.name',
  'ownerTeam.id',
  'ownerTeam.name',
  'maker.dcUserId',
  'maker.email',
  'maker.displayName',
  'reviewer.dcUserId',
  'reviewer.email',
  'reviewer.displayName',
  'rollout.evidenceRef',
  'fixturePack.packVersion',
]);
const PLACEHOLDER_VALUE = /^__UAT_[A-Z0-9_]+__$/;
const UUID_LITERAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_LITERAL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * U1.9 (#506): template ของ fixture pack และ input ตัวอย่างของ provision ที่ commit ไว้มีแต่ข้อมูลสังเคราะห์
 * + placeholder — ไม่มี id/อีเมลจริงของ deployment ใด (ค่าจริงอยู่ใน secret store และเติมตอน render)
 */
export function checkFixtureTemplate(templateText, exampleText) {
  const id = 'UAT-S17 fixture template และ provision example มีแต่ placeholder/ข้อมูลสังเคราะห์';
  if (templateText === null || exampleText === null) return check(id, [{ kind: 'MISSING' }]);
  const failures = [];
  const template = parseJsonOrNull(templateText);
  const example = parseJsonOrNull(exampleText);
  if (!template || template.schema !== 'UatFixturePackV1') {
    failures.push({ path: UAT_FILES.fixtureTemplate, kind: 'NOT_FIXTURE_PACK' });
  } else {
    for (const [field, token] of Object.entries(FIXTURE_TEMPLATE_PLACEHOLDERS)) {
      if (template[field] !== token) {
        failures.push({ path: UAT_FILES.fixtureTemplate, field, kind: 'DEPLOYMENT_VALUE_PRESENT' });
      }
    }
    const steps = Array.isArray(template.steps) ? template.steps.length : 0;
    if (steps < 1 || steps > 60) failures.push({ path: UAT_FILES.fixtureTemplate, kind: 'STEPS' });
  }
  if (!example || example.schema !== 'UatProvisionV1') {
    failures.push({ path: UAT_FILES.provisionExample, kind: 'NOT_PROVISION_INPUT' });
  } else {
    for (const field of PROVISION_EXAMPLE_PLACEHOLDER_FIELDS) {
      const value = field.split('.').reduce((node, key) => node?.[key], example);
      if (typeof value !== 'string' || !PLACEHOLDER_VALUE.test(value)) {
        failures.push({ path: UAT_FILES.provisionExample, field, kind: 'VALUE_PRESENT' });
      }
    }
    if (typeof example.fixturePack?.template !== 'string') {
      failures.push({ path: UAT_FILES.provisionExample, kind: 'FIXTURE_PACK_NOT_TEMPLATE' });
    }
  }
  for (const [path, text] of [
    [UAT_FILES.fixtureTemplate, templateText],
    [UAT_FILES.provisionExample, exampleText],
  ]) {
    if (UUID_LITERAL.test(text)) failures.push({ path, kind: 'REAL_ID_PRESENT' });
    if (EMAIL_LITERAL.test(text)) failures.push({ path, kind: 'EMAIL_PRESENT' });
  }
  return check(id, failures);
}

export function checkProxy(caddyfile) {
  const failures = [];
  if (caddyfile === null)
    return check('UAT-S10 proxy ปิด admin ของ Keycloak และบังคับ allowlist', [{ kind: 'MISSING' }]);
  const admin = /@keycloakAdmin\s+path\s+([^\n]+)/.exec(caddyfile)?.[1] ?? '';
  for (const path of ['/auth/admin/*', '/auth/realms/master/*']) {
    if (!admin.split(/\s+/).includes(path)) failures.push({ kind: 'ADMIN_PATH_OPEN', path });
  }
  if (!/respond\s+@keycloakAdmin\s+404/.test(caddyfile))
    failures.push({ kind: 'ADMIN_NOT_BLOCKED' });
  if (
    !/not\s+remote_ip\s+\{\$UAT_ALLOWED_CIDRS\}/.test(caddyfile) ||
    !/respond\s+@outside\s+403/.test(caddyfile)
  ) {
    failures.push({ kind: 'NO_ALLOWLIST' });
  }
  if (!/tls\s+\/run\/secrets\//.test(caddyfile)) failures.push({ kind: 'NO_TLS' });
  if (!/handle\s+\/api\/\*\s*\{\s*reverse_proxy\s+api:3000/.test(caddyfile)) {
    failures.push({ kind: 'API_NOT_SAME_ORIGIN' });
  }
  if (!/admin\s+off/.test(caddyfile)) failures.push({ kind: 'CADDY_ADMIN_ON' });
  // นอก `route {}` Caddy เรียง `handle` ก่อน `respond` → allowlist/การปิด admin ถูกข้ามสำหรับ /auth, /api
  if (
    !/route\s*\{[^]*?respond\s+@outside\s+403[^]*?respond\s+@keycloakAdmin\s+404[^]*?handle\s+\/auth\/\*/.test(
      caddyfile,
    )
  ) {
    failures.push({ kind: 'ORDER_NOT_ENFORCED' });
  }
  return check('UAT-S10 proxy ปิด admin ของ Keycloak และบังคับ allowlist', failures);
}

/** ADR-030: VM1 จบ TLS, VM2 เป็น stack, VM3 เป็น PostgreSQL ผ่าน relay เพียงตัวเดียว */
export function checkThreeVmTopology({
  overlay,
  caddyfile,
  relayConfig,
  dbRolesScript,
  deployScript,
}) {
  const id = 'UAT-S20 UAT 3 VM: TLS ที่ VM1, relay เดียวไป PostgreSQL VM3';
  const failures = [];
  if (overlay === null || caddyfile === null || relayConfig === null || dbRolesScript === null) {
    return check(id, [{ kind: 'MISSING_ARTIFACT' }]);
  }
  for (const pattern of [
    /^  postgres: !reset null$/m,
    /^  postgres-data: !reset null$/m,
    /^  db-relay:$/m,
    /postgres:15\.4-alpine@sha256:[0-9a-f]{64}/,
    /- '192\.168\.102\.112:8080:8080'/,
    /PGHOST: db-relay/,
    /KC_DB_URL: jdbc:postgresql:\/\/db-relay:5432\/keycloak_uat/,
    /DATABASE_URL: postgresql:\/\/dcontact_app:.*@db-relay:5432\/dcontact_uat\?schema=public/,
  ]) {
    if (!pattern.test(overlay))
      failures.push({ kind: 'OVERLAY_INVARIANT', pattern: pattern.source });
  }
  for (const pattern of [
    /auto_https off/,
    /trusted_proxies static 192\.168\.102\.114\/32/,
    /@notEdge not remote_ip 192\.168\.102\.114\/32/,
    /@outside not client_ip \{\$UAT_ALLOWED_CIDRS\}/,
    /respond @notEdge 403/,
    /respond @outside 403/,
    /respond @keycloakAdmin 404/,
  ]) {
    if (!pattern.test(caddyfile))
      failures.push({ kind: 'CADDY_EDGE_INVARIANT', pattern: pattern.source });
  }
  if (/^\s*tls\b/m.test(caddyfile)) failures.push({ kind: 'CADDY_TLS_ENABLED' });
  if (!/server vm3 192\.168\.102\.113:5432 check/.test(relayConfig)) {
    failures.push({ kind: 'RELAY_TARGET' });
  }
  if (
    !/dcontact_platform/.test(dbRolesScript) ||
    !/dcontact_provisioner/.test(dbRolesScript) ||
    !/rolcanlogin/.test(dbRolesScript)
  ) {
    failures.push({ kind: 'ROLE_NOLOGIN_NOT_CHECKED' });
  }
  if (!/is_3vm/.test(deployScript ?? '') || !/pg-dcontact_uat/.test(deployScript ?? '')) {
    failures.push({ kind: 'DEPLOY_SCRIPT_NOT_3VM_AWARE' });
  }
  return check(id, failures);
}

/** network ที่ service ต่อ (ทั้งแบบ list และแบบ map) จาก raw lines ของ `parseComposeServices` */
export function composeServiceNetworks(service) {
  const networks = [];
  let inside = false;
  for (const line of service?.raw ?? []) {
    const indent = line.length - line.trimStart().length;
    if (indent === 4) {
      inside = /^ {4}networks:\s*$/.test(line);
      continue;
    }
    if (!inside || indent !== 6) continue;
    const match = /^\s*(?:-\s*)?([A-Za-z0-9_.-]+)(?::.*)?$/.exec(line);
    if (match) networks.push(match[1]);
  }
  return networks.sort();
}

function composeServiceSecrets(service) {
  const secrets = [];
  let inside = false;
  for (const line of service?.raw ?? []) {
    const indent = line.length - line.trimStart().length;
    if (indent === 4) {
      inside = /^ {4}secrets:\s*$/.test(line);
      continue;
    }
    const match = inside && indent === 6 ? /^\s*-\s*([A-Za-z0-9_.-]+)\s*$/.exec(line) : null;
    if (match) secrets.push(match[1]);
  }
  return secrets.sort();
}

/** Caddyfile.3vm.line ต้องเท่ากับ Caddyfile.3vm ทุกบรรทัด ยกเว้น comment และ block ของ LINE webhook */
function caddyWithoutLineWebhook(text) {
  return text
    .replace(/\n\t\t@lineWebhook \{[^]*?respond @webhookOther 404\n/, '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) && line.trim() !== '')
    .join('\n');
}

/**
 * #565 / ADR-031: overlay `uat-line` — ไม่มี overlay = ไม่มี LINE เลย; มี overlay = เปิดแคบที่สุด
 * - ไฟล์ฐานและ overlay 3vm ไม่มี service `line-*` และ overlay ไม่แตะ `api`
 * - `line-egress` เป็นทางออกเดียว: network `lineegress` มีแค่ relay, `linepilot` มีแค่ relay + runner,
 *   relay รับเฉพาะ SNI `api.line.me` และมี backend เดียว
 * - `line-webhook` = profile `uat-line` + secret แบบไฟล์ ไม่ได้ access token ไม่เปิดพอร์ต อยู่บน `internal` เท่านั้น
 * - route webhook อยู่หลัง edge check ก่อน allowlist และ Caddyfile ส่วนอื่นเหมือน Caddyfile.3vm
 * - deploy ใส่ overlay ตาม flag และถอด container ด้วย `--remove-orphans`; script secret ไม่ echo และตั้ง 0400
 */
export function checkLineOverlay({
  compose,
  compose3vm,
  overlay,
  caddyfile3vm,
  caddyfile,
  egressConfig,
  deployScript,
  secretsScript,
}) {
  const id = 'UAT-S21 overlay uat-line เปิด LINE แคบที่สุดและถอดได้';
  if ([overlay, caddyfile, egressConfig, secretsScript, caddyfile3vm].includes(null)) {
    return check(id, [{ kind: 'MISSING_ARTIFACT' }]);
  }
  const failures = [];
  for (const [file, text] of [
    ['base', compose ?? ''],
    ['3vm', compose3vm ?? ''],
  ]) {
    for (const name of Object.keys(parseComposeServices(text))) {
      if (name.startsWith('line-'))
        failures.push({ kind: 'LINE_SERVICE_OUTSIDE_OVERLAY', file, name });
    }
    if (/lineegress|linepilot/.test(text.split('\n').map(stripYamlComment).join('\n'))) {
      failures.push({ kind: 'LINE_NETWORK_OUTSIDE_OVERLAY', file });
    }
  }

  const services = parseComposeServices(overlay);
  for (const name of ['line-webhook', 'line-pilot', 'line-egress']) {
    if (!services[name]) failures.push({ kind: 'MISSING_SERVICE', name });
  }
  const allowed = new Set(['proxy', 'line-webhook', 'line-pilot', 'line-egress']);
  for (const service of Object.values(services)) {
    if (!allowed.has(service.name))
      failures.push({ kind: 'UNEXPECTED_SERVICE', name: service.name });
    if (service.ports.length > 0) failures.push({ kind: 'PORT_PUBLISHED', name: service.name });
    for (const network of composeServiceNetworks(service)) {
      const permitted =
        network === 'lineegress'
          ? service.name === 'line-egress'
          : network === 'linepilot'
            ? ['line-egress', 'line-pilot'].includes(service.name)
            : true;
      if (!permitted) failures.push({ kind: 'EGRESS_NETWORK_SHARED', name: service.name, network });
    }
  }
  if (!/^ {2}linepilot:\s*\n {4}internal: true$/m.test(overlay)) {
    failures.push({ kind: 'LINEPILOT_NOT_INTERNAL' });
  }

  const egress = services['line-egress'];
  if (egress) {
    if (!/@sha256:[0-9a-f]{64}$/.test(egress.image ?? ''))
      failures.push({ kind: 'EGRESS_IMAGE_NOT_PINNED' });
    if (composeServiceNetworks(egress).join(',') !== 'lineegress,linepilot') {
      failures.push({ kind: 'EGRESS_NETWORKS' });
    }
    if (!egress.profiles.includes('line-pilot')) failures.push({ kind: 'EGRESS_ALWAYS_ON' });
    // alias `api.line.me` บน network ของ relay ทำให้ relay resolve เป็นตัวเอง (ส่งวน) — ต้องใช้ IP คงที่
    if (/aliases:/.test(egress.raw.join('\n'))) failures.push({ kind: 'EGRESS_ALIAS_LOOP' });
  }
  const pilot = services['line-pilot'];
  if (pilot) {
    if (!pilot.profiles.includes('line-pilot')) failures.push({ kind: 'RUNNER_ALWAYS_ON' });
    const relayAddress = /ipv4_address:\s*([0-9.]+)/.exec(egress?.raw.join('\n') ?? '')?.[1];
    if (
      !relayAddress ||
      !pilot.raw.some((line) => line.includes(`'api.line.me:${relayAddress}'`))
    ) {
      failures.push({ kind: 'RUNNER_NOT_PINNED_TO_RELAY' });
    }
    if (pilot.environment.LINE_SECRET_SOURCE !== 'file')
      failures.push({ kind: 'RUNNER_SECRET_NOT_FILE' });
    if (!/^postgresql:\/\/dcontact_app:/.test(pilot.environment.DATABASE_URL ?? '')) {
      failures.push({ kind: 'RUNNER_NOT_APPLICATION_ROLE' });
    }
  }
  const webhook = services['line-webhook'];
  if (webhook) {
    if (webhook.environment.DCONTACT_API_PROFILE !== 'uat-line')
      failures.push({ kind: 'WEBHOOK_PROFILE' });
    if (webhook.environment.LINE_WEBHOOK_SECRET_SOURCE !== 'file') {
      failures.push({ kind: 'WEBHOOK_SECRET_NOT_FILE' });
    }
    if (composeServiceSecrets(webhook).includes('line-channel-access-token')) {
      failures.push({ kind: 'WEBHOOK_HAS_ACCESS_TOKEN' });
    }
    if (composeServiceNetworks(webhook).join(',') !== 'internal')
      failures.push({ kind: 'WEBHOOK_NETWORKS' });
    if (!/^postgresql:\/\/dcontact_app:/.test(webhook.environment.DATABASE_URL ?? '')) {
      failures.push({ kind: 'WEBHOOK_NOT_APPLICATION_ROLE' });
    }
  }
  // secret ไม่อยู่ใน env: LINE_* ของ overlay เป็น reference `${...}` หรือโหมด/path เท่านั้น
  for (const service of Object.values(services)) {
    for (const [name, value] of Object.entries(service.environment)) {
      if (/SECRET$|TOKEN$|_KEY$/.test(name) && !/^(file|\/run\/secrets)$/.test(value)) {
        failures.push({ kind: 'SECRET_IN_ENV', name: service.name, variable: name });
      }
    }
  }

  const code = egressConfig
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  if (!/^\s*mode tcp$/m.test(code)) failures.push({ kind: 'EGRESS_NOT_PASSTHROUGH' });
  if (!/tcp-request content reject unless \{ req\.ssl_sni -m str -i api\.line\.me \}/.test(code)) {
    failures.push({ kind: 'EGRESS_SNI_NOT_ENFORCED' });
  }
  const backends = [...code.matchAll(/^\s*server\s+\S+\s+(\S+)/gm)].map((match) => match[1]);
  if (backends.join(',') !== 'api.line.me:443') failures.push({ kind: 'EGRESS_BACKEND', backends });

  if (
    !/respond @notEdge 403[^]*?@lineWebhook \{\s*method POST\s*path \/webhook\/line\s*\}[^]*?handle @lineWebhook[^]*?max_size[^]*?reverse_proxy line-webhook:3000[^]*?respond @outside 403/.test(
      caddyfile,
    )
  ) {
    failures.push({ kind: 'WEBHOOK_ROUTE_ORDER' });
  }
  if (caddyWithoutLineWebhook(caddyfile) !== caddyWithoutLineWebhook(caddyfile3vm)) {
    failures.push({ kind: 'CADDYFILE_DRIFT' });
  }

  for (const pattern of [
    /line-pilot\.enabled/,
    /is_line "\$dir"/,
    /--remove-orphans "\$\{services\[@\]\}"/,
  ]) {
    if (!pattern.test(deployScript ?? ''))
      failures.push({ kind: 'DEPLOY_NOT_LINE_AWARE', pattern: pattern.source });
  }
  for (const pattern of [/read -rs/, /chmod 0400/, /10001:10001/, /--rotate/]) {
    if (!pattern.test(secretsScript))
      failures.push({ kind: 'SECRETS_SCRIPT', pattern: pattern.source });
  }
  return check(id, failures);
}

export function checkWorkflow(workflow) {
  const failures = [];
  if (workflow === null) return check('UAT-S11 workflow uat-preview', [{ kind: 'MISSING' }]);
  // trigger ดูเฉพาะ block `on:` (ไม่ใช่ `push: true` ของ build-push-action)
  const triggers = /^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m.exec(workflow)?.[1] ?? '';
  const triggerNames = [...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]);
  if (triggerNames.length !== 1 || triggerNames[0] !== 'workflow_dispatch') {
    failures.push({ kind: 'NOT_MANUAL_ONLY' });
  }
  const environments = [...workflow.matchAll(/^\s+environment:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  if (environments.length === 0 || environments.some((name) => name !== 'uat-preview')) {
    failures.push({ kind: 'ENVIRONMENT_NOT_UAT_PREVIEW' });
  }
  if (
    !/concurrency:\s*\n\s+group:\s*uat-preview\s*\n\s+cancel-in-progress:\s*false/.test(workflow)
  ) {
    failures.push({ kind: 'CONCURRENCY' });
  }
  if (!/u1-uat-readiness\.mjs --static/.test(workflow) || !/uat-deploy smoke/.test(workflow)) {
    failures.push({ kind: 'READINESS_NOT_RUN' });
  }
  if (!/--migration-guard/.test(workflow)) failures.push({ kind: 'NO_MIGRATION_GUARD' });
  if (!/uat-deploy backup/.test(workflow)) failures.push({ kind: 'NO_BACKUP' });
  if (!/uat-deploy rollback /.test(workflow)) failures.push({ kind: 'NO_ROLLBACK' });
  if (/\bstart-dev\b/.test(workflow)) failures.push({ kind: 'START_DEV' });
  if (/migrate\s+(dev|reset)|db\s+push|--accept-data-loss|--force-reset/.test(workflow)) {
    failures.push({ kind: 'NON_ADDITIVE_MIGRATION_COMMAND' });
  }
  for (const line of workflow.split('\n')) {
    if (/\b(echo|printf|cat)\b.*\$\{\{\s*secrets\./.test(line))
      failures.push({ kind: 'SECRET_ECHO' });
  }
  for (const match of workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)) {
    // secret ส่งผ่าน `env:` ของ step เท่านั้น ไม่ฝังใน `run:` ตรง ๆ
    const line = workflow.slice(
      workflow.lastIndexOf('\n', match.index) + 1,
      workflow.indexOf('\n', match.index),
    );
    if (!/^\s+[A-Z0-9_]+:\s*\$\{\{\s*secrets\./.test(line)) {
      failures.push({ kind: 'SECRET_NOT_VIA_ENV', name: match[1] });
    }
  }
  if (!/::add-mask::/.test(workflow) && !/ci-ssh-setup\.sh/.test(workflow))
    failures.push({ kind: 'NO_MASK' });
  return check('UAT-S11 workflow uat-preview', failures);
}

/** image smoke ใช้ service จริง จึงรับเฉพาะการสั่งด้วยมือ */
const SMOKE_WORKFLOW_TRIGGERS = Object.freeze(['workflow_dispatch']);
const SMOKE_DEPLOY_STEPS = Object.freeze([
  'prepare',
  'backup',
  'migrate',
  'keycloak',
  'deploy',
  'smoke',
  'provision',
]);

/**
 * U1.10 (#507): workflow `uat-image-smoke` รัน UAT stack จริงบน runner — ต้องไม่มีทางแตะ UAT จริงหรือ secret:
 * ไม่มี `secrets.*`, ไม่ผูก environment (โดยเฉพาะ `uat-preview`), permission อ่านอย่างเดียว, ไม่ push/login
 * registry ภายนอก (push ได้แค่ registry ชั่วคราวบน runner) และต้องรัน `uat-deploy.sh` ตามลำดับจริงแล้ว `down -v`
 */
export function checkSmokeWorkflow(workflow) {
  const id = 'UAT-S18 workflow uat-image-smoke ไม่มี secret/environment/push ภายนอก';
  if (workflow === null) return check(id, [{ kind: 'MISSING' }]);
  const failures = [];
  const code = workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const triggers = /^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m.exec(code)?.[1] ?? '';
  const triggerNames = [...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]);
  for (const name of triggerNames) {
    if (!SMOKE_WORKFLOW_TRIGGERS.includes(name)) failures.push({ kind: 'TRIGGER', name });
  }
  if (!triggerNames.includes('workflow_dispatch')) failures.push({ kind: 'NOT_MANUAL_ONLY' });
  if (!/^permissions:\s*\n {2}contents:\s*read\s*$/m.test(code)) {
    failures.push({ kind: 'PERMISSIONS_NOT_READ_ONLY' });
  }
  if (/^\s+[a-z-]+:\s*write\s*$/m.test(code) || /permissions:\s*write-all/.test(code)) {
    failures.push({ kind: 'WRITE_PERMISSION' });
  }
  if (/\$\{\{\s*secrets\./.test(code) || /secrets:\s*inherit/.test(code)) {
    failures.push({ kind: 'USES_SECRETS' });
  }
  if (/^\s+environment:/m.test(code)) failures.push({ kind: 'USES_ENVIRONMENT' });
  if (/group:\s*uat-preview\s*$/m.test(code)) failures.push({ kind: 'UAT_PREVIEW_CONCURRENCY' });
  if (/^\s+push:\s*true\s*$/m.test(code)) failures.push({ kind: 'IMAGE_PUSH' });
  if (/docker\/login-action|docker\s+login\b|ghcr\.io/.test(code)) {
    failures.push({ kind: 'EXTERNAL_REGISTRY' });
  }
  if (!/^\s+REGISTRY:\s*(localhost|127\.0\.0\.1):\d+\s*$/m.test(code)) {
    failures.push({ kind: 'REGISTRY_NOT_LOCAL' });
  }
  if (!/registry:[^\s@]*@sha256:[0-9a-f]{64}/.test(code)) {
    failures.push({ kind: 'REGISTRY_NOT_DIGEST_PINNED' });
  }
  if (!/bin\/uat-deploy\.sh/.test(code)) failures.push({ kind: 'NOT_VIA_UAT_DEPLOY_SH' });
  for (const step of SMOKE_DEPLOY_STEPS) {
    if (!new RegExp(`uat-deploy ${step} `).test(code))
      failures.push({ kind: 'STEP_MISSING', step });
  }
  if (!/u1-uat-keycloak-users\.mjs --users/.test(code)) failures.push({ kind: 'NO_ACCOUNTS' });
  if (!/::add-mask::/.test(code)) failures.push({ kind: 'NO_MASK' });
  if (!/^\s+timeout-minutes:\s*\d+/m.test(code)) failures.push({ kind: 'NO_TIMEOUT' });
  if (!/if:\s*always\(\)[^]*?down -v/.test(code)) failures.push({ kind: 'NO_TEARDOWN' });
  if (/\bstart-dev\b/.test(code)) failures.push({ kind: 'START_DEV' });
  return check(id, failures);
}

export function checkEnvExample(text) {
  if (text === null) return check('UAT-S12 uat.env.example มีแต่ชื่อ', [{ kind: 'MISSING' }]);
  const failures = text
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line) && !/^[A-Z0-9_]+=$/.test(line))
    .map((line) => ({ kind: 'VALUE_PRESENT', name: line.split('=')[0] }));
  return check('UAT-S12 uat.env.example มีแต่ชื่อ', failures);
}

export function checkDockerignore(text) {
  const failures = [];
  if (text === null)
    return check('UAT-S13 .dockerignore กัน secret/หลักฐาน', [{ kind: 'MISSING' }]);
  const lines = text.split('\n').map((line) => line.trim());
  for (const required of ['.env', '.env.*', '**/node_modules', '**/test-results', 'artifacts']) {
    if (!lines.includes(required)) failures.push({ kind: 'NOT_IGNORED', path: required });
  }
  if (lines.some((line) => /^!\.env/.test(line))) failures.push({ kind: 'ENV_REINCLUDED' });
  return check('UAT-S13 .dockerignore กัน secret/หลักฐาน', failures);
}

/** ประกอบ pattern จากชิ้นส่วน เพื่อให้ไฟล์นี้เองไม่ตรง pattern ของตัวเอง */
const PRIVATE_KEY = new RegExp(['-----BEGIN', '[A-Z ]*', 'PRIVATE KEY-----'].join(' ?'));
export const SECRET_PATTERNS = Object.freeze([
  ['PRIVATE_KEY', PRIVATE_KEY],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['GITHUB_TOKEN', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['AWS_ACCESS_KEY', /\bAKIA[0-9A-Z]{16}\b/],
  ['SLACK_TOKEN', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['BEARER_LITERAL', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  [
    'CREDENTIAL_ASSIGNMENT',
    /\b[A-Z0-9_]*(PASSWORD|SECRET|TOKEN)[A-Z0-9_]*[=:]\s*['"]?(?![$<{?'"\s]|\*\*\*)[^\s'"#]{6,}/,
  ],
]);

export function scanSecrets(files) {
  const failures = [];
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    text.split('\n').forEach((line, index) => {
      for (const [kind, pattern] of SECRET_PATTERNS) {
        if (pattern.test(line)) failures.push({ path, line: index + 1, kind });
      }
      for (const literal of DEV_CREDENTIAL_LITERALS) {
        // สอง script นี้ประกาศรายการ credential ของ dev ไว้เพื่อปฏิเสธ — ไม่ใช่การใช้งาน
        const declaresDenylist = [UAT_FILES.keycloakScript, UAT_FILES.readinessScript].includes(
          path,
        );
        if (!declaresDenylist && line.includes(literal)) {
          failures.push({ path, line: index + 1, kind: 'DEV_CREDENTIAL_LITERAL' });
        }
      }
    });
  }
  return check('UAT-S14 negative secret scan ของไฟล์ UAT', failures, {
    scanned: Object.keys(files).filter((path) => files[path] !== null).length,
  });
}

export function runStaticChecks(root = repositoryRoot) {
  const files = Object.fromEntries(
    Object.entries(UAT_FILES).map(([key, path]) => [key, read(path, root)]),
  );
  const missing = Object.entries(UAT_FILES)
    .filter(([key]) => files[key] === null)
    .map(([, path]) => ({ path, kind: 'MISSING' }));
  const compose = files.compose ?? '';
  const checks = [
    check('UAT-S00 artifact ของ U1.6 ครบ', missing),
    checkComposeServices(compose),
    checkComposePorts(compose),
    checkNoStartDev({
      [UAT_FILES.compose]: files.compose,
      [UAT_FILES.workflow]: files.workflow,
      [UAT_FILES.deployScript]: files.deployScript,
      [UAT_FILES.apiDockerfile]: files.apiDockerfile,
    }),
    checkKeycloakProductionMode(compose),
    checkComposeCredentials(compose),
    checkComposeImages(compose),
    checkDockerfilePins({
      [UAT_FILES.apiDockerfile]: files.apiDockerfile,
      [UAT_FILES.consoleDockerfile]: files.consoleDockerfile,
      [UAT_FILES.keycloakDockerfile]: files.keycloakDockerfile,
    }),
    checkKeycloakTheme(compose, files.realm, files.keycloakDockerfile),
    checkRealm(files.realm),
    checkApiEnvironment(compose),
    checkEvidenceStorage(compose, files.objectStorageEntrypoint),
    checkUatProvision(compose, files.apiDockerfile, files.deployScript),
    checkProxy(files.caddyfile),
    checkThreeVmTopology({
      overlay: files.compose3vm,
      caddyfile: files.caddyfile3vm,
      relayConfig: files.dbRelayConfig,
      dbRolesScript: files.dbRoles3vmScript,
      deployScript: files.deployScript,
    }),
    checkLineOverlay({
      compose: files.compose,
      compose3vm: files.compose3vm,
      overlay: files.composeLine,
      caddyfile3vm: files.caddyfile3vm,
      caddyfile: files.caddyfileLine,
      egressConfig: files.lineEgressConfig,
      deployScript: files.deployScript,
      secretsScript: files.lineSecretsScript,
    }),
    checkWorkflow(files.workflow),
    checkSmokeWorkflow(files.smokeWorkflow),
    checkEnvExample(files.envExample),
    checkDockerignore(files.dockerignore),
    checkFixtureTemplate(files.fixtureTemplate, files.provisionExample),
    scanSecrets(
      Object.fromEntries(Object.entries(UAT_FILES).map(([key, path]) => [path, files[key]])),
    ),
  ];
  return report('static', checks);
}

function report(mode, checks) {
  return {
    type: 'u1.uat.readiness',
    mode,
    status: checks.some((entry) => entry.status === 'FAIL') ? 'FAIL' : 'PASS',
    checks,
  };
}

// ── migration guard ─────────────────────────────────────────────────────────

export const MIGRATIONS_DIRECTORY = 'packages/db/prisma/migrations';

export function findDropStatements(sql) {
  const statements = String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return [...statements.matchAll(/\bDROP\b[^;]*/gi)].map((match) => match[0].trim().slice(0, 80));
}

/** changes = [{ status: 'A'|'M'|'D'|'R...', path, sql }] ของ migration ระหว่าง base..HEAD */
export function guardMigrations(changes) {
  const failures = [];
  const added = [];
  for (const change of changes) {
    if (!change.path.startsWith(`${MIGRATIONS_DIRECTORY}/`)) continue;
    if (change.status !== 'A') {
      // migration ที่ apply แล้วต้องไม่ถูกแก้/ลบ/ย้าย — แก้ = UAT กับ repo ไม่ตรงกัน
      failures.push({
        path: change.path,
        kind: 'APPLIED_MIGRATION_CHANGED',
        status: change.status,
      });
      continue;
    }
    added.push(change.path);
    if (!change.path.endsWith('.sql')) continue;
    const drops = findDropStatements(change.sql ?? '');
    if (drops.length > 0)
      failures.push({ path: change.path, kind: 'DROP_STATEMENT', statements: drops });
  }
  return check('UAT-M01 migration ใหม่เป็น additive (ไม่มี DROP)', failures, { added });
}

function git(args, root) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} ล้มเหลว: ${result.stderr.trim()}`);
  return result.stdout;
}

export function runMigrationGuard({ base, initial = false, head = 'HEAD', root = repositoryRoot }) {
  if (initial) {
    // deploy ครั้งแรกลงฐานข้อมูลว่าง: ไม่มีข้อมูลให้เสีย แต่บันทึกไว้ใน record ว่าไม่มี base
    return {
      ...report('migration-guard', [
        {
          id: 'UAT-M01 migration ใหม่เป็น additive (ไม่มี DROP)',
          status: 'PASS',
          basis: 'INITIAL_EMPTY_DATABASE',
        },
      ]),
      base: null,
      head: git(['rev-parse', head], root).trim(),
    };
  }
  if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('--base ต้องเป็น commit SHA เต็ม');
  git(['merge-base', '--is-ancestor', base, head], root);
  const changes = git(
    ['diff', '--name-status', '--no-renames', base, head, '--', MIGRATIONS_DIRECTORY],
    root,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      const sql = status === 'A' ? git(['show', `${head}:${path}`], root) : '';
      return { status, path, sql };
    });
  return {
    ...report('migration-guard', [guardMigrations(changes)]),
    base,
    head: git(['rev-parse', head], root).trim(),
  };
}

// ── live smoke ──────────────────────────────────────────────────────────────

/**
 * HTTP(S) request ที่ต่อไป `connectHost` ได้ (เช่น 127.0.0.1 บน VM) โดยยังใช้ SNI/Host ของ UAT_HOST
 * ไม่ตาม redirect เพื่อให้เห็นสถานะจริงของ path ที่ต้องปิด
 */
export function requestUrl(
  url,
  { method = 'GET', headers = {}, body, connectHost, timeoutMs = 10_000 } = {},
) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolvePromise, reject) => {
    const request = client.request(
      {
        method,
        host: connectHost ?? target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        servername: target.hostname,
        headers: { host: target.host, accept: 'application/json, text/html', ...headers },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function json(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

export function tcpPortOpen(host, port, timeoutMs = 2_000) {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function liveCheck(id, work) {
  try {
    const failures = await work();
    if (failures === 'SKIPPED') return { id, status: 'SKIPPED' };
    return check(id, failures);
  } catch (error) {
    // ข้อความของ error มาจาก network stack/ของเราเอง ไม่มี token
    return {
      id,
      status: 'FAIL',
      failures: [{ kind: 'ERROR', message: String(error?.message ?? error).slice(0, 200) }],
    };
  }
}

/** journey flow แบบไม่เปลี่ยน state: run ปัจจุบัน → validate → compile → simulate ด้วย fixture ของ run */
async function authenticatedJourneyFlow(call) {
  const failures = [];
  const current = await call('GET', '/api/v1/uat-runs/current');
  if (current.status !== 200) return [{ step: 'uat-runs/current', status: current.status }];
  const journeyId = json(current)?.journeyId;
  if (!journeyId) return [{ step: 'uat-runs/current', kind: 'NO_JOURNEY' }];
  const snapshot = await call('GET', `/api/v1/journey-authoring/journeys/${journeyId}`);
  const head = json(snapshot)?.head;
  if (snapshot.status !== 200 || !head) return [{ step: 'journey', status: snapshot.status }];
  const binding = {
    draftRevision: head.currentDraftRevision,
    draftDigest: head.currentDraftDigest,
  };
  const validate = await call(
    'POST',
    `/api/v1/journey-authoring/journeys/${journeyId}/validate`,
    binding,
  );
  if (validate.status !== 200) failures.push({ step: 'validate', status: validate.status });
  const compile = await call('POST', `/api/v1/journey-authoring/journeys/${journeyId}/compile`, {
    ...binding,
    expectedHeadVersion: head.version,
  });
  const compileDigest = json(compile)?.artifact?.compileDigest;
  if (compile.status !== 200 || !compileDigest) {
    failures.push({ step: 'compile', status: compile.status });
    return failures;
  }
  const fixture = await call('GET', '/api/v1/uat-runs/current/simulation-fixture');
  if (fixture.status !== 200 || !json(fixture)?.fixture) {
    failures.push({ step: 'simulation-fixture', status: fixture.status });
    return failures;
  }
  const simulate = await call(
    'POST',
    `/api/v1/journey-authoring/journeys/${journeyId}/simulations`,
    {
      compileDigest,
      fixture: json(fixture).fixture,
    },
  );
  if (simulate.status !== 200) failures.push({ step: 'simulate', status: simulate.status });
  return failures;
}

export async function runLiveSmoke({
  baseUrl,
  connectHost,
  portCheckHost,
  token,
  realm = 'dcontact',
  ports = FORBIDDEN_PORTS,
  allowHttp = false,
  request = requestUrl,
  portOpen = tcpPortOpen,
} = {}) {
  if (!baseUrl) throw new Error('UAT_BASE_URL is required');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !allowHttp) throw new Error('UAT_BASE_URL ต้องเป็น https');
  const origin = base.origin;
  const get = (path) => request(`${origin}${path}`, { connectHost });
  const checks = [];

  checks.push(
    await liveCheck('UAT-L01 Console index', async () => {
      const response = await get('/');
      const failures = [];
      if (response.status !== 200) failures.push({ status: response.status });
      if (!/text\/html/.test(String(response.headers['content-type'] ?? '')))
        failures.push({ kind: 'NOT_HTML' });
      if (!/<div id="root">/.test(response.body)) failures.push({ kind: 'NOT_CONSOLE' });
      return failures;
    }),
  );

  checks.push(
    await liveCheck('UAT-L02 runtime-profile = uat (Kafka/LINE/egress ปิด)', async () => {
      const response = await get('/api/v1/runtime-profile');
      const body = json(response);
      const expected = {
        profile: 'uat',
        kafka: 'DISABLED',
        lineWebhook: 'DISABLED',
        providerEgress: 'BLOCKED',
        journeyRuntime: 'NOT_DEPLOYED',
        unilateralPublish: 'NOT_EXPOSED',
      };
      if (response.status !== 200 || !body) return [{ status: response.status }];
      return Object.entries(expected)
        .filter(([key, value]) => body[key] !== value)
        .map(([key]) => ({ field: key, actual: String(body[key]) }));
    }),
  );

  checks.push(
    await liveCheck(
      'UAT-L03 route นอก allowlist = 404 ROUTE_NOT_AVAILABLE_IN_PROFILE',
      async () => {
        const failures = [];
        for (const path of ['/api/v1/tenants', '/api/v1/line/webhook', '/api/v1/interactions']) {
          const response = await get(path);
          if (
            response.status !== 404 ||
            json(response)?.code !== 'ROUTE_NOT_AVAILABLE_IN_PROFILE'
          ) {
            failures.push({ path, status: response.status });
          }
        }
        return failures;
      },
    ),
  );

  const issuer = `${origin}/auth/realms/${realm}`;
  checks.push(
    await liveCheck('UAT-L04 OIDC discovery ของ Keycloak ตรง issuer', async () => {
      const response = await get(`/auth/realms/${realm}/.well-known/openid-configuration`);
      const body = json(response);
      if (response.status !== 200 || !body) return [{ status: response.status }];
      const failures = [];
      if (body.issuer !== issuer) failures.push({ kind: 'ISSUER_MISMATCH' });
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        if (typeof body[key] !== 'string' || !body[key].startsWith(`${issuer}/`)) {
          failures.push({ kind: 'ENDPOINT_NOT_ON_ISSUER', key });
        }
      }
      return failures;
    }),
  );

  checks.push(
    await liveCheck('UAT-L05 admin ของ Keycloak ไม่เปิดสู่ภายนอก', async () => {
      const failures = [];
      for (const path of [
        '/auth/admin/',
        '/auth/admin/master/console/',
        `/auth/admin/realms/${realm}`,
        '/auth/realms/master/.well-known/openid-configuration',
        '/auth/realms/master/protocol/openid-connect/token',
      ]) {
        const response = await get(path);
        if (![403, 404].includes(response.status)) failures.push({ path, status: response.status });
      }
      return failures;
    }),
  );

  checks.push(
    await liveCheck(
      'UAT-L06 journey-authoring ผ่านบัญชีทดสอบ (validate/compile/simulate)',
      async () => {
        if (!token) return 'SKIPPED';
        const call = (method, path, payload) =>
          request(`${origin}${path}`, {
            method,
            connectHost,
            headers: {
              authorization: `Bearer ${token}`,
              ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: payload === undefined ? undefined : JSON.stringify(payload),
          });
        return authenticatedJourneyFlow(call);
      },
    ),
  );

  checks.push(
    await liveCheck('UAT-L07 พอร์ตภายในปิดบน host (TCP connect)', async () => {
      const host = portCheckHost ?? connectHost ?? base.hostname;
      const failures = [];
      for (const port of ports) {
        if (await portOpen(host, port)) failures.push({ port, kind: 'OPEN' });
      }
      return failures;
    }),
  );

  checks.push(
    await liveCheck(`UAT-L08 หน้า Keycloak ใช้ login theme ${UAT_LOGIN_THEME} (#515)`, async () => {
      // client ที่ไม่มีอยู่ = หน้า error ของ realm ซึ่ง render ด้วย login theme ของ realm — GET ไม่มี session/state
      // Accept ของ get() ขึ้นต้นด้วย application/json ซึ่ง Keycloak ตอบ error เป็น JSON — ขอ HTML ตรง ๆ
      const page = await request(
        `${origin}/auth/realms/${realm}/protocol/openid-connect/auth?client_id=uat-readiness-theme-probe&response_type=code&scope=openid`,
        { connectHost, headers: { accept: 'text/html' } },
      );
      if (!/class="dc-shell"/.test(page.body)) return [{ status: page.status, kind: 'NOT_THEMED' }];
      const stylesheet = new RegExp(
        `href="(/auth/resources/[^"]+/login/${UAT_LOGIN_THEME}/css/)dcontact\\.css"`,
      ).exec(page.body)?.[1];
      if (!stylesheet) return [{ kind: 'NO_THEME_STYLESHEET' }];
      const failures = [];
      // tokens.css สร้างตอน build image (ไม่อยู่ใน Git) — ขาด = หน้าไม่มีสี
      for (const file of ['dcontact.css', 'tokens.css']) {
        const response = await get(`${stylesheet}${file}`);
        if (response.status !== 200 || !/--dc-/.test(response.body)) {
          failures.push({ file, status: response.status });
        }
      }
      return failures;
    }),
  );

  return { ...report('live', checks), baseUrl: origin };
}

// ── deployment record ───────────────────────────────────────────────────────

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return null;
  // ไฟล์จาก SSH อาจมีหลายบรรทัด — ใช้ JSON บรรทัดสุดท้าย
  const lines = text.split('\n').filter((line) => line.trim().startsWith('{'));
  try {
    return JSON.parse(text);
  } catch {
    return lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
  }
}

function readEnvFile(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

export function buildDeploymentRecord({
  action,
  release,
  rollbackOf,
  keycloak,
  backup,
  migrationGuard,
  smoke,
  environment = process.env,
  now = new Date(),
}) {
  const images =
    action === 'rollback'
      ? rollbackOf?.images
      : {
          api: release?.API_IMAGE,
          console: release?.CONSOLE_IMAGE,
          ops: release?.OPS_IMAGE,
          keycloak: release?.KEYCLOAK_IMAGE,
        };
  const sourceSha = action === 'rollback' ? rollbackOf?.sourceSha : release?.SOURCE_SHA;
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw new Error('sourceSha ไม่ครบ');
  for (const [name, image] of Object.entries(images ?? {})) {
    if (!/@sha256:[0-9a-f]{64}$/.test(image ?? ''))
      throw new Error(`image ${name} ไม่ได้อ้างด้วย digest`);
  }
  if (smoke?.status !== 'PASS') throw new Error('readiness smoke ไม่ผ่าน — ไม่บันทึก record');
  return {
    schema: 'UatDeploymentRecordV1',
    action,
    environment:
      action === 'rollback' ? rollbackOf.environment : environment.UAT_ENVIRONMENT || 'uat',
    sourceSha,
    images,
    realmConfigDigest:
      action === 'rollback' ? rollbackOf.realmConfigDigest : (keycloak?.realmConfigDigest ?? null),
    fixturePackVersion:
      action === 'rollback'
        ? rollbackOf.fixturePackVersion
        : environment.UAT_FIXTURE_PACK_VERSION || null,
    migration:
      action === 'rollback'
        ? { applied: false, note: 'rollback ไม่แตะฐานข้อมูล' }
        : {
            applied: true,
            guard: migrationGuard?.status ?? null,
            base: migrationGuard?.base ?? null,
            added: migrationGuard?.checks?.[0]?.added ?? [],
          },
    backup:
      action === 'rollback'
        ? null
        : backup
          ? { status: backup.status, file: backup.file ?? null, sha256: backup.sha256 ?? null }
          : null,
    smoke: {
      status: smoke.status,
      checks: smoke.checks.map((entry) => ({ id: entry.id, status: entry.status })),
    },
    rollbackOf:
      action === 'rollback'
        ? { recordedAt: rollbackOf.deployedAt ?? null, runUrl: rollbackOf.runUrl ?? null }
        : null,
    runUrl: environment.RUN_URL ?? null,
    deployedAt: now.toISOString(),
  };
}

export function renderSummary(record) {
  const rows = [
    ['action', record.action],
    ['environment', record.environment],
    ['source SHA', record.sourceSha],
    ['api image', record.images.api],
    ['console image', record.images.console],
    ['ops image', record.images.ops],
    ['keycloak image', record.images.keycloak ?? '—'],
    ['realm config digest', record.realmConfigDigest ?? '—'],
    ['fixture pack version', record.fixturePackVersion ?? '—'],
    [
      'migration guard',
      record.migration.applied
        ? `${record.migration.guard} (base ${record.migration.base ?? 'initial'})`
        : 'ไม่ migrate (rollback)',
    ],
    ['backup', record.backup ? `${record.backup.status} ${record.backup.file ?? ''}`.trim() : '—'],
    ['smoke', record.smoke.status],
    ['deployed at', record.deployedAt],
  ];
  return [
    `## UAT deployment record (${record.action})`,
    '',
    '| รายการ | ค่า |',
    '| --- | --- |',
    ...rows.map(([key, value]) => `| ${key} | \`${String(value).replace(/\|/g, '\\|')}\` |`),
    '',
    ...record.smoke.checks.map((entry) => `- ${entry.status} — ${entry.id}`),
    '',
  ].join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  if (argv.includes('--live')) {
    return runLiveSmoke({
      baseUrl: environment.UAT_BASE_URL,
      connectHost: environment.UAT_CONNECT_HOST || undefined,
      portCheckHost: environment.UAT_PORT_CHECK_HOST || undefined,
      token: environment.UAT_SMOKE_ACCESS_TOKEN || undefined,
    });
  }
  if (argv.includes('--migration-guard') && !argv.includes('--migration-guard-report')) {
    return runMigrationGuard({ base: option(argv, '--base'), initial: argv.includes('--initial') });
  }
  if (argv.includes('--deployment-record')) {
    const action = option(argv, '--action');
    if (!['deploy', 'rollback'].includes(action)) throw new Error('--action deploy|rollback');
    return buildDeploymentRecord({
      action,
      release: option(argv, '--release') ? readEnvFile(option(argv, '--release')) : null,
      rollbackOf: readJson(option(argv, '--rollback-of')),
      keycloak: readJson(option(argv, '--keycloak')),
      backup: readJson(option(argv, '--backup')),
      migrationGuard: readJson(option(argv, '--migration-guard-report')),
      smoke: readJson(option(argv, '--smoke')),
      environment,
    });
  }
  if (argv.includes('--summary')) {
    return { summary: renderSummary(readJson(option(argv, '--summary'))) };
  }
  return runStaticChecks();
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  main()
    .then((result) => {
      if (result.summary !== undefined) process.stdout.write(result.summary);
      else process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status === 'FAIL') process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ type: 'u1.uat.readiness', status: 'FAIL', error: String(error?.message ?? error) })}\n`,
      );
      process.exitCode = 1;
    });
}
