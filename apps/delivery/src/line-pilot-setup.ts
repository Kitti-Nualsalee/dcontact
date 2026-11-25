/**
 * Owner: Delivery/Channels — setup steps of the capped pilot that the wizard calls (S2.7 #368)
 *
 *   pnpm --filter @d-contact/delivery pilot:setup <command>
 *
 * - `tenant`                 create/find the dedicated test tenant of the pilot and print the tenant ID
 * - `bot-info`               print the bot user ID (= webhook destination) using the token from the secret source
 * - `endpoint-digest <url>`  print the digest of the approved webhook endpoint
 * - `gate <endpoint-url>`    ensure the scope then promote DISABLED → DRY_RUN → PROVIDER_CONFORMANCE
 * - `credential`             verify the token (client_id must be the pilot Channel ID) → register → activate
 *                            (`CXA_S2_CREDENTIAL_KIND=V2_1|LONG_LIVED`, long-lived needs an exception ref)
 *
 * the token/secret are read from the Keychain or a file (`LINE_SECRET_SOURCE=file` on UAT #565) in memory only
 * and are never printed; stdout has only IDs/digests — on UAT the pilot tenant comes from `uat-provision`, not `tenant`
 * the actor of each command comes from the env `CXA_S2_OPERATOR_REF` and `CXA_S2_COMPLIANCE_REF` (they must not be the same value)
 */
import { createHash } from 'node:crypto';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { LineAuditRepository } from './line-audit-repository.js';
import { LineControlPlane, type LineControlActor } from './line-control-plane.js';
import { LineControlRepository, type LineGateScope } from './line-control-repository.js';
import { lineSecretFingerprint } from './line-credential-boundary.js';
import { lineKeychainServiceName } from './line-keychain-secret-source.js';
import { resolveLinePilotRuntime } from './line-pilot-runtime.js';
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
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function actors(): { operator: LineControlActor; compliance: LineControlActor } {
  const operator = requiredEnv('CXA_S2_OPERATOR_REF');
  const compliance = requiredEnv('CXA_S2_COMPLIANCE_REF');
  if (operator === compliance)
    throw new Error('operator and compliance must be different refs (#358 §E)');
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

/** config digest of the pilot: the whole binding that the allowlist/run authorization must match (#358 §B) */
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
  return resolveLinePilotRuntime().source.read({
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
    if (!userId) throw new Error('cannot read bot info — check the token');
    process.stdout.write(`${userId}\n`);
  },

  async 'endpoint-digest'(_database, url) {
    if (!url?.startsWith('https://')) throw new Error('an https endpoint is required');
    process.stdout.write(`${lineWebhookEndpointDigest(url)}\n`);
  },

  async gate(database, url) {
    if (!url?.startsWith('https://')) throw new Error('an https endpoint is required');
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
        throw new Error(`cannot advance the gate to ${target}: ${JSON.stringify(advanced)}`);
      gate = advanced.value;
    }
    if (gate.configDigest !== configDigest)
      throw new Error('the gate config digest does not match this endpoint');
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
      throw new Error('the token failed verify or its client_id is not the pilot Channel ID');
    }
    const now = new Date();
    // v2.1 (≤30 days) is the recommended value; long-lived needs an approved test-only exception and is revoked after S2
    const kind =
      process.env.CXA_S2_CREDENTIAL_KIND === 'LONG_LIVED'
        ? ('CHANNEL_ACCESS_TOKEN_LONG_LIVED' as const)
        : ('CHANNEL_ACCESS_TOKEN_V2_1' as const);
    const exceptionRef = process.env.CXA_S2_LONG_LIVED_EXCEPTION_REF;
    if (kind === 'CHANNEL_ACCESS_TOKEN_LONG_LIVED' && !exceptionRef) {
      throw new Error('a long-lived token needs CXA_S2_LONG_LIVED_EXCEPTION_REF (#358 §G)');
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
        throw new Error(`cannot activate: ${JSON.stringify(activated)}`);
    }
    process.stdout.write(`${credential.id}\n`);
  },
};

async function main(): Promise<void> {
  const command = commands[process.argv[2] ?? ''];
  if (!command) throw new Error(`supported commands: ${Object.keys(commands).join(', ')}`);
  const database = new PrismaClient();
  try {
    await command(database, process.argv[3]);
  } finally {
    await database.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'pilot setup failed'}\n`);
  process.exitCode = 1;
});
