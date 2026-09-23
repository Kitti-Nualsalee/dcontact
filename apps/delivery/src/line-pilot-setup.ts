/**
 * Owner: Delivery/Channels — ขั้น setup ของ capped pilot ที่ wizard เรียก (S2.7 #368)
 *
 *   pnpm --filter @d-contact/delivery pilot:setup <command>
 *
 * - `tenant`                 สร้าง/หา dedicated test tenant ของ pilot แล้วพิมพ์ tenant ID
 * - `bot-info`               พิมพ์ bot user ID (= webhook destination) โดยใช้ token จาก Keychain
 * - `endpoint-digest <url>`  พิมพ์ digest ของ webhook endpoint ที่อนุมัติ
 * - `gate <endpoint-url>`    ensure scope แล้วเลื่อน DISABLED → DRY_RUN → PROVIDER_CONFORMANCE
 * - `credential`             verify token (client_id ต้องเป็น Channel ID ของ pilot) → register → activate
 *                            (`CXA_S2_CREDENTIAL_KIND=V2_1|LONG_LIVED`, long-lived ต้องมี exception ref)
 *
 * token/secret อ่านจาก Keychain ในหน่วยความจำเท่านั้นและไม่ถูกพิมพ์; stdout มีแค่ ID/digest
 * actor ของแต่ละคำสั่งมาจาก env `CXA_S2_OPERATOR_REF` และ `CXA_S2_COMPLIANCE_REF` (ห้ามเป็นค่าเดียวกัน)
 */
import { createHash } from 'node:crypto';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { LineAuditRepository } from './line-audit-repository.js';
import { LineControlPlane, type LineControlActor } from './line-control-plane.js';
import { LineControlRepository, type LineGateScope } from './line-control-repository.js';
import { lineSecretFingerprint } from './line-credential-boundary.js';
import {
  KeychainLineSecretSource,
  lineKeychainServiceName,
} from './line-keychain-secret-source.js';
import {
  LINE_PILOT_CHANNEL_ACCOUNT_ID,
  lineWebhookEndpointDigest,
} from './line-provider-conformance.js';
import { HttpLineProviderTransport } from './line-provider-transport.js';
import { lineContentDigest } from './line-push-request.js';

