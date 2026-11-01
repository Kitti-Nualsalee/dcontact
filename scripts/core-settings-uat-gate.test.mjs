import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  CASE_IDS,
  FIXTURES,
  RELEASE_CHECKS,
  sha256,
  validateUatBundle,
  runUatGate,
} from './core-settings-uat-gate.mjs';

const repo = resolve(import.meta.dirname, '..');
const sha = execFileSync('git', ['rev-parse', 'origin/main'], {
  cwd: repo,
  encoding: 'utf8',
}).trim();
const pins = { sha, config: 'c'.repeat(64), fixtures: 'unit-test-only-v1' };
// ข้อมูลจำลองสำหรับ unit test เท่านั้น ไม่ export เป็นหลักฐาน UAT
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'core729-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'manifest.json');
  const images = Object.fromEntries(
    ['api', 'console', 'ops', 'keycloak', 'e1', 'freeswitch'].map((id) => [
      id,
      `sha256:${'d'.repeat(64)}`,
    ]),
  );
  const binding = {
    testedSha: sha,
    deployedSha: sha,
    configDigest: pins.config,
    fixtureVersion: pins.fixtures,
    images,
  };
  const m = {
    schemaVersion: 1,
    kind: 'CORE_SETTINGS_VM_UAT',
    ...binding,
    environment: 'vm-uat',
    runtimeProfile: 'uat-workspace',
    deployedBaseSha: 'b'.repeat(40),
    timezone: 'Asia/Bangkok',
    fixtureCoverage: [...FIXTURES],
    openDefects: [],
    artifacts: [],
    releaseChecks: [],
    runs: [],
  };
  function add(id, value) {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    writeFileSync(join(root, `${id}.json`), bytes);
    m.artifacts.push({
      id,
      path: `${id}.json`,
      sha256: sha256(bytes),
      redacted: true,
      kind: id === 'capture' ? 'capture' : 'observation',
    });
    return id;
  }
  add('capture', 'unit-test-only captured artifact');
  for (const id of RELEASE_CHECKS)
    m.releaseChecks.push({
      id,
      evidence: add(id, {
        kind: 'CORE_SETTINGS_RELEASE_OBSERVATION',
        ...binding,
        checkId: id,
        result: 'PASS',
        actor: 'test-operator',
        expected: 'expected',
        actual: 'actual',
        artifacts: ['capture'],
        recordedAt: '2026-01-01T00:00:00Z',
        deployedBaseSha: m.deployedBaseSha,
        voiceWrapupPolicy: 'LEGACY',
        twoWayAudioConfirmedBy: 'test-operator',
        dispositionReadback: true,
        voiceEnabled: false,
        calls: 0,
        liveLeases: 0,
        defaultsRestored: true,
      }),
    });
  for (const [index, browser] of ['chrome', 'chrome', 'msedge', 'msedge'].entries()) {
    const id = `run-${index}`,
      hour = String(index + 1).padStart(2, '0');
    const startedAt = `2026-01-01T${hour}:00:00Z`,
      endedAt = `2026-01-01T${hour}:30:00Z`;
    const run = { id, browser, round: (index % 2) + 1, startedAt, endedAt, cases: [] };
    run.provenance = add(`${id}-provenance`, {
      kind: 'CORE_SETTINGS_BROWSER_PROVENANCE',
      ...binding,
      runId: id,
      channel: browser,
      version: '156.0.0.0',
      userAgent: `Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36${browser === 'msedge' ? ' Edg/156.0.0.0' : ''}`,
      syntheticIdentity: false,
      fakeMedia: false,
      routeMocks: false,
      timezone: m.timezone,
      startedAt,
      endedAt,
    });
    for (const caseId of CASE_IDS)
      run.cases.push({
        id: caseId,
        evidence: add(`${id}-${caseId}`, {
          kind: 'CORE_SETTINGS_UI_OBSERVATION',
          ...binding,
          runId: id,
          caseId,
          result: 'PASS',
          method: 'real-ui',
          actor: 'test-admin',
          expected: 'expected',
          actual: 'actual',
          recordedAt: `2026-01-01T${hour}:15:00Z`,
          artifacts: ['capture'],
        }),
      });
    m.runs.push(run);
  }
  function seal() {
    const bytes = Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
    writeFileSync(path, bytes);
    writeFileSync(
      `${path}.signoff.json`,
      JSON.stringify({
        kind: 'CORE_SETTINGS_UAT_SIGNOFF',
        manifestSha256: sha256(bytes),
        role: 'owner',
        name: 'unit-test-owner',
        scope: 'core-settings-first-slice',
        decision: 'ACCEPT',
        recordedAt: '2026-01-01T05:00:00Z',
        attestationReference: 'unit-test-only-not-real-signoff',
      }),
    );
  }
  function edit(id, mutate) {
    const a = m.artifacts.find((a) => a.id === id);
    const file = join(root, a.path),
      value = JSON.parse(readFileSync(file));
    mutate(value);
    const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(file, bytes);
    a.sha256 = sha256(bytes);
  }
  seal();
  return { root, path, m, seal, edit, validate: () => validateUatBundle(path, pins, { repo }) };
}

