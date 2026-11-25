/**
 * U1.5 (#433): pure checks of file kind, negative scan and the evidence bundle digest
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  UAT_EVIDENCE_MAX_BYTES,
  extractUatImageText,
  scanUatText,
  sniffUatEvidence,
} from './uat-evidence-content.js';
import {
  assertUatScreenshot,
  scanUatEvidenceBytes,
  scanUatStepResults,
  sha256Hex,
  uatEvidenceBundleDigest,
  verifyUatEvidenceBundleDigest,
  type UatEvidenceBundleV1,
} from './uat-evidence.js';
import { UatRunError, parseUatFixturePackManifest, type UatStepResultView } from './uat-run.js';

/** a fake token shaped like a JWT — not a real credential */
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1YXQtZmFrZSJ9.c2lnbmF0dXJlLWZha2U';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** a real 1x1 PNG with extra chunks */
function png(extra: Buffer[] = []): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...extra,
    chunk('IDAT', deflateSync(Buffer.from([0, 0x80]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function segment(marker: number, data: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
}

/** a JPEG skeleton (SOI, APP0, extra segment, SOS + entropy data with byte stuffing/RST, EOI) */
function jpeg(extra: Buffer[] = []): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(
      0xe0,
      Buffer.from('JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000', 'latin1'),
    ),
    ...extra,
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function rejected(work: () => unknown, code: UatRunError['code'], safeParams?: object) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof UatRunError, String(error));
    assert.equal(error.code, code);
    if (safeParams) assert.deepEqual(error.safeParams, safeParams);
    return true;
  });
}

test('U1.5 accepts only PNG/JPEG screenshots by magic bytes — trace/HAR/network log are rejected', () => {
  assert.equal(assertUatScreenshot('image/png', png()), 'image/png');
  assert.equal(assertUatScreenshot('image/jpeg', jpeg()), 'image/jpeg');

  // Playwright trace.zip (zip local file header)
  const trace = Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.alloc(40)]);
  assert.equal(sniffUatEvidence(trace), 'ZIP');
  rejected(() => assertUatScreenshot('image/png', trace), 'EVIDENCE_TYPE_REJECTED', {
    detected: 'ZIP',
  });
  const har = Buffer.from('{"log":{"version":"1.2","entries":[]}}');
  rejected(() => assertUatScreenshot('image/png', har), 'EVIDENCE_TYPE_REJECTED', {
    detected: 'JSON',
  });
  const networkLog = Buffer.from('GET /api/v1/uat-runs 200\n');
  rejected(() => assertUatScreenshot('image/jpeg', networkLog), 'EVIDENCE_TYPE_REJECTED', {
    detected: 'TEXT',
  });
  rejected(() => assertUatScreenshot('image/png', Buffer.alloc(0)), 'EVIDENCE_TYPE_REJECTED');

  // the declared content type must match the real file
  rejected(() => assertUatScreenshot('image/jpeg', png()), 'EVIDENCE_TYPE_REJECTED', {
    detected: 'PNG',
    reason: 'CONTENT_TYPE_MISMATCH',
  });
  // polyglot: a PNG with a trace.zip appended / a truncated file
  rejected(
    () => assertUatScreenshot('image/png', Buffer.concat([png(), trace])),
    'EVIDENCE_TYPE_REJECTED',
    { detected: 'PNG', reason: 'TRAILING_DATA' },
  );
  rejected(
    () => assertUatScreenshot('image/jpeg', Buffer.concat([jpeg(), trace])),
    'EVIDENCE_TYPE_REJECTED',
    { detected: 'JPEG', reason: 'TRAILING_DATA' },
  );
  rejected(
    () => assertUatScreenshot('image/png', png().subarray(0, 40)),
    'EVIDENCE_TYPE_REJECTED',
    { detected: 'PNG', reason: 'MALFORMED' },
  );
  rejected(
    () =>
      assertUatScreenshot(
        'image/png',
        Buffer.concat([png(), Buffer.alloc(UAT_EVIDENCE_MAX_BYTES)]),
      ),
    'EVIDENCE_TOO_LARGE',
    { maxBytes: UAT_EVIDENCE_MAX_BYTES },
  );
});

