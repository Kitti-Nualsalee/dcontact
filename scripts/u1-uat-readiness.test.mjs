import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  UAT_FILES,
  buildDeploymentRecord,
  checkApiEnvironment,
  checkComposeCredentials,
  checkComposeImages,
  checkComposePorts,
  checkComposeServices,
  checkDockerfilePins,
  checkDockerignore,
  checkEvidenceStorage,
  checkEnvExample,
  checkFixtureTemplate,
  checkKeycloakProductionMode,
  checkKeycloakTheme,
  checkLineOverlay,
  checkLineTrialOverlay,
  checkNoStartDev,
  checkProxy,
  checkRealm,
  checkSmokeWorkflow,
  checkThreeVmTopology,
  checkUatProvision,
  checkWorkflow,
  findDropStatements,
  guardMigrations,
  parseComposeServices,
  renderSummary,
  runLiveSmoke,
  runMigrationGuard,
  runStaticChecks,
  scanSecrets,
  tcpPortOpen,
} from './u1-uat-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(repositoryRoot, path), 'utf8');
const compose = read(UAT_FILES.compose);
const caddyfile = read(UAT_FILES.caddyfile);
const realm = read(UAT_FILES.realm);
const workflow = read(UAT_FILES.workflow);
const smokeWorkflow = read(UAT_FILES.smokeWorkflow);
const apiDockerfile = read(UAT_FILES.apiDockerfile);
const consoleDockerfile = read(UAT_FILES.consoleDockerfile);
const keycloakDockerfile = read(UAT_FILES.keycloakDockerfile);
const storageEntrypoint = read(UAT_FILES.objectStorageEntrypoint);
const deployScript = read(UAT_FILES.deployScript);
const compose3vm = read(UAT_FILES.compose3vm);
const caddyfile3vm = read(UAT_FILES.caddyfile3vm);
const dbRelayConfig = read(UAT_FILES.dbRelayConfig);
const dbRoles3vmScript = read(UAT_FILES.dbRoles3vmScript);
const composeLine = read(UAT_FILES.composeLine);
const caddyfileLine = read(UAT_FILES.caddyfileLine);
const lineEgressConfig = read(UAT_FILES.lineEgressConfig);
const lineSecretsScript = read(UAT_FILES.lineSecretsScript);
const composeLineTrial = read(UAT_FILES.composeLineTrial);

/** แทรก block ใต้ `services:` ของ compose จริง */
function withService(block) {
  return compose.replace(/^services:\n/m, `services:\n${block}\n`);
}

function failed(result, kind) {
  assert.equal(result.status, 'FAIL', JSON.stringify(result));
  if (kind) {
    assert.ok(
      result.failures.some((failure) => failure.kind === kind),
      `expected ${kind}: ${JSON.stringify(result.failures)}`,
    );
  }
}

// ── static: artifact จริงของ repo ───────────────────────────────────────────

test('static readiness ผ่านบน artifact จริงของ repo', () => {
  const result = runStaticChecks();
  const failures = result.checks.filter((entry) => entry.status !== 'PASS');
  assert.deepEqual(failures, []);
  assert.equal(result.status, 'PASS');
});

test('parser ของ compose อ่าน service/ports/env ของ UAT ได้ครบ', () => {
  const services = parseComposeServices(compose);
  assert.deepEqual(Object.keys(services).sort(), [
    'api',
    'db-roles',
    'keycloak',
    'keycloak-config',
    'migrate',
    'object-storage',
    'object-storage-init',
    'object-storage-lifecycle',
    'object-storage-migrated-expiry',
    'postgres',
    'proxy',
    'tenant-ui-flag',
    'uat-provision',
  ]);
  assert.deepEqual(services.proxy.ports, ['443:8443', '80:8080']);
  assert.equal(services.api.environment.DCONTACT_API_PROFILE, 'uat');
  assert.deepEqual(services.keycloak.command, ['start', '--features=organization']);
});

// ── static: fixture ที่ผิด ─────────────────────────────────────────────────

test('UAT-S01: worker/FreeSWITCH/Kafka/Redis ใน compose ไม่ผ่าน', () => {
  assert.equal(checkComposeServices(compose).status, 'PASS');
  for (const [block, kind] of [
    ['  redis:\n    image: redis@sha256:' + 'a'.repeat(64), 'REDIS'],
    ['  redpanda:\n    image: redpandadata/redpanda@sha256:' + 'a'.repeat(64), 'KAFKA'],
    ['  freeswitch:\n    image: safarov/freeswitch@sha256:' + 'a'.repeat(64), 'FREESWITCH'],
    ['  journey-worker:\n    image: ${JOURNEY_IMAGE:?x}', 'JOURNEY_WORKER'],
  ]) {
    failed(checkComposeServices(withService(block)), kind);
  }
  // comment ที่กล่าวถึง FreeSWITCH ไม่นับ แต่ env จริงนับ
  failed(
    checkComposeServices(
      compose.replace(
        '      NODE_ENV: production\n',
        '      NODE_ENV: production\n      REDIS_URL: redis://x\n',
      ),
    ),
    'FORBIDDEN_REFERENCE',
  );
});

test('UAT-S02: service อื่นที่เปิดพอร์ตหรือพอร์ตแปลกของ proxy ไม่ผ่าน', () => {
  assert.equal(checkComposePorts(compose).status, 'PASS');
  failed(
    checkComposePorts(
      compose.replace(
        '    command: postgres -c max_connections=100\n',
        "    command: postgres -c max_connections=100\n    ports:\n      - '5432:5432'\n",
      ),
    ),
    'PUBLISHES_PORT',
  );
  failed(
    checkComposePorts(compose.replace("      - '80:8080'", "      - '8080:8080'")),
    'UNEXPECTED_PORT',
  );
  failed(checkComposePorts(compose.replace("      - '443:8443'\n", '')), 'HTTPS_NOT_PUBLISHED');
});

test('UAT-S03/S04: start-dev หรือ Keycloak ที่ไม่ได้อยู่หลัง proxy ไม่ผ่าน', () => {
  assert.equal(checkKeycloakProductionMode(compose).status, 'PASS');
  const dev = compose.replace('      - start\n', '      - start-dev\n');
  failed(checkNoStartDev({ compose: dev }), 'START_DEV');
  failed(checkKeycloakProductionMode(dev), 'NOT_START');
  failed(
    checkKeycloakProductionMode(
      compose.replace("KC_HTTP_ENABLED: 'true'", "KC_HTTP_ENABLED: 'false'"),
    ),
    'KC_HTTP_ENABLED',
  );
  failed(
    checkKeycloakProductionMode(compose.replace('KC_HOSTNAME: https://', 'KC_HOSTNAME: http://')),
    'KC_HOSTNAME_NOT_HTTPS',
  );
});

test('UAT-S05: credential literal, default value หรือ secret ที่ไม่ใช่ :? ไม่ผ่าน', () => {
  assert.equal(checkComposeCredentials(compose).status, 'PASS');
  failed(
    checkComposeCredentials(
      compose.replace(/POSTGRES_PASSWORD: \$\{[^}]+\}/, 'POSTGRES_PASSWORD: s3cretvalue'),
    ),
    'LITERAL_CREDENTIAL',
  );
  failed(
    checkComposeCredentials(
      compose.replace(
        /POSTGRES_PASSWORD: \$\{[^}]+\}/,
        'POSTGRES_PASSWORD: ${UAT_POSTGRES_PASSWORD:-dcontact}',
      ),
    ),
    'DEFAULT_VALUE',
  );
  failed(
    checkComposeCredentials(
      compose.replace(
        /POSTGRES_PASSWORD: \$\{[^}]+\}/,
        'POSTGRES_PASSWORD: ${UAT_POSTGRES_PASSWORD}',
      ),
    ),
    'NOT_REQUIRED_FORM',
  );
  failed(
    checkComposeCredentials(
      compose.replace(
        /DATABASE_URL: postgresql:\/\/dcontact_app:\$\{[^}]+\}@/,
        'DATABASE_URL: postgresql://dcontact_app:dcontact_app@',
      ),
    ),
    'LITERAL_PASSWORD_IN_URL',
  );
});

