/**
 * Owner: Delivery/Channels — CLI ของ capped pilot บน protected runner (S2.7 #368, #360 §C/§D)
 *
 *   pnpm --filter @d-contact/delivery pilot <command> [--flag value]
 *
 * ลำดับ (แต่ละคำสั่งคือคนละ role ตาม #358 §E):
 *   capture-recipient --since <iso>                      Platform Operator — recipient จาก signed webhook
 *   allowlist --actor <ref> --recipient-ref <ref> --recipient-fingerprint <hex> --approval-audit-ref <ref>
 *                                                        Tenant Admin
 *   propose --actor <ref> --contact-id <uuid> [--identity-id <uuid>]
 *                                                        Platform Operator — reserve + enqueue + proposal view
 *   approve --role TENANT_ADMIN|COMPLIANCE --actor <ref> --digest <presentationDigest>
 *   send --actor <ref> --digest <presentationDigest>     Platform Operator — push 1 ใบ + replay probe 409
 *   await-touch [--timeout-minutes <n>]                  worker + รอ quoted reply → PR02 evidence
 *   rollback --actor <ref>                               Platform Operator — RB01
 *   bundle                                               sanitized bundle ของ PR02 + RB01
 *
 * env มีแค่ reference: `CXA_S2_PILOT_TENANT_ID`, `CXA_S2_CREDENTIAL_REF_ID`, `CXA_S2_PILOT_SENDER`
 * secret/recipient อ่านจาก Keychain เท่านั้น; state ระหว่างขั้นเก็บ ID/digest (ไม่มี PII) ใน
 * `artifacts/cxa-s2/pilot/state.json` และ `send` ยิงได้เฉพาะเมื่อ digest ที่พิมพ์ตรง proposal ทุกตัวอักษร
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import {
  actionKey as toActionKey,
  contactId as toContactId,
  identityId as toIdentityId,
  reservationId as toReservationId,
  tenantId as toTenantId,
} from '@d-contact/cxa-contracts';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { LineAuditRepository } from './line-audit-repository.js';
import { LineControlPlane, type LineControlActor } from './line-control-plane.js';
import type { LineGateScope } from './line-control-repository.js';
import { LineControlRepository } from './line-control-repository.js';
import { LineDeliveryEnqueue } from './line-delivery-enqueue.js';
import {
  captureLineRecipientFromWebhook,
  KeychainLineAccessTokenResolver,
  KeychainLineRecipientResolver,
} from './line-keychain-resolvers.js';
import {
  KeychainLineSecretSource,
  KeychainLineSecretWriter,
  lineKeychainServiceName,
} from './line-keychain-secret-source.js';
import { LineOutboundAdapter, type LineSubmitCommand } from './line-outbound-adapter.js';
import {
  buildLineCappedPilotEvidence,
  runLineReplayProbe,
  runLineRollbackDrill,
  type LineReplayProbeEvidence,
} from './line-pilot-drills.js';
import { LINE_PILOT_CHANNEL_ACCOUNT_ID } from './line-provider-conformance.js';
import {
  buildLineProviderEvidenceBundle,
  lineHostFingerprint,
  type LineProviderCheckEvidence,
} from './line-provider-evidence-bundle.js';
import { HttpLineProviderTransport } from './line-provider-transport.js';
import { lineContentDigest } from './line-push-request.js';
import {
  buildLineRunProposalView,
  lineProposalApprovalMatches,
  lineRunProposalEvidence,
  renderLineRunProposal,
  type LineRunProposalView,
} from './line-run-proposal-view.js';
import { LineTouchGovernanceAdapter } from './line-touch-governance.js';
import { EncryptedLineWebhookPayloadVault } from './line-webhook-payload-vault.js';
import { resolveLineWebhookSecrets } from './line-webhook-secrets.js';
import { LineWebhookWorker } from './line-webhook-worker.js';

const FIXTURE_REF = 'fixture:service-notification/v1';
const PURPOSE = 'SERVICE_NOTIFICATION';
const CONTACT_KIND = 'SERVICE';
const REPOSITORY_ROOT = resolve(process.cwd(), '../..');
const STATE_PATH = resolve(REPOSITORY_ROOT, 'artifacts/cxa-s2/pilot/state.json');

interface PilotState {
  runAuthorizationId?: string;
  deliveryId?: string;
  reservationId?: string;
  recipientProtectedRef?: string;
  recipientFingerprint?: string;
  quota?: {
    type: 'limited' | 'none';
    targetLimit: number | null;
    totalUsage: number;
    observedAt: string;
  };
  capUsage?: { recipientLast24h: number; last24h: number; lifetime: number };
  finalMainSha?: string;
  presentationDigest?: string;
  proposalEvidence?: ReturnType<typeof lineRunProposalEvidence>;
  probe?: LineReplayProbeEvidence;
  pr02?: LineProviderCheckEvidence;
  rb01?: LineProviderCheckEvidence;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function requiredFlag(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`ต้องระบุ --${name}`);
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ต้องตั้ง ${name}`);
  return value;
}

function readState(): PilotState {
  return existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as PilotState) : {};
}

function writeState(state: PilotState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function git(arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function migrationsDigest(): string {
  const directory = resolve(REPOSITORY_ROOT, 'packages/db/prisma/migrations');
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map(
      (name) =>
        `${name}:${sha256(readFileSync(resolve(directory, name, 'migration.sql'), 'utf8'))}`,
    );
  return sha256(entries.join('\n'));
}

function actor(role: LineControlActor['role']): LineControlActor {
  return { role, ref: requiredFlag('actor') };
}

function pilot() {
  const database = new PrismaClient();
  const tenantId = requiredEnv('CXA_S2_PILOT_TENANT_ID');
  const scope: LineGateScope = {
    tenantId,
    channelAccountId: LINE_PILOT_CHANNEL_ACCOUNT_ID,
    senderIdentityId: requiredEnv('CXA_S2_PILOT_SENDER'),
    purpose: PURPOSE,
    contactKind: CONTACT_KIND,
  };
  const source = new KeychainLineSecretSource();
  const repository = new LineControlRepository(database);
  const control = new LineControlPlane({
    control: repository,
    audit: new LineAuditRepository(database),
  });
  const governance = new ContactGovernanceService(database);
  return {
    database,
    tenantId,
    scope,
    source,
    repository,
    control,
    governance,
    transport: new HttpLineProviderTransport(),
    recipients: new KeychainLineRecipientResolver(database, source),
    credentials: new KeychainLineAccessTokenResolver(database, source),
    credentialRefId: requiredEnv('CXA_S2_CREDENTIAL_REF_ID'),
  };
}

type Pilot = ReturnType<typeof pilot>;

async function gateOf(p: Pilot) {
  const gate = await p.control.findGate(p.scope);
  if (!gate?.configDigest)
    throw new Error('gate ของ pilot ยังไม่ถึง PROVIDER_CONFORMANCE (ไม่มี config digest)');
  return gate;
}

async function payloadVault(p: Pilot) {
  const secrets = await resolveLineWebhookSecrets({
    mode: 'keychain',
    channelAccountId: LINE_PILOT_CHANNEL_ACCOUNT_ID,
    source: p.source,
  });
  const keyRef = requiredEnv('LINE_WEBHOOK_PAYLOAD_KEY_REF');
  return new EncryptedLineWebhookPayloadVault(p.database, {
    key: (ref) => (ref === keyRef ? secrets.payloadKey : undefined),
  });
}

/** view ต้องสร้างซ้ำได้ตรงทุก byte จาก state + DB — ใช้ทั้งตอนแสดงและตอนตรวจ digest ก่อนอนุมัติ/ส่ง */
async function proposalView(p: Pilot, state: PilotState): Promise<LineRunProposalView> {
  if (!state.runAuthorizationId || !state.quota || !state.capUsage || !state.finalMainSha) {
    throw new Error('ยังไม่มี proposal — รัน propose ก่อน');
  }
  const run = await p.repository.findRun(p.tenantId, state.runAuthorizationId);
  if (!run) throw new Error('ไม่พบ run authorization');
  const gate = await gateOf(p);
  const entry = await withTenantDatabaseTransaction(p.database, p.tenantId, (transaction) =>
    transaction.dlLineAllowlistEntry.findFirstOrThrow({ where: { id: run.allowlistEntryId } }),
  );
  const credential = await withTenantDatabaseTransaction(p.database, p.tenantId, (transaction) =>
    transaction.dlLineCredentialRef.findFirstOrThrow({ where: { id: run.credentialRefId } }),
  );
  const outbox = await withTenantDatabaseTransaction(p.database, p.tenantId, (transaction) =>
    transaction.dlOutboxEntry.findFirstOrThrow({ where: { deliveryId: state.deliveryId } }),
  );
  return buildLineRunProposalView({
    finalMainSha: state.finalMainSha,
    digests: {
      config: gate.configDigest!,
      migrations: migrationsDigest(),
      registry: sha256(
        readFileSync(resolve(REPOSITORY_ROOT, 'scripts/cxa-s2-readiness.mjs'), 'utf8'),
      ),
    },
    run,
    gate,
    allowlistEntry: entry,
    credential,
    capUsage: state.capUsage,
    quota: { ...state.quota, observedAt: new Date(state.quota.observedAt) },
    retryKey: outbox.providerRequestKey,
  });
}

