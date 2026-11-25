/**
 * Owner: Delivery/Channels — CLI of the protected provider runner (S2.6 #366, #360 §C)
 *
 * Runs on a macOS machine holding the Keychain + the pilot's local ngrok binding:
 *   pnpm --filter @d-contact/delivery provider:pr01
 * or on the UAT `line-pilot` runner with `LINE_SECRET_SOURCE=file` (#565) — see `line-pilot-runtime.ts`
 *
 * Inputs are all references (no secret): tenant, credential ref, digest of the approved webhook endpoint
 * and the expected commit — the token is read from the secret source only through `LineCredentialBoundary`
 * Output is one sanitized bundle file that the CI ingestion re-checks; stdout has only a path/digest/status
 *
 * S2.6 can run only PR01 (no push) — PR02/RB01 belong to S2.7 and need a new one-shot approval
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { LineCredentialBoundary } from './line-credential-boundary.js';
import { resolveLinePilotRuntime } from './line-pilot-runtime.js';
import {
  LINE_PILOT_CHANNEL_ACCOUNT_ID,
  runLineProviderConformance,
} from './line-provider-conformance.js';
import {
  buildLineProviderEvidenceBundle,
  lineHostFingerprint,
} from './line-provider-evidence-bundle.js';
import { HttpLineProviderTransport } from './line-provider-transport.js';

const APPROVED_FIXTURE = 'fixture:service-notification/v1';
/** the probe fires only at our own endpoint — injected the same way as `HttpLineProviderTransport` */
const http: typeof globalThis.fetch = globalThis.fetch;
const POLL_INTERVAL_MS = 5_000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function main(): Promise<void> {
  const runtime = resolveLinePilotRuntime();
  const tenantId = required('CXA_S2_PILOT_TENANT_ID');
  const credentialRefId = required('CXA_S2_CREDENTIAL_REF_ID');
  const approvedEndpointDigest = required('CXA_S2_APPROVED_WEBHOOK_ENDPOINT_DIGEST');
  const waitSeconds = Number(process.env.CXA_S2_MESSAGE_WAIT_SECONDS ?? 300);

  // the bundle must be bound to a commit that can be re-checked: Git = clean tree + matches the expected commit (or origin/main),
  // release = the image SHA matches the expected commit
  const provenance = runtime.provenance();
  provenance.assertFinalMain(process.env.CXA_S2_EXPECTED_COMMIT_SHA);
  const commitSha = provenance.commitSha;

  const database = new PrismaClient();
  try {
    const credential = await withTenantDatabaseTransaction(database, tenantId, (transaction) =>
      transaction.dlLineCredentialRef.findUnique({ where: { id: credentialRefId } }),
    );
    if (!credential || credential.tenantId !== tenantId) {
      throw new Error('credential ref of this tenant not found');
    }
    if (credential.channelAccountId !== LINE_PILOT_CHANNEL_ACCOUNT_ID) {
      throw new Error('the credential ref does not belong to the pilot channel');
    }

    const handle = await new LineCredentialBoundary(runtime.source).resolve(
      credential,
      credential.version,
      new Date(),
    );
    const secrets: string[] = [];
    const transport = new HttpLineProviderTransport();
    const evidence = await runLineProviderConformance({
      transport: {
        // keep the token value for another exact-value check of the whole bundle, then clear it at the end
        verifyToken: (token) => (secrets.push(token), transport.verifyToken(token)),
        getQuota: (token) => transport.getQuota(token),
        getConsumption: (token) => transport.getConsumption(token),
        validatePush: (request) => transport.validatePush(request),
        push: () => Promise.reject(new Error('PR01 must not push')),
        getWebhookEndpoint: (token) => transport.getWebhookEndpoint(token),
        testWebhookEndpoint: (token) => transport.testWebhookEndpoint(token),
        revokeToken: () => Promise.reject(new Error('PR01 must not revoke')),
      },
      accessToken: handle,
      credential,
      channelAccountId: LINE_PILOT_CHANNEL_ACCOUNT_ID,
      contentRef: APPROVED_FIXTURE,
      approvedEndpointDigest,
      probeInvalidSignature: async (endpoint) => {
        const response = await http(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-line-signature': 'invalid' },
          body: JSON.stringify({ destination: '', events: [] }),
        });
        return response.status;
      },
      countSignedMessages: async (since) => {
        process.stderr.write(
          `waiting for a signed message webhook: send any message to the test OA within ${waitSeconds} seconds\n`,
        );
        const deadline = Date.now() + waitSeconds * 1_000;
        for (;;) {
          const count = await withTenantDatabaseTransaction(database, tenantId, (transaction) =>
            transaction.dlLineWebhookInboxEntry.count({
              where: {
                tenantId,
                channelAccountId: LINE_PILOT_CHANNEL_ACCOUNT_ID,
                eventType: 'message',
                receivedAt: { gte: since },
                state: { not: 'QUARANTINED' },
              },
            }),
          );
          if (count > 0 || Date.now() >= deadline) return count;
          await new Promise((resolve_) => setTimeout(resolve_, POLL_INTERVAL_MS));
        }
      },
    });

    const bundle = buildLineProviderEvidenceBundle({
      commitSha,
      generatedAt: new Date(),
      runner: {
        platform: process.platform,
        keychain: runtime.kind === 'keychain',
        hostFingerprint: lineHostFingerprint(hostname()),
        workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      },
      evidence: [evidence],
      secrets,
    });
    secrets.length = 0;

    const runId = process.env.GITHUB_RUN_ID ?? `local-${randomUUID()}`;
    const path = resolve(runtime.bundleDir, `pr01-${runId}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `CXA_S2_PROVIDER_BUNDLE:${JSON.stringify({ path, bundleSha256: bundle.bundleSha256, status: evidence.status, steps: evidence.steps })}\n`,
    );
    if (evidence.status !== 'PASS') process.exitCode = 1;
  } finally {
    await database.$disconnect();
  }
}

main().catch((error: unknown) => {
  // errors from the boundary/runner are already machine messages — print no stack/cause that could carry a value out
  process.stderr.write(`${error instanceof Error ? error.message : 'provider runner failed'}\n`);
  process.exitCode = 1;
});