test('UAT-S06: image ที่ไม่ pin digest หรือ build บน VM ไม่ผ่าน', () => {
  assert.equal(checkComposeImages(compose).status, 'PASS');
  failed(
    checkComposeImages(
      compose.replace(
        /image: docker\.io\/library\/postgres:16-alpine@sha256:[0-9a-f]+/,
        'image: postgres:16-alpine',
      ),
    ),
    'NOT_DIGEST_PINNED',
  );
  failed(
    checkComposeImages(compose.replace(/image: \$\{API_IMAGE:\?[^}]*\}/, 'image: ${API_IMAGE}')),
    'NOT_DIGEST_PINNED',
  );
  failed(checkComposeImages(withService('  extra:\n    build: .')), 'BUILD_ON_VM');
});

test('UAT-S19: realm ใช้ theme dcontact ต้องรัน Keycloak จาก image ที่มี theme (#515/#522)', () => {
  assert.equal(checkKeycloakTheme(compose, realm, keycloakDockerfile).status, 'PASS');
  failed(
    checkKeycloakTheme(
      compose.replace(
        /image: \$\{KEYCLOAK_IMAGE:\?[^}]*\}/,
        `image: docker.io/keycloak/keycloak:26.7.5@sha256:${'a'.repeat(64)}`,
      ),
      realm,
      keycloakDockerfile,
    ),
    'KEYCLOAK_IMAGE_NOT_OURS',
  );
  failed(
    checkKeycloakTheme(
      compose,
      realm.replace('"loginTheme": "dcontact"', '"loginTheme": "keycloak"'),
      keycloakDockerfile,
    ),
    'REALM_THEME',
  );
  failed(
    checkKeycloakTheme(compose, realm, keycloakDockerfile.replace(/^COPY --from=theme .*$/m, '')),
    'THEMES_NOT_COPIED',
  );
  failed(checkKeycloakTheme(compose, realm, null), 'NO_KEYCLOAK_DOCKERFILE');
});

test('UAT-S07: FROM ที่ไม่ pin digest, :latest, root หรือไม่มี revision label ไม่ผ่าน', () => {
  const pins = (text) => checkDockerfilePins({ Dockerfile: text });
  assert.equal(pins(apiDockerfile).status, 'PASS');
  assert.equal(pins(consoleDockerfile).status, 'PASS');
  assert.equal(pins(keycloakDockerfile).status, 'PASS');
  failed(
    pins(
      keycloakDockerfile.replace(/^ARG KEYCLOAK_IMAGE=.*$/m, 'ARG KEYCLOAK_IMAGE=keycloak:26.7.5'),
    ),
    'UNPINNED_FROM',
  );
  failed(
    pins(apiDockerfile.replace(/^ARG NODE_IMAGE=.*$/m, 'ARG NODE_IMAGE=node:20-bookworm-slim')),
    'UNPINNED_FROM',
  );
  failed(
    pins(consoleDockerfile.replace(/^FROM \$\{CADDY_IMAGE\}/m, 'FROM caddy:latest')),
    'UNPINNED_FROM',
  );
  failed(
    pins(
      `FROM node:latest@sha256:${'a'.repeat(64)}\nUSER 1000\nLABEL org.opencontainers.image.revision=$SOURCE_SHA`,
    ),
    'UNPINNED_FROM',
  );
  failed(pins(apiDockerfile.replace(/^USER .*$/gm, 'USER root')), 'NO_NON_ROOT_USER');
  failed(
    pins(apiDockerfile.replace(/org\.opencontainers\.image\.revision=\$SOURCE_SHA/g, 'x=y')),
    'NO_REVISION_LABEL',
  );
  failed(checkDockerfilePins({ missing: null }), 'MISSING');
});

test('UAT-S08: realm ที่มี user, secret, OTP ไม่บังคับ หรือ redirect wildcard ไม่ผ่าน', () => {
  assert.equal(checkRealm(realm).status, 'PASS');
  const mutate = (change) => {
    const value = JSON.parse(realm);
    change(value);
    return checkRealm(JSON.stringify(value));
  };
  failed(
    mutate((r) => (r.users = [{ username: 'maker' }])),
    'USERS_PRESENT',
  );
  failed(
    mutate((r) => r.clients.push({ clientId: 'x', publicClient: false, secret: 'x' })),
    'SECRET_FIELD',
  );
  failed(
    mutate((r) => {
      const forms = r.authenticationFlows.find((flow) => !flow.topLevel);
      forms.authenticationExecutions.find((e) => e.authenticator === 'auth-otp-form').requirement =
        'CONDITIONAL';
    }),
    'OTP_NOT_REQUIRED_IN_BROWSER_FLOW',
  );
  failed(
    mutate((r) => (r.requiredActions[0].defaultAction = false)),
    'CONFIGURE_TOTP_NOT_DEFAULT',
  );
  failed(
    mutate(
      (r) =>
        (r.clients.find((c) => c.clientId === 'dcontact-uat-console').redirectUris = [
          'https://x/*',
        ]),
    ),
    'NON_EXACT_REDIRECT',
  );
  failed(
    mutate(
      (r) =>
        (r.clients.find((c) => c.clientId === 'dcontact-uat-console').directAccessGrantsEnabled =
          true),
    ),
    'PASSWORD_GRANT',
  );
  failed(
    mutate((r) => (r.organizations = [])),
    'NO_TENANT_ORGANIZATION',
  );
  failed(
    mutate((r) => (r.sslRequired = 'none')),
    'SSL_NOT_REQUIRED',
  );
  failed(checkRealm('{not json'), 'INVALID_JSON');
});

test('UAT-S09: env ของ api ที่ขัดกับ profile uat ไม่ผ่าน', () => {
  assert.equal(checkApiEnvironment(compose).status, 'PASS');
  for (const name of ['LINE_CHANNEL_SECRET', 'KAFKA_BROKERS', 'SIP_BROWSER_NODES_JSON']) {
    failed(
      checkApiEnvironment(
        compose.replace(
          '      DCONTACT_API_PROFILE: uat\n',
          `      DCONTACT_API_PROFILE: uat\n      ${name}: \${X:?x}\n`,
        ),
      ),
      'CONFLICTS_WITH_UAT_PROFILE',
    );
  }
  failed(
    checkApiEnvironment(
      compose.replace('DCONTACT_API_PROFILE: uat', 'DCONTACT_API_PROFILE: default'),
    ),
    'PROFILE_NOT_UAT',
  );
});

