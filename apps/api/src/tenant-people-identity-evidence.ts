/**
 * #868: หลักฐาน identity และผลภายนอกของ People ก่อน/หลังสลับ API รุ่นบน UAT
 *
 * อ่าน application DB ด้วย worker principal ใน transaction read-only แล้วอ่าน receipt ฝั่ง Keycloak ผ่าน GET
 * ของ extension ด้วย adapter เดียวกับ worker (`readOutcome`) ไม่เรียก POST, ไม่ส่งเมล และไม่คืน secret/token/PII
 * Keycloak ทำงานเฉพาะ operation ที่ application บันทึกไว้ก่อน การไล่ทุก operation/step/generation จาก DB จึงจับได้ทั้ง
 * receipt ที่ไม่ตรงและผลฝั่ง provider ที่ application ไม่มีบันทึก
 */
import { createHash } from 'node:crypto';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { digest } from './tenant-voice-catalog.js';
import { normalizePeopleCreate, peopleCreateDigest } from './tenant-people-input.js';
import type { PeopleStep, PeopleStepOutcome, PeopleWorkerClaim } from './tenant-people-worker.js';
import type {
  PeopleInvitationAttempt,
  PeopleInvitationOutcome,
} from './tenant-people-invitation-worker.js';
import type {
  PeopleDisableAttempt,
  PeopleDisableOutcome,
} from './tenant-people-disable-keycloak.js';

export const PEOPLE_STEPS: readonly PeopleStep[] = [
  'CREATE_IDENTITY',
  'TENANT_ROLE',
  'ORG_MEMBERSHIP',
  'VERIFY_MAPPING',
  'VERIFY_PROVISIONED',
];
const OWNER = 'uat-868-identity-evidence';
const NEVER = new Date(0);

export interface PeopleIdentityEvidenceSource {
  tenantId: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  readReadiness(): Promise<Record<string, unknown> | null>;
  readStep(claim: PeopleWorkerClaim): Promise<PeopleStepOutcome>;
  readInvitation(attempt: PeopleInvitationAttempt): Promise<PeopleInvitationOutcome>;
  readDisable(attempt: PeopleDisableAttempt): Promise<PeopleDisableOutcome>;
  /** จำนวน HTTP ที่ไม่ใช่ 2xx หรือ exception; adapter คืน UNKNOWN ทั้งกรณีไม่มี receipt และอ่านไม่ได้ */
  requestFailures(): number;
}

type Recorded = { outcome: string; receiptRef: string | null };
export interface PeopleIdentityMismatch {
  kind: 'STEP' | 'INVITATION' | 'DISABLE';
  operationId: string;
  step?: PeopleStep;
  generation?: number;
  reason:
    | 'RECEIPT_MISMATCH'
    | 'UNRECORDED_PROVIDER_RECEIPT'
    | 'PROVIDER_UNREADABLE'
    | 'PAYLOAD_CORRUPTED';
  application: Recorded | null;
  provider: Recorded | null;
}

