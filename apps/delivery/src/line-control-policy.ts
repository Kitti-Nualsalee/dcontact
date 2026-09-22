/**
 * Owner: Delivery/Channels — policy ล้วนของ LINE control plane (S2.3 #367)
 *
 * Authority: rollout/security decision #358 §A/§B/§C/§D/§E/§F และ Phase Contract #362 §9/§10
 *
 * ไฟล์นี้ไม่มี I/O, ไม่มี database, ไม่มี credential value และไม่มี provider call — มีแต่
 * ตารางตัดสินใจที่อ่านแล้วเทียบกับคำตัดสินได้ตรง ๆ: ใครสั่งอะไรได้, business state ไหนแตะ
 * provider operation ใดได้, cap หนึ่งหน่วยต้องผ่าน limit อะไรบ้าง, proposal digest คิดจากอะไร,
 * quota snapshot แบบไหนใช้ไม่ได้ และสัญญาณไหนต้อง kill อัตโนมัติ
 *
 * ทุกค่าที่เป็นตัวเลข cap มาจาก `LINE_PILOT_CAPS` ของ `@d-contact/cxa-contracts` เสมอ —
 * ที่นี่ห้ามมี literal ของ cap ซ้ำ เพราะการปรับ cap สูงขึ้นต้องเป็น decision ใหม่ (#358 §C)
 */
import { createHash } from 'node:crypto';
import {
  LINE_PILOT_CAPS,
  LINE_PILOT_PROFILE,
  type LineCapKind,
  type LineGateErrorCode,
  type LineKillReason,
  type LineProviderOutcomeCode,
  type LineRolloutState,
} from '@d-contact/cxa-contracts';
import type { LineCapLimit } from './line-control-repository.js';

/** ตรงกับ Postgres enum `DlLineActorKind`; `SYSTEM` ใช้ได้เฉพาะ kill อัตโนมัติ */
export const LINE_CONTROL_ACTOR_ROLES = [
  'TENANT_ADMIN',
  'COMPLIANCE',
  'PLATFORM_OPERATOR',
  'SYSTEM',
] as const;
export type LineControlActorRole = (typeof LINE_CONTROL_ACTOR_ROLES)[number];

export const LINE_CONTROL_ACTIONS = [
  'ADVANCE_STATE',
  'LOWER_STATE',
  'SET_TECHNICAL_SWITCH',
  'KILL',
  'CLEAR_KILL',
  'REGISTER_ALLOWLIST',
  'REVOKE_ALLOWLIST',
  'REGISTER_CREDENTIAL',
  'ACTIVATE_CREDENTIAL',
  'REVOKE_CREDENTIAL',
  'PROPOSE_RUN',
  'APPROVE_RUN_TENANT_ADMIN',
  'APPROVE_RUN_COMPLIANCE',
  'CLOSE_RUN',
  'EXECUTE_RUN',
] as const;
export type LineControlAction = (typeof LINE_CONTROL_ACTIONS)[number];

/**
 * authority matrix ตาม #358 §E: Platform Operator เสนอ/เปิด switch/execute, Tenant Admin ยืนยัน
 * recipient/purpose/content, Compliance อนุมัติการเลื่อนขั้นและยก kill ส่วนการลดขั้นกับ kill
 * ทำได้ทันทีโดยฝั่งใดฝั่งหนึ่ง (#358 §C/§F) — `SYSTEM` มีสิทธิ์เฉพาะ kill อัตโนมัติเท่านั้น
 */
export const LINE_CONTROL_AUTHORITY: Readonly<
  Record<LineControlAction, readonly LineControlActorRole[]>
