import assert from 'node:assert/strict';
import test from 'node:test';
import type { LineCredentialMetadata } from './line-credential-boundary.js';
import { LineSecretHandle } from './line-credential-boundary.js';
import {
  assertNoSecretValue,
  LINE_CONFORMANCE_STEPS,
  LINE_PILOT_CHANNEL_ACCOUNT_ID,
  lineWebhookEndpointDigest,
  runLineProviderConformance,
  type LineProviderConformanceInput,
} from './line-provider-conformance.js';
import type {
  LinePushRequest,
  LineProviderTransport,
  LineTransportResult,
} from './line-provider-transport.js';

const TOKEN = 'synthetic-conformance-token-value';
const ENDPOINT = 'https://pilot.example.test/webhook/line';
const NOW = new Date('2026-09-23T10:00:00.000Z');

/** PR01 provider double: records every call and has no usable push */
class ConformanceDouble implements LineProviderTransport {
  readonly calls: string[] = [];
  clientId = LINE_PILOT_CHANNEL_ACCOUNT_ID;
  quota = { type: 'limited', value: 200 as number | null };
  usage = 1;
  endpoint: string | null = ENDPOINT;
  webhookStatus = 200;

  async verifyToken(accessToken: string) {
    this.calls.push(`verify:${accessToken === TOKEN}`);
    return { valid: true, clientId: this.clientId, expiresInSeconds: 20 * 86_400 };
  }
  async getQuota() {
    this.calls.push('quota');
    return this.quota;
  }
  async getConsumption() {
    this.calls.push('consumption');
    return { totalUsage: this.usage };
  }
  async validatePush(request: Pick<LinePushRequest, 'messages' | 'accessToken'>) {
    this.calls.push(`validate:${request.messages.length}`);
    return { valid: true };
  }
  async push(): Promise<LineTransportResult> {
    this.calls.push('push');
    throw new Error('PR01 must not push');
  }
  async getWebhookEndpoint() {
    this.calls.push('endpoint');
    return { endpoint: this.endpoint, active: this.endpoint !== null };
  }
  async testWebhookEndpoint() {
    this.calls.push('webhook-test');
    return { success: this.webhookStatus === 200, statusCode: this.webhookStatus };
  }
  async revokeToken() {
    this.calls.push('revoke');
    return { revoked: false, httpStatus: null };
  }
}

const credential = (
  overrides: Partial<LineCredentialMetadata & { longLivedExceptionRef: string | null }> = {},
) => ({
  id: '00000000-0000-4000-8000-000000000001',
  version: 3,
  credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1' as const,
  status: 'ACTIVE' as const,
  keychainService: 'd-contact.line.2007056595',
  keychainAccount: 'channel-access-token',
  fingerprint: 'f'.repeat(64),
  expiresAt: new Date('2026-10-10T00:00:00.000Z'),
  revokedAt: null,
  ...overrides,
});

function input(
  transport: ConformanceDouble,
  overrides: Partial<LineProviderConformanceInput> = {},
): LineProviderConformanceInput & { probes: string[] } {
  const probes: string[] = [];
  return {
    transport,
    accessToken: new LineSecretHandle(TOKEN, 'ref', 3, 'f'.repeat(64)),
    credential: credential(),
    channelAccountId: LINE_PILOT_CHANNEL_ACCOUNT_ID,
    contentRef: 'fixture:service-notification/v1',
    approvedEndpointDigest: lineWebhookEndpointDigest(ENDPOINT),
    probeInvalidSignature: async (endpoint) => (probes.push(endpoint), 401),
    countSignedMessages: async () => 1,
    now: () => NOW,
    probes,
    ...overrides,
  };
}

const failed = (evidence: { steps: Array<{ id: string; status: string; code?: string }> }) =>
  evidence.steps.filter((step) => step.status === 'FAIL').map((step) => `${step.id}:${step.code}`);

test('S2-LINE-PR01: a fully ready account = PASS on every step with no push and no token value in the evidence', async () => {
  const transport = new ConformanceDouble();
  const request = input(transport);
  const evidence = await runLineProviderConformance(request);
  assert.equal(evidence.status, 'PASS');
  assert.deepEqual(
    evidence.steps.map((step) => step.id),
    [...LINE_CONFORMANCE_STEPS],
  );
  assert.ok(!transport.calls.includes('push'));
  assert.equal(evidence.pushAttempted, false);
  assert.deepEqual(request.probes, [ENDPOINT]);
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!serialized.includes(LINE_PILOT_CHANNEL_ACCOUNT_ID));
  assert.ok(!serialized.includes(ENDPOINT));
  assert.ok(!serialized.includes('แจ้งเตือน')); // allow-thai: asserts the Thai fixture message body is absent from evidence
  assert.equal(transport.calls[0], 'verify:true');
});