test('UAT-S15: api ใช้ user เฉพาะของ object storage แบบ :? ต่อ network ภายใน และ bucket ไม่มี anonymous policy', () => {
  const ok = (text = compose, script = storageEntrypoint) => checkEvidenceStorage(text, script);
  assert.equal(ok().status, 'PASS');
  const apiKey = /S3_ACCESS_KEY: \$\{UAT_S3_API_ACCESS_KEY:\?[^}]*\}/;
  // root credential ของ object storage ห้ามใช้ใน api
  failed(
    ok(compose.replace(apiKey, 'S3_ACCESS_KEY: ${UAT_S3_ROOT_ACCESS_KEY:?required}')),
    'API_USES_ROOT_CREDENTIAL',
  );
  failed(ok(compose.replace(apiKey, 'S3_ACCESS_KEY: evidence-api')), 'NOT_REQUIRED_FORM');
  failed(
    ok(compose.replace(/S3_SECRET_KEY: \$\{[^}]+\}/, 'S3_SECRET_KEY: ${UAT_S3_API_SECRET_KEY:-x}')),
    'NOT_REQUIRED_FORM',
  );
  failed(ok(compose.replace(/\n {6}S3_ENDPOINT: [^\n]+/, '')), 'S3_ENDPOINT_NOT_INTERNAL');
  failed(
    ok(
      compose.replace(
        'S3_ENDPOINT: http://object-storage:8333\n      S3_ACCESS_KEY',
        'S3_ENDPOINT: https://s3.amazonaws.com\n      S3_ACCESS_KEY',
      ),
    ),
    'S3_ENDPOINT_NOT_INTERNAL',
  );
  failed(
    ok(
      compose.replace(
        '      object-storage-init:\n        condition: service_completed_successfully\n    # U1.2',
        '    # U1.2',
      ),
    ),
    'API_DOES_NOT_WAIT_FOR_OBJECT_STORAGE_INIT',
  );
  failed(
    ok(
      compose.replace(
        '    read_only: true\n    networks:\n      - internal\n\n  keycloak:',
        '    read_only: true\n    networks:\n      - edge\n\n  keycloak:',
      ),
    ),
    'NOT_ON_INTERNAL_NETWORK',
  );
  failed(
    ok(
      compose.replace(
        "    entrypoint: ['/bin/sh', '/uat/object-storage-entrypoint.sh']\n",
        "    entrypoint: ['/bin/sh', '/uat/object-storage-entrypoint.sh']\n    ports:\n      - '8333:8333'\n",
      ),
    ),
    'OBJECT_STORAGE_PUBLISHES_PORT',
  );
  failed(
    ok(compose.replace("'/uat/object-storage-entrypoint.sh']", "'/entrypoint.sh', 'mini']")),
    'OBJECT_STORAGE_ENTRYPOINT',
  );
  failed(
    ok(compose.replace('s3.lifecycle.run-shard -shards 0-15', 'fs.ls')),
    'NO_LIFECYCLE_RUNNER',
  );
  failed(
    ok(
      compose.replace(
        "    command: ['node', 'scripts/uat-object-storage.mjs', 'init']\n",
        "    command: ['node', 'scripts/uat-object-storage.mjs', 'init']\n    profiles: ['ops']\n",
      ),
    ),
    'OBJECT_STORAGE_INIT_IN_PROFILE',
  );
  failed(ok(compose, null), 'OBJECT_STORAGE_ENTRYPOINT_MISSING');
  failed(
    ok(
      compose,
      storageEntrypoint.replace(
        'exec /usr/bin/weed -logtostderr=true server',
        'exec /usr/bin/weed mini',
      ),
    ),
    'OBJECT_STORAGE_MINI_MODE',
  );
  failed(
    ok(
      compose,
      storageEntrypoint.replace(
        '  "identities": [\n',
        '  "identities": [\n    { "name": "anonymous", "actions": ["Read"] },\n',
      ),
    ),
    'ANONYMOUS_IDENTITY',
  );
  failed(
    ok(
      compose,
      storageEntrypoint.replace(
        '"policyNames": ["uat-evidence-api"]',
        '"actions": ["Admin:uat-evidence"]',
      ),
    ),
    'POLICY_NOT_ATTACHED',
  );
  failed(
    ok(
      compose,
      storageEntrypoint.replace(
        '"policyNames": ["uat-evidence-api"]',
        '"policyNames": ["uat-evidence-api"],\n      "actions": ["Read"]',
      ),
    ),
    'API_COARSE_ACTIONS',
  );
  failed(
    ok(
      compose,
      storageEntrypoint.replace(
        'arn:aws:s3:::${bucket}/uat-evidence/*',
        'arn:aws:s3:::${bucket}/*',
      ),
    ),
    'POLICY_NOT_BUCKET_SCOPED',
  );
  failed(ok(compose, storageEntrypoint.replace('s3:DeleteObject', 's3:*')), 'POLICY_TOO_BROAD');
  failed(ok(compose, storageEntrypoint.replace(/API_USES_ROOT_CREDENTIAL/g, 'X')), 'NO_ROOT_GUARD');
  failed(
    ok(compose, storageEntrypoint.replace(/INVALID_CREDENTIAL_CHARSET/g, 'X')),
    'NO_CREDENTIAL_CHARSET_GUARD',
  );
  failed(
    ok(
      compose.replace(
        "    command: ['node', 'scripts/uat-object-storage.mjs', 'init']\n",
        "    command: ['node', 'scripts/uat-object-storage.mjs', 'init', 'PutBucketPolicy']\n",
      ),
    ),
    'ANONYMOUS_POLICY',
  );
  failed(
    ok(
      compose.replace(
        /\n {2}object-storage-lifecycle:\n/,
        '\n  object-storage-lifecycle-renamed:\n',
      ),
    ),
    'MISSING_SERVICE',
  );
});

test('UAT-S16: provision เป็น one-shot ของ ops, owner connection, CLI อยู่ใน ops image และ input ทาง stdin', () => {
  assert.equal(checkUatProvision(compose, apiDockerfile, deployScript).status, 'PASS');
  const service = parseComposeServices(compose)['uat-provision'];
  assert.deepEqual(service.profiles, ['ops']);
  assert.deepEqual(service.command, ['--check', '--input', '-']);
  const ownerUrl =
    /DATABASE_URL: postgresql:\/\/\$\{UAT_POSTGRES_USER[^\n]*@postgres:5432\/dcontact\?schema=public\n(?=      UAT_TENANT_ID)/;
  assert.match(compose, ownerUrl);
  // connection ของ application (dcontact_app) = ห้าม
  failed(
    checkUatProvision(
      compose.replace(
        ownerUrl,
        'DATABASE_URL: postgresql://dcontact_app:${UAT_APP_DB_PASSWORD:?required}@postgres:5432/dcontact\n',
      ),
      apiDockerfile,
      deployScript,
    ),
    'NOT_OWNER_CONNECTION',
  );
  failed(
    checkUatProvision(
      compose.replace(
        ownerUrl,
        'DATABASE_URL: postgresql://dcontact_app:${UAT_APP_DB_PASSWORD:?required}@postgres:5432/dcontact\n',
      ),
      apiDockerfile,
      deployScript,
    ),
    'APPLICATION_ROLE',
  );
  failed(
    checkUatProvision(
      compose.replace('  uat-provision:\n', '  uat-provisioning:\n'),
      apiDockerfile,
      deployScript,
    ),
    'MISSING_SERVICE',
  );
  failed(
    checkUatProvision(
      compose.replace(/( {2}uat-provision:\n) {4}profiles: \['ops'\]\n/, '$1'),
      apiDockerfile,
      deployScript,
    ),
    'NOT_OPS_PROFILE',
  );
  failed(
    checkUatProvision(
      compose,
      // ลบเฉพาะใน ops stage — COPY เดียวกันของ runtime stage ต้องไม่ทำให้ผ่าน
      apiDockerfile.replace(/(AS ops\b[^]*?)COPY --from=build \/out\/api \/app\n/, '$1'),
      deployScript,
    ),
    'OPS_IMAGE_WITHOUT_CLI',
  );
  failed(
    checkUatProvision(
      compose,
      apiDockerfile,
      deployScript.replace('--input - <"$file"', '--input "$file"'),
    ),
    'DEPLOY_NOT_VIA_STDIN',
  );
  failed(
    checkUatProvision(
      compose,
      apiDockerfile,
      deployScript.replace(/PROVISION_INPUT_PERMISSIONS/g, 'X'),
    ),
    'INPUT_PERMISSIONS',
  );
});

test('E1.16: UAT เปิด/ปิด dphone embed ผ่าน audited platform-control CLI', () => {
  const service = parseComposeServices(compose)['tenant-ui-flag'];
  assert.deepEqual(service.profiles, ['ops']);
  assert.match(compose, /entrypoint: \['node', '\/platform-control\/dist\/ui-flag-main\.js'\]/);
  assert.match(service.environment.PLATFORM_DATABASE_URL, /\$\{UAT_POSTGRES_USER/);
  assert.match(apiDockerfile, /COPY --from=build \/out\/platform-control \/platform-control/);
  assert.match(deployScript, /ui-flag\)/);
  assert.match(deployScript, /--flag dphone\.embed\.enabled/);
  assert.match(deployScript, /on\)[\s\S]*--on --ack-voice-pilot/);
  assert.match(deployScript, /off\)[\s\S]*mode=\(--off\)/);
  assert.match(
    compose3vm,
    /tenant-ui-flag:[\s\S]*PLATFORM_DATABASE_URL:.*@db-relay:5432\/dcontact_uat/,
  );
});

