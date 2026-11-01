import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runOrganizationSmoke } from './core-settings-organization-smoke.mjs';
import { collectRuntimeSnapshot } from './core-settings-uat-snapshot.mjs';

export const REGISTRATION_AMENDMENT =
  'https://github.com/Kitti-Nualsalee/dcontact/issues/723#issuecomment-6559426967';
export const PRIOR_VOICE_TRIAL =
  'https://github.com/Kitti-Nualsalee/dcontact/issues/726#issuecomment-6500773233';
export const PRIOR_VOICE_SHA = '158c8ccec29e37bd51ac1fe26676b8cf3123d7be';
export const CASE_IDS = [
  ...Array.from({ length: 9 }, (_, i) => `ORG-TR0${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `TEAM-TR0${i + 1}`),
];
export const RELEASE_CHECKS = [
  'candidate-ci',
  'deployed-base',
  'workspace-overlay',
  'identity-fixtures',
  'migration-rls',
  'old-api-new-schema',
  'backup-restore-readiness',
  'idle-window',
  'authenticated-smoke',
  'voice-smoke',
  'live-defaults',
  'app-rollback',
  'candidate-restored',
  'final-state',
];
export const FIXTURES = [
  'two-tenants',
  'two-admins',
  'supervisor-own-team',
  'agent',
  'compliance',
  'missing-proof',
  'revoked-proof',
  'mismatched-proof',
  'legacy-defaults',
  'provisioned-defaults',
  'ref-free',
  'referenced',
  'history-only',
  'current-future',
  'unresolved-negative',
];
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const timestamp = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) &&
  Number.isFinite(Date.parse(v));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** ตรวจความครบ/ความสอดคล้องของหลักฐาน ไม่สร้างผลทดลองหรือ human signoff */
export function validateUatBundle(manifestPath, pins, { repo = process.cwd() } = {}) {
  const errors = [];
  const need = (ok, code) => {
    if (!ok) errors.push(code);
  };
  const fail = () => ({ result: 'NOT_PASSED', vmUat: 'NOT_PROVEN', errors });
  let m, root, manifestBytes;
  try {
    manifestBytes = readFileSync(manifestPath);
    m = JSON.parse(manifestBytes);
    root = realpathSync(dirname(resolve(manifestPath)));
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error();
  } catch {
    return { result: 'NOT_PASSED', vmUat: 'NOT_PROVEN', errors: ['MANIFEST_UNREADABLE'] };
  }
  need(SHA.test(pins?.sha ?? ''), 'EXPECTED_SHA_REQUIRED');
  need(HASH.test(pins?.config ?? ''), 'EXPECTED_CONFIG_REQUIRED');
  need(text(pins?.fixtures), 'EXPECTED_FIXTURES_REQUIRED');
  need(m.schemaVersion === 1 && m.kind === 'CORE_SETTINGS_VM_UAT', 'SCHEMA');
  const registrationOnly = m.voiceVerification === 'registration-with-prior-trial';
  need(
    m.voiceVerification === undefined || m.voiceVerification === 'full-call' || registrationOnly,
    'VOICE_MODE',
  );
  if (registrationOnly)
    need(
      m.voiceAmendmentReference === REGISTRATION_AMENDMENT &&
        m.priorVoiceTrialReference === PRIOR_VOICE_TRIAL &&
        m.priorVoiceTestedSha === PRIOR_VOICE_SHA,
      'VOICE_AMENDMENT_REQUIRED',
    );
  const registrationEvidence = (d) =>
    d?.voiceVerification === 'registration-with-prior-trial' &&
    d.registered === true &&
    d.twoWayAudio === 'NOT_RUN' &&
    d.activeCallTrial === 'NOT_RUN' &&
    d.priorVoiceTrialReference === PRIOR_VOICE_TRIAL &&
    d.priorVoiceTestedSha === PRIOR_VOICE_SHA;

  need(
    SHA.test(m.testedSha ?? '') && m.testedSha === pins?.sha && m.deployedSha === m.testedSha,
    'STALE_SHA',
  );
  need(HASH.test(m.configDigest ?? '') && m.configDigest === pins?.config, 'STALE_CONFIG');
  need(m.fixtureVersion === pins?.fixtures && text(m.fixtureVersion), 'STALE_FIXTURES');
  need(m.environment === 'vm-uat' && m.runtimeProfile === 'uat-workspace', 'VM_PROFILE');
  need(SHA.test(m.deployedBaseSha ?? '') && m.deployedBaseSha !== m.testedSha, 'DEPLOYED_BASE');
  need(
    Array.isArray(m.fixtureCoverage) && FIXTURES.every((id) => m.fixtureCoverage.includes(id)),
    'FIXTURE_COVERAGE',
  );
  need(
    Array.isArray(m.openDefects) &&
      m.openDefects.every((d) => d && text(d.id) && ['S3', 'S4'].includes(d.severity)),
    'OPEN_S1_S2_OR_UNKNOWN',
  );
  try {
    new Intl.DateTimeFormat('en', { timeZone: m.timezone });
    need(text(m.timezone), 'TIMEZONE');
  } catch {
    need(false, 'TIMEZONE');
  }
  const images = m.images;
  need(
    images &&
      Object.keys(images).length === 6 &&
      images.e1 === images.api &&
      ['api', 'console', 'ops', 'keycloak', 'e1', 'freeswitch'].every((id) =>
        DIGEST.test(images[id] ?? ''),
      ),
    'IMAGE_DIGESTS',
  );
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', m.testedSha, 'origin/main'], {
      cwd: repo,
      stdio: 'ignore',
    });
  } catch {
    need(false, 'TESTED_SHA_NOT_ON_MAIN');
  }

  // Artifact paths ต้องอยู่ใต้ bundle แม้มี symlink; ไม่อ่าน secret นอก directory
  const artifacts = new Map();
  for (const a of Array.isArray(m.artifacts) ? m.artifacts : []) {
    if (!a || !text(a.id) || artifacts.has(a.id)) {
      need(false, 'ARTIFACT_ID');
      continue;
    }
    artifacts.set(a.id, null);
    try {
      if (!text(a.path) || isAbsolute(a.path)) throw Error();
      const path = realpathSync(resolve(root, a.path));
      const rel = relative(root, path);
      if (
        !rel ||
        rel === '..' ||
        rel.startsWith('../') ||
        isAbsolute(rel) ||
        !statSync(path).isFile()
      )
        throw Error();
      const bytes = readFileSync(path);
      if (
        !HASH.test(a.sha256 ?? '') ||
        sha256(bytes) !== a.sha256 ||
        !bytes.length ||
        a.redacted !== true
      )
        throw Error();
      artifacts.set(a.id, { ...a, bytes });
    } catch {
      need(false, `ARTIFACT_INVALID:${a.id}`);
    }
  }
  need(artifacts.size > 0, 'ARTIFACTS_MISSING');
  const document = (id) => {
    const a = artifacts.get(id);
    if (!a) {
      need(false, `EVIDENCE_MISSING:${String(id)}`);
      return null;
    }
    try {
      return JSON.parse(a.bytes);
    } catch {
      need(false, `EVIDENCE_JSON:${id}`);
      return null;
    }
  };
  const bound = (d, code) => {
    need(
      d &&
        d.testedSha === m.testedSha &&
        d.deployedSha === m.deployedSha &&
        d.configDigest === m.configDigest &&
        d.fixtureVersion === m.fixtureVersion &&
        isDeepStrictEqual(d.images, m.images),
      code,
    );
  };
  const evidenceRefs = (refs, code) =>
    need(
      Array.isArray(refs) &&
        refs.length > 0 &&
        refs.every((id) => artifacts.get(id)?.kind === 'capture'),
      code,
    );

  const releaseIds = new Set();
  let latestRelease = 0;
  const releaseTimes = new Map();
  for (const row of Array.isArray(m.releaseChecks) ? m.releaseChecks : []) {
    if (!row || !RELEASE_CHECKS.includes(row.id) || releaseIds.has(row.id)) {
      need(false, 'RELEASE_ID');
      continue;
    }
    releaseIds.add(row.id);
    const d = document(row.evidence);
    bound(d, `RELEASE_BINDING:${row.id}`);
    need(
      d?.kind === 'CORE_SETTINGS_RELEASE_OBSERVATION' &&
        d.checkId === row.id &&
        d.result === 'PASS' &&
        text(d.actor) &&
        text(d.expected) &&
        text(d.actual) &&
        timestamp(d.recordedAt),
      `RELEASE_NOT_PASSED:${row.id}`,
    );
    if (d) {
      evidenceRefs(d.artifacts, `RELEASE_ARTIFACTS:${row.id}`);
      releaseTimes.set(row.id, Date.parse(d.recordedAt));
      latestRelease = Math.max(latestRelease, Date.parse(d.recordedAt) || 0);
      if (
        row.id === 'deployed-base' ||
        row.id === 'old-api-new-schema' ||
        row.id === 'app-rollback'
      )
        need(d.deployedBaseSha === m.deployedBaseSha, `BASE_BINDING:${row.id}`);
      if (row.id === 'voice-smoke' && registrationOnly)
        need(registrationEvidence(d), 'REGISTRATION_NOT_PROVEN');
      if (row.id === 'live-defaults' && registrationOnly)
        need(
          registrationEvidence(d) && d.registrationStayedRegistered === true,
          'REGISTERED_DEFAULTS_NOT_PROVEN',
        );
      if (row.id === 'voice-smoke' && !registrationOnly)
        need(
          ['LEGACY', 'VOICE_NOTE_V1'].includes(d.voiceWrapupPolicy) &&
            d.twoWayAudioConfirmedBy === d.actor &&
            d.dispositionReadback === true &&
            (d.voiceWrapupPolicy !== 'VOICE_NOTE_V1' || d.notesReadback === true),
          'VOICE_CONTRACT',
        );
      if (row.id === 'final-state')
        need(
          d.voiceEnabled === false &&
            d.calls === 0 &&
            d.liveLeases === 0 &&
            d.defaultsRestored === true,
          'FINAL_STATE',
        );
    }
  }
  need(
    RELEASE_CHECKS.every((id) => releaseIds.has(id)),
    'RELEASE_COVERAGE',
  );

  const runs = Array.isArray(m.runs) ? m.runs : [];
  const runIds = new Set();
  let lastEnd = 0;
  need(runs.length === 4, 'RUN_PAIR_COUNT');
  for (const [i, run] of runs.entries()) {
    if (!run || typeof run !== 'object') {
      need(false, 'RUN_INVALID');
      continue;
    }
    const tag = text(run.id) ? run.id : String(i);
    need(text(run.id) && !runIds.has(run.id), `RUN_ID:${tag}`);
    runIds.add(run.id);
    need(
      ['chrome', 'msedge'].includes(run.browser) && [1, 2].includes(run.round),
      `BROWSER_ROUND:${tag}`,
    );
    need(
      timestamp(run.startedAt) &&
        timestamp(run.endedAt) &&
        Date.parse(run.startedAt) >= lastEnd &&
        Date.parse(run.endedAt) > Date.parse(run.startedAt),
      `RUN_ORDER:${tag}`,
    );
    lastEnd = Date.parse(run.endedAt) || Infinity;
    const provenance = document(run.provenance);
    bound(provenance, `RUN_BINDING:${tag}`);
    const product = run.browser === 'msedge' ? /Edg\/[\d.]+/ : /Chrome\/[\d.]+/;
    need(
      provenance?.kind === 'CORE_SETTINGS_BROWSER_PROVENANCE' &&
        provenance.runId === run.id &&
        provenance.channel === run.browser &&
        text(provenance.version) &&
        text(provenance.userAgent) &&
        product.test(provenance.userAgent) &&
        !/HeadlessChrome|Chromium/.test(provenance.userAgent) &&
        (run.browser !== 'chrome' || !/Edg\//.test(provenance.userAgent)) &&
        provenance.syntheticIdentity === false &&
        provenance.fakeMedia === false &&
        provenance.routeMocks === false &&
        provenance.timezone === m.timezone &&
        provenance.startedAt === run.startedAt &&
        provenance.endedAt === run.endedAt,
      `BROWSER_PROVENANCE:${tag}`,
    );
    const ids = new Set();
    for (const row of Array.isArray(run.cases) ? run.cases : []) {
      if (!row || !CASE_IDS.includes(row.id) || ids.has(row.id)) {
        need(false, `CASE_ID:${tag}`);
        continue;
      }
      ids.add(row.id);
      const d = document(row.evidence);
      bound(d, `CASE_BINDING:${tag}:${row.id}`);
      need(
        d?.kind === 'CORE_SETTINGS_UI_OBSERVATION' &&
          d.runId === run.id &&
          d.caseId === row.id &&
          d.result === 'PASS' &&
          text(d.actor) &&
          text(d.expected) &&
          text(d.actual) &&
          timestamp(d.recordedAt) &&
          Date.parse(d.recordedAt) >= Date.parse(run.startedAt) &&
          Date.parse(d.recordedAt) <= Date.parse(run.endedAt) &&
          d.method === 'real-ui',
        `CASE_NOT_PASSED:${tag}:${row.id}`,
      );
      if (d) evidenceRefs(d.artifacts, `CASE_ARTIFACTS:${tag}:${row.id}`);
      if (registrationOnly && ['ORG-TR08', 'ORG-TR09', 'TEAM-TR09'].includes(row.id))
        need(registrationEvidence(d), `CASE_REGISTRATION_NOT_PROVEN:${tag}:${row.id}`);
    }
    need(
      CASE_IDS.every((id) => ids.has(id)),
      `CASE_COVERAGE:${tag}`,
    );
  }
  for (const browser of ['chrome', 'msedge']) {
    const pair = runs.filter((r) => r?.browser === browser);
    need(
      pair.length === 2 && pair[0]?.round === 1 && pair[1]?.round === 2,
      `CONSECUTIVE_PAIR:${browser}`,
    );
    if (pair.length === 2) {
      need(runs.indexOf(pair[1]) === runs.indexOf(pair[0]) + 1, `CONSECUTIVE_PAIR:${browser}`);
      const first = document(pair[0].provenance),
        second = document(pair[1].provenance);
      need(
        first?.version === second?.version && first?.userAgent === second?.userAgent,
        `BROWSER_CHANGED:${browser}`,
      );
    }
  }
  need(releaseTimes.get('final-state') >= lastEnd, 'FINAL_STATE_BEFORE_RUNS');
  need(
    releaseTimes.get('candidate-restored') <= Date.parse(runs[0]?.startedAt),
    'CANDIDATE_NOT_RESTORED_BEFORE_RUNS',
  );
  // Detached attestation ลงนามผูก exact manifest bytes ไม่ใส่ signoff ในไฟล์ที่ hash ตัวเอง
  let signoff;
  try {
    signoff = JSON.parse(readFileSync(`${manifestPath}.signoff.json`));
  } catch {
    need(false, 'SIGNOFF_MISSING');
  }
  const completedAt = Math.max(lastEnd, latestRelease);
  need(
    signoff?.kind === 'CORE_SETTINGS_UAT_SIGNOFF' &&
      signoff.manifestSha256 === sha256(manifestBytes) &&
      ['owner', 'test-delegate'].includes(signoff.role) &&
      text(signoff.name) &&
      signoff.scope === 'core-settings-first-slice' &&
      signoff.decision === 'ACCEPT' &&
      timestamp(signoff.recordedAt) &&
      Date.parse(signoff.recordedAt) >= completedAt &&
      Date.parse(signoff.recordedAt) <= Date.now() &&
      text(signoff.attestationReference),
    'SIGNOFF_INVALID',
  );
  if (errors.length) return fail();
  return {
    result: 'BUNDLE_CONSISTENT',
    voiceVerification: m.voiceVerification ?? 'full-call',
    audioTrial: registrationOnly ? 'PRIOR_TRIAL_ONLY' : 'TEAM_ATTESTED_CURRENT_TRIAL',
    vmUat: 'NOT_INDEPENDENTLY_VERIFIED',
    manifestSha256: sha256(manifestBytes),
    testedSha: m.testedSha,
    images: m.images,
    // ไม่ใช่ acceptance marker และไม่ยืนยันตัวตนผู้ลงนามแทนช่องทางรับรองของทีม
    acceptanceMarkerIssued: false,
    errors,
  };
}

/** CLI ต้องมี read-only smoke จริงด้วย; การตรวจ static bundle อย่างเดียวไม่ให้ผลผ่านเกต */
export async function runUatGate(manifestPath, pins) {
  const bundle = validateUatBundle(manifestPath, pins);
  if (bundle.result !== 'BUNDLE_CONSISTENT') return bundle;
  const env = process.env;
  if (!env.CORE_SETTINGS_ACCESS_TOKEN || !env.CORE_SETTINGS_BASE_URL)
    return {
      ...bundle,
      result: 'NOT_PASSED',
      vmUat: 'NOT_PROVEN',
      errors: ['LIVE_SMOKE_REQUIRED'],
    };
  if (env.CORE_SETTINGS_BASE_URL !== 'https://dcontact-uat.osd.co.th')
    return {
      ...bundle,
      result: 'NOT_PASSED',
      vmUat: 'NOT_PROVEN',
      errors: ['LIVE_TARGET_MISMATCH'],
    };
  let snapshot;
  try {
    snapshot = collectRuntimeSnapshot();
  } catch {
    return {
      ...bundle,
      result: 'NOT_PASSED',
      vmUat: 'NOT_PROVEN',
      errors: ['RUNTIME_SNAPSHOT_UNAVAILABLE'],
    };
  }
  if (
    snapshot.sourceSha !== pins.sha ||
    snapshot.configDigest !== pins.config ||
    !isDeepStrictEqual(snapshot.images, bundle.images)
  )
    return {
      ...bundle,
      result: 'NOT_PASSED',
      vmUat: 'NOT_PROVEN',
      errors: ['LIVE_DEPLOYMENT_CHANGED'],
    };
  let smoke;
  try {
    smoke = await runOrganizationSmoke({
      baseUrl: env.CORE_SETTINGS_BASE_URL,
      accessToken: env.CORE_SETTINGS_ACCESS_TOKEN,
      connectHost: env.CORE_SETTINGS_CONNECT_HOST,
      includeTeams: true,
    });
  } catch {
    /* ไม่คืน credential หรือ error payload จาก transport */
  }
  if (smoke?.result !== 'PASS')
    return {
      ...bundle,
      result: 'NOT_PASSED',
      vmUat: 'NOT_PROVEN',
      errors: ['LIVE_SMOKE_NOT_PASSED'],
    };
  const rechecked = validateUatBundle(manifestPath, pins);
  if (
    rechecked.result !== 'BUNDLE_CONSISTENT' ||
    rechecked.manifestSha256 !== bundle.manifestSha256
  )
    return {
      ...bundle,
      result: 'NOT_PASSED',
      vmUat: 'NOT_PROVEN',
      errors: ['BUNDLE_CHANGED_DURING_GATE'],
    };
  let after;
  try {
    after = collectRuntimeSnapshot();
  } catch {
    return {
      ...bundle,
      result: 'NOT_PASSED',
      vmUat: 'NOT_PROVEN',
      errors: ['RUNTIME_SNAPSHOT_UNAVAILABLE'],
    };
  }
  if (
    after.sourceSha !== snapshot.sourceSha ||
    after.configDigest !== snapshot.configDigest ||
    !isDeepStrictEqual(after.images, snapshot.images)
  )
    return {
      ...bundle,
      result: 'NOT_PASSED',
      vmUat: 'NOT_PROVEN',
      errors: ['LIVE_DEPLOYMENT_CHANGED'],
    };
  return { ...bundle, result: 'EVIDENCE_VALIDATED', vmUat: 'ATTESTED_BY_TEAM', liveSmoke: 'PASS' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const keys = ['--manifest', '--sha', '--config', '--fixtures'];
  const opts = {};
  let invalid = args.length !== 8;
  for (let i = 0; i < args.length; i += 2) {
    if (!keys.includes(args[i]) || opts[args[i]] || !text(args[i + 1])) invalid = true;
    opts[args[i]] = args[i + 1];
  }
  if (invalid) {
    process.stderr.write(
      'ใช้ --manifest <file> --sha <deployed SHA> --config <digest> --fixtures <version> จาก operator record ที่ตรวจแล้ว\n',
    );
    process.exitCode = 1;
  } else {
    const result = await runUatGate(opts['--manifest'], {
      sha: opts['--sha'],
      config: opts['--config'],
      fixtures: opts['--fixtures'],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.result !== 'EVIDENCE_VALIDATED') process.exitCode = 1;
  }
}