interface OperationRow {
  operationId: string;
  userId: string;
  actorId: string;
  commandId: string;
  correlationId: string;
  payloadDigest: string;
  payload: unknown;
}
interface StepReceiptRow {
  operationId: string;
  step: PeopleStep;
  outcome: string;
  receiptRef: string | null;
}
interface DispatchRow {
  operationId: string;
  userId: string;
  generation: number;
  providerAttemptRef: string;
  fencingToken: string;
  leaseOwner: string;
  outcome: string | null;
  receiptRef: string | null;
}
interface DisableRow {
  operationId: string;
  userId: string;
  identityId: string;
  role: 'AGENT' | 'SUPERVISOR' | 'ADMIN';
  payloadDigest: string;
  fencingToken: string;
  attempted: boolean;
  outcome: string | null;
  receiptRef: string | null;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function readApplication(database: PrismaClient, tenantId: string) {
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    // set_config ของ tenant เป็น query แรกแล้ว PostgreSQL ยังยอมให้เปลี่ยนเป็น read-only ได้ (ไม่ยอมกลับเป็น read-write)
    await transaction.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const operations = await transaction.$queryRaw<OperationRow[]>`
      SELECT id::text AS "operationId",target_user_id::text AS "userId",actor_user_id::text AS "actorId",
        command_id::text AS "commandId",correlation_id::text AS "correlationId",payload_digest AS "payloadDigest",
        request_payload AS payload
      FROM tenant_people_operations WHERE tenant_id=${tenantId}::uuid ORDER BY id`;
    // receipt ล่าสุดที่ไม่ใช่ UNKNOWN ต่อ step; Keycloak เก็บหนึ่ง receipt ต่อ operation/step
    const steps = await transaction.$queryRaw<StepReceiptRow[]>`
      SELECT DISTINCT ON (operation_id,step) operation_id::text AS "operationId",step,outcome,
        provider_receipt_ref AS "receiptRef"
      FROM tenant_people_step_receipts WHERE tenant_id=${tenantId}::uuid AND outcome<>'UNKNOWN'
      ORDER BY operation_id,step,fencing_token DESC`;
    const dispatches = await transaction.$queryRaw<DispatchRow[]>`
      SELECT d.operation_id::text AS "operationId",d.user_id::text AS "userId",d.generation,
        d.provider_attempt_ref::text AS "providerAttemptRef",d.fencing_token::text AS "fencingToken",
        d.lease_owner AS "leaseOwner",r.outcome,r.receipt_ref AS "receiptRef"
      FROM tenant_people_invitation_dispatches d
      LEFT JOIN tenant_people_invitation_receipts r ON r.tenant_id=d.tenant_id AND r.provider_attempt_ref=d.provider_attempt_ref
      WHERE d.tenant_id=${tenantId}::uuid ORDER BY d.operation_id,d.generation`;
    const disables = await transaction.$queryRaw<DisableRow[]>`
      SELECT DISTINCT ON (s.id) s.id::text AS "operationId",s.user_id::text AS "userId",
        s.identity_id::text AS "identityId",s.role,s.payload_digest AS "payloadDigest",
        s.fencing_token::text AS "fencingToken",s.attempted,r.outcome,r.provider_receipt_ref AS "receiptRef"
      FROM tenant_people_disables s
      LEFT JOIN tenant_people_disable_receipts r ON r.tenant_id=s.tenant_id AND r.operation_id=s.id AND r.outcome<>'UNKNOWN'
      WHERE s.tenant_id=${tenantId}::uuid ORDER BY s.id,r.fencing_token DESC NULLS LAST`;
    return { operations, steps, dispatches, disables };
  });
}

function recorded(outcome: { outcome: string; receiptRef?: string }): Recorded {
  return { outcome: outcome.outcome, receiptRef: outcome.receiptRef ?? null };
}

function compare(
  application: Recorded | null,
  provider: Recorded,
): PeopleIdentityMismatch['reason'] | null {
  if (provider.outcome === 'UNKNOWN') return application ? 'PROVIDER_UNREADABLE' : null;
  if (!application) return 'UNRECORDED_PROVIDER_RECEIPT';
  return application.outcome === provider.outcome && application.receiptRef === provider.receiptRef
    ? null
    : 'RECEIPT_MISMATCH';
}

