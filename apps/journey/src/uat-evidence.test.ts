/**
 * U1.5 (#433): ตรวจชนิดไฟล์, negative scan และ digest ของ evidence bundle แบบ pure
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
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

/** token ปลอมรูป JWT — ไม่ใช่ credential จริง */
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1YXQtZmFrZSJ9.c2lnbmF0dXJlLWZha2U';

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG 1x1 จริง พร้อม chunk เสริม */
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

/** โครง JPEG (SOI, APP0, segment เสริม, SOS + entropy data ที่มี byte stuffing/RST, EOI) */
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

test('U1.5 รับเฉพาะภาพหน้าจอ PNG/JPEG ตาม magic bytes — trace/HAR/network log ถูกปฏิเสธ', () => {
  assert.equal(assertUatScreenshot('image/png', png()), 'image/png');
  assert.equal(assertUatScreenshot('image/jpeg', jpeg()), 'image/jpeg');

  // Playwright trace.zip (local file header ของ zip)
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

  // content type ที่ประกาศต้องตรงกับไฟล์จริง
  rejected(() => assertUatScreenshot('image/jpeg', png()), 'EVIDENCE_TYPE_REJECTED', {
    detected: 'PNG',
    reason: 'CONTENT_TYPE_MISMATCH',
  });
  // polyglot: PNG ที่พ่วง trace.zip ต่อท้าย / ไฟล์ขาด
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

test('U1.5 negative scan ตรวจ token, header, secret, PII และ OIDC code/state', () => {
  const cases: Array<[string, string]> = [
    [FAKE_JWT, 'JWT'],
    ['Bearer abcdefgh12345678', 'BEARER'],
    ['Authorization: Basic dXNlcjpwYXNz', 'AUTHORIZATION_HEADER'],
    ['Cookie: KEYCLOAK_SESSION=abc123', 'COOKIE'],
    ['set-cookie: sid=abc', 'COOKIE'],
    ['client_secret=s3cr3t-value', 'SECRET'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'SECRET'],
    ['AKIAABCDEFGHIJKLMNOP', 'SECRET'],
    ['ติดต่อ somchai@example.co.th', 'EMAIL'],
    ['โทร 0812345678', 'PHONE'],
    ['โทร +14155550123', 'PHONE'],
    ['โทร 0812345678ครับ', 'PHONE'],
    ['ติดต่อ 021234567 หรือ 0812345678.', 'PHONE'],
    ['https://sso.test/cb?code=abc123&session_state=x', 'OIDC_CODE'],
    ['https://sso.test/cb?state=xyz', 'OIDC_STATE'],
  ];
  for (const [text, kind] of cases) {
    assert.ok(scanUatText(text).includes(kind as never), `${kind}: ${scanUatText(text)}`);
  }
  // ข้อความของผู้ทดสอบ/opaque ref ปกติไม่ถูกจับ
  for (const clean of [
    'เห็น Journey list และป้าย SIMULATION_ONLY',
    'corr-2026-09-28:abc',
    'a1b2c3d4e5f6',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'uat-evidence/4e342ec5-d35b-41ed-bd44-1cf47a41af4b',
    // git SHA ที่ขึ้นต้นแบบเบอร์ไทยแล้วต่อด้วยตัวอักษร (U1.11 #512)
    '0812345678ab4c1d2e3f4a5b6c7d8e9f0a1b2c3d',
    '0512345678abcdef0123456789abcdef01234567',
    '"buildSha":"061234567fabcdef0123456789abcdef01234567"',
  ]) {
    assert.deepEqual(scanUatText(clean), [], clean);
  }
  // fixture pack ใช้ scanner เดียวกัน
  assert.throws(
    () => parseUatFixturePackManifest({ schema: 'UatFixturePackV1', note: `?code=abc` }),
    (error: unknown) => error instanceof UatRunError && error.safeParams?.kind === 'OIDC_CODE',
  );
});

const result = (overrides: Partial<UatStepResultView> = {}): UatStepResultView => ({
  stepId: 'LOGIN',
  outcome: 'PASS',
  expected: 'เห็น Journey list',
  actual: 'เห็น Journey list',
  severity: null,
  correlationId: null,
  stateLabel: 'REAL_STATE',
  recordedByRef: 'maker',
  recordedAt: '2026-09-28T00:00:00.000Z',
  ...overrides,
});

test('U1.5 fixture ที่มี token ปลอมทำให้ scan FAIL โดย finding ไม่มีข้อความที่ match', () => {
  assert.deepEqual(scanUatStepResults([result()]), []);
  const findings = scanUatStepResults([
    result(),
    result({ stepId: 'SIMULATE', actual: `ได้ header Authorization: Bearer ${FAKE_JWT}` }),
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

test('U1.5 scan metadata ข้อความในภาพ (PNG tEXt/zTXt/iTXt, JPEG COM/APPn) และ integrity', () => {
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

  // object หาย (retention) หรือถูกแก้ = finding S1 ไม่ใช่ผ่านเงียบ
  assert.deepEqual(
    scanUatEvidenceBytes(evidence(clean, 'image/png'), null).map((f) => f.kind),
    ['EVIDENCE_UNAVAILABLE'],
  );
  assert.deepEqual(
    scanUatEvidenceBytes(evidence(clean, 'image/png'), tokenText).map((f) => f.kind),
    ['EVIDENCE_INTEGRITY'],
  );
});

test('U1.5 digest ของ bundle คำนวณซ้ำได้จาก canonical JSON และจับการแก้เนื้อหาได้', () => {
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
  // ลำดับ key ไม่มีผลต่อ digest (canonical JSON)
  const reordered = JSON.parse(JSON.stringify({ digest: bundle.digest, ...content }));
  assert.ok(verifyUatEvidenceBundleDigest(reordered));
  assert.equal(verifyUatEvidenceBundleDigest({ ...bundle, verdict: 'FAIL' }), false);
});