test('S2-LINE-PR01: the token is single-use — the handle is consumed after PR01', async () => {
  const request = input(new ConformanceDouble());
  await runLineProviderConformance(request);
  assert.equal(request.accessToken.consumed, true);
  await assert.rejects(() => runLineProviderConformance(request));
});

test('S2-LINE-PR01: client_id not matching the pilot Channel ID = FAIL', async () => {
  const transport = new ConformanceDouble();
  transport.clientId = '1234567890';
  const evidence = await runLineProviderConformance(input(transport));
  assert.equal(evidence.status, 'FAIL');
  assert.deepEqual(failed(evidence), ['TOKEN_VERIFIED:TOKEN_CLIENT_ID_MISMATCH']);
  assert.equal(evidence.token.clientIdMatches, false);
});

test('S2-LINE-PR01: insufficient remaining quota or unreadable quota = fail closed', async () => {
  const exhausted = new ConformanceDouble();
  exhausted.usage = 200;
  assert.deepEqual(failed(await runLineProviderConformance(input(exhausted))), [
    'QUOTA_AVAILABLE:QUOTA_EXHAUSTED',
  ]);
  const unknown = new ConformanceDouble();
  unknown.quota = { type: 'mystery', value: null };
  assert.deepEqual(failed(await runLineProviderConformance(input(unknown))), [
    'QUOTA_AVAILABLE:QUOTA_UNAVAILABLE',
  ]);
});

test('S2-LINE-PR01: an endpoint set at LINE that does not match the approved digest = that URL is never probed', async () => {
  const transport = new ConformanceDouble();
  transport.endpoint = 'https://other.example.test/webhook/line';
  const request = input(transport);
  const evidence = await runLineProviderConformance(request);
  assert.deepEqual(failed(evidence), [
    'WEBHOOK_ENDPOINT_BOUND:WEBHOOK_ENDPOINT_DIGEST_MISMATCH',
    'WEBHOOK_INVALID_SIGNATURE_REJECTED:WEBHOOK_INVALID_SIGNATURE_ACCEPTED',
  ]);
  assert.deepEqual(request.probes, []);
});

test('S2-LINE-PR01: a webhook test not 200, a forged signature that passes, or no signed message = FAIL', async () => {
  const transport = new ConformanceDouble();
  transport.webhookStatus = 500;
  const evidence = await runLineProviderConformance(
    input(transport, {
      probeInvalidSignature: async () => 200,
      countSignedMessages: async () => 0,
    }),
  );
  assert.deepEqual(failed(evidence), [
    'WEBHOOK_SIGNED_EMPTY_TEST:WEBHOOK_TEST_FAILED',
    'WEBHOOK_INVALID_SIGNATURE_REJECTED:WEBHOOK_INVALID_SIGNATURE_ACCEPTED',
    'WEBHOOK_SIGNED_MESSAGE_ACCEPTED:WEBHOOK_SIGNED_MESSAGE_MISSING',
  ]);
});

test('S2-LINE-PR01: a provider call that throws is a FAIL of that step, not skipped', async () => {
  const transport = new ConformanceDouble();
  transport.verifyToken = async () => {
    throw new Error(`network ${TOKEN}`);
  };
  const evidence = await runLineProviderConformance(input(transport));
  assert.deepEqual(failed(evidence), ['TOKEN_VERIFIED:PROVIDER_CALL_FAILED']);
  assert.ok(!JSON.stringify(evidence).includes(TOKEN));
});

test('S2-LINE-PR01: v2.1 over 30 days and long-lived without an exception fail the credential policy', async () => {
  const tooLong = await runLineProviderConformance(
    input(new ConformanceDouble(), {
      credential: credential({ expiresAt: new Date('2026-12-01T00:00:00.000Z') }),
    }),
  );
  assert.deepEqual(failed(tooLong), ['CREDENTIAL_POLICY:CREDENTIAL_V2_1_LIFETIME_EXCEEDED']);
  const longLived = await runLineProviderConformance(
    input(new ConformanceDouble(), {
      credential: credential({
        credentialKind: 'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
        expiresAt: null,
      }),
    }),
  );
  assert.deepEqual(failed(longLived), [
    'CREDENTIAL_POLICY:CREDENTIAL_LONG_LIVED_WITHOUT_EXCEPTION',
  ]);
});

test('S2-LINE-OB02: the exact-value scan catches a real secret in evidence without revealing the value', () => {
  assert.throws(
    () => assertNoSecretValue({ nested: [`x${TOKEN}y`] }, [TOKEN]),
    (error: Error) => error.message.includes('secret') && !error.message.includes(TOKEN),
  );
  assert.doesNotThrow(() => assertNoSecretValue({ nested: ['clean'] }, [TOKEN]));
});