test('U1.5 the negative scan checks token, header, secret, PII and OIDC code/state', () => {
  const cases: Array<[string, string]> = [
    [FAKE_JWT, 'JWT'],
    ['Bearer abcdefgh12345678', 'BEARER'],
    ['Authorization: Basic dXNlcjpwYXNz', 'AUTHORIZATION_HEADER'],
    ['Cookie: KEYCLOAK_SESSION=abc123', 'COOKIE'],
    ['set-cookie: sid=abc', 'COOKIE'],
    ['client_secret=s3cr3t-value', 'SECRET'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'SECRET'],
    ['AKIAABCDEFGHIJKLMNOP', 'SECRET'],
    ['Contact somchai@example.co.th', 'EMAIL'],
    ['Call 0812345678', 'PHONE'],
    ['Call +14155550123', 'PHONE'],
    ['โทร 0812345678ครับ', 'PHONE'], // allow-thai: phone number directly adjacent to Thai characters (scanner edge case)
    ['ติดต่อ 021234567 หรือ 0812345678.', 'PHONE'], // allow-thai: phone numbers mixed into Thai text (scanner edge case)
    ['https://sso.test/cb?code=abc123&session_state=x', 'OIDC_CODE'],
    ['https://sso.test/cb?state=xyz', 'OIDC_STATE'],
  ];
  for (const [text, kind] of cases) {
    assert.ok(scanUatText(text).includes(kind as never), `${kind}: ${scanUatText(text)}`);
  }
  // ordinary tester text/opaque refs are not caught
  for (const clean of [
    'Saw the Journey list and the SIMULATION_ONLY badge',
    'corr-2026-09-28:abc',
    'a1b2c3d4e5f6',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'uat-evidence/4e342ec5-d35b-41ed-bd44-1cf47a41af4b',
    // a git SHA that starts like a Thai number and continues with letters (U1.11 #512)
    '0812345678ab4c1d2e3f4a5b6c7d8e9f0a1b2c3d',
    '0512345678abcdef0123456789abcdef01234567',
    '"buildSha":"061234567fabcdef0123456789abcdef01234567"',
  ]) {
    assert.deepEqual(scanUatText(clean), [], clean);
  }
  // the fixture pack uses the same scanner
  assert.throws(
    () => parseUatFixturePackManifest({ schema: 'UatFixturePackV1', note: `?code=abc` }),
    (error: unknown) => error instanceof UatRunError && error.safeParams?.kind === 'OIDC_CODE',
  );
});

const result = (overrides: Partial<UatStepResultView> = {}): UatStepResultView => ({
  stepId: 'LOGIN',
  outcome: 'PASS',
  expected: 'Saw the Journey list',
  actual: 'Saw the Journey list',
  severity: null,
  correlationId: null,
  stateLabel: 'REAL_STATE',
  recordedByRef: 'maker',
  recordedAt: '2026-09-28T00:00:00.000Z',
  ...overrides,
});

test('U1.5 a fixture with a fake token makes the scan FAIL with a finding that holds no matched text', () => {
  assert.deepEqual(scanUatStepResults([result()]), []);
  const findings = scanUatStepResults([
    result(),
    result({ stepId: 'SIMULATE', actual: `Got header Authorization: Bearer ${FAKE_JWT}` }),
  ]);
  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['JWT', 'BEARER', 'AUTHORIZATION_HEADER'],
  );
  for (const finding of findings) {
    assert.equal(finding.severity, 'S1');
    assert.deepEqual(finding.location, {
      source: 'STEP_RESULT',
      stepId: 'SIMULATE',
      resultIndex: 1,
      field: 'actual',
    });
  }
  assert.doesNotMatch(JSON.stringify(findings), /eyJ|Bearer/);
});

