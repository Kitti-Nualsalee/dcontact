/**
 * Owner: Delivery/Channels — real-account provider conformance `S2-LINE-PR01` (S2.6 #366)
 *
 * Authority: #360 §B/§D items 1–3, #358 §D/§G, #362 §9
 *
 * PR01 proves that the account/token/quota/payload/webhook are ready "without a single push":
 * - once the token is verified, `client_id` must match the pilot Channel ID and the token lifetime match the policy
 * - quota/consumption is readable and enough remains for a single run
 * - the approved fixture passes `validate/push` (no recipient, no send)
 * - the configured webhook endpoint is active + matches the approved digest, LINE can fire a signed empty webhook
 *   and get `200`, a forged signature gets `401`, and a real signed message webhook passes raw-byte verification
 *
 * the token is used through `LineSecretHandle.use` once for every call of PR01 and then discarded.
 * The evidence returned has only a code/fingerprint/digest — no token, raw channel ID, endpoint URL
 * or message content, and it is always checked with the real secret values (exact-value scan) before being returned
 */
import { createHash } from 'node:crypto';
import { LINE_PILOT_CAPS, LINE_V2_1_TOKEN_MAX_DAYS } from '@d-contact/cxa-contracts';
import {
  assertRedactedPayload,
  type LineCredentialMetadata,
  type LineSecretHandle,
} from './line-credential-boundary.js';
import { evaluateQuotaAdvisory, type LineQuotaAdvisoryStatus } from './line-control-policy.js';
import { lineContentDigest, resolveLineFixture } from './line-push-request.js';
import type { LineProviderTransport } from './line-provider-transport.js';

export const LINE_PROVIDER_CONFORMANCE_CHECK_ID = 'S2-LINE-PR01';
/** Channel ID of the test OA `D-Contact` the pilot is bound to (#356 §2) — the token must answer this `client_id` */
export const LINE_PILOT_CHANNEL_ACCOUNT_ID = '2007056595';

export const LINE_CONFORMANCE_STEPS = [
  'TOKEN_VERIFIED',
  'CREDENTIAL_POLICY',
  'QUOTA_AVAILABLE',
  'PUSH_PAYLOAD_VALID',
  'WEBHOOK_ENDPOINT_BOUND',
  'WEBHOOK_SIGNED_EMPTY_TEST',
  'WEBHOOK_INVALID_SIGNATURE_REJECTED',
  'WEBHOOK_SIGNED_MESSAGE_ACCEPTED',
] as const;
export type LineConformanceStepId = (typeof LINE_CONFORMANCE_STEPS)[number];

/** The reason a step failed as a machine code only — no message from the provider */
export type LineConformanceFailureCode =
  | 'TOKEN_INVALID'
  | 'TOKEN_CLIENT_ID_MISMATCH'
  | 'TOKEN_EXPIRES_BEFORE_RUN'
  | 'CREDENTIAL_KIND_NOT_ACCESS_TOKEN'
  | 'CREDENTIAL_NOT_ACTIVE'
  | 'CREDENTIAL_V2_1_LIFETIME_EXCEEDED'
  | 'CREDENTIAL_LONG_LIVED_WITHOUT_EXCEPTION'
  | `QUOTA_${Exclude<LineQuotaAdvisoryStatus, 'OK'>}`
  | 'PUSH_PAYLOAD_INVALID'
  | 'WEBHOOK_ENDPOINT_INACTIVE'
  | 'WEBHOOK_ENDPOINT_NOT_HTTPS'
  | 'WEBHOOK_ENDPOINT_DIGEST_MISMATCH'
  | 'WEBHOOK_TEST_FAILED'
  | 'WEBHOOK_INVALID_SIGNATURE_ACCEPTED'
  | 'WEBHOOK_SIGNED_MESSAGE_MISSING'
  | 'PROVIDER_CALL_FAILED';

export interface LineConformanceStep {
  id: LineConformanceStepId;
  status: 'PASS' | 'FAIL';
  code?: LineConformanceFailureCode;
}

/** type alias (not an interface) so it can be put into a bundle that accepts evidence as a record */
export type LineProviderConformanceEvidence = {
  type: 'line.provider-conformance';
  checkId: typeof LINE_PROVIDER_CONFORMANCE_CHECK_ID;
  status: 'PASS' | 'FAIL';
  startedAt: string;
  finishedAt: string;
  /** sha256 of the Channel ID — the raw value looks like a phone number so it cannot pass the PII scan and need not be kept */
  channelAccountFingerprint: string;
  token: {
    credentialRefId: string;
    credentialKind: LineCredentialMetadata['credentialKind'];
    version: number;
    fingerprint: string;
    expiresAt: string | null;
    clientIdMatches: boolean;
  };
  quota: {
    type: 'limited' | 'none' | 'unknown';
    targetLimit: number | null;
    totalUsage: number | null;
    advisory: LineQuotaAdvisoryStatus;
  };
  fixture: { contentRef: string; contentDigest: string };
  webhook: {
    endpointDigest: string | null;
    active: boolean;
    testStatusCode: number | null;
    invalidSignatureStatus: number | null;
    signedMessagesAccepted: number;
  };
  steps: LineConformanceStep[];
  /** true = no push at all in PR01 (#360 §A item 3) */
  pushAttempted: false;
};