test('bundle ครบตรวจได้เฉพาะหลักฐานรับรอง ไม่ออก acceptance marker', (t) => {
  const f = fixture(t),
    result = f.validate();
  assert.deepEqual(result.errors, []);
  assert.equal(result.result, 'BUNDLE_CONSISTENT');
  assert.equal(result.acceptanceMarkerIssued, false);
});

const failures = [
  ['ขาด manifest schema', (f) => delete f.m.schemaVersion, 'SCHEMA'],
  ['SHA เก่าหรือไม่ตรง deployed', (f) => (f.m.deployedSha = 'a'.repeat(40)), 'STALE_SHA'],
  ['config เปลี่ยน', (f) => (f.m.configDigest = 'a'.repeat(64)), 'STALE_CONFIG'],
  ['fixture เปลี่ยน', (f) => (f.m.fixtureVersion = 'v2'), 'STALE_FIXTURES'],
  ['loopback ไม่ใช่ VM', (f) => (f.m.environment = 'local'), 'VM_PROFILE'],
  ['fixture ไม่ครบ', (f) => f.m.fixtureCoverage.pop(), 'FIXTURE_COVERAGE'],
  ['มี S1', (f) => f.m.openDefects.push({ id: 'X', severity: 'S1' }), 'OPEN_S1_S2_OR_UNKNOWN'],
  ['มี S2', (f) => f.m.openDefects.push({ id: 'X', severity: 'S2' }), 'OPEN_S1_S2_OR_UNKNOWN'],
  ['ไม่ระบุ defect list', (f) => delete f.m.openDefects, 'OPEN_S1_S2_OR_UNKNOWN'],
  ['image เป็น tag', (f) => (f.m.images.api = 'latest'), 'IMAGE_DIGESTS'],
  ['timezone ผิด', (f) => (f.m.timezone = 'Invalid/Zone'), 'TIMEZONE'],
  ['ไม่มี deployed base', (f) => delete f.m.deployedBaseSha, 'DEPLOYED_BASE'],
  ['ขาด release check', (f) => f.m.releaseChecks.pop(), 'RELEASE_COVERAGE'],
  ['release check ซ้ำ', (f) => f.m.releaseChecks.push(f.m.releaseChecks[0]), 'RELEASE_ID'],
  [
    'release NOT_RUN',
    (f) => f.edit('migration-rls', (d) => (d.result = 'NOT_RUN')),
    'RELEASE_NOT_PASSED:migration-rls',
  ],
  [
    'rollback คนละ base',
    (f) => f.edit('app-rollback', (d) => (d.deployedBaseSha = 'a'.repeat(40))),
    'BASE_BINDING:app-rollback',
  ],
  [
    'Voice ไม่มี human ยืนยัน',
    (f) => f.edit('voice-smoke', (d) => delete d.twoWayAudioConfirmedBy),
    'VOICE_CONTRACT',
  ],
  [
    'notes policy ขาด readback',
    (f) => f.edit('voice-smoke', (d) => (d.voiceWrapupPolicy = 'VOICE_NOTE_V1')),
    'VOICE_CONTRACT',
  ],
  ['Voice ค้างหลังจบ', (f) => f.edit('final-state', (d) => (d.voiceEnabled = true)), 'FINAL_STATE'],
  ['ขาดรอบ', (f) => f.m.runs.pop(), 'RUN_PAIR_COUNT'],
  ['รอบซ้ำ', (f) => (f.m.runs[1].round = 1), 'CONSECUTIVE_PAIR:chrome'],
  ['ขาด Edge จริง', (f) => (f.m.runs[2].browser = 'chromium'), 'BROWSER_ROUND:run-2'],
  ['run ID ซ้ำ', (f) => (f.m.runs[1].id = f.m.runs[0].id), 'RUN_ID:run-0'],
  ['เวลาสลับหรือซ้อน', (f) => (f.m.runs[1].startedAt = f.m.runs[0].startedAt), 'RUN_ORDER:run-1'],
  ['ขาด case', (f) => f.m.runs[0].cases.pop(), 'CASE_COVERAGE:run-0'],
  ['case ซ้ำ', (f) => f.m.runs[0].cases.push(f.m.runs[0].cases[0]), 'CASE_ID:run-0'],
  [
    'case SKIP',
    (f) => f.edit('run-0-ORG-TR01', (d) => (d.result = 'SKIP')),
    'CASE_NOT_PASSED:run-0:ORG-TR01',
  ],
  [
    'case ไม่มี actual',
    (f) => f.edit('run-0-ORG-TR01', (d) => delete d.actual),
    'CASE_NOT_PASSED:run-0:ORG-TR01',
  ],
  [
    'case คนละ run',
    (f) => f.edit('run-0-ORG-TR01', (d) => (d.runId = 'old')),
    'CASE_NOT_PASSED:run-0:ORG-TR01',
  ],
  [
    'case ไม่มี raw proof',
    (f) => f.edit('run-0-ORG-TR01', (d) => (d.artifacts = [])),
    'CASE_ARTIFACTS:run-0:ORG-TR01',
  ],
  [
    'case คนละ SHA',
    (f) => f.edit('run-0-ORG-TR01', (d) => (d.testedSha = 'a'.repeat(40))),
    'CASE_BINDING:run-0:ORG-TR01',
  ],
  [
    'synthetic proof',
    (f) => f.edit('run-0-provenance', (d) => (d.syntheticIdentity = true)),
    'BROWSER_PROVENANCE:run-0',
  ],
  [
    'fake media',
    (f) => f.edit('run-0-provenance', (d) => (d.fakeMedia = true)),
    'BROWSER_PROVENANCE:run-0',
  ],
  [
    'route mocks',
    (f) => f.edit('run-0-provenance', (d) => (d.routeMocks = true)),
    'BROWSER_PROVENANCE:run-0',
  ],
  [
    'rename Chromium เป็น Edge',
    (f) => f.edit('run-2-provenance', (d) => (d.userAgent = 'Chromium/156')),
    'BROWSER_PROVENANCE:run-2',
  ],
  [
    'Chrome UA แทน Edge',
    (f) => f.edit('run-2-provenance', (d) => (d.userAgent = 'Chrome/156')),
    'BROWSER_PROVENANCE:run-2',
  ],
  [
    'browser เปลี่ยนระหว่างคู่',
    (f) => f.edit('run-1-provenance', (d) => (d.version = '157.0')),
    'BROWSER_CHANGED:chrome',
  ],
  ['ไฟล์ไม่มี', (f) => rmSync(join(f.root, 'capture.json')), 'ARTIFACT_INVALID:capture'],
  [
    'checksum ผิด',
    (f) => writeFileSync(join(f.root, 'capture.json'), 'changed'),
    'ARTIFACT_INVALID:capture',
  ],
  ['ยังไม่ redact', (f) => (f.m.artifacts[0].redacted = false), 'ARTIFACT_INVALID:capture'],
  [
    'path ออกนอก bundle',
    (f) => (f.m.artifacts[0].path = '../outside.json'),
    'ARTIFACT_INVALID:capture',
  ],
];
for (const [name, mutate, code] of failures)
  test(`ปฏิเสธ ${name}`, (t) => {
    const f = fixture(t);
    mutate(f);
    f.seal();
    const result = f.validate();
    assert.equal(result.result, 'NOT_PASSED');
    assert.ok(result.errors.includes(code), result.errors.join('\n'));
  });