function submitCommand(
  p: Pilot,
  state: PilotState,
  quota?: PilotState['quota'],
): LineSubmitCommand {
  if (
    !state.deliveryId ||
    !state.runAuthorizationId ||
    !state.recipientFingerprint ||
    !state.recipientProtectedRef
  ) {
    throw new Error('state ไม่ครบ — รัน propose ก่อน');
  }
  const observed = quota ?? state.quota;
  return {
    tenantId: p.tenantId,
    deliveryId: state.deliveryId,
    scope: p.scope,
    runAuthorizationId: state.runAuthorizationId,
    recipientFingerprint: state.recipientFingerprint,
    recipientProtectedRef: state.recipientProtectedRef,
    correlationId: `s2-pilot-${state.deliveryId}`,
    ...(observed
      ? {
          quota: {
            type: observed.type,
            ...(observed.targetLimit !== null ? { targetLimit: observed.targetLimit } : {}),
            totalUsage: observed.totalUsage,
            observedAt: new Date(observed.observedAt),
          },
        }
      : {}),
  };
}

async function quotaSnapshot(p: Pilot) {
  const token = await p.credentials.resolve({
    tenantId: p.tenantId,
    credentialRefId: p.credentialRefId,
    version: (
      await withTenantDatabaseTransaction(p.database, p.tenantId, (transaction) =>
        transaction.dlLineCredentialRef.findFirstOrThrow({ where: { id: p.credentialRefId } }),
      )
    ).version,
  });
  if (!token) throw new Error('อ่าน access token จาก Keychain ไม่ได้');
  const quota = await p.transport.getQuota(token.accessToken);
  const consumption = await p.transport.getConsumption(token.accessToken);
  if (quota.type !== 'limited' && quota.type !== 'none') throw new Error('อ่าน quota ไม่ได้');
  return {
    type: quota.type,
    targetLimit: quota.value,
    totalUsage: consumption.totalUsage,
    observedAt: new Date().toISOString(),
  } as const;
}