> = Object.freeze({
  ADVANCE_STATE: ['COMPLIANCE'],
  LOWER_STATE: ['COMPLIANCE', 'PLATFORM_OPERATOR'],
  SET_TECHNICAL_SWITCH: ['PLATFORM_OPERATOR'],
  KILL: ['COMPLIANCE', 'PLATFORM_OPERATOR', 'SYSTEM'],
  CLEAR_KILL: ['COMPLIANCE'],
  REGISTER_ALLOWLIST: ['TENANT_ADMIN'],
  REVOKE_ALLOWLIST: ['TENANT_ADMIN', 'COMPLIANCE'],
  REGISTER_CREDENTIAL: ['PLATFORM_OPERATOR'],
  ACTIVATE_CREDENTIAL: ['PLATFORM_OPERATOR'],
  REVOKE_CREDENTIAL: ['PLATFORM_OPERATOR', 'COMPLIANCE'],
  PROPOSE_RUN: ['PLATFORM_OPERATOR'],
  APPROVE_RUN_TENANT_ADMIN: ['TENANT_ADMIN'],
  APPROVE_RUN_COMPLIANCE: ['COMPLIANCE'],
  CLOSE_RUN: ['PLATFORM_OPERATOR', 'COMPLIANCE'],
  EXECUTE_RUN: ['PLATFORM_OPERATOR'],
});

export class LineControlAuthorizationError extends Error {
  readonly code: LineGateErrorCode = 'LINE_GATE_AUTHORIZATION_DENIED';

  constructor(
    readonly actorRole: LineControlActorRole,
    readonly action: LineControlAction,
  ) {
    super(`actor role ${actorRole} ไม่มีสิทธิ ${action}`);
    this.name = 'LineControlAuthorizationError';
  }
}

export function mayPerform(role: LineControlActorRole, action: LineControlAction): boolean {
  return LINE_CONTROL_AUTHORITY[action].includes(role);
}

export function assertControlAuthority(
  role: LineControlActorRole,
  action: LineControlAction,
): void {
  if (!mayPerform(role, action)) throw new LineControlAuthorizationError(role, action);
}

// ── Business state → provider operation (#358 §A) ────────────────────────────

/**
 * operation ที่ control plane รู้จัก ไม่ใช่ HTTP call จริง (S2.3 ไม่มี provider I/O):
 * เป็น "สิทธิ์ที่ผู้เรียกกำลังขอ" ซึ่ง S2.4/S2.5 จะต้องขอก่อนแตะ transport เสมอ
 */
export const LINE_PROVIDER_OPERATIONS = [
  'LOCAL_VALIDATION',
  'TOKEN_VERIFY',
  'QUOTA_READ',
  'MESSAGE_VALIDATE',
  'WEBHOOK_TEST',
  'PUSH',
] as const;
export type LineProviderOperation = (typeof LINE_PROVIDER_OPERATIONS)[number];

/** business state ต่ำสุดที่อนุญาต operation นั้น — `DISABLED` ไม่อนุญาตอะไรเลย */
export const LINE_OPERATION_MINIMUM_STATE: Readonly<
  Record<LineProviderOperation, Exclude<LineRolloutState, 'DISABLED'>>
> = Object.freeze({
  LOCAL_VALIDATION: 'DRY_RUN',
  TOKEN_VERIFY: 'PROVIDER_CONFORMANCE',
  QUOTA_READ: 'PROVIDER_CONFORMANCE',
  MESSAGE_VALIDATE: 'PROVIDER_CONFORMANCE',
  WEBHOOK_TEST: 'PROVIDER_CONFORMANCE',
  PUSH: 'CAPPED_PILOT',
});

/** operation ที่ต้องมี network ไปหา LINE จริง จึงต้องมี credential + quota ที่อ่านได้ */
export const LINE_OPERATIONS_NEEDING_PROVIDER: readonly LineProviderOperation[] = Object.freeze([
  'TOKEN_VERIFY',
  'QUOTA_READ',
  'MESSAGE_VALIDATE',
  'WEBHOOK_TEST',
  'PUSH',
]);

const ROLLOUT_ORDER: readonly LineRolloutState[] = [
  'DISABLED',
  'DRY_RUN',
  'PROVIDER_CONFORMANCE',
  'CAPPED_PILOT',
];

