/**
 * S2.3 (#367): stop condition ของ credential — secret value ต้องไม่ออกจาก provider boundary
 *
 * เทสต์ชุดนี้ถือค่า "secret" สังเคราะห์ในหน่วยความจำของเทสต์เอง ไม่มีค่าจริง ไม่มี Keychain
 * และไม่มี network; ที่ตรวจคือ handle/บูรณาการของ metadata ปฏิเสธถูกทางและไม่รั่วค่าออก log
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { scanForForbiddenTokens } from './line-evidence.js';
import {
  LineCredentialBoundary,
  LineCredentialBoundaryError,
  LineForbiddenFieldError,
  assertRedactedPayload,
  lineSecretFingerprint,
  type LineCredentialMetadata,
  type LineKeychainReference,
  type LineSecretSource,
} from './line-credential-boundary.js';

const AT = new Date('2026-09-22T10:00:00.000Z');
const SYNTHETIC_SECRET = 'synthetic-value-not-a-real-credential';

class RecordingSource implements LineSecretSource {
  readonly reads: LineKeychainReference[] = [];

  constructor(private readonly value: string | Error) {}

  async read(reference: LineKeychainReference): Promise<string> {
    this.reads.push(reference);
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}

function metadata(overrides: Partial<LineCredentialMetadata> = {}): LineCredentialMetadata {
  return {
    id: '2b0f0e6e-0000-4000-8000-000000000009',
    version: 3,
    credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
    status: 'ACTIVE',
    keychainService: 'd-contact.line.2007056595',
    keychainAccount: 'channel-access-token',
    fingerprint: lineSecretFingerprint(SYNTHETIC_SECRET),
    expiresAt: new Date('2026-10-20T00:00:00.000Z'),
    ...overrides,
  };
}

async function rejectsWith(work: Promise<unknown>, code: string, secret = SYNTHETIC_SECRET) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof LineCredentialBoundaryError, String(error));
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(secret));
    assert.ok(!inspect(error, { depth: 5 }).includes(secret));
    return true;
  });
}

test('handle: ใช้ค่าได้ครั้งเดียวและ serialize ออกมาไม่มีค่า secret', async () => {
  const source = new RecordingSource(SYNTHETIC_SECRET);
  const boundary = new LineCredentialBoundary(source);
  const handle = await boundary.resolve(metadata(), 3, AT);

  assert.deepEqual(source.reads, [
    { keychainService: 'd-contact.line.2007056595', keychainAccount: 'channel-access-token' },
  ]);
  for (const rendered of [
    String(handle),
    JSON.stringify(handle),
    inspect(handle, { depth: 5 }),
    inspect({ credential: handle }, { depth: 5 }),
  ]) {
    assert.ok(!rendered.includes(SYNTHETIC_SECRET), rendered);
    assert.ok(rendered.includes('REDACTED'), rendered);
  }

  assert.equal(handle.consumed, false);
  assert.equal(await handle.use((secret) => secret.length), SYNTHETIC_SECRET.length);
  assert.equal(handle.consumed, true);
  // ใช้ซ้ำไม่ได้: ค่าถูกทิ้งไปแล้วตั้งแต่ครั้งแรก
  await rejectsWith(
    handle.use(() => 'ห้ามถึงตรงนี้'),
    'CREDENTIAL_UNAVAILABLE',
  );
  assert.ok(!JSON.stringify(handle).includes(SYNTHETIC_SECRET));
});

test('handle: callback ที่ throw ก็ยังทิ้งค่า และ dispose ทิ้งได้โดยไม่ใช้', async () => {
  const boundary = new LineCredentialBoundary(new RecordingSource(SYNTHETIC_SECRET));
  const handle = await boundary.resolve(metadata(), 3, AT);
  await assert.rejects(
    handle.use(() => {
      throw new Error('provider ล้ม');
    }),
    /provider ล้ม/,
  );
  assert.equal(handle.consumed, true);

  const second = await boundary.resolve(metadata(), 3, AT);
  second.dispose();
  await rejectsWith(
    second.use(() => 'ห้ามถึงตรงนี้'),
    'CREDENTIAL_UNAVAILABLE',
  );
});

test('resolve: version/status/expiry ไม่ผ่าน = ไม่แตะ Keychain เลย', async () => {
  const cases: Array<[Partial<LineCredentialMetadata>, number, string]> = [
    [{}, 4, 'CREDENTIAL_VERSION_MISMATCH'],
    [{ status: 'CANDIDATE' }, 3, 'CREDENTIAL_UNAVAILABLE'],
    [{ status: 'RETIRED' }, 3, 'CREDENTIAL_UNAVAILABLE'],
    [{ status: 'REVOKED', revokedAt: AT }, 3, 'CREDENTIAL_UNAVAILABLE'],
    [{ expiresAt: new Date(AT.getTime() - 1) }, 3, 'CREDENTIAL_UNAVAILABLE'],
  ];
  for (const [overrides, expectedVersion, code] of cases) {
    const source = new RecordingSource(SYNTHETIC_SECRET);
    await rejectsWith(
      new LineCredentialBoundary(source).resolve(metadata(overrides), expectedVersion, AT),
      code,
    );
    assert.deepEqual(source.reads, [], JSON.stringify(overrides));
  }
});

test('resolve: Keychain ล้มหรือ fingerprint ไม่ตรง = fail closed และข้อความไม่พาค่าออกมา', async () => {
  // error ของ Keychain อาจมีค่าอยู่ในข้อความ — boundary ต้องไม่ส่งต่อทั้งข้อความและ cause
  await rejectsWith(
    new LineCredentialBoundary(
      new RecordingSource(new Error(`security: ${SYNTHETIC_SECRET}`)),
    ).resolve(metadata(), 3, AT),
    'CREDENTIAL_UNAVAILABLE',
  );
  await rejectsWith(
    new LineCredentialBoundary(new RecordingSource('')).resolve(metadata(), 3, AT),
    'CREDENTIAL_UNAVAILABLE',
  );
  // rotation ค้างครึ่งทาง: metadata เป็นของ version ใหม่แต่ Keychain ยังเป็นค่าเก่า
  await rejectsWith(
    new LineCredentialBoundary(new RecordingSource('ค่าเก่าที่ยังไม่ได้หมุน')).resolve(
      metadata(),
      3,
      AT,
    ),
    'CREDENTIAL_UNAVAILABLE',
  );
});

test('fingerprint: sha256 hex 64 ตัว และค่าต่างให้ fingerprint ต่าง', () => {
  const fingerprint = lineSecretFingerprint(SYNTHETIC_SECRET);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, lineSecretFingerprint(SYNTHETIC_SECRET));
  assert.notEqual(fingerprint, lineSecretFingerprint(`${SYNTHETIC_SECRET}x`));
  assert.ok(!fingerprint.includes(SYNTHETIC_SECRET));
});

test('payload guard: field ต้องห้ามถูกปฏิเสธไม่ว่าซ้อนลึกแค่ไหน', () => {
  assert.doesNotThrow(() =>
    assertRedactedPayload({
      deliveryId: 'dlv_1',
      nested: { fingerprint: 'a'.repeat(64), at: new Date() },
      list: [{ outcomeCode: 'LINE_ACCEPTED' }],
    }),
  );
  for (const payload of [
    { userId: 'U' + '0'.repeat(32) },
    { nested: { messages: [] } },
    { list: [{ deep: { channelAccessToken: 'x' } }] },
    { Authorization: 'Bearer x' },
  ]) {
    assert.throws(() => assertRedactedPayload(payload), LineForbiddenFieldError);
  }
});

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const S2_3_SOURCES = [
  'line-control-policy.ts',
  'line-control-plane.ts',
  'line-credential-boundary.ts',
  'line-control-repository.ts',
];

test('negative scan: source ของ control plane ไม่มี SDK/network/credential token และไม่อ่าน env', () => {
  const sources = S2_3_SOURCES.map((name) => readFileSync(resolve(sourceDirectory, name), 'utf8'));
  const scan = scanForForbiddenTokens(sources);
  assert.deepEqual(scan.forbiddenTokensFound, []);
  assert.equal(scan.clean, true);
  for (const [index, text] of sources.entries()) {
    assert.ok(!text.includes('process.env'), S2_3_SOURCES[index]);
    assert.ok(!/\bsecret\s*[:=]\s*['"`]/.test(text), S2_3_SOURCES[index]);
  }
});