test('U1.5 scans image text metadata (PNG tEXt/zTXt/iTXt, JPEG COM/APPn) and integrity', () => {
  const evidence = (bytes: Buffer, contentType: 'image/png' | 'image/jpeg') => ({
    evidenceId: '8c7d7e1e-7f55-4a4c-9d7b-000000000001',
    stepId: 'LOGIN',
    sha256: sha256Hex(bytes),
    contentType,
  });
  const clean = png([chunk('tEXt', Buffer.from('Software\u0000uat-screenshot', 'latin1'))]);
  assert.deepEqual(scanUatEvidenceBytes(evidence(clean, 'image/png'), clean), []);

  const tokenText = png([chunk('tEXt', Buffer.from(`Comment\u0000${FAKE_JWT}`, 'latin1'))]);
  assert.deepEqual(
    scanUatEvidenceBytes(evidence(tokenText, 'image/png'), tokenText).map((f) => [
      f.kind,
      f.location.field,
    ]),
    [['JWT', 'PNG_TEXT']],
  );
  const compressed = png([
    chunk(
      'zTXt',
      Buffer.concat([
        Buffer.from('Author\u0000\u0000', 'latin1'),
        deflateSync('tester@corp.co.th'),
      ]),
    ),
    chunk(
      'iTXt',
      Buffer.concat([
        Buffer.from('URL\u0000\u0001\u0000th\u0000\u0000', 'latin1'),
        deflateSync('https://sso.test/cb?state=abc'),
      ]),
    ),
  ]);
  assert.deepEqual(
    extractUatImageText(compressed, 'image/png').map((entry) => entry.text),
    [
      'Author',
      'tester@corp.co.th',
      'URL\u0000\u0001\u0000th\u0000',
      'https://sso.test/cb?state=abc',
    ],
  );
  assert.deepEqual(
    scanUatEvidenceBytes(evidence(compressed, 'image/png'), compressed).map((f) => f.kind),
    ['EMAIL', 'OIDC_STATE'],
  );
  const commented = jpeg([
    segment(0xfe, Buffer.from('Cookie: sid=abc')),
    segment(0xe1, Buffer.from('Exif\u0000\u0000http://cb?code=zzz')),
  ]);
  assert.deepEqual(
    scanUatEvidenceBytes(evidence(commented, 'image/jpeg'), commented).map((f) => [
      f.kind,
      f.location.field,
    ]),
    [
      ['COOKIE', 'JPEG_COM'],
      ['OIDC_CODE', 'JPEG_APP'],
    ],
  );

  // an object missing (retention) or edited = an S1 finding, not a silent pass
  assert.deepEqual(
    scanUatEvidenceBytes(evidence(clean, 'image/png'), null).map((f) => f.kind),
    ['EVIDENCE_UNAVAILABLE'],
  );
  assert.deepEqual(
    scanUatEvidenceBytes(evidence(clean, 'image/png'), tokenText).map((f) => f.kind),
    ['EVIDENCE_INTEGRITY'],
  );
});

test('U1.5 the bundle digest can be recomputed from canonical JSON and catches content edits', () => {
  const content: Omit<UatEvidenceBundleV1, 'digest'> = {
    schema: 'UatEvidenceBundleV1',
    manifest: {
      runId: 'run',
      sequence: 1,
      environment: 'uat',
      packVersion: 'pack-1',
      fixtureDigest: 'a'.repeat(64),
      buildSha: 'a1b2c3d',
      journeyId: null,
      lifecycle: 'ACTIVE',
      openedAt: '2026-09-28T00:00:00.000Z',
      closedAt: null,
    },
    steps: [{ stepId: 'LOGIN', title: 'Login', stateLabel: 'REAL_STATE' }],
    stateLabels: { REAL_STATE: ['LOGIN'], SIMULATION_ONLY: [] },
    stepResults: [result()],
    screenshots: [],
    auditRefs: [],
    scan: {
      scanId: 'scan',
      runId: 'run',
      scannerVersion: 'UAT_NEGATIVE_SCAN_V1',
      inputDigest: 'b'.repeat(64),
      status: 'PASSED',
      severity: null,
      findings: [],
      scannedByRef: 'maker',
      scannedAt: '2026-09-28T00:00:00.000Z',
    },
    verdict: 'PASS',
  };
  const bundle = { ...content, digest: uatEvidenceBundleDigest(content) };
  assert.ok(verifyUatEvidenceBundleDigest(bundle));
  // key order has no effect on the digest (canonical JSON)
  const reordered = JSON.parse(JSON.stringify({ digest: bundle.digest, ...content }));
  assert.ok(verifyUatEvidenceBundleDigest(reordered));
  assert.equal(verifyUatEvidenceBundleDigest({ ...bundle, verdict: 'FAIL' }), false);
});