export interface LineProviderConformanceInput {
  transport: LineProviderTransport;
  /** handle of the access token returned by `LineCredentialBoundary.resolve` — consumed here */
  accessToken: LineSecretHandle;
  credential: LineCredentialMetadata & { longLivedExceptionRef?: string | null };
  channelAccountId: string;
  contentRef: string;
  /** sha256 of the webhook endpoint URL the Platform Operator approved (local ngrok binding) */
  approvedEndpointDigest: string;
  /**
   * Fire a request with a bad signature at our own public endpoint (not LINE) and return the HTTP status
   * — proves that the binding LINE sees really rejects a forged signature. Called only when the endpoint LINE
   * has configured matches the approved digest, so there is no way to fire at another URL
   */
  probeInvalidSignature: (endpoint: string) => Promise<number>;
  /** number of signed message webhooks ingress accepted into the inbox since `since` (read from the tenant's DB) */
  countSignedMessages: (since: Date) => Promise<number>;
  now?: () => Date;
}

export function lineChannelFingerprint(channelAccountId: string): string {
  return createHash('sha256').update(`line-channel|${channelAccountId}`).digest('hex');
}

export function lineWebhookEndpointDigest(endpoint: string): string {
  return createHash('sha256').update(`line-webhook-endpoint|${endpoint}`).digest('hex');
}

const DAY_MS = 24 * 60 * 60 * 1000;

function credentialPolicy(
  credential: LineProviderConformanceInput['credential'],
  at: Date,
): LineConformanceFailureCode | undefined {
  if (
    credential.credentialKind !== 'CHANNEL_ACCESS_TOKEN_V2_1' &&
    credential.credentialKind !== 'CHANNEL_ACCESS_TOKEN_LONG_LIVED'
  ) {
    return 'CREDENTIAL_KIND_NOT_ACCESS_TOKEN';
  }
  if (credential.status !== 'ACTIVE' || credential.revokedAt) return 'CREDENTIAL_NOT_ACTIVE';
  if (credential.credentialKind === 'CHANNEL_ACCESS_TOKEN_LONG_LIVED') {
    return credential.longLivedExceptionRef ? undefined : 'CREDENTIAL_LONG_LIVED_WITHOUT_EXCEPTION';
  }
  if (
    credential.expiresAt === null ||
    credential.expiresAt.getTime() - at.getTime() > LINE_V2_1_TOKEN_MAX_DAYS * DAY_MS
  ) {
    return 'CREDENTIAL_V2_1_LIFETIME_EXCEEDED';
  }
  return undefined;
}

const step = (
  id: LineConformanceStepId,
  failure: LineConformanceFailureCode | undefined,
): LineConformanceStep =>
  failure ? { id, status: 'FAIL', code: failure } : { id, status: 'PASS' };

/**
 * Run every PR01 step even if an earlier step fails so the evidence can say what is ready/not ready
 * — except a provider call that throws, which counts as a FAIL of that step, not silently skipped
 */
