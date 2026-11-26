/**
 * S2.3 (#367): credential stop condition — a secret value must not leave the provider boundary
 *
 * This suite holds a synthetic "secret" value in the test's own memory, with no real value, no Keychain
 * and no network; what it checks is that the handle/metadata integrity rejects correctly and no value leaks to logs
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

test('handle: the value can be used once and the serialized form contains no secret value', async () => {
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
  // Cannot be reused: the value was discarded from the first time
  await rejectsWith(
    handle.use(() => 'must not reach here'),
    'CREDENTIAL_UNAVAILABLE',
  );
  assert.ok(!JSON.stringify(handle).includes(SYNTHETIC_SECRET));
});

test('handle: a throwing callback still discards the value, and dispose discards without using it', async () => {
  const boundary = new LineCredentialBoundary(new RecordingSource(SYNTHETIC_SECRET));
  const handle = await boundary.resolve(metadata(), 3, AT);
  await assert.rejects(
    handle.use(() => {
      throw new Error('provider failed');
    }),
    /provider failed/,
  );
  assert.equal(handle.consumed, true);

  const second = await boundary.resolve(metadata(), 3, AT);
  second.dispose();
  await rejectsWith(
    second.use(() => 'must not reach here'),
    'CREDENTIAL_UNAVAILABLE',
  );
});

test('resolve: version/status/expiry failing = never touches the Keychain', async () => {
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

test('resolve: Keychain failing or fingerprint mismatch = fail closed and the message carries no value', async () => {
  // A Keychain error may contain the value in its message — the boundary must forward neither the message nor the cause
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
  // Rotation stuck halfway: the metadata is of the new version but the Keychain still holds the old value
  await rejectsWith(
    new LineCredentialBoundary(new RecordingSource('old value that has not been rotated')).resolve(
      metadata(),
      3,
      AT,
    ),
    'CREDENTIAL_UNAVAILABLE',
  );
});

test('fingerprint: 64 sha256 hex characters, and different values give different fingerprints', () => {
  const fingerprint = lineSecretFingerprint(SYNTHETIC_SECRET);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, lineSecretFingerprint(SYNTHETIC_SECRET));
  assert.notEqual(fingerprint, lineSecretFingerprint(`${SYNTHETIC_SECRET}x`));
  assert.ok(!fingerprint.includes(SYNTHETIC_SECRET));
});

test('payload guard: a forbidden field is rejected no matter how deeply nested', () => {
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

test('negative scan: control plane source has no SDK/network/credential token and does not read env', () => {
  const sources = S2_3_SOURCES.map((name) => readFileSync(resolve(sourceDirectory, name), 'utf8'));
  const scan = scanForForbiddenTokens(sources);
  assert.deepEqual(scan.forbiddenTokensFound, []);
  assert.equal(scan.clean, true);
  for (const [index, text] of sources.entries()) {
    assert.ok(!text.includes('process.env'), S2_3_SOURCES[index]);
    assert.ok(!/\bsecret\s*[:=]\s*['"`]/.test(text), S2_3_SOURCES[index]);
  }
});