const commands: Record<string, (p: Pilot) => Promise<void>> = {
  async 'capture-recipient'(p) {
    const captured = await captureLineRecipientFromWebhook({
      database: p.database,
      vault: await payloadVault(p),
      writer: new KeychainLineSecretWriter(),
      tenantId: p.tenantId,
      channelAccountId: LINE_PILOT_CHANNEL_ACCOUNT_ID,
      since: new Date(requiredFlag('since')),
    });
    if (!captured) throw new Error('ไม่พบ signed message webhook แบบ one-to-one หลังเวลาที่ระบุ');
    writeState({ ...readState(), ...captured });
    process.stdout.write(`${JSON.stringify(captured)}\n`);
  },

  async allowlist(p) {
    const gate = await gateOf(p);
    const now = new Date();
    const entry = await p.control.registerAllowlistEntry(
      actor('TENANT_ADMIN'),
      {
        tenantId: p.tenantId,
        gateId: gate.id,
        scope: p.scope,
        recipientFingerprint: requiredFlag('recipient-fingerprint'),
        recipientProtectedRef: requiredFlag('recipient-ref'),
        contentRef: FIXTURE_REF,
        contentDigest: lineContentDigest(FIXTURE_REF),
        configDigest: gate.configDigest!,
        validFrom: now,
        validUntil: new Date(now.getTime() + 7 * 86_400_000),
        approvalAuditRef: requiredFlag('approval-audit-ref'),
      },
      now,
    );
    process.stdout.write(`${JSON.stringify({ allowlistEntryId: entry.id })}\n`);
  },

  async propose(p) {
    const state = readState();
    if (!state.recipientProtectedRef || !state.recipientFingerprint) {
      throw new Error('ยังไม่มี recipient — รัน capture-recipient และ allowlist ก่อน');
    }
    if (git(['status', '--porcelain', '--untracked-files=no']) !== '')
      throw new Error('working tree ไม่ clean');
    const finalMainSha = git(['rev-parse', 'HEAD']);
    if (finalMainSha !== git(['rev-parse', 'origin/main']))
      throw new Error('HEAD ไม่ใช่ final main');

    const gate = await gateOf(p);
    const operator = actor('PLATFORM_OPERATOR');
    const contactId = requiredFlag('contact-id');
    const identityId = flag('identity-id');
    const actionKey = `s2-pilot-${randomUUID()}`;
    const correlationId = `s2-pilot-${actionKey}`;
    const decision = await p.governance.authorizeAndReserve(toTenantId(p.tenantId), {
      contactId,
      ...(identityId ? { identityId } : {}),
      channel: 'LINE',
      purpose: PURPOSE,
      contactKind: CONTACT_KIND,
      senderIdentityId: p.scope.senderIdentityId,
      source: 'S2_PILOT',
      sourceId: actionKey,
      actionKey,
      policyVersion: 1,
    });
    if (decision.decision !== 'ALLOW' || !decision.reservationId) {
      throw new Error(`Governance ไม่อนุญาต: ${decision.decision}/${decision.reasonCode}`);
    }
    const queued = await new LineDeliveryEnqueue(p.database, p.governance).enqueue({
      tenantId: toTenantId(p.tenantId),
      correlationId,
      reservationId: toReservationId(decision.reservationId),
      actionKey: toActionKey(actionKey),
      contactId: toContactId(contactId),
      ...(identityId ? { identityId: toIdentityId(identityId) } : {}),
      purpose: PURPOSE,
      source: 'S2_PILOT',
      senderIdentityId: p.scope.senderIdentityId,
      contentRef: FIXTURE_REF,
      leaseExpiresAt:
        decision.reservationExpiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (queued.status === 'ERROR') throw new Error(`enqueue ไม่ได้: ${queued.code}`);

    const allowlist = await withTenantDatabaseTransaction(p.database, p.tenantId, (transaction) =>
      transaction.dlLineAllowlistEntry.findFirstOrThrow({
        where: {
          gateId: gate.id,
          recipientProtectedRef: state.recipientProtectedRef,
          revokedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const credential = await withTenantDatabaseTransaction(p.database, p.tenantId, (transaction) =>
      transaction.dlLineCredentialRef.findFirstOrThrow({ where: { id: p.credentialRefId } }),
    );
    const proposed = await p.control.proposeRun(
      operator,
      {
        tenantId: p.tenantId,
        gate,
        allowlistEntry: allowlist,
        credential,
        proposalRef: queued.deliveryId,
        proposedAt: new Date(),
      },
      new Date(),
    );
    if (proposed.status !== 'APPLIED')
      throw new Error(`เสนอ run ไม่ได้: ${JSON.stringify(proposed)}`);

    const since = new Date(Date.now() - 86_400_000);
    const ledger = await withTenantDatabaseTransaction(p.database, p.tenantId, (transaction) =>
      transaction.dlLineCapLedgerEntry.findMany({
        where: { gateId: gate.id, capKind: 'LOGICAL_DELIVERY', state: { not: 'RELEASED' } },
        select: { reservedAt: true, recipientFingerprint: true },
      }),
    );
    const next: PilotState = {
      ...state,
      runAuthorizationId: proposed.value.id,
      deliveryId: queued.deliveryId,
      reservationId: decision.reservationId,
      finalMainSha,
      quota: await quotaSnapshot(p),
      capUsage: {
        recipientLast24h: ledger.filter(
          (row) =>
            row.reservedAt >= since && row.recipientFingerprint === state.recipientFingerprint,
        ).length,
        last24h: ledger.filter((row) => row.reservedAt >= since).length,
        lifetime: ledger.length,
      },
    };
    const view = await proposalView(p, next);
    writeState({
      ...next,
      presentationDigest: view.presentationDigest,
      proposalEvidence: lineRunProposalEvidence(view),
    });
    process.stdout.write(renderLineRunProposal(view));
  },

  async approve(p) {
    const state = readState();
    const view = await proposalView(p, state);
    if (!lineProposalApprovalMatches(view, requiredFlag('digest'))) {
      throw new Error('digest ไม่ตรง proposal ปัจจุบัน — ค่าใดค่าหนึ่งเปลี่ยน ต้องเสนอใหม่');
    }
    const role = requiredFlag('role');
    if (role !== 'TENANT_ADMIN' && role !== 'COMPLIANCE')
      throw new Error('role ต้องเป็น TENANT_ADMIN หรือ COMPLIANCE');
    const approved = await p.control.approveRun(
      actor(role),
      p.tenantId,
      state.runAuthorizationId!,
      new Date(),
    );
    process.stdout.write(
      `${JSON.stringify(approved.status === 'APPLIED' ? { status: approved.status, state: approved.value.state } : approved)}\n`,
    );
  },

  async send(p) {
    const state = readState();
    const view = await proposalView(p, state);
    if (!lineProposalApprovalMatches(view, requiredFlag('digest'))) {
      throw new Error('digest ไม่ตรง proposal ที่อนุมัติ — ไม่ส่ง');
    }
    const run = await p.repository.findRun(p.tenantId, state.runAuthorizationId!);
    if (run?.state !== 'APPROVED') throw new Error('run ยังไม่ได้รับอนุมัติครบสอง role');
    const gate = await gateOf(p);
    const operator = actor('PLATFORM_OPERATOR');
    const deps = {
      database: p.database,
      control: p.control,
      transport: p.transport,
      recipients: p.recipients,
      credentials: p.credentials,
      actor: operator,
      configDigest: gate.configDigest!,
    };
    // quota ต้องสดกว่า TTL ครึ่งหนึ่ง (#358 §D) — poll ใหม่ก่อนข้าม barrier
    const command = submitCommand(p, state, await quotaSnapshot(p));
    const adapter = new LineOutboundAdapter({ ...deps, governance: p.governance });
    const submitted = await adapter.submit(command);
    if (submitted.status !== 'ACCEPTED') {
      await p.control.kill(operator, gate, 'OPERATOR_KILL', new Date());
      throw new Error(`push ไม่ accepted (${JSON.stringify(submitted)}) — kill scope แล้ว`);
    }
    const probe = await runLineReplayProbe(deps, command);
    writeState({ ...state, probe });
    process.stdout.write(
      `${JSON.stringify({ submitted, probe: { status: probe.status, failure: probe.failure ?? null } })}\n`,
    );
    if (probe.status !== 'PASS') {
      await p.control.kill(operator, gate, 'DUPLICATE_BUSINESS_EFFECT', new Date());
      process.exitCode = 1;
    }
  },

  async 'await-touch'(p) {
    const state = readState();
    if (!state.probe || !state.deliveryId || !state.presentationDigest)
      throw new Error('ยังไม่ได้ send');
    const worker = new LineWebhookWorker({
      database: p.database,
      payloads: await payloadVault(p),
      governance: new LineTouchGovernanceAdapter(p.database, p.governance),
      leaseOwner: `s2-pilot-${hostname()}`,
    });
    const deadline = Date.now() + Number(flag('timeout-minutes') ?? 60) * 60_000;
    process.stderr.write('รอ Quote/Reply ข้อความ pilot ใน LINE (ภายใน 24 ชม. ของ LINE)\n');
    let touches = 0;
    for (;;) {
      await worker.runOnce(p.tenantId);
      await worker.resolvePending(p.tenantId);
      touches = await withTenantDatabaseTransaction(p.database, p.tenantId, (transaction) =>
        transaction.cgTouch.count({ where: { attempt: { deliveryId: state.deliveryId } } }),
      );
      if (touches > 0 || Date.now() >= deadline) break;
      await new Promise((resolve_) => setTimeout(resolve_, 10_000));
    }
    // acceptance evidence (#368 owner: cross-domain acceptance) — อ่าน canonical facts แบบ read-only
    // เพื่อพิสูจน์ Attempt/Touch/refund; ไม่มี write ใดไป cg_* จาก CLI นี้
    const facts = await withTenantDatabaseTransaction(
      p.database,
      p.tenantId,
      async (transaction) => ({
        logicalDeliveries: await transaction.dlLineCapLedgerEntry.count({
          where: {
            runAuthorizationId: state.runAuthorizationId,
            capKind: 'LOGICAL_DELIVERY',
            state: 'COMMITTED',
          },
        }),
        attempts: await transaction.cgAttempt.count({ where: { deliveryId: state.deliveryId } }),
        touches,
        refunds: await transaction.cgReservation.count({
          where: { id: state.reservationId, refundedAt: { not: null } },
        }),
        acceptedReceipts: await transaction.dlProviderSubmissionAttempt.count({
          where: { deliveryId: state.deliveryId, outcomeClass: 'ACCEPTED' },
        }),
      }),
    );
    const pr02 = buildLineCappedPilotEvidence(state.probe, {
      ...facts,
      proposalPresentationDigest: state.presentationDigest,
    });
    writeState({ ...state, pr02 });
    process.stdout.write(`${JSON.stringify(pr02)}\n`);
    if (pr02.status !== 'PASS') process.exitCode = 1;
  },

  async rollback(p) {
    const state = readState();
    const gate = await gateOf(p);
    const operator = actor('PLATFORM_OPERATOR');
    const credential = await withTenantDatabaseTransaction(p.database, p.tenantId, (transaction) =>
      transaction.dlLineCredentialRef.findFirstOrThrow({ where: { id: p.credentialRefId } }),
    );
    const rb01 = await runLineRollbackDrill(
      {
        database: p.database,
        control: p.control,
        transport: p.transport,
        credentials: p.credentials,
        actor: operator,
        configDigest: gate.configDigest!,
      },
      operator,
      {
        scope: p.scope,
        runAuthorizationId: state.runAuthorizationId!,
        credentialRefId: credential.id,
        recipientFingerprint: state.recipientFingerprint!,
        contentRef: FIXTURE_REF,
        revocation: async () => {
          const token = await p.credentials.resolve({
            tenantId: p.tenantId,
            credentialRefId: credential.id,
            version: credential.version,
          });
          if (!token) return null;
          if (credential.credentialKind === 'CHANNEL_ACCESS_TOKEN_LONG_LIVED') {
            return {
              credentialKind: 'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
              accessToken: token.accessToken,
            };
          }
          const channelSecret = await p.source.read({
            keychainService: lineKeychainServiceName(LINE_PILOT_CHANNEL_ACCOUNT_ID),
            keychainAccount: 'channel-secret',
          });
          return {
            credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
            accessToken: token.accessToken,
            channelId: LINE_PILOT_CHANNEL_ACCOUNT_ID,
            channelSecret,
          };
        },
      },
    );
    writeState({ ...state, rb01 });
    process.stdout.write(`${JSON.stringify(rb01)}\n`);
    if (rb01.status !== 'PASS') process.exitCode = 1;
  },

  async bundle(p) {
    const state = readState();
    if (!state.pr02 || !state.rb01) throw new Error('ต้องมีผล await-touch และ rollback ก่อน');
    // exact-value scan ด้วย secret จริงที่ยังอยู่ใน Keychain (token ถูก revoke แล้วแต่ค่ายังอ่านได้)
    const secrets: string[] = [];
    for (const account of ['channel-access-token', 'channel-secret']) {
      try {
        secrets.push(
          await p.source.read({
            keychainService: lineKeychainServiceName(LINE_PILOT_CHANNEL_ACCOUNT_ID),
            keychainAccount: account,
          }),
        );
      } catch {
        // item ที่ไม่มีไม่ใช่ความลับที่ต้องสแกน
      }
    }
    if (secrets.length === 0) throw new Error('อ่าน secret สำหรับ exact-value scan ไม่ได้');
    const bundle = buildLineProviderEvidenceBundle({
      commitSha: state.finalMainSha!,
      generatedAt: new Date(),
      runner: {
        platform: process.platform,
        keychain: true,
        hostFingerprint: lineHostFingerprint(hostname()),
        workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      },
      evidence: [state.pr02, state.rb01],
      secrets,
    });
    secrets.length = 0;
    const path = resolve(
      process.env.CXA_S2_PROVIDER_BUNDLE_DIR ??
        resolve(REPOSITORY_ROOT, 'artifacts/cxa-s2/provider'),
      `pilot-${process.env.GITHUB_RUN_ID ?? `local-${randomUUID()}`}.json`,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `CXA_S2_PROVIDER_BUNDLE:${JSON.stringify({ path, bundleSha256: bundle.bundleSha256 })}\n`,
    );
  },
};

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('pilot รันได้เฉพาะ protected runner บน macOS');
  const command = commands[process.argv[2] ?? ''];
  if (!command) throw new Error(`คำสั่งที่รองรับ: ${Object.keys(commands).join(', ')}`);
  const p = pilot();
  try {
    await command(p);
  } finally {
    await p.database.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'pilot ล้มเหลว'}\n`);
  process.exitCode = 1;
});
