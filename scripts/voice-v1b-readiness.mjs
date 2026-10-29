import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^[a-f0-9]{40}$/;
const runPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const REQUIRED_PREFLIGHT_GATES = Object.freeze([
  'DEPLOYED_SOURCE_AND_IMAGES',
  'WORKER_BINDING',
  'IDENTITY_EXTENSION_AND_CLIENT_POLICY',
  'CAPACITY',
  'APPLICATION_BACKUP_REHEARSAL',
  'IDENTITY_BACKUP_REHEARSAL',
  'AUTHENTICATED_IDLE',
  'MEDIA',
  'SWITCHES',
  'CLOCK',
  'EXTENSION_POOL',
  'RECIPIENT_ALLOWLIST',
  'DELIVERY_PROBE',
]);
export const STATIC_ARTIFACTS = Object.freeze({
  workspace: 'apps/api/src/workspace-uat-api.ts',
  bootstrap: 'apps/api/src/e1-uat-api.ts',
  overlay: 'infra/uat/docker-compose.uat.workspace.yml',
  profile: 'apps/api/src/runtime-profile.ts',
  identity: 'infra/keycloak/Dockerfile',
  worker: 'apps/api/src/tenant-people-runtime.ts',
  composition: 'apps/api/src/tenant-people-composition.ts',
  identityPort: 'apps/api/src/tenant-people-keycloak.ts',
  package: 'package.json',
});

function check(id, passed) {
  return { id, status: passed ? 'PASS' : 'FAIL' };
}
function report(mode, checks, sourceSha, runId) {
  return {
    type: 'voice.v1b.readiness',
    mode,
    status: checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    sourceSha,
    ...(runId ? { runId } : {}),
    scope: mode === 'static' ? 'SOURCE_ARTIFACTS_ONLY' : 'READ_ONLY_PREFLIGHT_ONLY',
    trial: 'NOT_EVALUATED',
    checks,
  };
}
function sourceRevision(directory) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 5_000,
  });
  const value = result.stdout?.trim();
  return result.status === 0 && shaPattern.test(value) ? value : null;
}

export function runStaticChecks(directory = root) {
  const artifacts = {};
  const checks = [];
  for (const [name, path] of Object.entries(STATIC_ARTIFACTS)) {
    try {
      artifacts[name] = readFileSync(resolve(directory, path), 'utf8');
    } catch {
      artifacts[name] = '';
    }
    checks.push(check(`ARTIFACT_${name.toUpperCase()}`, !!artifacts[name]));
  }
  checks.push(
    check(
      'DEDICATED_WORKSPACE_COMPOSITION',
      /createE1UatApiModule/.test(artifacts.workspace) &&
        /createWorkspacePeopleRuntime/.test(artifacts.workspace) &&
        !/from\s+['"].*\/main(?:\.js)?['"]/.test(artifacts.workspace),
    ),
  );
  checks.push(
    check(
      'DIRECT_SIP_FLUSH',
      /peopleDisableFlush/.test(artifacts.workspace) &&
        /peopleDisableFlush:[\s\S]*voiceCommands\.flush/.test(artifacts.bootstrap),
    ),
  );
  checks.push(
    check(
      'WORKSPACE_PROFILE',
      /DCONTACT_API_PROFILE: uat-workspace/.test(artifacts.overlay) &&
        /kafka: 'DISABLED'/.test(artifacts.profile) &&
        /lineWebhook: 'DISABLED'/.test(artifacts.profile),
    ),
  );
  checks.push(
    check(
      'NO_BACKBONE_OR_LINE_OVERLAY',
      !/KAFKA_BROKERS|LINE_[A-Z_]+|platform-.*main|dist\/main\.js/.test(artifacts.overlay),
    ),
  );
  checks.push(
    check(
      'PEOPLE_DEFAULT_OFF',
      /TENANT_PEOPLE_INVITATIONS_ENABLED: \$\{UAT_TENANT_PEOPLE_INVITATIONS_ENABLED:-false\}/.test(
        artifacts.overlay,
      ) &&
        /TENANT_PEOPLE_DISABLE_ENABLED: \$\{UAT_TENANT_PEOPLE_DISABLE_ENABLED:-false\}/.test(
          artifacts.overlay,
        ),
    ),
  );
  checks.push(
    check(
      'SERVER_ONLY_WORKER_BINDINGS',
      ['BINDINGS_JSON', 'WORKER_DATABASE_URL', 'SECRET_UAT'].every((name) =>
        artifacts.overlay.includes(`TENANT_PEOPLE_${name}: \${UAT_TENANT_PEOPLE_${name}:-}`),
      ),
    ),
  );
  checks.push(
    check(
      'DISABLE_FAIL_CLOSED',
      /PEOPLE_DISABLE_FLUSH_REQUIRED/.test(artifacts.composition) &&
        /disableReady/.test(artifacts.identityPort),
    ),
  );
  checks.push(
    check(
      'PINNED_KEYCLOAK',
      /keycloak\/keycloak:26\.7\.5@sha256:[a-f0-9]{64}/.test(artifacts.identity),
    ),
  );
  checks.push(
    check(
      'WORKER_DRAIN_AND_RECONCILE',
      /onModuleDestroy/.test(artifacts.worker) &&
        /runPeopleDisable/.test(artifacts.worker) &&
        /app\.enableShutdownHooks\(\)/.test(artifacts.bootstrap),
    ),
  );
  const worktree = spawnSync('git', ['status', '--porcelain'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 5_000,
  });
  return {
    ...report('static', checks, sourceRevision(directory)),
    worktreeDirty: worktree.status === 0 ? worktree.stdout.trim().length > 0 : null,
  };
}

export function validatePreflightEvidence(evidence, { sourceSha, runId, now = Date.now() }) {
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(',') !== 'gates,runId,schema,sourceSha' ||
    evidence.schema !== 'VoiceV1BPreflightV1' ||
    evidence.sourceSha !== sourceSha ||
    evidence.runId !== runId ||
    !Array.isArray(evidence.gates) ||
    evidence.gates.length !== REQUIRED_PREFLIGHT_GATES.length
  )
    return false;
  const names = new Set();
  for (const gate of evidence.gates) {
    if (
      !gate ||
      typeof gate !== 'object' ||
      Object.keys(gate).sort().join(',') !== 'digest,id,observedAt,reference,status' ||
      !REQUIRED_PREFLIGHT_GATES.includes(gate.id) ||
      names.has(gate.id) ||
      gate.status !== 'PASS' ||
      typeof gate.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(gate.digest) ||
      typeof gate.reference !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{2,119}$/.test(gate.reference) ||
      typeof gate.observedAt !== 'string'
    )
      return false;
    const observed = Date.parse(gate.observedAt);
    if (!Number.isFinite(observed) || observed > now + 30_000 || now - observed > 60 * 60_000)
      return false;
    names.add(gate.id);
  }
  return true;
}

