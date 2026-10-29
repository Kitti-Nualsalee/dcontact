import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  main,
  REQUIRED_PREFLIGHT_GATES,
  runLiveChecks,
  runStaticChecks,
  STATIC_ARTIFACTS,
  validatePreflightEvidence,
} from './voice-v1b-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const now = Date.parse('2026-10-26T10:00:00Z');
const sourceSha = 'a'.repeat(40);
const runId = 'b7-synthetic-001';
function evidence() {
  return {
    schema: 'VoiceV1BPreflightV1',
    sourceSha,
    runId,
    gates: REQUIRED_PREFLIGHT_GATES.map((id) => ({
      id,
      status: 'PASS',
      observedAt: new Date(now).toISOString(),
      reference: `synthetic-${id}`,
      digest: 'b'.repeat(64),
    })),
  };
}
const configuration = () => ({
  baseUrl: 'https://uat.example.test',
  token: 'synthetic-token-never-print',
  sourceSha,
  runId,
  now,
  evidence: evidence(),
});

test('static ตรวจ dedicated workspace/direct flush/default-off/pins และไม่อ้าง trial ผ่าน', async () => {
  const result = await main(['--', '--static'], {});
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.trial, 'NOT_EVALUATED');
  assert.equal(result.scope, 'SOURCE_ARTIFACTS_ONLY');
});

test('static ปฏิเสธ artifact หายหรือ wiring direct flush ถูกถอด', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'b7-static-'));
  try {
    for (const path of Object.values(STATIC_ARTIFACTS)) {
      mkdirSync(dirname(resolve(directory, path)), { recursive: true });
      cpSync(resolve(root, path), resolve(directory, path));
    }
    const path = resolve(directory, STATIC_ARTIFACTS.bootstrap);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replaceAll('peopleDisableFlush', 'removedFlush'),
    );
    assert.equal(
      runStaticChecks(directory).checks.find((item) => item.id === 'DIRECT_SIP_FLUSH').status,
      'FAIL',
    );
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('app.enableShutdownHooks()', 'removedShutdownHook()'),
    );
    assert.equal(
      runStaticChecks(directory).checks.find((item) => item.id === 'WORKER_DRAIN_AND_RECONCILE')
        .status,
      'FAIL',
    );
    rmSync(resolve(directory, STATIC_ARTIFACTS.identityPort));
    assert.equal(
      runStaticChecks(directory).checks.find((item) => item.id === 'ARTIFACT_IDENTITYPORT').status,
      'FAIL',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('operator records ต้องครบ แยก source/run และสด ไม่มี secret/URL ใน reference', () => {
  const options = { sourceSha, runId, now };
  assert.equal(validatePreflightEvidence(evidence(), options), true);
  for (const change of [
    (value) => {
      value.sourceSha = 'c'.repeat(40);
    },
    (value) => {
      value.runId = 'other-run';
    },
    (value) => {
      value.gates.pop();
    },
    (value) => {
      value.gates[1] = value.gates[0];
    },
    (value) => {
      value.gates[0].observedAt = new Date(now - 3_600_001).toISOString();
    },
    (value) => {
      value.gates[0].observedAt = new Date(now + 60_000).toISOString();
    },
    (value) => {
      value.gates[0].reference = 'https://example.test/secret';
    },
    (value) => {
      value.gates[0].token = 'secret';
    },
  ]) {
    const value = evidence();
    change(value);
    assert.equal(validatePreflightEvidence(value, options), false);
  }
});

test('live ไม่ยิง request ถ้า target/input/proof ไม่พร้อม', async () => {
  let requests = 0;
  const request = async () => {
    requests++;
    throw Error('unexpected request');
  };
  for (const override of [
    { baseUrl: 'http://uat.example.test' },
    { baseUrl: 'https://user:secret@uat.example.test' },
    { baseUrl: 'https://uat.example.test/?token=secret' },
    { runId: '../invalid' },
    { token: '' },
    { evidence: null },
    { sourceSha: 'unknown' },
  ])
    assert.equal(
      (await runLiveChecks({ ...configuration(), ...override, request })).status,
      'FAIL',
    );
  assert.equal(requests, 0);
});

test('live ใช้ GET เท่านั้น ไม่ตาม redirect ไม่ส่งเมล/สร้าง user/เปิด switch และไม่ echo response', async () => {
  const paths = [];
  const request = async (url, options) => {
    paths.push(new URL(url).pathname);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.body, undefined);
    if (String(url).includes('runtime-profile'))
      return Response.json({
        profile: 'uat-workspace',
        kafka: 'DISABLED',
        lineWebhook: 'DISABLED',
        providerEgress: 'BLOCKED',
      });
    if (String(url).includes('capabilities'))
      return Response.json({
        version: 1,
        canWrite: true,
        ...Object.fromEntries(
          [
            'catalog',
            'configuration',
            'managedRouting',
            'peopleProvisioning',
            'invitation',
            'disable',
          ].map((name) => [name, { ready: true }]),
        ),
      });
    return Response.json({ items: [{ email: 'never-echo@example.test' }] });
  };
  const result = await runLiveChecks({ ...configuration(), request });
  assert.equal(result.status, 'PASS');
  assert.equal(result.trial, 'NOT_EVALUATED');
  assert.deepEqual(paths, [
    '/api/v1/runtime-profile',
    '/api/v1/tenant-voice/capabilities',
    '/api/v1/tenant-voice/people/users',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /never-echo|synthetic-token|Authorization|password/i);
});

test('live auth/error/invalid body ไม่รายงาน PASS และไม่พิมพ์ secret จาก exception', async () => {
  for (const request of [
    async () => Response.json({ token: 'do-not-print' }, { status: 401 }),
    async () => {
      throw Error('password=do-not-print');
    },
    async () => Response.json(null),
  ]) {
    const result = await runLiveChecks({ ...configuration(), request });
    assert.equal(result.status, 'FAIL');
    assert.doesNotMatch(JSON.stringify(result), /do-not-print|password/);
  }
});

test('CLI รับเฉพาะ static หรือ live/run-id และ live ไม่มี proof ต้อง fail closed', async () => {
  for (const args of [
    [],
    ['--static', '--live'],
    ['--live'],
    ['--live', '--run-id', '../bad'],
    ['--apply'],
  ])
    assert.equal((await main(args, {})).status, 'FAIL');
  assert.equal((await main(['--live', '--run-id', runId], {})).status, 'FAIL');
});
