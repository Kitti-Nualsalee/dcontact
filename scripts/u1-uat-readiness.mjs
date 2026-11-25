import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * U1.6 (#434): readiness of the UAT deployment (VM + Docker Compose) - no dependency other than Node
 *
 * - `--static`: checks the artifacts in the repo (compose, Dockerfile, Caddyfile, realm, workflow) + a negative
 *   secret scan - can run in CI without a network
 * - `--live`: smoke against a deployed UAT (`UAT_BASE_URL`, `UAT_CONNECT_HOST`, `UAT_SMOKE_ACCESS_TOKEN`)
 * - `--migration-guard --base <sha> | --initial`: a new migration must be additive (no DROP, no editing an existing file)
 * - `--deployment-record` / `--summary`: create/show the deployment record of the `uat-preview` workflow
 *
 * The result is a single JSON line; any FAIL check = a non-zero exit code; no token/secret is ever printed
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const UAT_FILES = Object.freeze({
  compose: 'infra/uat/docker-compose.uat.yml',
  caddyfile: 'infra/uat/Caddyfile',
  compose3vm: 'infra/uat/docker-compose.uat.3vm.yml',
  caddyfile3vm: 'infra/uat/Caddyfile.3vm',
  dbRelayConfig: 'infra/uat/haproxy-db-relay.cfg',
  // #565 (ADR-031): the `uat-line` overlay that is enabled by a flag on VM2
  composeLine: 'infra/uat/docker-compose.uat.line.yml',
  caddyfileLine: 'infra/uat/Caddyfile.3vm.line',
  lineEgressConfig: 'infra/uat/haproxy-line-egress.cfg',
  lineSecretsScript: 'infra/uat/operator/vm2-line-secrets.sh',
  // #567: the team trial overlay (a separate flag)
  composeLineTrial: 'infra/uat/docker-compose.uat.line-trial.yml',
  composeE1: 'infra/uat/docker-compose.uat.e1.yml',
  // #645: the Platform overlay on VM2 (A1.9) touches the same realm - it must not bind a browser flow over the realm template
  composePlatform3vm: 'infra/uat/docker-compose.platform.3vm.yml',
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
  // U1.9 (#506): the fixture pack of the UAT first slice (template + renderer) and the sample provision input
  fixtureTemplate: 'infra/uat/fixtures/uat-first-slice.v1.template.json',
  fixtureRenderer: 'scripts/u1-uat-fixture-render.mjs',
  provisionExample: 'infra/uat/uat-provision.example.json',
});

/** Services the UAT first slice must not have (#374): Journey worker/runtime, voice, event backbone, Redis */
export const FORBIDDEN_SERVICE_PATTERNS = Object.freeze([
  ['JOURNEY_WORKER', /journey(?!-?authoring)|apps\/journey|dcontact-journey/i],
  ['FREESWITCH', /freeswitch/i],
  ['KAFKA', /kafka|redpanda|zookeeper/i],
  ['REDIS', /redis|valkey/i],
]);
export const ALLOWED_PUBLIC_SERVICE = 'proxy';
/** #515/#522: the theme the UAT realm sets must be in the Keycloak image (infra/keycloak/Dockerfile) */
export const UAT_LOGIN_THEME = 'dcontact';
export const ALLOWED_PUBLIC_PORTS = Object.freeze(['443', '80']);
/** api env that conflicts with the `uat` profile (matches UAT_FORBIDDEN_ENV in apps/api/src/runtime-profile.ts) */
export const API_FORBIDDEN_ENV = Object.freeze([/^LINE_/, /^KAFKA_BROKERS$/, /^SIP_/]);
const SECRETISH_KEY =
  /(PASSWORD|SECRET|TOKEN|CREDENTIAL|PRIVATE|ACCESS_KEY|ADMIN_USERNAME|ROOT_USER|MC_HOST)/i;
/** dev/seed credential values that must not appear in UAT artifacts */
const DEV_CREDENTIAL_LITERALS = [
  'dcontact-secret',
  'admin1234',
  'agent1234',
  'ClueCon',
  'dcontact_app:dcontact_app',
  'dcontact:dcontact@',
  'dcontact-events-demo-secret',
  'dcontact-c360-introspection-dev-secret',
];
/** Ports that must be closed on the UAT host (only 80/443 of the proxy are open) */
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
  // a YAML comment = ` #` outside quotes - our compose has no `#` inside values
  const index = line.search(/(^|\s)#/);
  return index === -1 ? line : line.slice(0, index);
}

/**
 * Read the compose structure lightly (the usual Compose indentation of 2 spaces): services -> image/ports/
 * environment/command/profiles - enough to check policy without an external YAML parser
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
  return check('UAT-S01 compose has no worker/FreeSWITCH/Kafka/Redis', failures, {
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
  return check('UAT-S02 only the proxy publishes ports (443/80)', failures);
}

export function checkNoStartDev(files) {
  const failures = Object.entries(files)
    .filter(([, text]) => text !== null && /\bstart-dev\b/.test(text))
    .map(([path]) => ({ path, kind: 'START_DEV' }));
  return check('UAT-S03 Keycloak does not use start-dev', failures);
}

export function checkKeycloakProductionMode(compose) {
  const keycloak = parseComposeServices(compose).keycloak;
  const failures = [];
  if (!keycloak)
    return check('UAT-S04 Keycloak in production mode behind the proxy', [{ kind: 'MISSING' }]);
  if (!keycloak.command.includes('start')) failures.push({ kind: 'NOT_START' });
  const env = keycloak.environment;
  if (!/^https:\/\//.test(env.KC_HOSTNAME ?? '')) failures.push({ kind: 'KC_HOSTNAME_NOT_HTTPS' });
  if (env.KC_PROXY_HEADERS !== 'xforwarded' && env.KC_PROXY_HEADERS !== 'forwarded') {
    failures.push({ kind: 'KC_PROXY_HEADERS' });
  }
  if (env.KC_HTTP_ENABLED !== 'true') failures.push({ kind: 'KC_HTTP_ENABLED' });
  if (keycloak.ports.length > 0) failures.push({ kind: 'ADMIN_PORT_PUBLISHED' });
  // #680: readiness must be decided from the HTTP status - the body may have sub-checks that are UP even while the overall state is still DOWN (bootstrap)
  const health = keycloak.raw.find((line) => line.includes('/health/ready'));
  if (!health || !health.includes("grep -q ' 200 '") || /grep -q UP\b/.test(health)) {
    failures.push({ kind: 'HEALTHCHECK_NOT_STATUS_BASED' });
  }
  return check('UAT-S04 Keycloak in production mode behind the proxy', failures);
}

/**
 * #515/#522: the UAT realm sets the `dcontact` login/email theme - Keycloak must run from our image (which has the theme)
 * not the upstream Keycloak image directly, otherwise the login page of the whole realm breaks
 */
export function checkKeycloakTheme(compose, realmText, dockerfile) {
  const id = 'UAT-S19 the Keycloak image has the login/email theme the UAT realm uses';
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
  return check('UAT-S05 no default credential (every secret is ${VAR:?})', failures);
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
  return check('UAT-S06 every image is referenced by digest', failures);
}

/** Every `FROM` must pin a digest (directly or via an ARG default) or reference an earlier stage; `:latest` is forbidden */
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
        // an earlier stage
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

/** `AMR_MAX_AGE_SECONDS` in scripts/keycloak-platform-setup.mjs - change both together */
export const PLATFORM_AMR_MAX_AGE_SECONDS = 36000;

export function checkRealm(realmText) {
  const failures = [];
  let realm;
  try {
    realm = JSON.parse(realmText ?? '');
  } catch {
    return check('UAT-S08 the UAT realm has no user/secret and enforces password+TOTP', [
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
  // #645: a session longer than the AMR max age in platform-console (36000) = a token without pwd/otp -> MFA_REQUIRED
  if (
    !(realm.ssoSessionIdleTimeout > 0) ||
    !(realm.ssoSessionIdleTimeout <= realm.ssoSessionMaxLifespan) ||
    !(realm.ssoSessionMaxLifespan <= PLATFORM_AMR_MAX_AGE_SECONDS)
  ) {
    failures.push({ kind: 'SSO_SESSION_OUT_OF_BOUNDS' });
  }
  if (realm.registrationAllowed) failures.push({ kind: 'REGISTRATION_ALLOWED' });
  if (realm.sslRequired === 'none' || realm.sslRequired === 'NONE')
    failures.push({ kind: 'SSL_NOT_REQUIRED' });
  return check('UAT-S08 the UAT realm has no user/secret and enforces password+TOTP', failures);
}

export function checkApiEnvironment(compose) {
  const api = parseComposeServices(compose).api;
  if (!api)
    return check('UAT-S09 api env passes the fail-closed profile uat', [{ kind: 'MISSING' }]);
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
  return check('UAT-S09 api env passes the fail-closed profile uat', failures);
}

const REQUIRED_REFERENCE = /^\$\{([A-Z0-9_]+):\?[^}]*\}$/;

/**
 * U1.5 (#433) + #540 (ADR-029): object storage for UAT evidence on SeaweedFS
 * - the api connects to the internal endpoint with the credential of a dedicated user (not root) using `:?` and waits for object-storage-init to finish
 * - storage publishes no port, does not use `weed mini` (admin/worker gRPC has no mTLS) and has a lifecycle runner
 * - the entrypoint creates s3.json: no anonymous identity, and the API uses an AWS-style policy limited to the bucket/prefix only
 */
export function checkEvidenceStorage(compose, entrypointScript) {
  const id =
    'UAT-S15 evidence storage: a dedicated object storage user for the API, private bucket';
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
  // the api reaches http://object-storage:8333 because it is on the same network (internal has no way out)
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
 * U1.8 (#502): provisioning of tenant/accounts/fixture pack is done only through the one-shot `uat-provision` in the ops profile
 * with the owner connection (not `dcontact_app`), an ops image that has the real CLI, and the input file passed through stdin
 */
export function checkUatProvision(compose, apiDockerfile, deployScript) {
  const id = 'UAT-S16 UAT provision is an ops one-shot with the owner connection';
  const service = parseComposeServices(compose)['uat-provision'];
  if (!service) return check(id, [{ kind: 'MISSING_SERVICE' }]);
  const failures = [];
  if (!service.profiles.includes('ops')) failures.push({ kind: 'NOT_OPS_PROFILE' });
  if (!/^\$\{OPS_IMAGE:\?[^}]*\}$/.test(service.image ?? ''))
    failures.push({ kind: 'NOT_OPS_IMAGE' });
  // owner = POSTGRES_USER of the postgres container (like the `migrate` service), not an application role
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

/** template fields bound to a deployment - must always be placeholders (the real values are filled in at render time) */
export const FIXTURE_TEMPLATE_PLACEHOLDERS = Object.freeze({
  environment: '__UAT_ENVIRONMENT__',
  packVersion: '__UAT_FIXTURE_PACK_VERSION__',
  buildSha: '__UAT_BUILD_SHA__',
  tenantId: '__UAT_TENANT_ID__',
  ownerTeamId: '__UAT_OWNER_TEAM_ID__',
  makerSubjectId: '__UAT_MAKER_SUBJECT_ID__',
  reviewerSubjectId: '__UAT_REVIEWER_SUBJECT_ID__',
});
/** example fields that come from the secret store - must be `__UAT_*__` placeholders that the CLI rejects */
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
 * U1.9 (#506): the committed fixture pack template and sample provision input hold only synthetic data
 * + placeholders - no real id/email of any deployment (the real values are in the secret store and filled in at render time)
 */
export function checkFixtureTemplate(templateText, exampleText) {
  const id =
    'UAT-S17 the fixture template and provision example hold only placeholders/synthetic data';
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
    return check('UAT-S10 the proxy closes the Keycloak admin and enforces an allowlist', [
      { kind: 'MISSING' },
    ]);
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
  // outside `route {}` Caddy orders `handle` before `respond` -> the allowlist/admin closure is bypassed for /auth, /api
  if (
    !/route\s*\{[^]*?respond\s+@outside\s+403[^]*?respond\s+@keycloakAdmin\s+404[^]*?handle\s+\/auth\/\*/.test(
      caddyfile,
    )
  ) {
    failures.push({ kind: 'ORDER_NOT_ENFORCED' });
  }
  return check('UAT-S10 the proxy closes the Keycloak admin and enforces an allowlist', failures);
}

/** ADR-030: VM1 terminates TLS, VM2 is the stack, VM3 is PostgreSQL through a single relay */
export function checkThreeVmTopology({
  overlay,
  caddyfile,
  relayConfig,
  dbRolesScript,
  deployScript,
}) {
  const id = 'UAT-S20 UAT 3 VM: TLS at VM1, a single relay to PostgreSQL on VM3';
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

/**
 * #645: the browser flow of the UAT realm has a single owner, the U1 `keycloak-config` (enforces OTP for every account) -
 * the account setup of the Platform overlay must not bind `dcontact-browser` over it, otherwise the two jobs overwrite each other depending on deploy order
 */
export function checkPlatformOverlayBrowserFlow(overlay) {
  const id = 'UAT-S24 the Platform overlay does not change the browser flow of the UAT realm';
  if (overlay === null) return check(id, [{ kind: 'MISSING_ARTIFACT' }]);
  const failures = [];
  const calls = overlay
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) => line.split('&&'))
    .filter((command) => /keycloak-account-service-setup\.mjs/.test(command));
  if (calls.length === 0) failures.push({ kind: 'NO_ACCOUNT_SETUP' });
  for (const command of calls) {
    if (!/--keep-realm-browser-flow\b/.test(command)) {
      failures.push({ kind: 'REALM_BROWSER_FLOW_REBOUND', command: command.trim() });
    }
  }
  return check(id, failures);
}

/** Networks a service attaches to (both list and map forms) from the raw lines of `parseComposeServices` */
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

/** Caddyfile.3vm.line must equal Caddyfile.3vm on every line except comments and the LINE webhook block */
function caddyWithoutLineWebhook(text) {
  return text
    .replace(/\n\t\t@lineWebhook \{[^]*?respond @webhookOther 404\n/, '')
    .replace(/\t\t# #566:[^\n]*\n\t\thandle \/api\/v1\/line-pilot\/\* \{[^}]*\}\n/, '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) && line.trim() !== '')
    .join('\n');
}

/**
 * #565 / ADR-031: the `uat-line` overlay - no overlay = no LINE at all; with the overlay = opened as narrowly as possible
 * - the base file and the 3vm overlay have no `line-*` service and the overlay does not touch `api`
 * - `line-egress` is the only way out: network `lineegress` has only the relay, `linepilot` has only the relay + runner,
 *   the relay accepts only SNI `api.line.me` and has a single backend
 * - `line-webhook` = profile `uat-line` + a file-based secret, no access token, no published port, only on `internal`
 * - the webhook route is behind the edge check before the allowlist, and the rest of the Caddyfile is the same as Caddyfile.3vm
 * - deploy adds the overlay by flag and removes the container with `--remove-orphans`; the secret script does not echo and sets 0400
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
  const id = 'UAT-S21 the uat-line overlay opens LINE as narrowly as possible and can be removed';
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
    // an alias `api.line.me` on the relay network makes the relay resolve to itself (a loop) - a fixed IP must be used
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
  // secrets are not in env: the LINE_* of the overlay are only `${...}` references or a mode/path
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
  // #566: the pilot read-only must pass the allowlist first and sit before /api/* of the api
  if (
    !/respond @outside 403[^]*?handle \/api\/v1\/line-pilot\/\* \{\s*reverse_proxy line-webhook:3000\s*\}[^]*?handle \/api\/\* \{/.test(
      caddyfile,
    )
  ) {
    failures.push({ kind: 'PILOT_API_ROUTE_ORDER' });
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

/**
 * #567: the team trial overlay gives `line-webhook` send permission as narrowly as possible - token + egress through the relay only
 * - may touch only `line-webhook` and `line-egress`; publishes no port
 * - `line-webhook` is only on `internal` + `linepilot` (never on `lineegress`) and points `api.line.me` at the relay IP
 * - the runner state (recipient) is mounted read-only
 * - deploy adds the overlay when there is a trial flag and the `uat-line` flag must be present too
 */
export function checkLineTrialOverlay({ overlay, lineOverlay, deployScript }) {
  const id = 'UAT-S22 the team trial overlay lets line-webhook send only through the relay';
  if (overlay === null || lineOverlay === null) return check(id, [{ kind: 'MISSING_ARTIFACT' }]);
  const failures = [];
  const services = parseComposeServices(overlay);
  for (const service of Object.values(services)) {
    if (!['line-webhook', 'line-egress'].includes(service.name)) {
      failures.push({ kind: 'UNEXPECTED_SERVICE', name: service.name });
    }
    if (service.ports.length > 0) failures.push({ kind: 'PORT_PUBLISHED', name: service.name });
  }
  const webhook = services['line-webhook'];
  if (!webhook) return check(id, [...failures, { kind: 'MISSING_SERVICE', name: 'line-webhook' }]);
  if (webhook.environment.LINE_TEAM_TRIAL !== 'on') failures.push({ kind: 'TRIAL_FLAG' });
  const networks = composeServiceNetworks(webhook).join(',');
  if (networks !== 'internal,linepilot') failures.push({ kind: 'WEBHOOK_NETWORKS', networks });
  const relayAddress = /ipv4_address:\s*([0-9.]+)/.exec(lineOverlay)?.[1];
  if (
    !relayAddress ||
    !webhook.raw.some((line) => line.includes(`'api.line.me:${relayAddress}'`))
  ) {
    failures.push({ kind: 'WEBHOOK_NOT_PINNED_TO_RELAY' });
  }
  const raw = webhook.raw.join('\n');
  if (!/- line-pilot-state:\/var\/lib\/line-pilot:ro\b/.test(raw)) {
    failures.push({ kind: 'STATE_NOT_READ_ONLY' });
  }
  for (const [name, value] of Object.entries(webhook.environment)) {
    if (/SECRET$|TOKEN$|_KEY$/.test(name) && !/^(file|\/run\/secrets)$/.test(value)) {
      failures.push({ kind: 'SECRET_IN_ENV', variable: name });
    }
  }
  for (const pattern of [
    /line-team-trial\.enabled/,
    /is_trial\(\)[^]*?is_line "\$1" \|\| fail 'TRIAL_REQUIRES_LINE'/,
  ]) {
    if (!pattern.test(deployScript ?? '')) {
      failures.push({ kind: 'DEPLOY_NOT_TRIAL_AWARE', pattern: pattern.source });
    }
  }
  return check(id, failures);
}

/** #682: the keycloak step must keep the realm config result line - `tail -n 1` would get the branding line */
export function keycloakRecordFailures(workflow) {
  const step = workflow.split('\n').find((line) => /uat-deploy keycloak\b/.test(line)) ?? '';
  return step.includes(`grep '"type":"u1.uat.keycloak"'`) ? [] : [{ kind: 'KEYCLOAK_RECORD_LINE' }];
}

export function checkWorkflow(workflow) {
  const failures = [];
  if (workflow === null) return check('UAT-S11 workflow uat-preview', [{ kind: 'MISSING' }]);
  // the trigger looks only at the `on:` block (not the `push: true` of build-push-action)
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
  failures.push(...keycloakRecordFailures(workflow));
  if (/\bstart-dev\b/.test(workflow)) failures.push({ kind: 'START_DEV' });
  if (/migrate\s+(dev|reset)|db\s+push|--accept-data-loss|--force-reset/.test(workflow)) {
    failures.push({ kind: 'NON_ADDITIVE_MIGRATION_COMMAND' });
  }
  for (const line of workflow.split('\n')) {
    if (/\b(echo|printf|cat)\b.*\$\{\{\s*secrets\./.test(line))
      failures.push({ kind: 'SECRET_ECHO' });
  }
  for (const match of workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)) {
    // secrets are passed only through the step `env:`, never embedded directly in `run:`
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

/** the image smoke uses real services, so it accepts only manual dispatch */
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
 * U1.10 (#507): the `uat-image-smoke` workflow runs the UAT stack for real on a runner - it must have no way to touch the real UAT or secrets:
 * no `secrets.*`, no environment binding (especially `uat-preview`), read-only permissions, no push/login to an
 * external registry (it may push only to a temporary registry on the runner) and it must run `uat-deploy.sh` in the real order and then `down -v`
 */
export function checkSmokeWorkflow(workflow) {
  const id = 'UAT-S18 the uat-image-smoke workflow has no secret/environment/external push';
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
  failures.push(...keycloakRecordFailures(code));
  return check(id, failures);
}

export function checkEnvExample(text) {
  if (text === null) return check('UAT-S12 uat.env.example has names only', [{ kind: 'MISSING' }]);
  const failures = text
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line) && !/^[A-Z0-9_]+=$/.test(line))
    .map((line) => ({ kind: 'VALUE_PRESENT', name: line.split('=')[0] }));
  return check('UAT-S12 uat.env.example has names only', failures);
}

export function checkDockerignore(text) {
  const failures = [];
  if (text === null)
    return check('UAT-S13 .dockerignore guards secrets/evidence', [{ kind: 'MISSING' }]);
  const lines = text.split('\n').map((line) => line.trim());
  for (const required of ['.env', '.env.*', '**/node_modules', '**/test-results', 'artifacts']) {
    if (!lines.includes(required)) failures.push({ kind: 'NOT_IGNORED', path: required });
  }
  if (lines.some((line) => /^!\.env/.test(line))) failures.push({ kind: 'ENV_REINCLUDED' });
  return check('UAT-S13 .dockerignore guards secrets/evidence', failures);
}

/** Assemble the pattern from pieces so that this file itself does not match its own pattern */
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
        // these two scripts declare a list of dev credentials in order to reject them - not to use them
        const declaresDenylist = [UAT_FILES.keycloakScript, UAT_FILES.readinessScript].includes(
          path,
        );
        if (!declaresDenylist && line.includes(literal)) {
          failures.push({ path, line: index + 1, kind: 'DEV_CREDENTIAL_LITERAL' });
        }
      }
    });
  }
  return check('UAT-S14 negative secret scan of the UAT files', failures, {
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
    check('UAT-S00 the U1.6 artifacts are complete', missing),
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
    checkPlatformOverlayBrowserFlow(files.composePlatform3vm),
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
    checkLineTrialOverlay({
      overlay: files.composeLineTrial,
      lineOverlay: files.composeLine,
      deployScript: files.deployScript,
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

/**
 * #567 (T6): CHECK constraints that can be "replaced" - `DROP CONSTRAINT <name>` passes the guard only for names in this list, and the same file must have an
 * `ADD CONSTRAINT <original name> CHECK` (no data is lost; the existing code keeps working with the new schema)
 * a name may be added only after a reviewed decision - any other `DROP` is still rejected
 */
export const REPLACEABLE_CHECK_CONSTRAINTS = Object.freeze([
  // #567: adds the `S2_LINE_TEAM_TRIAL_V1` profile branch, with the existing S2 branch unchanged in every respect
  'dl_line_run_authorizations_values_check',
  'dl_line_run_authorizations_caps_check',
  // #520: widens the click-to-call outcome values while keeping the constraint name and every previously supported value
  'dphone_click_to_call_audit_events_values_check',
  // #520: adds agent caps, keeping the original shape and adding only the conditions of the new column
  'dl_voice_scope_gates_shape',
  // #901: adds the source_kind PLATFORM_PROVISIONING, keeping the existing BOOTSTRAP_MANIFEST/VERIFIED_ENROLLMENT
  'tenant_voice_identity_bindings_source_kind_check',
]);

/** DROPs left after deducting the allowed CHECK constraint replacements */
export function disallowedDropStatements(sql) {
  const text = String(sql);
  return findDropStatements(text).filter((statement) => {
    const name = /^DROP\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?\s*$/i.exec(statement)?.[1];
    if (!name || !REPLACEABLE_CHECK_CONSTRAINTS.includes(name)) return true;
    return !new RegExp(`\\bADD\\s+CONSTRAINT\\s+"?${name}"?\\s+CHECK\\b`, 'i').test(text);
  });
}

/** changes = [{ status: 'A'|'M'|'D'|'R...', path, sql }] of the migrations between base..HEAD */
// Phase Contract Core Settings §5 (#723/#726) allows a nullable bootstrap only for CORE_ADMIN
// Pin the whole file so a general DROP NOT NULL is not allowed; every existing PROVISIONING field is still fully enforced by a CHECK
// #710: changes the PK of the invitation intents to (tenant_id, operation_id, generation) and renames the fencing CHECK
// safe on UAT because both tables were created in the same migration batch that has never been applied (base e3f2197 has no such tables)
// and there is no INSERT before this file, so the tables are always empty at DROP time - pin the whole file, do not open a general DROP PRIMARY KEY
export const APPROVED_DROP_MIGRATIONS = Object.freeze([
  Object.freeze({
    path: 'packages/db/prisma/migrations/20261019140000_core_organization_provenance/migration.sql',
    sha256: '6bd0e2a58f1b16e82a56a5d07194f7a5f8a98918e792bd385d5236bc694ea48c',
  }),
  Object.freeze({
    path: 'packages/db/prisma/migrations/20261021100000_tenant_people_invitation_multiple_generations/migration.sql',
    sha256: '99c6732a4cd6104d8fe513c2ee34283da9da033a88675fd63073db0524c0feae',
  }),
  Object.freeze({
    path: 'packages/db/prisma/migrations/20261022130000_tenant_voice_skill_scope/migration.sql',
    sha256: '5e281f7a38bace24cf114dde5a0484a41a0e01d2b317ea95293fce41a8f825c9',
  }),
  // #868: migration #841 keeps CREATOR/OPERATOR and enforces the INTEGRATION evidence
  // pin the whole file as rehearsed on a separate database so that any other CHECK change has to go through a new review
  Object.freeze({
    path: 'packages/db/prisma/migrations/20261103130000_m3_service_principals/migration.sql',
    sha256: 'b3f3fd9105ce2898ce191db125299d45f8aaf7a9693041f93d1f08492db0b613',
  }),
]);
export function guardMigrations(changes) {
  const failures = [];
  const added = [];
  for (const change of changes) {
    if (!change.path.startsWith(`${MIGRATIONS_DIRECTORY}/`)) continue;
    if (change.status !== 'A') {
      // an applied migration must not be edited/deleted/moved - editing it = UAT and the repo no longer match
      failures.push({
        path: change.path,
        kind: 'APPLIED_MIGRATION_CHANGED',
        status: change.status,
      });
      continue;
    }
    added.push(change.path);
    if (!change.path.endsWith('.sql')) continue;
    const digest = createHash('sha256')
      .update(change.sql ?? '')
      .digest('hex');
    const approved = APPROVED_DROP_MIGRATIONS.some(
      (pin) => pin.path === change.path && pin.sha256 === digest,
    );
    const drops = approved ? [] : disallowedDropStatements(change.sql ?? '');
    if (drops.length > 0)
      failures.push({ path: change.path, kind: 'DROP_STATEMENT', statements: drops });
  }
  return check(
    'UAT-M01 a new migration is additive (no DROP except replacing a reviewed CHECK)',
    failures,
    {
      added,
    },
  );
}

function git(args, root) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function runMigrationGuard({ base, initial = false, head = 'HEAD', root = repositoryRoot }) {
  if (initial) {
    // the first deploy onto an empty database: there is no data to lose, but record in the record that there is no base
    return {
      ...report('migration-guard', [
        {
          id: 'UAT-M01 a new migration is additive (no DROP)',
          status: 'PASS',
          basis: 'INITIAL_EMPTY_DATABASE',
        },
      ]),
      base: null,
      head: git(['rev-parse', head], root).trim(),
    };
  }
  if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('--base must be a full commit SHA');
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
 * An HTTP(S) request that can reach `connectHost` (e.g. 127.0.0.1 on the VM) while still using the SNI/Host of UAT_HOST
 * does not follow redirects so the real status of a path that must be closed is visible
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
    // the error message comes from the network stack/ourselves and has no token
    return {
      id,
      status: 'FAIL',
      failures: [{ kind: 'ERROR', message: String(error?.message ?? error).slice(0, 200) }],
    };
  }
}

/** a journey flow that does not change state: current run -> validate -> compile -> simulate with the fixture of the run */
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
  expectedProfile = 'uat',
  realm = 'dcontact',
  ports = FORBIDDEN_PORTS,
  allowHttp = false,
  request = requestUrl,
  portOpen = tcpPortOpen,
} = {}) {
  if (!baseUrl) throw new Error('UAT_BASE_URL is required');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !allowHttp) throw new Error('UAT_BASE_URL must be https');
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
    await liveCheck(
      `UAT-L02 runtime-profile = ${expectedProfile} (Kafka/LINE/egress closed)`,
      async () => {
        const response = await get('/api/v1/runtime-profile');
        const body = json(response);
        const expected = {
          profile: expectedProfile,
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
      },
    ),
  );

  checks.push(
    await liveCheck(
      'UAT-L03 a route outside the allowlist = 404 ROUTE_NOT_AVAILABLE_IN_PROFILE',
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
    await liveCheck('UAT-L04 the Keycloak OIDC discovery matches the issuer', async () => {
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
    await liveCheck('UAT-L05 the Keycloak admin is not exposed externally', async () => {
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
      'UAT-L06 journey-authoring through the test account (validate/compile/simulate)',
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
    await liveCheck('UAT-L07 internal ports are closed on the host (TCP connect)', async () => {
      const host = portCheckHost ?? connectHost ?? base.hostname;
      const failures = [];
      for (const port of ports) {
        if (await portOpen(host, port)) failures.push({ port, kind: 'OPEN' });
      }
      return failures;
    }),
  );

  checks.push(
    await liveCheck(
      `UAT-L08 the Keycloak page uses the login theme ${UAT_LOGIN_THEME} (#515)`,
      async () => {
        // a client that does not exist = the realm error page, which is rendered with the realm login theme - GET with no session/state
        // the Accept of get() starts with application/json, to which Keycloak answers the error as JSON - ask for HTML directly
        const page = await request(
          `${origin}/auth/realms/${realm}/protocol/openid-connect/auth?client_id=uat-readiness-theme-probe&response_type=code&scope=openid`,
          { connectHost, headers: { accept: 'text/html' } },
        );
        if (!/class="dc-shell"/.test(page.body))
          return [{ status: page.status, kind: 'NOT_THEMED' }];
        const stylesheet = new RegExp(
          `href="(/auth/resources/[^"]+/login/${UAT_LOGIN_THEME}/css/)dcontact\\.css"`,
        ).exec(page.body)?.[1];
        if (!stylesheet) return [{ kind: 'NO_THEME_STYLESHEET' }];
        const failures = [];
        // tokens.css is generated when the image is built (not in Git) - if missing, the page has no colors
        for (const file of ['dcontact.css', 'tokens.css']) {
          const response = await get(`${stylesheet}${file}`);
          if (response.status !== 200 || !/--dc-/.test(response.body)) {
            failures.push({ file, status: response.status });
          }
        }
        return failures;
      },
    ),
  );

  return { ...report('live', checks), baseUrl: origin };
}

// ── deployment record ───────────────────────────────────────────────────────

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return null;
  // a file from SSH may have several lines - use the last JSON line
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
  reconciliation,
  environment = process.env,
  now = new Date(),
}) {
  if (action === 'reconciliation') {
    if (typeof reconciliation !== 'string')
      throw new Error('the reconciliation manifest must be specified');
    const result = spawnSync(
      'python3',
      [
        '-B',
        resolve(repositoryRoot, 'infra/uat/operator/b714-deployment-reconciliation.py'),
        '--build',
        '--manifest',
        reconciliation,
      ],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.status !== 0) throw new Error('reconciliation evidence did not pass');
    return JSON.parse(result.stdout);
  }
  if (!['deploy', 'rollback'].includes(action)) throw new Error('invalid deployment action');
  if (
    action === 'rollback' &&
    (rollbackOf?.action === 'reconciliation' || rollbackOf?.rollbackEligible === false)
  )
    throw new Error('the reconciliation record is not a rollback certification');
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
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw new Error('sourceSha is incomplete');
  for (const [name, image] of Object.entries(images ?? {})) {
    if (!/@sha256:[0-9a-f]{64}$/.test(image ?? ''))
      throw new Error(`image ${name} is not referenced by digest`);
  }
  if (smoke?.status !== 'PASS')
    throw new Error('the readiness smoke did not pass - the record is not saved');
  // #682: it must be the realm config result (not the branding/dphone line) - a silent null would leave the record unable to say that the realm changed
  if (
    action === 'deploy' &&
    (keycloak?.type !== 'u1.uat.keycloak' ||
      !/^sha256:[0-9a-f]{64}$/.test(keycloak?.realmConfigDigest ?? ''))
  ) {
    throw new Error(
      'realmConfigDigest is incomplete - keycloak must be the result of u1-uat-keycloak-users --config',
    );
  }
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
        ? { applied: false, note: 'rollback does not touch the database' }
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
        : record.action === 'reconciliation'
          ? 'observes the ledger only, no migrate'
          : 'no migrate (rollback)',
    ],
    ['backup', record.backup ? `${record.backup.status} ${record.backup.file ?? ''}`.trim() : '—'],
    ['smoke', record.smoke.status],
    ['deployed at', record.deployedAt ?? 'unknown (separate from the observation time)'],
    ...(record.action === 'reconciliation'
      ? [
          ['observed at', record.observedAt],
          ['recorded at', record.recordedAt],
          ['business trial', record.businessTrial],
          ['realm provenance', 'historical only, not the current config digest'],
        ]
      : []),
  ];
  return [
    `## UAT deployment record (${record.action})`,
    '',
    '| Item | Value |',
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
      expectedProfile: environment.UAT_EXPECTED_API_PROFILE || 'uat',
    });
  }
  if (argv.includes('--migration-guard') && !argv.includes('--migration-guard-report')) {
    return runMigrationGuard({ base: option(argv, '--base'), initial: argv.includes('--initial') });
  }
  if (argv.includes('--deployment-record')) {
    const action = option(argv, '--action');
    if (!['deploy', 'rollback', 'reconciliation'].includes(action))
      throw new Error('--action deploy|rollback|reconciliation');
    return buildDeploymentRecord({
      action,
      reconciliation: option(argv, '--reconciliation-manifest'),
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