test('ไม่อ่าน symlink ออกนอก bundle และไม่คืนเนื้อหาไฟล์ใน error', (t) => {
  const f = fixture(t),
    outside = mkdtempSync(join(tmpdir(), 'core729-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'private'), 'do-not-print');
  rmSync(join(f.root, 'capture.json'));
  symlinkSync(join(outside, 'private'), join(f.root, 'capture.json'));
  const result = f.validate();
  assert.ok(result.errors.includes('ARTIFACT_INVALID:capture'));
  assert.ok(!JSON.stringify(result).includes('do-not-print'));
});

test('manifest เปลี่ยนหลัง signoff ต้องรับรองใหม่', (t) => {
  const f = fixture(t);
  f.m.openDefects.push({ id: 'X', severity: 'S3' });
  writeFileSync(f.path, JSON.stringify(f.m));
  assert.ok(f.validate().errors.includes('SIGNOFF_INVALID'));
});
for (const [name, change] of [
  ['ไม่มีทีมรับรอง', () => null],
  ['ชื่อว่าง', (d) => ({ ...d, name: '' })],
  ['ลงนามก่อนผลครบ', (d) => ({ ...d, recordedAt: '2025-01-01T00:00:00Z' })],
  ['แอบรับรอง scope อื่น', (d) => ({ ...d, scope: 'ci-only' })],
  ['ไม่รับรอง', (d) => ({ ...d, decision: 'REJECT' })],
])
  test(`ปฏิเสธ signoff ${name}`, (t) => {
    const f = fixture(t),
      path = `${f.path}.signoff.json`;
    const value = change(JSON.parse(readFileSync(path)));
    if (value) writeFileSync(path, JSON.stringify(value));
    else rmSync(path);
    assert.equal(f.validate().result, 'NOT_PASSED');
  });

test('CLI ขาด pins/ไฟล์/JSON ที่อ่านไม่ได้ต้อง exit nonzero', (t) => {
  const f = fixture(t),
    script = join(repo, 'scripts/core-settings-uat-gate.mjs');
  for (const args of [
    [],
    ['--manifest', f.path],
    [
      '--manifest',
      f.path,
      '--sha',
      sha,
      '--config',
      pins.config,
      '--fixtures',
      pins.fixtures,
      '--extra',
      'x',
    ],
  ]) {
    assert.equal(spawnSync(process.execPath, [script, ...args]).status, 1);
  }
  writeFileSync(f.path, 'broken json');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--manifest',
      f.path,
      '--sha',
      sha,
      '--config',
      pins.config,
      '--fixtures',
      pins.fixtures,
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).vmUat, 'NOT_PROVEN');
});