const TENANT_SLUG = 's2-line-pilot';
const FIXTURE_REF = 'fixture:service-notification/v1';
const TOKEN_ACCOUNT = 'channel-access-token';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ต้องตั้ง ${name}`);
  return value;
}

function actors(): { operator: LineControlActor; compliance: LineControlActor } {
  const operator = requiredEnv('CXA_S2_OPERATOR_REF');
  const compliance = requiredEnv('CXA_S2_COMPLIANCE_REF');
  if (operator === compliance)
    throw new Error('operator กับ compliance ต้องเป็นคนละ ref (#358 §E)');
  return {
    operator: { role: 'PLATFORM_OPERATOR', ref: operator },
    compliance: { role: 'COMPLIANCE', ref: compliance },
  };
}

function scope(tenantId: string): LineGateScope {
  return {
    tenantId,
    channelAccountId: LINE_PILOT_CHANNEL_ACCOUNT_ID,
    senderIdentityId: requiredEnv('CXA_S2_PILOT_SENDER'),
    purpose: 'SERVICE_NOTIFICATION',
    contactKind: 'SERVICE',
  };
}

/** config digest ของ pilot: binding ทั้งชุดที่ allowlist/run authorization ต้องตรงกัน (#358 §B) */
export function linePilotConfigDigest(input: {
  scope: LineGateScope;
  endpointDigest: string;
}): string {
  const canonical = [
    ['profile', 'S2_LINE_LOCAL_PILOT_V1'],
    ['channelAccountId', input.scope.channelAccountId],
    ['senderIdentityId', input.scope.senderIdentityId],
    ['purpose', input.scope.purpose],
    ['contactKind', input.scope.contactKind],
    ['contentDigest', lineContentDigest(FIXTURE_REF)],
    ['endpointDigest', input.endpointDigest],
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function readToken(): Promise<string> {
  return new KeychainLineSecretSource().read({
    keychainService: lineKeychainServiceName(LINE_PILOT_CHANNEL_ACCOUNT_ID),
    keychainAccount: TOKEN_ACCOUNT,
  });
}

const commands: Record<string, (database: PrismaClient, argument?: string) => Promise<void>> = {
  async tenant(database) {
    const existing = await database.tenant.findFirst({ where: { slug: TENANT_SLUG } });
    const tenant =
      existing ??
      (await database.tenant.create({
        data: {
          name: 'S2 LINE pilot (test)',
          slug: TENANT_SLUG,
          sipDomain: `${TENANT_SLUG}.local`,
        },
      }));
    process.stdout.write(`${tenant.id}\n`);
  },

  async 'bot-info'() {
    const { userId } = await new HttpLineProviderTransport().getBotInfo(await readToken());
    if (!userId) throw new Error('อ่าน bot info ไม่ได้ — ตรวจ token');
    process.stdout.write(`${userId}\n`);
  },

  async 'endpoint-digest'(_database, url) {
    if (!url?.startsWith('https://')) throw new Error('ต้องระบุ endpoint แบบ https');
    process.stdout.write(`${lineWebhookEndpointDigest(url)}\n`);
  },

  async gate(database, url) {
    if (!url?.startsWith('https://')) throw new Error('ต้องระบุ endpoint แบบ https');
    const tenantId = requiredEnv('CXA_S2_PILOT_TENANT_ID');
    const { operator, compliance } = actors();
    const control = new LineControlPlane({
      control: new LineControlRepository(database),
      audit: new LineAuditRepository(database),
    });
    const configDigest = linePilotConfigDigest({
      scope: scope(tenantId),
      endpointDigest: lineWebhookEndpointDigest(url),
    });
    let gate = await control.ensureScope(operator, scope(tenantId));
    for (const target of ['DRY_RUN', 'PROVIDER_CONFORMANCE'] as const) {
      if (
        gate.businessState === target ||
        (target === 'DRY_RUN' && gate.businessState !== 'DISABLED')
      ) {
        continue;
      }
      const advanced = await control.advanceState(
        compliance,
        gate,
        target,
        configDigest,
        new Date(),
      );
      if (advanced.status !== 'APPLIED')
        throw new Error(`เลื่อน gate ไป ${target} ไม่ได้: ${JSON.stringify(advanced)}`);
      gate = advanced.value;
    }
    if (gate.configDigest !== configDigest)
      throw new Error('config digest ของ gate ไม่ตรง endpoint นี้');
    process.stdout.write(
      `${JSON.stringify({ gateId: gate.id, state: gate.businessState, configDigest })}\n`,
    );
  },

  async credential(database) {
    const tenantId = requiredEnv('CXA_S2_PILOT_TENANT_ID');
    const { operator } = actors();
    const control = new LineControlPlane({
      control: new LineControlRepository(database),
      audit: new LineAuditRepository(database),
    });
    const token = await readToken();
    const verification = await new HttpLineProviderTransport().verifyToken(token);
    if (!verification.valid || verification.clientId !== LINE_PILOT_CHANNEL_ACCOUNT_ID) {
      throw new Error('token ไม่ผ่าน verify หรือ client_id ไม่ใช่ Channel ID ของ pilot');
    }
    const now = new Date();
    // v2.1 (≤30 วัน) เป็นค่าแนะนำ; long-lived ต้องมี approved test-only exception และ revoke หลัง S2
    const kind =
      process.env.CXA_S2_CREDENTIAL_KIND === 'LONG_LIVED'
        ? ('CHANNEL_ACCESS_TOKEN_LONG_LIVED' as const)
        : ('CHANNEL_ACCESS_TOKEN_V2_1' as const);
    const exceptionRef = process.env.CXA_S2_LONG_LIVED_EXCEPTION_REF;
    if (kind === 'CHANNEL_ACCESS_TOKEN_LONG_LIVED' && !exceptionRef) {
      throw new Error('long-lived token ต้องมี CXA_S2_LONG_LIVED_EXCEPTION_REF (#358 §G)');
    }
    const fingerprint = lineSecretFingerprint(token);
    const existing = await withTenantDatabaseTransaction(database, tenantId, (transaction) =>
      transaction.dlLineCredentialRef.findMany({
        where: { tenantId, channelAccountId: LINE_PILOT_CHANNEL_ACCOUNT_ID },
        orderBy: { version: 'desc' },
      }),
    );
    const same = existing.find(
      (row) => row.fingerprint === fingerprint && row.status !== 'REVOKED',
    );
    const credential =
      same ??
      (await control.registerCredential(
        operator,
        {
          tenantId,
          channelAccountId: LINE_PILOT_CHANNEL_ACCOUNT_ID,
          credentialKind: kind,
          ...(kind === 'CHANNEL_ACCESS_TOKEN_LONG_LIVED'
            ? { longLivedExceptionRef: exceptionRef! }
            : {}),
          version: (existing[0]?.version ?? 0) + 1,
          keychainService: lineKeychainServiceName(LINE_PILOT_CHANNEL_ACCOUNT_ID),
          keychainAccount: TOKEN_ACCOUNT,
          fingerprint,
          issuedAt: now,
          ...(verification.expiresInSeconds
            ? { expiresAt: new Date(now.getTime() + verification.expiresInSeconds * 1000) }
            : {}),
        },
        now,
      ));
    if (credential.status !== 'ACTIVE') {
      const activated = await control.verifyAndActivateCredential(
        operator,
        tenantId,
        credential.id,
        { channelAccountId: verification.clientId, verifiedAt: now },
        now,
      );
      if (activated.status !== 'APPLIED')
        throw new Error(`activate ไม่ได้: ${JSON.stringify(activated)}`);
    }
    process.stdout.write(`${credential.id}\n`);
  },
};

async function main(): Promise<void> {
  const command = commands[process.argv[2] ?? ''];
  if (!command) throw new Error(`คำสั่งที่รองรับ: ${Object.keys(commands).join(', ')}`);
  const database = new PrismaClient();
  try {
    await command(database, process.argv[3]);
  } finally {
    await database.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'pilot setup ล้มเหลว'}\n`);
  process.exitCode = 1;
});