export function rolloutRank(state: LineRolloutState): number {
  return ROLLOUT_ORDER.indexOf(state);
}

export function allowsOperation(
  state: LineRolloutState,
  operation: LineProviderOperation,
): boolean {
  if (state === 'DISABLED') return false;
  return rolloutRank(state) >= rolloutRank(LINE_OPERATION_MINIMUM_STATE[operation]);
}

export function needsProviderCredential(operation: LineProviderOperation): boolean {
  return LINE_OPERATIONS_NEEDING_PROVIDER.includes(operation);
}

/** เลื่อนขึ้นทีละขั้นเท่านั้น (trigger `DL_LINE_GATE_STEP` บังคับซ้ำใน DB) */
export function isSingleStepAdvance(from: LineRolloutState, to: LineRolloutState): boolean {
  return rolloutRank(to) === rolloutRank(from) + 1;
}

export function isLowering(from: LineRolloutState, to: LineRolloutState): boolean {
  return rolloutRank(to) < rolloutRank(from);
}

// ── Cap profile (#358 §C) ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60_000;

export interface LineCapLimitInput {
  capKind: LineCapKind;
  at: Date;
  /** cap ของ run ใบนี้ ลดจาก profile ได้แต่เกินไม่ได้ (DB CHECK บังคับ 1..4) */
  runCapProviderAttempts?: number;
}

/**
 * limit ทั้งชุดของ cap หนึ่งหน่วย — ผู้เรียก `reserveCap` ต้องส่งชุดนี้ครบเสมอ (hand-off ของ S2.1)
 * ส่งไม่ครบ = มี cap ที่ไม่มีใครนับ และ ledger จะบอกว่า "ผ่าน" ทั้งที่เกิน profile ไปแล้ว
 *
 * LOGICAL_DELIVERY มีสี่มิติพร้อมกัน: 1/run, 1/recipient/24h, 3/24h และ 10 ตลอด profile
 * นับเฉพาะแถว RESERVED+COMMITTED — งานที่ release ก่อน barrier ไม่กินโควตาของวัน/lifetime
 */
export function lineCapLimits(input: LineCapLimitInput): LineCapLimit[] {
  const since = new Date(input.at.getTime() - DAY_MS);
  switch (input.capKind) {
    case 'LOGICAL_DELIVERY':
      return [
        {
          code: 'RUN_DELIVERY_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: LINE_PILOT_CAPS.logicalDeliveriesPerRun,
          sameRun: true,
        },
        {
          code: 'CONTACT_WINDOW_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: LINE_PILOT_CAPS.logicalDeliveriesPerRecipientPer24h,
          sameRecipient: true,
          since,
        },
        {
          code: 'SUBMISSION_WINDOW_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: LINE_PILOT_CAPS.logicalDeliveriesPer24h,
          since,
        },
        {
          code: 'LIFETIME_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: LINE_PILOT_CAPS.logicalDeliveriesLifetime,
        },
      ];
    case 'CONCURRENT_SUBMISSION':
      return [
        {
          code: 'CONCURRENT_SUBMISSION_CAP_EXCEEDED',
          capKind: 'CONCURRENT_SUBMISSION',
          max: LINE_PILOT_CAPS.concurrentSubmissions,
          activeOnly: true,
        },
      ];
    case 'CONCURRENT_UNKNOWN':
      return [
        {
          code: 'CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED',
          capKind: 'CONCURRENT_UNKNOWN',
          max: LINE_PILOT_CAPS.concurrentUnknownReconciling,
          activeOnly: true,
        },
      ];
    case 'PROVIDER_ATTEMPT':
      return [
        {
          code: 'PROVIDER_ATTEMPT_CAP_EXCEEDED',
          capKind: 'PROVIDER_ATTEMPT',
          max: Math.min(
            input.runCapProviderAttempts ?? LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery,
            LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery,
          ),
          sameDelivery: true,
        },
      ];
  }
  // cap kind ใหม่ต้องมี limit ของตัวเองเสมอ — ปล่อยผ่านเป็นการยอมให้มี cap ที่ไม่มีใครนับ
  const exhaustive: never = input.capKind;
  throw new TypeError(`ไม่มี cap limit ของ ${String(exhaustive)}`);
}