test('static bundle ครบยังไม่ผ่านเกตเมื่อไม่มี authenticated live smoke', async (t) => {
  const f = fixture(t),
    previous = process.env.CORE_SETTINGS_ACCESS_TOKEN;
  delete process.env.CORE_SETTINGS_ACCESS_TOKEN;
  t.after(() => {
    if (previous !== undefined) process.env.CORE_SETTINGS_ACCESS_TOKEN = previous;
  });
  const result = await runUatGate(f.path, pins);
  assert.equal(result.result, 'NOT_PASSED');
  assert.deepEqual(result.errors, ['LIVE_SMOKE_REQUIRED']);
});

test('JSON Schema และ executable catalog ตรงกันทุก case/check/fixture', () => {
  const schema = JSON.parse(
    readFileSync(join(repo, 'docs/core-settings/uat-evidence.schema.json')),
  );
  assert.deepEqual(schema.$defs.uiObservation.properties.caseId.enum, CASE_IDS);
  assert.deepEqual(schema.$defs.releaseObservation.properties.checkId.enum, RELEASE_CHECKS);
  assert.deepEqual(schema.$defs.manifest.properties.fixtureCoverage.items.enum, FIXTURES);
});

test('ใช้ observation อ้างตนเองแทน capture ไม่ได้', (t) => {
  const f = fixture(t);
  f.edit('run-0-ORG-TR01', (d) => (d.artifacts = ['run-0-ORG-TR01']));
  f.seal();
  assert.ok(f.validate().errors.includes('CASE_ARTIFACTS:run-0:ORG-TR01'));
});