export async function collectTenantPeopleIdentityEvidence(
  database: PrismaClient,
  source: PeopleIdentityEvidenceSource,
) {
  const { tenantId } = source;
  const readiness = await source.readReadiness();
  const application = await readApplication(database, tenantId);
  const mismatches: PeopleIdentityMismatch[] = [];
  const counts = { operations: 0, steps: 0, invitations: 0, disables: 0 };
  const commands = new Map<string, PeopleWorkerClaim['command'] | null>();
  for (const operation of application.operations) {
    const payload = operation.payload;
    let command: PeopleWorkerClaim['command'] | null = null;
    try {
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const { infrastructure: _infrastructure, ...request } = Object.fromEntries(
          Object.entries(payload),
        );
        const normalized = normalizePeopleCreate({ ...request, commandId: operation.commandId });
        if (
          digest([tenantId, operation.actorId, peopleCreateDigest(normalized)]) ===
          operation.payloadDigest
        )
          command = normalized;
      }
    } catch {
      command = null;
    }
    commands.set(operation.operationId, command);
    counts.operations++;
    if (!command) {
      mismatches.push({
        kind: 'STEP',
        operationId: operation.operationId,
        reason: 'PAYLOAD_CORRUPTED',
        application: null,
        provider: null,
      });
      continue;
    }
    for (const step of PEOPLE_STEPS) {
      const receipt = application.steps.find(
        (row) => row.operationId === operation.operationId && row.step === step,
      );
      const local = receipt ? { outcome: receipt.outcome, receiptRef: receipt.receiptRef } : null;
      const provider = recorded(
        await source.readStep({
          tenantId,
          operationId: operation.operationId,
          userId: operation.userId,
          correlationId: operation.correlationId,
          payloadDigest: operation.payloadDigest,
          fencingToken: '0',
          owner: OWNER,
          step,
          reconcileOnly: true,
          command,
        }),
      );
      counts.steps++;
      const reason = compare(local, provider);
      if (reason)
        mismatches.push({
          kind: 'STEP',
          operationId: operation.operationId,
          step,
          reason,
          application: local,
          provider,
        });
    }
  }
  for (const dispatch of application.dispatches) {
    const operation = application.operations.find(
      (row) => row.operationId === dispatch.operationId,
    );
    const command = commands.get(dispatch.operationId);
    counts.invitations++;
    const local = dispatch.outcome
      ? { outcome: dispatch.outcome, receiptRef: dispatch.receiptRef }
      : null;
    if (!operation || !command) {
      mismatches.push({
        kind: 'INVITATION',
        operationId: dispatch.operationId,
        generation: dispatch.generation,
        reason: 'PAYLOAD_CORRUPTED',
        application: local,
        provider: null,
      });
      continue;
    }
    const provider = recorded(
      await source.readInvitation({
        tenantId,
        operationId: dispatch.operationId,
        userId: dispatch.userId,
        generation: dispatch.generation,
        providerAttemptRef: dispatch.providerAttemptRef,
        payloadDigest: operation.payloadDigest,
        fencingToken: dispatch.fencingToken,
        leaseOwner: dispatch.leaseOwner,
        leaseExpiresAt: NEVER,
        command,
      }),
    );
    // dispatch ที่ไม่มี receipt ทั้งสองฝั่งคือผลที่ยังไม่ชัด ไม่ใช่ความสอดคล้อง
    const reason =
      !local && provider.outcome === 'UNKNOWN' ? 'PROVIDER_UNREADABLE' : compare(local, provider);
    if (reason)
      mismatches.push({
        kind: 'INVITATION',
        operationId: dispatch.operationId,
        generation: dispatch.generation,
        reason,
        application: local,
        provider,
      });
  }
  for (const disable of application.disables) {
    if (!disable.attempted && !disable.outcome) continue;
    counts.disables++;
    const local = disable.outcome
      ? { outcome: disable.outcome, receiptRef: disable.receiptRef }
      : null;
    const provider = recorded(
      await source.readDisable({
        tenantId,
        operationId: disable.operationId,
        userId: disable.userId,
        identityId: disable.identityId,
        payloadDigest: disable.payloadDigest,
        fencingToken: disable.fencingToken,
        role: disable.role,
        adminCandidates: [],
        reconcileOnly: true,
      }),
    );
    const reason =
      !local && provider.outcome === 'UNKNOWN' ? 'PROVIDER_UNREADABLE' : compare(local, provider);
    if (reason)
      mismatches.push({
        kind: 'DISABLE',
        operationId: disable.operationId,
        reason,
        application: local,
        provider,
      });
  }
  const requestFailures = source.requestFailures();
  const readinessOk =
    !!readiness &&
    readiness.ready === true &&
    readiness.version === 1 &&
    readiness.tenantId === tenantId;
  return {
    tenantId,
    issuer: source.issuer,
    clientId: source.clientId,
    clientSecretSha256: sha256(source.clientSecret),
    readiness,
    counts,
    requestFailures,
    mismatches,
    status:
      readinessOk && requestFailures === 0 && mismatches.length === 0
        ? 'CONSISTENT'
        : 'INCONSISTENT',
  } as const;
}

export async function collectPeopleIdentityEvidence(
  database: PrismaClient,
  sources: readonly PeopleIdentityEvidenceSource[],
) {
  if (sources.length === 0) throw new Error('PEOPLE_BINDINGS_REQUIRED');
  const tenants = [];
  for (const source of sources)
    tenants.push(await collectTenantPeopleIdentityEvidence(database, source));
  const body = { tenants };
  return {
    schema: 'UatPeopleIdentityEvidenceV1' as const,
    observedAt: new Date().toISOString(),
    status: tenants.every((tenant) => tenant.status === 'CONSISTENT')
      ? 'CONSISTENT'
      : 'INCONSISTENT',
    evidenceSha256: sha256(JSON.stringify(body)),
    ...body,
    rollbackCertified: false as const,
  };
}