// ── Immutable run proposal (#358 §E) ─────────────────────────────────────────

/**
 * ทุกมิติที่ approver มองเห็นตอนอนุมัติ — digest คิดจากค่าเหล่านี้เท่านั้น ผู้ execute จึงแก้
 * อะไรหลัง approval ไม่ได้โดยที่ digest ยังเท่าเดิม (`proposalRef` ทำให้ run ใบใหม่ของ binding
 * เดิมมี digest ใหม่ ไม่ไปชน unique ของใบที่ consume ไปแล้ว)
 */
export interface LineRunProposalDigestInput {
  tenantId: string;
  gateId: string;
  channelAccountId: string;
  senderIdentityId: string;
  purpose: string;
  contactKind: string;
  allowlistEntryId: string;
  recipientFingerprint: string;
  contentDigest: string;
  configDigest: string;
  credentialRefId: string;
  credentialVersion: number;
  capLogicalDeliveries: number;
  capProviderAttempts: number;
  proposedBy: string;
  proposalRef: string;
  proposedAt: Date;
  expiresAt: Date;
}

export function lineRunProposalDigest(input: LineRunProposalDigestInput): string {
  const canonical = [
    ['profile', LINE_PILOT_PROFILE],
    ['tenantId', input.tenantId],
    ['gateId', input.gateId],
    ['channelAccountId', input.channelAccountId],
    ['senderIdentityId', input.senderIdentityId],
    ['purpose', input.purpose],
    ['contactKind', input.contactKind],
    ['allowlistEntryId', input.allowlistEntryId],
    ['recipientFingerprint', input.recipientFingerprint],
    ['contentDigest', input.contentDigest],
    ['configDigest', input.configDigest],
    ['credentialRefId', input.credentialRefId],
    ['credentialVersion', String(input.credentialVersion)],
    ['capLogicalDeliveries', String(input.capLogicalDeliveries)],
    ['capProviderAttempts', String(input.capProviderAttempts)],
    ['proposedBy', input.proposedBy],
    ['proposalRef', input.proposalRef],
    ['proposedAt', input.proposedAt.toISOString()],
    ['expiresAt', input.expiresAt.toISOString()],
  ].sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** TTL ของ one-shot authorization — DB CHECK บังคับซ้ำว่าต้องไม่เกินค่านี้ */
export function lineRunExpiry(proposedAt: Date): Date {
  return new Date(proposedAt.getTime() + LINE_PILOT_CAPS.runAuthorizationTtlMinutes * 60_000);
}

// ── Quota advisory (#358 §D) ─────────────────────────────────────────────────

/**
 * snapshot ที่ผู้เรียก (S2.4 transport) อ่านมาจาก LINE — control plane ไม่ยิงเอง
 * `type` ตามคำตอบของ provider: `limited` มีเพดาน, `none` คือไม่จำกัด
 */
export interface LineQuotaSnapshot {
  type: 'limited' | 'none';
  targetLimit?: number;
  totalUsage: number;
  observedAt: Date;
}

export const LINE_QUOTA_ADVISORY_STATUSES = ['OK', 'EXHAUSTED', 'STALE', 'UNAVAILABLE'] as const;
export type LineQuotaAdvisoryStatus = (typeof LINE_QUOTA_ADVISORY_STATUSES)[number];

/** snapshot เก่ากว่านี้ถือว่าใช้ตัดสินใจไม่ได้ — สั้นกว่า TTL ของ authorization หนึ่งเท่าตัว */
export const LINE_QUOTA_SNAPSHOT_MAX_AGE_MS =
  (LINE_PILOT_CAPS.runAuthorizationTtlMinutes / 2) * 60_000;

/**
 * quota เป็น advisory/approximate: ใช้ "ปฏิเสธ" ได้อย่างเดียว ห้ามใช้แทน durable cap
 * ไม่มี snapshot, snapshot เก่า หรือโควตาเหลือไม่พอ = fail closed ทั้งสามกรณี (#358 §D)
 */
export function evaluateQuotaAdvisory(
  snapshot: LineQuotaSnapshot | undefined,
  at: Date,
  requiredMessages = LINE_PILOT_CAPS.logicalDeliveriesPerRun,
): LineQuotaAdvisoryStatus {
  if (!snapshot) return 'UNAVAILABLE';
  const age = at.getTime() - snapshot.observedAt.getTime();
  if (age < 0 || age > LINE_QUOTA_SNAPSHOT_MAX_AGE_MS) return 'STALE';
  if (snapshot.type === 'none') return 'OK';
  const limit = snapshot.targetLimit;
  if (limit === undefined || !Number.isFinite(limit)) return 'UNAVAILABLE';
  return limit - snapshot.totalUsage >= requiredMessages ? 'OK' : 'EXHAUSTED';
}

// ── Automatic kill (#358 §F) ─────────────────────────────────────────────────

/**
 * สัญญาณที่ control plane ถือว่าเป็น "ต้อง kill ทันที" — ชุดปิดตาม #358 §F
 * สัญญาณเหล่านี้มาจากผู้เรียกที่เห็นเหตุการณ์จริง (adapter/worker/acceptance) ไม่ใช่การเดาเอง
 */
export const LINE_CONTROL_SIGNALS = [
  'CROSS_TENANT_LEAK',
  'ALLOWLIST_BINDING_MISMATCH',
  'CG3_BYPASS',
  'DUPLICATE_BUSINESS_EFFECT',
  'PII_OR_CREDENTIAL_LEAK',
  'EVIDENCE_HASH_MISMATCH',
  'UNKNOWN_OUTCOME_EXPIRED',
  'PROVIDER_ATTEMPTS_EXHAUSTED',
  'AUTH_FAILURE',
  'QUOTA_EXHAUSTED',
  'CAP_ACCOUNTING_INCONSISTENCY',
] as const;
export type LineControlSignal = (typeof LINE_CONTROL_SIGNALS)[number];

/** signal ทุกตัวมี kill reason ชื่อเดียวกันใน `LINE_KILL_REASONS` — mapping จึงเป็น identity */
export function automaticKillReasonFor(signal: LineControlSignal): LineKillReason {
  return signal;
}

/** kill ที่มาจากคน: แยกตาม role เพื่อให้ audit บอกได้ว่าใครสั่ง (#358 §F) */
export function operatorKillReasonFor(role: LineControlActorRole): LineKillReason {
  return role === 'COMPLIANCE' ? 'COMPLIANCE_KILL' : 'OPERATOR_KILL';
}

/**
 * provider outcome ที่ต้องปิด scope ทันทีโดยไม่ต้องรอคนตัดสิน (#358 §D/§F)
 * outcome ที่ไม่อยู่ในตารางนี้ (rejected/unavailable/unknown) ยังเป็นเรื่องของ delivery ใบเดียว
 */
export const LINE_OUTCOME_KILL_SIGNALS: Readonly<
  Partial<Record<LineProviderOutcomeCode, LineControlSignal>>
> = Object.freeze({
  LINE_AUTH_INVALID: 'AUTH_FAILURE',
  LINE_MONTHLY_QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  LINE_RETRY_WINDOW_EXPIRED: 'UNKNOWN_OUTCOME_EXPIRED',
});

export function killSignalForOutcome(
  outcomeCode: LineProviderOutcomeCode,
): LineControlSignal | undefined {
  return LINE_OUTCOME_KILL_SIGNALS[outcomeCode];
}
