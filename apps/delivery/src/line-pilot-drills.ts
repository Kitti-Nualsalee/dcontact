/**
 * Owner: Delivery/Channels — ขั้นตอน PR02 replay probe และ RB01 rollback drill (S2.7 #368)
 *
 * Authority: #360 §D ข้อ 7 และ 10, decision บน #368 (2026-09-23)
 *
 * - replay probe: re-POST exact request เดิม (payload + `X-Line-Retry-Key` เดิม) หนึ่งครั้งหลัง accepted
 *   ต้องได้ `409` + `x-line-accepted-request-id` = request ID ของ acceptance และ `sentMessages.id` เดิม
 *   ผ่าน control plane (one-shot replay + จอง `PROVIDER_ATTEMPT`) และบันทึกเป็น audit เท่านั้น
 * - rollback drill: technical switch off → kill → ไม่มี delivery ค้าง → revoke token ที่ provider +
 *   ใน metadata → คำขอส่งใหม่ต้องถูกปฏิเสธก่อน provider I/O
 *
 * ทั้งสองขั้นคืน evidence ที่มีแค่ status/ID/digest — ไม่มี token, recipient หรือเนื้อหาข้อความ
 */
import { createHash, randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { LineProviderAttemptRepository } from './line-attempt-repository.js';
import type { LineControlActor, LineControlPlane } from './line-control-plane.js';
import type { LineGateScope } from './line-control-repository.js';
import type { LineQuotaSnapshot } from './line-control-policy.js';
import type {
  LineAccessTokenResolver,
  LineRecipientResolver,
  LineSubmitCommand,
} from './line-outbound-adapter.js';
import { buildLineCanonicalRequest, lineContentDigest } from './line-push-request.js';
import type { LineProviderTransport, LineTokenRevocation } from './line-provider-transport.js';
import { OutboxRepository } from './outbox-repository.js';

export interface LinePilotDrillDeps {
  database: PrismaClient;
  control: LineControlPlane;
  transport: LineProviderTransport;
  recipients: LineRecipientResolver;
  credentials: LineAccessTokenResolver;
  actor: LineControlActor;
  configDigest: string;
  now?: () => Date;
}

export type LineReplayProbeFailure =
  | 'DELIVERY_NOT_ACCEPTED'
  | 'ACCEPTED_RECEIPT_MISSING'
  | 'RUN_REPLAY_DENIED'
  | 'PROVIDER_ATTEMPT_DENIED'
  | 'RECIPIENT_OR_CREDENTIAL_UNAVAILABLE'
  | 'NO_RESPONSE'
  | 'NOT_409'
  | 'ACCEPTED_REQUEST_ID_MISMATCH'
  | 'MESSAGE_ID_MISMATCH';

export interface LineReplayProbeEvidence {
  status: 'PASS' | 'FAIL';
  failure?: LineReplayProbeFailure;
  pushStatus: number | null;
  replayStatus: number | null;
  acceptedRequestId: string | null;
  replayAcceptedRequestId: string | null;
  sentMessageIds: string[];
  replaySentMessageIds: string[];
  acceptedRequestIdMatches: boolean;
  messageIdsMatch: boolean;
  evidenceDigest: string | null;
}

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length > 0 &&
  left.length === right.length &&
  [...left].sort().every((id, index) => id === [...right].sort()[index]);

function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function begin(deps: LinePilotDrillDeps, command: LineSubmitCommand, contentRef: string, at: Date) {
  return {
    tenantId: command.tenantId,
    scope: command.scope,
    runAuthorizationId: command.runAuthorizationId,
    deliveryId: command.deliveryId,
    recipientFingerprint: command.recipientFingerprint,
    contentDigest: lineContentDigest(contentRef),
    configDigest: deps.configDigest,
    ...(command.quota ? { quota: command.quota } : {}),
    at,
  };
}

/** PR02 ข้อ 7: ยิงซ้ำหนึ่งครั้งเท่านั้น — เรียกซ้ำหลังผ่านแล้วจะชน cap ของ attempt ไม่ใช่ยิงเพิ่มลอย ๆ */
export async function runLineReplayProbe(
  deps: LinePilotDrillDeps,
  command: LineSubmitCommand,
): Promise<LineReplayProbeEvidence> {
  const now = deps.now ?? (() => new Date());
  const empty: LineReplayProbeEvidence = {
    status: 'FAIL',
    pushStatus: null,
    replayStatus: null,
    acceptedRequestId: null,
    replayAcceptedRequestId: null,
    sentMessageIds: [],
    replaySentMessageIds: [],
    acceptedRequestIdMatches: false,
    messageIdsMatch: false,
    evidenceDigest: null,
  };
  const fail = (failure: LineReplayProbeFailure, partial: Partial<LineReplayProbeEvidence> = {}) =>
    ({ ...empty, ...partial, status: 'FAIL', failure }) as LineReplayProbeEvidence;

  const entry = await new OutboxRepository(deps.database, 'LINE_MESSAGING_API').findByDeliveryId(
    command.tenantId,
    command.deliveryId,
  );
  if (!entry || entry.outcome !== 'PROVIDER_ACCEPTED') return fail('DELIVERY_NOT_ACCEPTED');
  const receipts = await new LineProviderAttemptRepository(deps.database).listForDelivery(
    command.tenantId,
    command.deliveryId,
  );
  const accepted = receipts.find((receipt) => receipt.outcomeClass === 'ACCEPTED');
  if (!accepted?.lineRequestId) return fail('ACCEPTED_RECEIPT_MISSING');
  const base = {
    pushStatus: accepted.httpStatus ?? null,
    acceptedRequestId: accepted.lineRequestId,
    sentMessageIds: [...accepted.sentMessageIds],
  };

  const grant = await deps.control.beginRun(
    deps.actor,
    begin(deps, command, entry.contentRef, now()),
  );
  if (grant.status !== 'AUTHORIZED') return fail('RUN_REPLAY_DENIED', base);
  const reserved = await deps.control.reserveProviderAttempt(
    deps.actor,
    begin(deps, command, entry.contentRef, now()),
    grant.gate,
    grant.run,
    receipts.length + 1,
  );
  if (reserved.status !== 'APPLIED') return fail('PROVIDER_ATTEMPT_DENIED', base);

  const recipient = await deps.recipients.resolve({
    tenantId: command.tenantId,
    recipientProtectedRef: command.recipientProtectedRef,
  });
  const credential = await deps.credentials.resolve({
    tenantId: command.tenantId,
    credentialRefId: grant.credential.id,
    version: grant.credential.version,
  });
  if (!recipient || !credential) return fail('RECIPIENT_OR_CREDENTIAL_UNAVAILABLE', base);

  const canonical = buildLineCanonicalRequest({
    contentRef: entry.contentRef,
    recipientFingerprint: command.recipientFingerprint,
  });
  const result = await deps.transport
    .push({
      to: recipient.userId,
      messages: canonical.messages,
      retryKey: entry.providerRequestKey,
      accessToken: credential.accessToken,
    })
    .catch(() => ({ kind: 'NO_RESPONSE' as const, reason: 'NETWORK' as const }));
  if (result.kind !== 'RESPONSE') return fail('NO_RESPONSE', base);

  const response = result.response;
  const replay = {
    replayStatus: response.httpStatus,
    replayAcceptedRequestId: response.acceptedRequestId ?? null,
    replaySentMessageIds: [...(response.sentMessageIds ?? [])],
  };
  const acceptedRequestIdMatches = response.acceptedRequestId === accepted.lineRequestId;
  const messageIdsMatch = sameIds(accepted.sentMessageIds, replay.replaySentMessageIds);
  const evidenceDigest = digestOf({
    deliveryId: command.deliveryId,
    ...base,
    ...replay,
    replayRequestId: response.requestId ?? null,
  });
  await deps.control.recordProviderReplayProbe(deps.actor, {
    tenantId: command.tenantId,
    runAuthorizationId: command.runAuthorizationId,
    deliveryId: command.deliveryId,
    evidenceDigest,
    at: now(),
  });
  const evidence = {
    ...empty,
    ...base,
    ...replay,
    acceptedRequestIdMatches,
    messageIdsMatch,
    evidenceDigest,
  };
  if (response.httpStatus !== 409) return { ...evidence, status: 'FAIL', failure: 'NOT_409' };
  if (!acceptedRequestIdMatches)
    return { ...evidence, status: 'FAIL', failure: 'ACCEPTED_REQUEST_ID_MISMATCH' };
  if (!messageIdsMatch) return { ...evidence, status: 'FAIL', failure: 'MESSAGE_ID_MISMATCH' };
  return { ...evidence, status: 'PASS' };
}

export interface LineRollbackDrillInput {
  scope: LineGateScope;
  runAuthorizationId: string;
  credentialRefId: string;
  recipientFingerprint: string;
  contentRef: string;
  /** ค่า revoke ที่ protected runner ประกอบจาก Keychain — ไม่ถูกเก็บหรือคืนออกไป */
  revocation: () => Promise<LineTokenRevocation | null>;
  quota?: LineQuotaSnapshot;
}

/** type alias เพื่อให้ใส่ลง provider bundle ที่รับ evidence แบบ record ได้ */
export type LineRollbackDrillEvidence = {
  type: 'line.rollback-drill';
  checkId: 'S2-LINE-RB01';
  status: 'PASS' | 'FAIL';
  technicalSwitchOn: boolean;
  killLatched: boolean;
  unresolvedDeliveries: number;
  providerRevoked: boolean;
  metadataRevoked: boolean;
  credentialRevoked: boolean;
  freshSendBlockedBeforeIo: boolean;
  freshSendDenialCode: string | null;
};

/**
 * RB01: ทำครบทุกขั้นแม้ขั้นก่อนหน้าล้ม เพื่อให้ scope จบในสถานะปิดเสมอ (kill ชนะทุกอย่าง)
 * การ revoke ที่ provider ล้มไม่ทำให้ metadata revoke ถูกข้าม — credential ห้ามกลับมา active
 */
export async function runLineRollbackDrill(
  deps: Omit<LinePilotDrillDeps, 'recipients'>,
  operator: LineControlActor,
  input: LineRollbackDrillInput,
): Promise<LineRollbackDrillEvidence> {
  const now = deps.now ?? (() => new Date());
  const { tenantId } = input.scope;
  const findGate = async () => {
    const gate = await withTenantDatabaseTransaction(deps.database, tenantId, (transaction) =>
      transaction.dlLineScopeGate.findFirst({
        where: {
          tenantId,
          channelAccountId: input.scope.channelAccountId,
          senderIdentityId: input.scope.senderIdentityId,
          purpose: input.scope.purpose,
          contactKind: input.scope.contactKind,
        },
      }),
    );
    if (!gate) throw new Error('ไม่พบ gate ของ scope pilot');
    return gate;
  };

  let gate = await findGate();
  if (gate.technicalSwitchOn) {
    const switched = await deps.control.setTechnicalSwitch(operator, gate, false, now());
    if (switched.status === 'APPLIED') gate = switched.value;
  }
  gate = await deps.control.kill(operator, gate, 'PILOT_ROLLBACK', now());

  const unresolvedDeliveries = await withTenantDatabaseTransaction(
    deps.database,
    tenantId,
    (transaction) =>
      transaction.dlOutboxEntry.count({
        where: {
          tenantId,
          adapter: 'LINE_MESSAGING_API',
          state: { in: ['QUEUED', 'SUBMITTING', 'SUBMITTED', 'RECONCILING'] },
        },
      }),
  );

  let providerRevoked = false;
  const revocation = await input.revocation().catch(() => null);
  if (revocation) providerRevoked = (await deps.transport.revokeToken(revocation)).revoked;
  const metadataRevoked = await deps.control.revokeCredential(
    operator,
    tenantId,
    input.credentialRefId,
    now(),
  );

  // คำขอส่งใหม่ต้องถูกปฏิเสธที่ `beginRun` ซึ่งเป็นด่านก่อน provider I/O ทุกทางของ adapter
  const probe = await deps.control.beginRun(deps.actor, {
    tenantId,
    scope: input.scope,
    runAuthorizationId: input.runAuthorizationId,
    deliveryId: `rb01_probe_${randomUUID().replaceAll('-', '')}`,
    recipientFingerprint: input.recipientFingerprint,
    contentDigest: lineContentDigest(input.contentRef),
    configDigest: deps.configDigest,
    ...(input.quota ? { quota: input.quota } : {}),
    at: now(),
  });
  const freshSendBlockedBeforeIo = probe.status === 'DENIED';

  const final = await findGate();
  const evidence = {
    type: 'line.rollback-drill' as const,
    checkId: 'S2-LINE-RB01' as const,
    technicalSwitchOn: final.technicalSwitchOn,
    killLatched: final.killed,
    unresolvedDeliveries,
    providerRevoked,
    metadataRevoked,
    // ใช้ต่อไม่ได้จริงต้องครบทั้งฝั่ง LINE และฝั่ง metadata
    credentialRevoked: providerRevoked && metadataRevoked,
    freshSendBlockedBeforeIo,
    freshSendDenialCode: probe.status === 'DENIED' ? probe.code : null,
  };
  const passed =
    !evidence.technicalSwitchOn &&
    evidence.killLatched &&
    evidence.unresolvedDeliveries === 0 &&
    evidence.credentialRevoked &&
    evidence.freshSendBlockedBeforeIo;
  return { ...evidence, status: passed ? 'PASS' : 'FAIL' };
}

export interface LineCappedPilotFacts {
  /** จาก cap ledger ของ run: หน่วย logical delivery ที่ COMMITTED */
  logicalDeliveries: number;
  /** Attempt/Touch/refund ของ delivery ตาม canonical facts ของ Governance */
  attempts: number;
  touches: number;
  refunds: number;
  /** attempt receipt ที่ accepted มากกว่าหนึ่ง หรือ message ID มากกว่าชุดเดียว = ผู้รับอาจเห็นซ้ำ */
  acceptedReceipts: number;
  proposalPresentationDigest: string;
}

export type LineCappedPilotEvidence = {
  type: 'line.capped-pilot';
  checkId: 'S2-LINE-PR02';
  status: 'PASS' | 'FAIL';
  pushStatus: number | null;
  replayStatus: number | null;
  messageIdsMatch: boolean;
  acceptedRequestIdMatches: boolean;
  logicalDeliveries: number;
  attempts: number;
  touches: number;
  refunds: number;
  duplicateObserved: boolean;
  proposalPresentationDigest: string;
  replayEvidenceDigest: string | null;
};

/** รูปเดียวกับที่ `scripts/cxa-s2-provider-bundle.mjs` ตรวจ invariant ของ PR02 (#360 §D ข้อ 5–9) */
export function buildLineCappedPilotEvidence(
  probe: LineReplayProbeEvidence,
  facts: LineCappedPilotFacts,
): LineCappedPilotEvidence {
  const evidence = {
    type: 'line.capped-pilot' as const,
    checkId: 'S2-LINE-PR02' as const,
    pushStatus: probe.pushStatus,
    replayStatus: probe.replayStatus,
    messageIdsMatch: probe.messageIdsMatch,
    acceptedRequestIdMatches: probe.acceptedRequestIdMatches,
    logicalDeliveries: facts.logicalDeliveries,
    attempts: facts.attempts,
    touches: facts.touches,
    refunds: facts.refunds,
    duplicateObserved: facts.acceptedReceipts !== 1 || facts.logicalDeliveries !== 1,
    proposalPresentationDigest: facts.proposalPresentationDigest,
    replayEvidenceDigest: probe.evidenceDigest,
  };
  const passed =
    probe.status === 'PASS' &&
    evidence.pushStatus === 200 &&
    evidence.replayStatus === 409 &&
    evidence.messageIdsMatch &&
    evidence.logicalDeliveries === 1 &&
    evidence.attempts === 1 &&
    evidence.touches === 1 &&
    evidence.refunds === 0 &&
    !evidence.duplicateObserved &&
    /^[0-9a-f]{64}$/.test(evidence.proposalPresentationDigest);
  return { ...evidence, status: passed ? 'PASS' : 'FAIL' };
}