test('image binding ไม่ขึ้นกับลำดับ JSON keys', (t) => {
  const f = fixture(t);
  f.edit(
    'run-0-ORG-TR01',
    (d) => (d.images = Object.fromEntries(Object.entries(d.images).reverse())),
  );
  f.seal();
  assert.equal(f.validate().result, 'BUNDLE_CONSISTENT');
});

test('SHA ไม่อยู่ main ไม่ผ่านแม้ assertions/bindings เป็น PASS', (t) => {
  const f = fixture(t),
    result = validateUatBundle(f.path, pins, { repo: f.root });
  assert.ok(result.errors.includes('TESTED_SHA_NOT_ON_MAIN'));
});

test('pins ต้องได้รับจาก operator ไม่ default ตาม manifest', (t) => {
  const f = fixture(t),
    result = validateUatBundle(f.path, undefined, { repo });
  assert.ok(result.errors.includes('EXPECTED_SHA_REQUIRED'));
  assert.ok(result.errors.includes('EXPECTED_CONFIG_REQUIRED'));
  assert.ok(result.errors.includes('EXPECTED_FIXTURES_REQUIRED'));
});

test('manifest malformed ต้องไม่ crash หรือให้ PASS', (t) => {
  const f = fixture(t);
  for (const value of [
    null,
    [],
    'bad',
    { ...f.m, runs: [null] },
    { ...f.m, artifacts: [null], releaseChecks: [null] },
  ]) {
    writeFileSync(f.path, JSON.stringify(value));
    assert.equal(f.validate().result, 'NOT_PASSED');
  }
});

test('live smoke ต้องตรวจ VM target เดียวกับ runbook ไม่ใช้ loopback แทน', async (t) => {
  const f = fixture(t),
    previous = {
      token: process.env.CORE_SETTINGS_ACCESS_TOKEN,
      base: process.env.CORE_SETTINGS_BASE_URL,
    };
  process.env.CORE_SETTINGS_ACCESS_TOKEN = 'unit-test-only';
  process.env.CORE_SETTINGS_BASE_URL = 'http://127.0.0.1';
  t.after(() => {
    for (const [key, value] of [
      ['CORE_SETTINGS_ACCESS_TOKEN', previous.token],
      ['CORE_SETTINGS_BASE_URL', previous.base],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  assert.deepEqual((await runUatGate(f.path, pins)).errors, ['LIVE_TARGET_MISMATCH']);
});

test('config/image/SHA ที่เปลี่ยนบน VM ปฏิเสธก่อน authenticated smoke', async (t) => {
  const f = fixture(t);
  const { mkdirSync, chmodSync } = await import('node:fs');
  const directory = join(f.root, 'bin');
  mkdirSync(directory);
  const shim = join(directory, 'ssh');
  writeFileSync(
    shim,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(JSON.parse(process.env.CORE729_TEST_SNAPSHOT)));\n',
  );
  chmodSync(shim, 0o700);
  const previous = Object.fromEntries(
    ['PATH', 'CORE_SETTINGS_ACCESS_TOKEN', 'CORE_SETTINGS_BASE_URL', 'CORE729_TEST_SNAPSHOT'].map(
      (k) => [k, process.env[k]],
    ),
  );
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  process.env.PATH = `${directory}:${process.env.PATH}`;
  process.env.CORE_SETTINGS_ACCESS_TOKEN = 'unit-test-only';
  process.env.CORE_SETTINGS_BASE_URL = 'https://dcontact-uat.osd.co.th';
  const base = { sourceSha: sha, configDigest: pins.config, images: f.m.images };
  for (const snapshot of [
    { ...base, sourceSha: 'a'.repeat(40) },
    { ...base, configDigest: 'a'.repeat(64) },
    { ...base, images: {} },
  ]) {
    process.env.CORE729_TEST_SNAPSHOT = JSON.stringify(snapshot);
    assert.deepEqual((await runUatGate(f.path, pins)).errors, ['LIVE_DEPLOYMENT_CHANGED']);
  }
  writeFileSync(
    shim,
    '#!/usr/bin/env node\nprocess.stderr.write("private-do-not-print");process.exit(1);\n',
  );
  const result = await runUatGate(f.path, pins);
  assert.deepEqual(result.errors, ['RUNTIME_SNAPSHOT_UNAVAILABLE']);
  assert.ok(!JSON.stringify(result).includes('private-do-not-print'));
});