test('E1.16: UAT image มี embed assets, host อ้างอิง และ route ของ dphone ครบ', () => {
  assert.match(consoleDockerfile, /pnpm --filter @d-contact\/workspace build/);
  assert.match(
    consoleDockerfile,
    /COPY --from=build \/repo\/apps\/workspace\/dist\/embed \/srv\/workspace\/embed/,
  );
  assert.match(
    consoleDockerfile,
    /COPY examples\/dphone-host\/index\.html \/srv\/examples\/dphone-host\/index\.html/,
  );
  for (const config of [caddyfile, caddyfile3vm]) {
    assert.match(config, /handle \/dphone\/\* \{\s+header -X-Frame-Options/);
    assert.match(config, /handle \/embed\/\*/);
    assert.match(config, /handle_path \/workspace\/\*/);
    assert.match(config, /handle_path \/examples\/\*/);
  }
  assert.match(
    compose,
    /DPHONE_EMBED_SCRIPT_URL: https:\/\/\$\{UAT_HOST:[^}]+\}\/workspace\/embed\/dphone-embed\.js/,
  );
  const e1Overlay = readFileSync('infra/uat/docker-compose.uat.e1.yml', 'utf8');
  const caddyE1 = readFileSync('infra/uat/Caddyfile.3vm.e1', 'utf8');
  assert.match(e1Overlay, /command: \['node', 'dist\/e1-uat-main\.js'\]/);
  assert.match(e1Overlay, /DCONTACT_API_PROFILE: uat-e1/);
  assert.match(
    e1Overlay,
    /FREESWITCH_DIRECTORY_PASSWORD: \$\{UAT_E1_FREESWITCH_DIRECTORY_PASSWORD:/,
  );
  assert.match(e1Overlay, /SIP_BROWSER_NODES_JSON:/);
  assert.match(e1Overlay, /wss:\/\/\$\{UAT_HOST:[^}]+\}\/sip-ws/);
  assert.match(e1Overlay, /FREESWITCH_ESL_PASSWORD: \$\{UAT_E1_FREESWITCH_ESL_PASSWORD:/);
  const e1Services = parseComposeServices(e1Overlay);
  assert.equal(
    e1Services.freeswitch.image,
    'docker.io/safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6',
  );
  assert.deepEqual(e1Services.freeswitch.ports, ['192.168.102.112:16384-16420:16384-16420/udp']);
  assert.match(e1Services.freeswitch.raw.join('\n'), /\.\/e1-freeswitch:\/e1-freeswitch:ro/);
  assert.match(e1Services.freeswitch.raw.join('\n'), /cap_add:\s+- SYS_NICE/);
  assert.match(
    e1Services.freeswitch.raw.join('\n'),
    /E1_DIRECTORY_PASSWORD: \$\{UAT_E1_FREESWITCH_DIRECTORY_PASSWORD:/,
  );
  assert.match(
    e1Services.freeswitch.raw.join('\n'),
    /E1_ESL_PASSWORD: \$\{UAT_E1_FREESWITCH_ESL_PASSWORD:/,
  );
  assert.match(e1Services.freeswitch.raw.join('\n'), /\/var\/lib\/freeswitch:mode=0777/);
  assert.match(e1Services.freeswitch.raw.join('\n'), /fs_cli -p "\$\$E1_ESL_PASSWORD" -x status/);
  const e1Entrypoint = read('infra/uat/e1-freeswitch/entrypoint.sh');
  const e1SofiaProfile = read('infra/uat/e1-freeswitch/conf/sip_profiles/internal.xml');
  assert.match(e1Entrypoint, /E1_DIRECTORY_PASSWORD/);
  assert.match(e1Entrypoint, /E1_ESL_PASSWORD/);
  assert.match(e1Entrypoint, /exec \/docker-entrypoint\.sh/);
  assert.doesNotMatch(e1Entrypoint, /ClueCon|dcontact-xml-curl-dev-only/);
  assert.match(e1SofiaProfile, /force-register-domain" value="\$\$\{domain\}"/);
  assert.match(e1SofiaProfile, /force-subscription-domain" value="\$\$\{domain\}"/);
  assert.match(e1SofiaProfile, /force-register-db-domain" value="\$\$\{domain\}"/);
  assert.match(e1Overlay, /\.\/Caddyfile\.3vm\.e1:\/etc\/caddy\/Caddyfile:ro/);
  assert.match(
    caddyE1,
    /handle \/sip-ws \{\s+reverse_proxy freeswitch:5066 \{\s+# SIP response ต้องส่งทันที ไม่รวม buffer ระหว่าง WebSocket tunnel\s+flush_interval -1/,
  );
  assert.doesNotMatch(caddyfile3vm, /\/sip-ws/);
  assert.match(apiDockerfile, /test -f \/out\/api\/dist\/e1-uat-main\.js/);
  assert.match(
    apiDockerfile,
    /COPY scripts\/u1-uat-keycloak-users\.mjs scripts\/keycloak-dphone-embedded-setup\.mjs/,
  );
  const keycloakConfig = parseComposeServices(compose)['keycloak-config'];
  assert.equal(keycloakConfig.environment.DPHONE_EMBED_TEMPLATE_CLIENT, 'dcontact-uat-console');
  assert.match(keycloakConfig.environment.DPHONE_EMBED_ORIGIN, /https:\/\/\$\{UAT_HOST:/);
  assert.match(
    keycloakConfig.raw.join('\n'),
    /u1-uat-keycloak-users\.mjs --config && node scripts\/keycloak-dphone-embedded-setup\.mjs/,
  );
  assert.match(deployScript, /e1-enable\)/);
  assert.match(deployScript, /e1-disable\)/);
  assert.match(deployScript, /E1_ACCEPTANCE_OVERLAY_MISSING/);
  assert.match(deployScript, /E1_ENABLE_FAILED/);
  assert.match(deployScript, /freeswitch e1-sandbox/);
  assert.match(deployScript, /rm -sf e1-sandbox freeswitch/);
  assert.match(deployScript, /sandbox.*absent/);
  assert.match(workflow, /infra\/uat\/Caddyfile\.3vm\.e1/);
  const wizard = readFileSync('scripts/e1-16-uat-acceptance-wizard.sh', 'utf8');
  assert.match(wizard, /e1-enable '\$MAIN_SHA'/);
  assert.match(wizard, /e1-disable '\$MAIN_SHA'/);
  assert.ok(wizard.indexOf('e1-enable') < wizard.indexOf('ui-flag'));
  assert.ok(wizard.indexOf('ui-flag') < wizard.indexOf('e1-disable'));
});

test('UAT-S22: owner สำหรับ migrate/backup อ่าน FORCE RLS ได้โดยไม่ยกสิทธิ์ให้ API', () => {
  const bootstrap = read('infra/uat/operator/vm3-bootstrap-uat.sh');
  const repair = read('infra/uat/operator/vm3-uat-backup-role.sh');
  assert.match(bootstrap, /CREATE ROLE dcontact_uat_owner LOGIN INHERIT BYPASSRLS NOSUPERUSER/);
  assert.match(bootstrap, /CREATE ROLE dcontact_app LOGIN INHERIT NOBYPASSRLS NOSUPERUSER/);
  assert.match(repair, /ALTER ROLE dcontact_uat_owner BYPASSRLS;/);
  assert.match(repair, /role dcontact_app ต้องเป็น LOGIN INHERIT NOBYPASSRLS/);
  assert.doesNotMatch(repair, /(?:PASSWORD\s*=|UAT_[A-Z_]*PASSWORD)/);
});

test('UAT-S23: VM1 ส่ง SIP WebSocket ผ่าน Caddy แบบไม่ buffer และไม่พึ่ง FreeSWITCH override ชั่วคราว', () => {
  const vm1Bootstrap = read('infra/uat/operator/vm1-nginx-uat.sh');
  const vm1Migration = read('infra/uat/operator/vm1-nginx-websocket-uat.sh');
  assert.match(vm1Bootstrap, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(vm1Bootstrap, /proxy_set_header Connection "upgrade";/);
  assert.match(vm1Migration, /proxy_pass https:\/\/192\\\.168\\\.102\\\.112:5067/);
  assert.match(vm1Migration, /proxy_connect_timeout 5s/);
  assert.match(vm1Migration, /location = \/sip-ws \{/);
  assert.match(vm1Migration, /proxy_pass http:\/\/192\.168\.102\.112:8080/);
  assert.match(vm1Migration, /proxy_buffering off/);
  assert.match(vm1Migration, /proxy_request_buffering off/);
  assert.match(vm1Migration, /proxy_read_timeout 3600s/);
  assert.match(vm1Migration, /proxy_send_timeout 3600s/);
  assert.match(vm1Migration, /manual_sip_ws\.subn\('', source\)/);
  assert.match(vm1Migration, /Caddy ใน release/);
  assert.match(vm1Migration, /nginx -t/);
  assert.match(vm1Migration, /cp --preserve=mode,ownership/);
  assert.ok(
    vm1Migration.indexOf('if cmp -s "$expected" "$config"; then') <
      vm1Migration.indexOf('python3 - "$config" "$candidate"'),
    'state ใหม่ต้องผ่าน idempotency check ก่อนสร้าง candidate ของ migration',
  );
});

test('UAT-S10: proxy ที่เปิด admin ของ Keycloak หรือไม่มี allowlist ไม่ผ่าน', () => {
  assert.equal(checkProxy(caddyfile).status, 'PASS');
  failed(checkProxy(caddyfile.replace(' /auth/admin/*', '')), 'ADMIN_PATH_OPEN');
  failed(checkProxy(caddyfile.replace('respond @outside 403', '')), 'NO_ALLOWLIST');
  failed(checkProxy(caddyfile.replace('admin off', 'admin :2019')), 'CADDY_ADMIN_ON');
  // respond นอก route = Caddy เรียง handle มาก่อน (พบจริงตอนทดสอบกับ Caddy 2.8.4)
  failed(checkProxy(caddyfile.replace('\troute {', '\t{')), 'ORDER_NOT_ENFORCED');
});

test('UAT-S20: overlay 3 VM บังคับ relay, edge และ database แยก', () => {
  const input = {
    overlay: compose3vm,
    caddyfile: caddyfile3vm,
    relayConfig: dbRelayConfig,
    dbRolesScript: dbRoles3vmScript,
    deployScript,
  };
  assert.equal(checkThreeVmTopology(input).status, 'PASS');
  failed(
    checkThreeVmTopology({
      ...input,
      relayConfig: dbRelayConfig.replace('192.168.102.113', '192.168.102.114'),
    }),
    'RELAY_TARGET',
  );
  failed(
    checkThreeVmTopology({ ...input, caddyfile: caddyfile3vm.replace('respond @notEdge 403', '') }),
    'CADDY_EDGE_INVARIANT',
  );
});

test('UAT-S21: overlay uat-line ที่เปิดกว้างเกิน รั่วออกนอก overlay หรือถอดไม่ได้ ไม่ผ่าน', () => {
  const input = {
    compose,
    compose3vm,
    overlay: composeLine,
    caddyfile3vm,
    caddyfile: caddyfileLine,
    egressConfig: lineEgressConfig,
    deployScript,
    secretsScript: lineSecretsScript,
  };
  assert.equal(checkLineOverlay(input).status, 'PASS');
  failed(checkLineOverlay({ ...input, overlay: null }), 'MISSING_ARTIFACT');
  // service line-* ในไฟล์ฐาน = LINE เปิดแม้ไม่มี flag
  failed(
    checkLineOverlay({
      ...input,
      compose: compose.replace('\n  api:\n', '\n  line-webhook:\n    image: x\n  api:\n'),
    }),
    'LINE_SERVICE_OUTSIDE_OVERLAY',
  );
  // overlay แตะ api
  failed(
    checkLineOverlay({
      ...input,
      overlay: composeLine.replace(
        '\n  line-webhook:\n',
        '\n  api:\n    mem_limit: 1g\n\n  line-webhook:\n',
      ),
    }),
    'UNEXPECTED_SERVICE',
  );
  // service อื่นต่อ network ขาออก
  failed(
    checkLineOverlay({
      ...input,
      overlay: composeLine.replace(
        '    networks:\n      - internal\n\n  line-pilot:',
        '    networks:\n      - internal\n      - lineegress\n\n  line-pilot:',
      ),
    }),
    'EGRESS_NETWORK_SHARED',
  );
  // relay ที่ไม่กรอง SNI หรือมีปลายทางอื่น
  failed(
    checkLineOverlay({
      ...input,
      egressConfig: lineEgressConfig.replace(/.*req\.ssl_sni.*\n/, ''),
    }),
    'EGRESS_SNI_NOT_ENFORCED',
  );
  failed(
    checkLineOverlay({
      ...input,
      egressConfig: `${lineEgressConfig}    server other example.com:443\n`,
    }),
    'EGRESS_BACKEND',
  );
  // webhook ได้ access token หรือใช้ secret ใน env
  failed(
    checkLineOverlay({
      ...input,
      overlay: composeLine.replace(
        '      - line-channel-secret\n      - line-webhook-payload-key\n    healthcheck',
        '      - line-channel-access-token\n      - line-channel-secret\n      - line-webhook-payload-key\n    healthcheck',
      ),
    }),
    'WEBHOOK_HAS_ACCESS_TOKEN',
  );
  failed(
    checkLineOverlay({
      ...input,
      overlay: composeLine.replace(
        'LINE_WEBHOOK_SECRET_SOURCE: file',
        'LINE_WEBHOOK_SECRET_SOURCE: keychain',
      ),
    }),
    'WEBHOOK_SECRET_NOT_FILE',
  );
  // runner/relay ต้องไม่รันค้าง
  failed(
    checkLineOverlay({
      ...input,
      overlay: composeLine.replace(
        "  line-egress:\n    profiles: ['line-pilot']\n",
        '  line-egress:\n',
      ),
    }),
    'EGRESS_ALWAYS_ON',
  );
  // alias api.line.me บน network ของ relay ทำให้ relay ส่งวนกลับหาตัวเอง; runner ต้องชี้ IP ของ relay
  failed(
    checkLineOverlay({
      ...input,
      overlay: composeLine.replace(
        '        ipv4_address: 172.30.65.2\n',
        '        ipv4_address: 172.30.65.2\n        aliases:\n          - api.line.me\n',
      ),
    }),
    'EGRESS_ALIAS_LOOP',
  );
  failed(
    checkLineOverlay({
      ...input,
      overlay: composeLine.replace("'api.line.me:172.30.65.2'", "'api.line.me:172.30.65.3'"),
    }),
    'RUNNER_NOT_PINNED_TO_RELAY',
  );
  // webhook หลัง allowlist (LINE ถูก 403) หรือก่อน edge check
  const moved = caddyfileLine
    .replace(/\n\t\t@lineWebhook \{[^]*?respond @webhookOther 404\n/, '\n')
    .replace(
      '\t\trespond @outside 403\n',
      '\t\trespond @outside 403\n\n\t\t@lineWebhook {\n\t\t\tmethod POST\n\t\t\tpath /webhook/line\n\t\t}\n\t\thandle @lineWebhook {\n\t\t\treverse_proxy line-webhook:3000\n\t\t}\n',
    );
  failed(checkLineOverlay({ ...input, caddyfile: moved }), 'WEBHOOK_ROUTE_ORDER');
  // #566: read API ของ pilot ก่อน allowlist = เปิดสู่ internet
  const exposed = caddyfileLine
    .replace(/\t\t# #566:[^\n]*\n\t\thandle \/api\/v1\/line-pilot\/\* \{[^}]*\}\n/, '')
    .replace(
      '\t\t@outside not client_ip',
      '\t\thandle /api/v1/line-pilot/* {\n\t\t\treverse_proxy line-webhook:3000\n\t\t}\n\t\t@outside not client_ip',
    );
  failed(checkLineOverlay({ ...input, caddyfile: exposed }), 'PILOT_API_ROUTE_ORDER');
  failed(
    checkLineOverlay({
      ...input,
      caddyfile: caddyfileLine.replace('respond @keycloakAdmin 404', 'respond @keycloakAdmin 200'),
    }),
    'CADDYFILE_DRIFT',
  );
  failed(
    checkLineOverlay({
      ...input,
      deployScript: deployScript.replaceAll('line-pilot.enabled', 'line.on'),
    }),
    'DEPLOY_NOT_LINE_AWARE',
  );
  failed(
    checkLineOverlay({ ...input, secretsScript: lineSecretsScript.replace('read -rs', 'read -r') }),
    'SECRETS_SCRIPT',
  );
});

test('UAT-S22: overlay team trial ที่เปิดกว้างเกินหรือ deploy ไม่ผูกกับ uat-line ไม่ผ่าน', () => {
  const input = { overlay: composeLineTrial, lineOverlay: composeLine, deployScript };
  assert.equal(checkLineTrialOverlay(input).status, 'PASS');
  failed(checkLineTrialOverlay({ ...input, overlay: null }), 'MISSING_ARTIFACT');
  failed(
    checkLineTrialOverlay({
      ...input,
      overlay: composeLineTrial.replace(
        '      - linepilot\n',
        '      - linepilot\n      - lineegress\n',
      ),
    }),
    'WEBHOOK_NETWORKS',
  );
  failed(
    checkLineTrialOverlay({
      ...input,
      overlay: composeLineTrial.replace("'api.line.me:172.30.65.2'", "'api.line.me:1.2.3.4'"),
    }),
    'WEBHOOK_NOT_PINNED_TO_RELAY',
  );
  failed(
    checkLineTrialOverlay({
      ...input,
      overlay: composeLineTrial.replace('/var/lib/line-pilot:ro', '/var/lib/line-pilot'),
    }),
    'STATE_NOT_READ_ONLY',
  );
  failed(
    checkLineTrialOverlay({
      ...input,
      overlay: composeLineTrial.replace(
        "LINE_TEAM_TRIAL: 'on'",
        "LINE_TEAM_TRIAL: 'on'\n      LINE_CHANNEL_ACCESS_TOKEN: abcdefghijkl",
      ),
    }),
    'SECRET_IN_ENV',
  );
  failed(
    checkLineTrialOverlay({
      ...input,
      overlay: `${composeLineTrial}\n  api:\n    ports:\n      - '3000:3000'\n`,
    }),
    'UNEXPECTED_SERVICE',
  );
  failed(
    checkLineTrialOverlay({
      ...input,
      deployScript: deployScript.replace('is_line "$1" || fail \'TRIAL_REQUIRES_LINE\'', 'true'),
    }),
    'DEPLOY_NOT_TRIAL_AWARE',
  );
});

test('UAT-S11: workflow ที่ไม่ผูก environment/concurrency, echo secret หรือไม่รัน readiness ไม่ผ่าน', () => {
  assert.equal(checkWorkflow(workflow).status, 'PASS');
  failed(
    checkWorkflow(workflow.replaceAll('environment: uat-preview', 'environment: production')),
    'ENVIRONMENT_NOT_UAT_PREVIEW',
  );
  failed(
    checkWorkflow(workflow.replace('cancel-in-progress: false', 'cancel-in-progress: true')),
    'CONCURRENCY',
  );
  failed(
    checkWorkflow(
      workflow.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'),
    ),
    'NOT_MANUAL_ONLY',
  );
  failed(checkWorkflow(workflow.replace('--static', '--nothing')), 'READINESS_NOT_RUN');
  failed(
    checkWorkflow(
      workflow.replace(
        '      - uses: docker/setup-buildx-action@v3',
        '      - run: echo "${{ secrets.UAT_SSH_HOST }}"\n      - uses: docker/setup-buildx-action@v3',
      ),
    ),
    'SECRET_ECHO',
  );
  failed(checkWorkflow(`${workflow}\n# docker compose up keycloak start-dev\n`), 'START_DEV');
  failed(
    checkWorkflow(`${workflow}\n      - run: npx prisma migrate reset --force\n`),
    'NON_ADDITIVE_MIGRATION_COMMAND',
  );
});

test('UAT-S18: workflow uat-image-smoke ที่รันอัตโนมัติ ใช้ secret/environment/push ภายนอก หรือไม่ teardown ไม่ผ่าน', () => {
  assert.equal(checkSmokeWorkflow(smokeWorkflow).status, 'PASS');
  failed(checkSmokeWorkflow(null), 'MISSING');
  const step = '      - uses: docker/setup-buildx-action@v3';
  const withStep = (lines) => smokeWorkflow.replace(step, `${lines}\n${step}`);
  failed(
    checkSmokeWorkflow(
      withStep(
        '      - env:\n          KEY: ${{ secrets.UAT_SSH_PRIVATE_KEY }}\n        run: true',
      ),
    ),
    'USES_SECRETS',
  );
  failed(
    checkSmokeWorkflow(
      smokeWorkflow.replace(
        '    timeout-minutes: 45\n',
        '    timeout-minutes: 45\n    environment: uat-preview\n',
      ),
    ),
    'USES_ENVIRONMENT',
  );
  failed(
    checkSmokeWorkflow(
      smokeWorkflow.replace('on:\n  workflow_dispatch:', 'on:\n  pull_request_target:'),
    ),
    'TRIGGER',
  );
  for (const trigger of ['pull_request', 'push']) {
    failed(
      checkSmokeWorkflow(
        smokeWorkflow.replace(
          'on:\n  workflow_dispatch:',
          `on:\n  ${trigger}:\n  workflow_dispatch:`,
        ),
      ),
      'TRIGGER',
    );
  }
  failed(
    checkSmokeWorkflow(
      smokeWorkflow.replace(
        'permissions:\n  contents: read',
        'permissions:\n  contents: read\n  packages: write',
      ),
    ),
    'WRITE_PERMISSION',
  );
  failed(
    checkSmokeWorkflow(smokeWorkflow.replace('          load: true', '          push: true')),
    'IMAGE_PUSH',
  );
  failed(
    checkSmokeWorkflow(
      withStep('      - uses: docker/login-action@v3\n        with:\n          registry: ghcr.io'),
    ),
    'EXTERNAL_REGISTRY',
  );
  failed(
    checkSmokeWorkflow(smokeWorkflow.replace('REGISTRY: localhost:5000', 'REGISTRY: ghcr.io/acme')),
    'REGISTRY_NOT_LOCAL',
  );
  failed(
    checkSmokeWorkflow(smokeWorkflow.replace(/(registry:2\.8\.3)@sha256:[0-9a-f]{64}/, '$1')),
    'REGISTRY_NOT_DIGEST_PINNED',
  );
  failed(
    checkSmokeWorkflow(smokeWorkflow.replace('uat-deploy migrate ', 'docker compose run migrate ')),
    'STEP_MISSING',
  );
  failed(checkSmokeWorkflow(smokeWorkflow.replaceAll('down -v', 'down')), 'NO_TEARDOWN');
  failed(checkSmokeWorkflow(smokeWorkflow.replaceAll('::add-mask::', '')), 'NO_MASK');
  // comment ไม่นับ — ข้อความอธิบายใน comment ไม่ทำให้ผ่าน/ล้มแทนโค้ด
  failed(
    checkSmokeWorkflow(`${smokeWorkflow.replaceAll('down -v', 'down')}\n# if: always() down -v\n`),
    'NO_TEARDOWN',
  );
});

test('UAT-S12/S13: env example ที่มีค่า หรือ .dockerignore ที่ปล่อย .env ไม่ผ่าน', () => {
  assert.equal(checkEnvExample('A=\nB=\n').status, 'PASS');
  failed(checkEnvExample('UAT_POSTGRES_PASSWORD=hunter\n'), 'VALUE_PRESENT');
  assert.equal(checkDockerignore(read(UAT_FILES.dockerignore)).status, 'PASS');
  failed(checkDockerignore('node_modules\n'), 'NOT_IGNORED');
  failed(
    checkDockerignore(`${read(UAT_FILES.dockerignore)}\n!.env.production\n`),
    'ENV_REINCLUDED',
  );
});

test('UAT-S17: fixture template/provision example ที่มีค่าจริงของ deployment, id หรืออีเมลไม่ผ่าน', () => {
  const templateText = read(UAT_FILES.fixtureTemplate);
  const exampleText = read(UAT_FILES.provisionExample);
  assert.equal(checkFixtureTemplate(templateText, exampleText).status, 'PASS');
  const template = JSON.parse(templateText);
  const example = JSON.parse(exampleText);
  const uuid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  failed(
    checkFixtureTemplate(JSON.stringify({ ...template, tenantId: uuid }), exampleText),
    'DEPLOYMENT_VALUE_PRESENT',
  );
  failed(
    checkFixtureTemplate(JSON.stringify({ ...template, buildSha: 'abc1234' }), exampleText),
    'DEPLOYMENT_VALUE_PRESENT',
  );
  failed(
    checkFixtureTemplate(
      JSON.stringify({ ...template, steps: [{ ...template.steps[0], expected: `ref ${uuid}` }] }),
      exampleText,
    ),
    'REAL_ID_PRESENT',
  );
  failed(
    checkFixtureTemplate(
      templateText,
      JSON.stringify({ ...example, maker: { ...example.maker, email: 'someone@example.com' } }),
    ),
    'VALUE_PRESENT',
  );
  failed(
    checkFixtureTemplate(
      templateText,
      JSON.stringify({ ...example, tenant: { ...example.tenant, name: 'ACME UAT' } }),
    ),
    'VALUE_PRESENT',
  );
  failed(
    checkFixtureTemplate(templateText, `${exampleText}\n// someone@example.com`),
    'NOT_PROVISION_INPUT',
  );
  failed(
    checkFixtureTemplate(templateText, JSON.stringify({ ...example, fixturePack: template })),
    'FIXTURE_PACK_NOT_TEMPLATE',
  );
  failed(checkFixtureTemplate(null, exampleText), 'MISSING');
});

test('UAT-S14: secret scan จับ key/JWT/token/credential literal', () => {
  const segment = 'A'.repeat(24);
  const bad = {
    key: ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '),
    jwt: `token eyJ${segment}.eyJ${segment}.${segment}`,
    github: `gh${'p'}_${'a1'.repeat(20)}`,
    aws: `AKIA${'B'.repeat(16)}`,
    assignment: 'UAT_POSTGRES_PASSWORD=Correct-Horse-9',
    dev: 'MINIO_ROOT_PASSWORD: dcontact-secret',
  };
  for (const [name, text] of Object.entries(bad)) {
    assert.equal(scanSecrets({ [name]: text }).status, 'FAIL', name);
  }
  assert.equal(
    scanSecrets({
      ok: [
        'POSTGRES_PASSWORD: ${UAT_POSTGRES_PASSWORD:?required}',
        'KEYCLOAK_ADMIN_PASSWORD=',
        '  UAT_SSH_PRIVATE_KEY: ${{ secrets.UAT_SSH_PRIVATE_KEY }}',
        ': "${UAT_APP_DB_PASSWORD:?UAT_APP_DB_PASSWORD is required}"',
        "ALTER ROLE keycloak WITH LOGIN PASSWORD :'keycloak_password';",
      ].join('\n'),
    }).status,
    'PASS',
  );
});

// ── migration guard ─────────────────────────────────────────────────────────

test('UAT-M01: migration ใหม่ที่มี DROP หรือการแก้ migration เดิมไม่ผ่าน', () => {
  const path = (name) => `packages/db/prisma/migrations/${name}/migration.sql`;
  assert.equal(
    guardMigrations([
      {
        status: 'A',
        path: path('1_add'),
        sql: 'CREATE TABLE x (id uuid);\n-- DROP TABLE x; ในอนาคต\n/* DROP */',
      },
    ]).status,
    'PASS',
  );
  failed(
    guardMigrations([{ status: 'A', path: path('2_drop'), sql: 'ALTER TABLE x DROP COLUMN y;' }]),
    'DROP_STATEMENT',
  );
  failed(
    guardMigrations([{ status: 'A', path: path('3_idx'), sql: 'drop index if exists x_idx;' }]),
    'DROP_STATEMENT',
  );
  failed(
    guardMigrations([{ status: 'M', path: path('0_init'), sql: '' }]),
    'APPLIED_MIGRATION_CHANGED',
  );
  failed(
    guardMigrations([{ status: 'D', path: path('0_init'), sql: '' }]),
    'APPLIED_MIGRATION_CHANGED',
  );
  assert.deepEqual(findDropStatements('SELECT 1; -- DROP TABLE x'), []);
});

test('UAT-M01 (#567): แทนที่ CHECK ที่ review แล้วผ่าน แต่ชื่ออื่น/ไม่มี ADD ชื่อเดิม/DROP แบบอื่นยังล้ม', () => {
  const path = (name) => `packages/db/prisma/migrations/${name}/migration.sql`;
  const name = 'dl_line_run_authorizations_caps_check';
  const replace = `ALTER TABLE t DROP CONSTRAINT "${name}";\nALTER TABLE t ADD CONSTRAINT "${name}" CHECK (true);`;
  assert.equal(guardMigrations([{ status: 'A', path: path('4_ok'), sql: replace }]).status, 'PASS');
  // ชื่อไม่อยู่ใน allowlist
  failed(
    guardMigrations([
      {
        status: 'A',
        path: path('5_other'),
        sql: replace.replaceAll(name, 'dl_line_cap_ledger_values_check'),
      },
    ]),
    'DROP_STATEMENT',
  );
  // drop อย่างเดียวไม่ add กลับ (หรือ add เป็นชื่ออื่น)
  failed(
    guardMigrations([
      { status: 'A', path: path('6_drop_only'), sql: `ALTER TABLE t DROP CONSTRAINT "${name}";` },
    ]),
    'DROP_STATEMENT',
  );
  failed(
    guardMigrations([
      {
        status: 'A',
        path: path('7_renamed'),
        sql: `ALTER TABLE t DROP CONSTRAINT "${name}";\nALTER TABLE t ADD CONSTRAINT "${name}_v2" CHECK (true);`,
      },
    ]),
    'DROP_STATEMENT',
  );
  // แทนที่ได้ แต่ DROP อื่นในไฟล์เดียวกันยังล้ม
  failed(
    guardMigrations([
      { status: 'A', path: path('8_mixed'), sql: `${replace}\nALTER TABLE t DROP COLUMN y;` },
    ]),
    'DROP_STATEMENT',
  );
});

test('UAT-M01 (#520): CHECK constraint ของ click-to-call และ voice rollout ที่ review แล้วแทนที่ได้', () => {
  const path = (name) => `packages/db/prisma/migrations/${name}/migration.sql`;
  for (const name of [
    'dphone_click_to_call_audit_events_values_check',
    'dl_voice_scope_gates_shape',
  ]) {
    const sql = `ALTER TABLE t DROP CONSTRAINT "${name}";\nALTER TABLE t ADD CONSTRAINT "${name}" CHECK (true);`;
    assert.equal(guardMigrations([{ status: 'A', path: path(name), sql }]).status, 'PASS');
  }
});

test('UAT-M01: guard อ่าน migration จาก git จริง (base = HEAD ไม่มีไฟล์ใหม่)', () => {
  const result = runMigrationGuard({ base: runMigrationGuard({ initial: true }).head });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.checks[0].added, []);
  assert.throws(() => runMigrationGuard({ base: 'not-a-sha' }), /commit SHA/);
});

// ── live smoke กับ stub server ──────────────────────────────────────────────

const TOKEN = ['stub', 'access', 'token', 'value'].join('-');

function stubUat({
  profile = {},
  adminStatus = 404,
  issuerOverride,
  requireToken = TOKEN,
  themed = true,
  tokensCss = true,
} = {}) {
  const seen = { hosts: new Set(), authorized: 0 };
  const server = http.createServer((request, response) => {
    seen.hosts.add(request.headers.host);
    const url = new URL(request.url, 'http://stub');
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const origin = `http://${request.headers.host}`;
    if (url.pathname === '/') return send(200, '<!doctype html><div id="root"></div>', 'text/html');
    if (url.pathname === '/api/v1/runtime-profile') {
      return send(200, {
        profile: 'uat',
        kafka: 'DISABLED',
        lineWebhook: 'DISABLED',
        providerEgress: 'BLOCKED',
        journeyRuntime: 'NOT_DEPLOYED',
        unilateralPublish: 'NOT_EXPOSED',
        ...profile,
      });
    }
    if (url.pathname === '/auth/realms/dcontact/.well-known/openid-configuration') {
      const issuer = issuerOverride ?? `${origin}/auth/realms/dcontact`;
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
      });
    }
    if (url.pathname === '/auth/realms/dcontact/protocol/openid-connect/auth') {
      // Keycloak ตอบ error เป็น JSON เมื่อ Accept ไม่ได้ขอ HTML
      if (!/^text\/html/.test(request.headers.accept ?? '')) {
        return send(400, { error: 'invalid_request' });
      }
      const shell = themed
        ? '<link href="/auth/resources/v1/login/dcontact/css/dcontact.css" rel="stylesheet" /><div class="dc-shell">'
        : '<div class="login-pf-page">';
      return send(400, `<!doctype html>${shell}</div>`, 'text/html');
    }
    if (url.pathname === '/auth/resources/v1/login/dcontact/css/dcontact.css') {
      return send(200, '.dc-shell { color: var(--dc-text-primary); }', 'text/css');
    }
    if (url.pathname === '/auth/resources/v1/login/dcontact/css/tokens.css' && tokensCss) {
      return send(200, ':root { --dc-text-primary: #1e293b; }', 'text/css');
    }
    if (url.pathname.startsWith('/auth/admin') || url.pathname.startsWith('/auth/realms/master')) {
      return send(adminStatus, 'blocked', 'text/plain');
    }
    if (
      url.pathname.startsWith('/api/v1/uat-runs') ||
      url.pathname.startsWith('/api/v1/journey-authoring')
    ) {
      if (request.headers.authorization !== `Bearer ${requireToken}`)
        return send(401, { status: 401 });
      seen.authorized += 1;
      const journeyId = '00000000-0000-4000-8000-000000000002';
      if (url.pathname === '/api/v1/uat-runs/current') return send(200, { runId: 'r', journeyId });
      if (url.pathname === '/api/v1/uat-runs/current/simulation-fixture') {
        return send(200, {
          runId: 'r',
          fixture: { fixtureId: 'f', startAt: '2026-01-01T00:00:00Z', seed: 's', context: {} },
        });
      }
      if (url.pathname === `/api/v1/journey-authoring/journeys/${journeyId}`) {
        return send(200, {
          head: { version: 1, currentDraftRevision: 2, currentDraftDigest: 'sha256:x' },
        });
      }
      if (url.pathname.endsWith('/compile'))
        return send(200, { artifact: { compileDigest: 'sha256:c' } });
      return send(200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) {
      return send(404, { status: 404, code: 'ROUTE_NOT_AVAILABLE_IN_PROFILE' });
    }
    return send(404, 'not found', 'text/plain');
  });
  return new Promise((resolvePromise) =>
    server.listen(0, '127.0.0.1', () =>
      resolvePromise({ server, seen, port: server.address().port }),
    ),
  );
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function smoke(stub, options = {}) {
  return runLiveSmoke({
    baseUrl: `http://uat.example.test:${stub.port}`,
    connectHost: '127.0.0.1',
    allowHttp: true,
    ports: [await closedPort()],
    ...options,
  });
}

test('UAT-L: smoke ผ่านกับ UAT ที่ถูกต้อง; journey flow SKIPPED เมื่อไม่มี token', async () => {
  const stub = await stubUat();
  try {
    const result = await smoke(stub);
    const statuses = Object.fromEntries(
      result.checks.map((entry) => [entry.id.split(' ')[0], entry.status]),
    );
    assert.deepEqual(statuses, {
      'UAT-L01': 'PASS',
      'UAT-L02': 'PASS',
      'UAT-L03': 'PASS',
      'UAT-L04': 'PASS',
      'UAT-L05': 'PASS',
      'UAT-L06': 'SKIPPED',
      'UAT-L07': 'PASS',
      'UAT-L08': 'PASS',
    });
    assert.equal(result.status, 'PASS');
    // ต่อ 127.0.0.1 แต่ส่ง Host ของ UAT_HOST
    assert.deepEqual([...stub.seen.hosts], [`uat.example.test:${stub.port}`]);
  } finally {
    stub.server.close();
  }
});

test('UAT-L02: smoke ยอมรับ profile uat-e1 เฉพาะเมื่อ operator ระบุ', async () => {
  const stub = await stubUat({ profile: { profile: 'uat-e1' } });
  try {
    assert.equal((await smoke(stub)).status, 'FAIL');
    assert.equal((await smoke(stub, { expectedProfile: 'uat-e1' })).status, 'PASS');
  } finally {
    stub.server.close();
  }
});

test('UAT-L06: journey flow ผ่านด้วย token และรายงานไม่มี token', async () => {
  const stub = await stubUat();
  try {
    const result = await smoke(stub, { token: TOKEN });
    assert.equal(result.status, 'PASS');
    assert.equal(result.checks.find((entry) => entry.id.startsWith('UAT-L06')).status, 'PASS');
    assert.ok(stub.seen.authorized >= 6);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    const rejected = await smoke(stub, { token: 'wrong-token-value' });
    assert.equal(rejected.checks.find((entry) => entry.id.startsWith('UAT-L06')).status, 'FAIL');
    assert.ok(!JSON.stringify(rejected).includes('wrong-token-value'));
  } finally {
    stub.server.close();
  }
});

test('UAT-L: profile ผิด, admin เปิด, issuer ไม่ตรง หรือพอร์ตเปิด = FAIL', async () => {
  const cases = [
    [{ profile: { kafka: 'ENABLED' } }, 'UAT-L02'],
    [{ profile: { profile: 'default' } }, 'UAT-L02'],
    [{ adminStatus: 200 }, 'UAT-L05'],
    [{ adminStatus: 302 }, 'UAT-L05'],
    [{ issuerOverride: 'http://other.example/auth/realms/dcontact' }, 'UAT-L04'],
    [{ themed: false }, 'UAT-L08'],
    [{ tokensCss: false }, 'UAT-L08'],
  ];
  for (const [options, id] of cases) {
    const stub = await stubUat(options);
    try {
      const result = await smoke(stub);
      assert.equal(result.status, 'FAIL', JSON.stringify(options));
      assert.equal(result.checks.find((entry) => entry.id.startsWith(id)).status, 'FAIL', id);
    } finally {
      stub.server.close();
    }
  }
  const stub = await stubUat();
  try {
    const result = await smoke(stub, { ports: [stub.port] });
    assert.equal(result.checks.find((entry) => entry.id.startsWith('UAT-L07')).status, 'FAIL');
  } finally {
    stub.server.close();
  }
});

test('UAT-L: base URL ต้องเป็น https และ server ที่ไม่ตอบ = FAIL ไม่ใช่ crash', async () => {
  await assert.rejects(runLiveSmoke({ baseUrl: 'http://uat.example.test' }), /https/);
  await assert.rejects(runLiveSmoke({}), /UAT_BASE_URL/);
  const port = await closedPort();
  const result = await runLiveSmoke({
    baseUrl: `http://127.0.0.1:${port}`,
    allowHttp: true,
    ports: [],
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(await tcpPortOpen('127.0.0.1', port), false);
});

// ── deployment record ───────────────────────────────────────────────────────

test('deployment record: บันทึก SHA/digest/realm/pack; ปฏิเสธ image ไม่ pin หรือ smoke ไม่ผ่าน', () => {
  const sha = 'a'.repeat(40);
  const digest = (name) => `ghcr.io/o/${name}@sha256:${'b'.repeat(64)}`;
  const smokeReport = { status: 'PASS', checks: [{ id: 'UAT-L01 Console index', status: 'PASS' }] };
  const input = {
    action: 'deploy',
    release: {
      SOURCE_SHA: sha,
      API_IMAGE: digest('api'),
      CONSOLE_IMAGE: digest('console'),
      OPS_IMAGE: digest('ops'),
      KEYCLOAK_IMAGE: digest('keycloak'),
    },
    keycloak: { realmConfigDigest: `sha256:${'c'.repeat(64)}` },
    backup: { status: 'PASS', file: 'backups/pg-dcontact-x.dump', sha256: 'd'.repeat(64) },
    migrationGuard: { status: 'PASS', base: 'e'.repeat(40), checks: [{ added: [] }] },
    smoke: smokeReport,
    environment: {
      UAT_ENVIRONMENT: 'uat',
      UAT_FIXTURE_PACK_VERSION: 'u1-pack-1',
      RUN_URL: 'https://example/run',
    },
    now: new Date('2026-09-28T00:00:00Z'),
  };
  const record = buildDeploymentRecord(input);
  assert.equal(record.sourceSha, sha);
  assert.equal(record.images.api, digest('api'));
  assert.equal(record.images.keycloak, digest('keycloak'));
  assert.equal(record.fixturePackVersion, 'u1-pack-1');
  assert.equal(record.realmConfigDigest, `sha256:${'c'.repeat(64)}`);
  assert.match(renderSummary(record), /UAT deployment record \(deploy\)/);

  const rollback = buildDeploymentRecord({
    action: 'rollback',
    rollbackOf: record,
    smoke: smokeReport,
    environment: {},
  });
  assert.equal(rollback.migration.applied, false);
  assert.deepEqual(rollback.images, record.images);

  assert.throws(
    () =>
      buildDeploymentRecord({
        ...input,
        release: { ...input.release, API_IMAGE: 'ghcr.io/o/api:latest' },
      }),
    /digest/,
  );
  assert.throws(
    () => buildDeploymentRecord({ ...input, smoke: { status: 'FAIL', checks: [] } }),
    /smoke/,
  );
});