export async function runLineProviderConformance(
  input: LineProviderConformanceInput,
): Promise<LineProviderConformanceEvidence> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const fixture = resolveLineFixture(input.contentRef);
  const contentDigest = lineContentDigest(input.contentRef);
  const expectedRunEnd = new Date(
    startedAt.getTime() + LINE_PILOT_CAPS.runAuthorizationTtlMinutes * 60_000,
  );

  const attempt = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch {
      return undefined;
    }
  };

  return input.accessToken.use(async (token) => {
    const verification = await attempt(() => input.transport.verifyToken(token));
    const quota = await attempt(() => input.transport.getQuota(token));
    const consumption = await attempt(() => input.transport.getConsumption(token));
    const quotaObservedAt = now();
    const validation = await attempt(() =>
      input.transport.validatePush({
        accessToken: token,
        messages: fixture.messages as ReadonlyArray<Record<string, unknown>>,
      }),
    );
    const endpoint = await attempt(() => input.transport.getWebhookEndpoint(token));
    const webhookTest = await attempt(() => input.transport.testWebhookEndpoint(token));
    const signedMessages = (await attempt(() => input.countSignedMessages(startedAt))) ?? 0;

    const clientIdMatches = verification?.clientId === input.channelAccountId;
    const tokenFailure: LineConformanceFailureCode | undefined = !verification
      ? 'PROVIDER_CALL_FAILED'
      : !verification.valid
        ? 'TOKEN_INVALID'
        : !clientIdMatches
          ? 'TOKEN_CLIENT_ID_MISMATCH'
          : verification.expiresInSeconds !== undefined &&
              startedAt.getTime() + verification.expiresInSeconds * 1000 <= expectedRunEnd.getTime()
            ? 'TOKEN_EXPIRES_BEFORE_RUN'
            : undefined;

    const quotaType =
      quota?.type === 'limited' || quota?.type === 'none' ? quota.type : ('unknown' as const);
    const advisory: LineQuotaAdvisoryStatus =
      !quota || !consumption || quotaType === 'unknown'
        ? 'UNAVAILABLE'
        : evaluateQuotaAdvisory(
            {
              type: quotaType,
              ...(quota.value !== null ? { targetLimit: quota.value } : {}),
              totalUsage: consumption.totalUsage,
              observedAt: quotaObservedAt,
            },
            now(),
          );

    const endpointDigest = endpoint?.endpoint ? lineWebhookEndpointDigest(endpoint.endpoint) : null;
    const endpointFailure: LineConformanceFailureCode | undefined = !endpoint
      ? 'PROVIDER_CALL_FAILED'
      : !endpoint.active || !endpoint.endpoint
        ? 'WEBHOOK_ENDPOINT_INACTIVE'
        : !endpoint.endpoint.startsWith('https://')
          ? 'WEBHOOK_ENDPOINT_NOT_HTTPS'
          : endpointDigest !== input.approvedEndpointDigest
            ? 'WEBHOOK_ENDPOINT_DIGEST_MISMATCH'
            : undefined;
    const invalidSignatureStatus =
      endpointFailure === undefined && endpoint?.endpoint
        ? ((await attempt(() => input.probeInvalidSignature(endpoint.endpoint!))) ?? null)
        : null;

    const steps: LineConformanceStep[] = [
      step('TOKEN_VERIFIED', tokenFailure),
      step('CREDENTIAL_POLICY', credentialPolicy(input.credential, startedAt)),
      step('QUOTA_AVAILABLE', advisory === 'OK' ? undefined : `QUOTA_${advisory}`),
      step(
        'PUSH_PAYLOAD_VALID',
        !validation
          ? 'PROVIDER_CALL_FAILED'
          : validation.valid
            ? undefined
            : 'PUSH_PAYLOAD_INVALID',
      ),
      step('WEBHOOK_ENDPOINT_BOUND', endpointFailure),
      step(
        'WEBHOOK_SIGNED_EMPTY_TEST',
        webhookTest?.success === true && webhookTest.statusCode === 200
          ? undefined
          : 'WEBHOOK_TEST_FAILED',
      ),
      step(
        'WEBHOOK_INVALID_SIGNATURE_REJECTED',
        invalidSignatureStatus === 401 ? undefined : 'WEBHOOK_INVALID_SIGNATURE_ACCEPTED',
      ),
      step(
        'WEBHOOK_SIGNED_MESSAGE_ACCEPTED',
        signedMessages > 0 ? undefined : 'WEBHOOK_SIGNED_MESSAGE_MISSING',
      ),
    ];

    const evidence: LineProviderConformanceEvidence = {
      type: 'line.provider-conformance',
      checkId: LINE_PROVIDER_CONFORMANCE_CHECK_ID,
      status: steps.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      channelAccountFingerprint: lineChannelFingerprint(input.channelAccountId),
      token: {
        credentialRefId: input.credential.id,
        credentialKind: input.credential.credentialKind,
        version: input.credential.version,
        fingerprint: input.credential.fingerprint,
        expiresAt: input.credential.expiresAt?.toISOString() ?? null,
        clientIdMatches,
      },
      quota: {
        type: quotaType,
        targetLimit: quota?.value ?? null,
        totalUsage: consumption?.totalUsage ?? null,
        advisory,
      },
      fixture: { contentRef: input.contentRef, contentDigest },
      webhook: {
        endpointDigest,
        active: endpoint?.active === true,
        testStatusCode: webhookTest?.statusCode ?? null,
        invalidSignatureStatus,
        signedMessagesAccepted: signedMessages,
      },
      steps,
      pushAttempted: false,
    };
    assertRedactedPayload(evidence);
    assertNoSecretValue(evidence, [token]);
    return evidence;
  });
}

export class LineSecretLeakError extends Error {
  readonly code = 'PII_OR_CREDENTIAL_LEAK';

  constructor() {
    super('the evidence contains a real secret value');
    this.name = 'LineSecretLeakError';
  }
}

/**
 * exact-value scan: the pattern scan in CI does not know the real secret values but the protected runner does, so it can check with
 * the real values before the bundle leaves the machine — the error message does not reveal the location or the value
 */
export function assertNoSecretValue(value: unknown, secrets: readonly string[]): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (secret.length >= 8 && serialized.includes(secret)) throw new LineSecretLeakError();
  }
}
