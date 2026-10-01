/**
 * Owner: Delivery/Channels — CLI ของ protected provider runner (S2.6 #366, #360 §C)
 *
 * รันบนเครื่อง macOS ที่ถือ Keychain + local ngrok binding ของ pilot:
 *   pnpm --filter @d-contact/delivery provider:pr01
 * หรือบน runner `line-pilot` ของ UAT ด้วย `LINE_SECRET_SOURCE=file` (#565) — ดู `line-pilot-runtime.ts`
 *
 * input เป็น reference ทั้งหมด (ไม่มี secret): tenant, credential ref, digest ของ webhook endpoint
 * ที่อนุมัติ และ commit ที่คาดไว้ — token อ่านจาก secret source ผ่าน `LineCredentialBoundary` เท่านั้น
 * output คือ sanitized bundle หนึ่งไฟล์ที่ CI ingestion ตรวจซ้ำ; stdout มีแค่ path/digest/status
 *
 * S2.6 รันได้แค่ PR01 (ไม่มี push) — PR02/RB01 เป็นของ S2.7 และต้องมี one-shot approval ใหม่
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
/** probe ยิงไป endpoint ของเราเองเท่านั้น — inject แบบเดียวกับ `HttpLineProviderTransport` */
const http: typeof globalThis.fetch = globalThis.fetch;
const POLL_INTERVAL_MS = 5_000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ต้องตั้ง ${name}`);
  return value;
}

async function main(): Promise<void> {
  const runtime = resolveLinePilotRuntime();
  const tenantId = required('CXA_S2_PILOT_TENANT_ID');
  const credentialRefId = required('CXA_S2_CREDENTIAL_REF_ID');
  const approvedEndpointDigest = required('CXA_S2_APPROVED_WEBHOOK_ENDPOINT_DIGEST');
  const waitSeconds = Number(process.env.CXA_S2_MESSAGE_WAIT_SECONDS ?? 300);

  // bundle ต้องผูกกับ commit ที่ตรวจซ้ำได้: Git = tree clean + ตรง commit ที่คาดไว้ (หรือ origin/main),
  // release = SHA ของ image ตรง commit ที่คาดไว้
  const provenance = runtime.provenance();
  provenance.assertFinalMain(process.env.CXA_S2_EXPECTED_COMMIT_SHA);
  const commitSha = provenance.commitSha;

  const database = new PrismaClient();
  try {
    const credential = await withTenantDatabaseTransaction(database, tenantId, (transaction) =>
      transaction.dlLineCredentialRef.findUnique({ where: { id: credentialRefId } }),
    );
    if (!credential || credential.tenantId !== tenantId) {
      throw new Error('ไม่พบ credential ref ของ tenant นี้');
    }
    if (credential.channelAccountId !== LINE_PILOT_CHANNEL_ACCOUNT_ID) {
      throw new Error('credential ref ไม่ใช่ของ pilot channel');
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
        // เก็บค่า token ไว้ตรวจ exact-value ของ bundle ทั้งก้อนอีกรอบ แล้วล้างทิ้งตอนจบ
        verifyToken: (token) => (secrets.push(token), transport.verifyToken(token)),
        getQuota: (token) => transport.getQuota(token),
        getConsumption: (token) => transport.getConsumption(token),
        validatePush: (request) => transport.validatePush(request),
        push: () => Promise.reject(new Error('PR01 ห้าม push')),
        getWebhookEndpoint: (token) => transport.getWebhookEndpoint(token),
        testWebhookEndpoint: (token) => transport.testWebhookEndpoint(token),
        revokeToken: () => Promise.reject(new Error('PR01 ห้าม revoke')),
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
          `รอ signed message webhook: ส่งข้อความใดก็ได้ถึง OA ทดสอบภายใน ${waitSeconds} วินาที\n`,
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
  // error ของ boundary/runner เป็น machine message อยู่แล้ว — ไม่พิมพ์ stack/cause ที่อาจพาค่าออกมา
  process.stderr.write(`${error instanceof Error ? error.message : 'provider runner ล้มเหลว'}\n`);
  process.exitCode = 1;
});