export async function runLiveChecks({
  baseUrl,
  token,
  sourceSha,
  runId,
  evidence,
  request = fetch,
  now = Date.now(),
}) {
  const checks = [
    check('EXPECTED_SOURCE_SHA', typeof sourceSha === 'string' && shaPattern.test(sourceSha)),
    check('RUN_ID', typeof runId === 'string' && runPattern.test(runId)),
  ];
  let base;
  try {
    base = new URL(baseUrl);
  } catch {}
  const targetAllowed =
    !!base &&
    base.protocol === 'https:' &&
    !base.username &&
    !base.password &&
    !base.search &&
    !base.hash &&
    base.pathname === '/';
  checks.push(check('HTTPS_TARGET', targetAllowed));
  checks.push(
    check('AUTH_INPUT', typeof token === 'string' && token.length > 0 && !/[\r\n]/.test(token)),
  );
  checks.push(
    check(
      'FRESH_OPERATOR_PREFLIGHT_RECORDS',
      validatePreflightEvidence(evidence, { sourceSha, runId, now }),
    ),
  );
  if (checks.some((item) => item.status !== 'PASS'))
    return report(
      'live',
      checks,
      shaPattern.test(sourceSha ?? '') ? sourceSha : null,
      runPattern.test(runId ?? '') ? runId : undefined,
    );
  for (const [id, path, accepts] of [
    [
      'RUNTIME_ISOLATION',
      'api/v1/runtime-profile',
      (value) =>
        value.profile === 'uat-workspace' &&
        value.kafka === 'DISABLED' &&
        value.lineWebhook === 'DISABLED' &&
        value.providerEgress === 'BLOCKED',
    ],
    [
      'B_CAPABILITIES',
      'api/v1/tenant-voice/capabilities',
      (value) =>
        value.version === 1 &&
        value.canWrite === true &&
        [
          'catalog',
          'configuration',
          'managedRouting',
          'peopleProvisioning',
          'invitation',
          'disable',
        ].every((name) => value[name]?.ready === true),
    ],
    [
      'AUTHENTICATED_DIRECTORY',
      'api/v1/tenant-voice/people/users?limit=20',
      (value) => Array.isArray(value.items),
    ],
  ]) {
    try {
      const response = await request(new URL(path, base), {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        checks.push(check(id, false));
        continue;
      }
      const value = await response.json();
      checks.push(
        check(id, !!value && typeof value === 'object' && !Array.isArray(value) && accepts(value)),
      );
    } catch {
      checks.push(check(id, false));
    }
  }
  return report('live', checks, sourceSha, runId);
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const args = argv.filter((value) => value !== '--');
  if (args.length === 1 && args[0] === '--static') return runStaticChecks();
  if (
    args.length !== 3 ||
    args[0] !== '--live' ||
    args[1] !== '--run-id' ||
    !runPattern.test(args[2])
  )
    return report('arguments', [check('USAGE_STATIC_OR_LIVE_RUN_ID', false)], null);
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(environment.V1B_PREFLIGHT_EVIDENCE_FILE, 'utf8'));
  } catch {}
  return runLiveChecks({
    baseUrl: environment.UAT_BASE_URL,
    token: environment.V1B_READINESS_ACCESS_TOKEN,
    sourceSha: environment.V1B_EXPECTED_SOURCE_SHA,
    runId: args[2],
    evidence,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exitCode = result.status === 'PASS' ? 0 : 1;
    })
    .catch(() => {
      console.log(
        JSON.stringify({ type: 'voice.v1b.readiness', status: 'FAIL', code: 'READINESS_FAILED' }),
      );
      process.exitCode = 1;
    });
}
