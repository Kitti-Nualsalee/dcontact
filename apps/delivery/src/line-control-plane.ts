/**
 * Owner: Delivery/Channels — durable control plane ของ LINE pilot (S2.3 #367)
 *
 * Authority: rollout/security decision #358, account authority #356, Phase Contract #362 §9
 *
 * ที่นี่คือ `LineRolloutAuthority` ของ #362 §4: propose/approve/consume/kill/clearWithApproval
 * ทุกสถานะอยู่ใน Postgres ไม่มี counter หรือ latch ใน memory — instance ใหม่หลัง restart อ่าน
 * ความจริงเดิมได้ครบ และ worker สองตัวแข่งกันได้ผู้ชนะหนึ่งตัวเสมอเพราะ race safety มาจาก
 * CAS/unique index/row lock ของ `LineControlRepository` ไม่ใช่การเช็คใน process นี้
 *
 * ลำดับที่ห้ามสลับของ effective gate (#358 §A) — ค่าใดหาย/อ่านไม่ได้/ไม่ตรง = `DISABLED`:
 *   1. durable business state ของ exact scope
 *   2. technical switch ของ Platform Operator
 *   3. kill latch (ชนะทุก state)
 *   4. exact allowlist + config digest (recipient/content/config ตรงทุกมิติ)
 *   5. credential ที่ ACTIVE และเป็น version เดียวกับที่ run authorization pin ไว้
 *   6. quota snapshot ที่ยังสดและเหลือพอ (advisory — ไม่แทน durable cap)
 *   7. one-shot run authorization ที่อนุมัติครบ ยังไม่หมดอายุ และยังไม่ถูกใช้
 * จากนั้นจึงจอง cap แบบ atomic; CG3 recheck เป็นของผู้เรียก (Governance owner) ก่อนข้าม barrier
 *
 * ไฟล์นี้ไม่มี provider I/O, ไม่มี secret value และไม่อ่าน environment variable — quota snapshot
 * กับผลการ verify token เป็น input ที่ owner ของ transport (S2.4) ป้อนเข้ามา
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  DlLineAllowlistEntry,
  DlLineAuditCategory,
  DlLineCapLedgerEntry,
  DlLineCredentialRef,
  DlLineRolloutState,
  DlLineRunAuthorization,
  DlLineScopeGate,
} from '@d-contact/db';
import {
  LINE_PILOT_CAPS,
  type LineCapKind,
  type LineCredentialKind,
  type LineGateErrorCode,
  type LineKillReason,
} from '@d-contact/cxa-contracts';
import { assertOpaqueContentRef } from './evidence.js';
import type { LineAuditRepository } from './line-audit-repository.js';
import {
  type LineControlRepository,
  type LineGateScope,
  type ReserveLineCapResult,
} from './line-control-repository.js';
import {
  assertControlAuthority,
  allowsOperation,
  automaticKillReasonFor,
  evaluateQuotaAdvisory,
  isLowering,
  isSingleStepAdvance,
  lineCapLimits,
  lineRunExpiry,
  lineRunProposalDigest,
  needsProviderCredential,
  operatorKillReasonFor,
  type LineControlActorRole,
  type LineControlSignal,
  type LineProviderOperation,
  type LineQuotaSnapshot,
} from './line-control-policy.js';

export interface LineControlActor {
  role: LineControlActorRole;
  /** opaque ref ของผู้สั่ง — ไม่ใช่อีเมลลูกค้าหรือ LINE user ID (DB CHECK ปฏิเสธรูปแบบนั้น) */
  ref: string;
}

export type LineControlOutcome<T> =
  | { status: 'APPLIED'; value: T }
  | { status: 'STALE' }
  | { status: 'DENIED'; code: LineGateErrorCode };

export interface LineGateEvaluationRequest {
  scope: LineGateScope;
  operation: LineProviderOperation;
  at: Date;
  /** จำเป็นสำหรับทุก operation ที่แตะ provider */
  configDigest?: string;
  quota?: LineQuotaSnapshot;
  /** จำเป็นสำหรับ PUSH เท่านั้น — ต้องตรงกับ allowlist tuple ที่อนุมัติไว้ทุกค่า */
  runAuthorizationId?: string;
  deliveryId?: string;
  recipientFingerprint?: string;
  contentDigest?: string;
}

export interface LineGateAllowed {
  status: 'ALLOWED';
  gate: DlLineScopeGate;
  credential?: DlLineCredentialRef;
  allowlistEntry?: DlLineAllowlistEntry;
  run?: DlLineRunAuthorization;
  /** true เมื่อ authorization ใบนี้ถูก consume โดย delivery ใบเดียวกันไปแล้ว (replay หลัง restart) */
  alreadyConsumed: boolean;
}

export interface LineGateDenied {
  status: 'DENIED';
  code: LineGateErrorCode;
  /** สัญญาณที่ทำให้ต้อง kill อัตโนมัติ — มีเฉพาะเคสที่ผิดสัญญาจริง ไม่ใช่ scope นอก allowlist */
  signal?: LineControlSignal;
}

export type LineGateDecision = LineGateAllowed | LineGateDenied;

export interface LineRunGrant {
  status: 'AUTHORIZED';
  gate: DlLineScopeGate;
  run: DlLineRunAuthorization;
  allowlistEntry: DlLineAllowlistEntry;
  credential: DlLineCredentialRef;
  logicalDelivery: DlLineCapLedgerEntry;
  /**
   * `PRE` = ยังไม่ข้าม barrier (release ได้), `POST` = หน่วย logical delivery commit ไปแล้ว
   * ผู้เรียกที่ได้ `POST` หลัง restart ต้องไป exact-key reconciliation ห้าม submit ใหม่ (#362 §11)
   */
  barrier: 'PRE' | 'POST';
  /** มีเฉพาะตอน `PRE` — slot ของ concurrency ที่ถืออยู่ */
  concurrencySlot?: DlLineCapLedgerEntry;
}

export type LineRunResult = LineRunGrant | LineGateDenied;

export interface RegisterLineAllowlistCommand {
  tenantId: string;
  gateId: string;
  scope: LineGateScope;
  recipientFingerprint: string;
  recipientProtectedRef: string;
  contentRef: string;
  contentDigest: string;
  configDigest: string;
  validFrom: Date;
  validUntil: Date;
  approvalAuditRef: string;
}

export interface RegisterLineCredentialCommand {
  tenantId: string;
  channelAccountId: string;
  credentialKind: LineCredentialKind;
  version: number;
  keychainService: string;
  keychainAccount: string;
  fingerprint: string;
  keyId?: string;
  issuedAt: Date;
  expiresAt?: Date;
  longLivedExceptionRef?: string;
}

/** ผลการ verify token ที่ owner ของ transport อ่านมาจาก LINE — ไม่มีค่า token อยู่ในนี้ */
export interface LineCredentialVerification {
  /** `client_id` ที่ provider ตอบกลับ ต้องเท่ากับ Channel ID ของ scope (#358 §G) */
  channelAccountId: string;
  verifiedAt: Date;
}

export interface ProposeLineRunCommand {
  tenantId: string;
  gate: DlLineScopeGate;
  allowlistEntry: DlLineAllowlistEntry;
  credential: DlLineCredentialRef;
  /** ref ที่ operator ตั้งให้ run ใบนี้ — ทำให้ binding เดิมเสนอใหม่ได้โดยไม่ชนใบที่ใช้ไปแล้ว */
  proposalRef: string;
  proposedAt: Date;
  capProviderAttempts?: number;
}

export interface BeginLineRunCommand {
  tenantId: string;
  scope: LineGateScope;
  runAuthorizationId: string;
  deliveryId: string;
  recipientFingerprint: string;
  contentDigest: string;
  configDigest: string;
  quota?: LineQuotaSnapshot;
  at: Date;
}

const ACCESS_TOKEN_KINDS: readonly LineCredentialKind[] = [
  'CHANNEL_ACCESS_TOKEN_V2_1',
  'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
];

export interface LineControlPlaneOptions {
  control: LineControlRepository;
  audit: LineAuditRepository;
  /** inject ได้เพื่อให้เทสต์ deterministic; production ใช้ `randomUUID` */
  newId?: () => string;
}

export class LineControlPlane {
  private readonly control: LineControlRepository;
  private readonly audit: LineAuditRepository;
  private readonly newId: () => string;

  constructor(options: LineControlPlaneOptions) {
    this.control = options.control;
    this.audit = options.audit;
    this.newId = options.newId ?? randomUUID;
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  /**
   * eventId คงที่ต่อ "คำสั่งเดียวกัน": replay คำสั่งเดิมด้วยค่าเดิมคืนแถวเดิม ส่วนคำสั่งที่ต่าง
   * (คนละ actor/คนละ version) ได้ eventId คนละตัว จึงบันทึกครบทั้งผู้ชนะและผู้แพ้ของ race
   */
  private async record(entry: {
    tenantId: string;
    category: DlLineAuditCategory;
    code: string;
    actor: LineControlActor;
    at: Date;
    subjectId?: string;
    deliveryId?: string;
    /** ค่าที่ทำให้คำสั่งนี้ต่างจากคำสั่งอื่นบน subject เดียวกัน */
    salt: readonly string[];
  }): Promise<void> {
    const salt = createHash('sha256')
      .update([entry.category, entry.code, entry.actor.ref, ...entry.salt].join('|'))
      .digest('hex')
      .slice(0, 16);
    await this.audit.append({
      id: this.newId(),
      tenantId: entry.tenantId,
      eventId: `s2.3.${entry.category.toLowerCase()}:${entry.subjectId ?? 'scope'}:${salt}`,
      category: entry.category,
      code: entry.code,
      actorKind: entry.actor.role,
      actorRef: entry.actor.ref,
      ...(entry.subjectId ? { subjectId: entry.subjectId } : {}),
      ...(entry.deliveryId ? { deliveryId: entry.deliveryId } : {}),
      occurredAt: entry.at,
    });
  }

  // ── Gate lifecycle ────────────────────────────────────────────────────────

  /** สร้าง gate ของ exact scope เป็น DISABLED ถ้ายังไม่มี — idempotent ต่อผู้เรียกทุกคน */
  async ensureScope(actor: LineControlActor, scope: LineGateScope): Promise<DlLineScopeGate> {
    assertControlAuthority(actor.role, 'SET_TECHNICAL_SWITCH');
    return this.control.ensureGate(this.newId(), scope);
  }

  findGate(scope: LineGateScope): Promise<DlLineScopeGate | null> {
    return this.control.findGate(scope);
  }

  /** ค้น allowlist ด้วย exact tuple — ผู้เรียกต้องรู้ recipient/content/config ครบถึงจะเจอ */
  findAllowlistEntry(
    tenantId: string,
    gateId: string,
    recipientFingerprint: string,
    contentDigest: string,
    configDigest: string,
  ): Promise<DlLineAllowlistEntry | null> {
    return this.control.findAllowlistEntryByTuple(
      tenantId,
      gateId,
      recipientFingerprint,
      contentDigest,
      configDigest,
    );
  }

  /**
   * เลื่อน business state ขึ้นทีละขั้นด้วย approval ของ Compliance (#358 §E) — ตั้งแต่
   * `PROVIDER_CONFORMANCE` ขึ้นไปต้องมี config digest ที่ allowlist/run authorization ใช้ร่วมกัน
   */
  async advanceState(
    actor: LineControlActor,
    gate: DlLineScopeGate,
    target: DlLineRolloutState,
    configDigest: string | null,
    at: Date,
  ): Promise<LineControlOutcome<DlLineScopeGate>> {
    assertControlAuthority(actor.role, 'ADVANCE_STATE');
    if (gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    if (!isSingleStepAdvance(gate.businessState, target)) {
      return { status: 'DENIED', code: 'LINE_GATE_INVALID_TRANSITION' };
    }
    const digest = configDigest ?? gate.configDigest;
    if (target !== 'DRY_RUN' && !digest) {
      return { status: 'DENIED', code: 'CONFIG_DIGEST_MISMATCH' };
    }
    const updated = await this.control.compareAndSetGate(gate.tenantId, gate.id, gate.version, {
      businessState: target,
      ...(digest === gate.configDigest ? {} : { configDigest: digest }),
    });
    if (!updated) return { status: 'STALE' };
    await this.record({
      tenantId: gate.tenantId,
      category: 'GATE',
      code: `GATE_ADVANCED_${target}`,
      actor,
      at,
      subjectId: gate.id,
      salt: [String(updated.version)],
    });
    return { status: 'APPLIED', value: updated };
  }

  /** ลดขั้นทำได้ทันทีโดย Compliance หรือ Platform Operator (#358 §C) */
  async lowerState(
    actor: LineControlActor,
    gate: DlLineScopeGate,
    target: DlLineRolloutState,
    at: Date,
  ): Promise<LineControlOutcome<DlLineScopeGate>> {
    assertControlAuthority(actor.role, 'LOWER_STATE');
    if (!isLowering(gate.businessState, target)) {
      return { status: 'DENIED', code: 'LINE_GATE_INVALID_TRANSITION' };
    }
    const updated = await this.control.compareAndSetGate(gate.tenantId, gate.id, gate.version, {
      businessState: target,
    });
    if (!updated) return { status: 'STALE' };
    await this.record({
      tenantId: gate.tenantId,
      category: 'GATE',
      code: `GATE_LOWERED_${target}`,
      actor,
      at,
      subjectId: gate.id,
      salt: [String(updated.version)],
    });
    return { status: 'APPLIED', value: updated };
  }

  /** technical switch เป็นของ Platform Operator ล้วน และเปิดบน scope ที่ถูก kill ไม่ได้ */
  async setTechnicalSwitch(
    actor: LineControlActor,
    gate: DlLineScopeGate,
    on: boolean,
    at: Date,
  ): Promise<LineControlOutcome<DlLineScopeGate>> {
    assertControlAuthority(actor.role, 'SET_TECHNICAL_SWITCH');
    if (on && gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    const updated = await this.control.compareAndSetGate(gate.tenantId, gate.id, gate.version, {
      technicalSwitchOn: on,
    });
    if (!updated) return { status: 'STALE' };
    await this.record({
      tenantId: gate.tenantId,
      category: 'GATE',
      code: on ? 'GATE_TECHNICAL_SWITCH_ON' : 'GATE_TECHNICAL_SWITCH_OFF',
      actor,
      at,
      subjectId: gate.id,
      salt: [String(updated.version)],
    });
    return { status: 'APPLIED', value: updated };
  }

  /**
   * kill latch: ไม่ต้องรู้ version และชนะทุก state — ครั้งแรกบันทึกเหตุผล ครั้งต่อไปเป็น no-op
   * ที่ยังคืน gate ซึ่ง latch อยู่ audit บันทึกผู้สั่งทุกคน ไม่ใช่เฉพาะผู้ที่ latch สำเร็จ
   */
  async kill(
    actor: LineControlActor,
    gate: DlLineScopeGate,
    reason: LineKillReason,
    at: Date,
  ): Promise<DlLineScopeGate> {
    assertControlAuthority(actor.role, 'KILL');
    const killed = await this.control.killGate(gate.tenantId, gate.id, reason, at);
    await this.record({
      tenantId: gate.tenantId,
      category: 'KILL',
      code: `KILL_${reason}`,
      actor,
      at,
      subjectId: gate.id,
      salt: [reason, at.toISOString()],
    });
    return killed;
  }

  /** kill ที่ระบบตัดสินเอง (#358 §F) — actor เป็น `SYSTEM` ไม่ใช่การตัดสินใจของคน */
  killOnSignal(
    gate: DlLineScopeGate,
    signal: LineControlSignal,
    at: Date,
  ): Promise<DlLineScopeGate> {
    return this.kill(
      { role: 'SYSTEM', ref: `system.${signal.toLowerCase()}` },
      gate,
      automaticKillReasonFor(signal),
      at,
    );
  }

  /** kill โดยคน: reason ผูกกับ role ของผู้สั่งเพื่อให้ audit แยก operator/compliance ได้ */
  killByActor(actor: LineControlActor, gate: DlLineScopeGate, at: Date): Promise<DlLineScopeGate> {
    return this.kill(actor, gate, operatorKillReasonFor(actor.role), at);
  }

  /**
   * ยก kill ต้องเป็น Compliance และต้องมี approval ref ใหม่ที่อ้าง remediation/evidence
   * (#358 §E) — DB trigger บังคับซ้ำว่า ref ต้องไม่ซ้ำของเดิมและ state ต้องกลับไป `DISABLED`
   */
  async clearWithApproval(
    actor: LineControlActor,
    gate: DlLineScopeGate,
    killClearedRef: string,
    at: Date,
  ): Promise<LineControlOutcome<DlLineScopeGate>> {
    assertControlAuthority(actor.role, 'CLEAR_KILL');
    if (!gate.killed) return { status: 'DENIED', code: 'LINE_GATE_INVALID_TRANSITION' };
    if (killClearedRef === gate.killClearedRef) {
      return { status: 'DENIED', code: 'LINE_GATE_AUTHORIZATION_DENIED' };
    }
    const updated = await this.control.clearGateKill(
      gate.tenantId,
      gate.id,
      gate.version,
      killClearedRef,
    );
    if (!updated) return { status: 'STALE' };
    await this.record({
      tenantId: gate.tenantId,
      category: 'KILL',
      code: 'KILL_CLEARED',
      actor,
      at,
      subjectId: gate.id,
      salt: [killClearedRef, String(updated.version)],
    });
    return { status: 'APPLIED', value: updated };
  }

  // ── Allowlist ─────────────────────────────────────────────────────────────

  /** Tenant Admin เป็นผู้ยืนยัน recipient/purpose/content ของ scope (#358 §E) */
  async registerAllowlistEntry(
    actor: LineControlActor,
    command: RegisterLineAllowlistCommand,
    at: Date,
  ): Promise<DlLineAllowlistEntry> {
    assertControlAuthority(actor.role, 'REGISTER_ALLOWLIST');
    assertOpaqueContentRef(command.contentRef);
    const entry = await this.control.addAllowlistEntry({
      id: this.newId(),
      tenantId: command.tenantId,
      gateId: command.gateId,
      channelAccountId: command.scope.channelAccountId,
      senderIdentityId: command.scope.senderIdentityId,
      purpose: command.scope.purpose,
      contactKind: command.scope.contactKind,
      recipientFingerprint: command.recipientFingerprint,
      recipientProtectedRef: command.recipientProtectedRef,
      contentRef: command.contentRef,
      contentDigest: command.contentDigest,
      configDigest: command.configDigest,
      validFrom: command.validFrom,
      validUntil: command.validUntil,
      approvalAuditRef: command.approvalAuditRef,
    });
    await this.record({
      tenantId: command.tenantId,
      category: 'ALLOWLIST',
      code: 'ALLOWLIST_REGISTERED',
      actor,
      at,
      subjectId: entry.id,
      salt: [command.approvalAuditRef],
    });
    return entry;
  }

  async revokeAllowlistEntry(
    actor: LineControlActor,
    tenantId: string,
    id: string,
    revocationCode: string,
    at: Date,
  ): Promise<boolean> {
    assertControlAuthority(actor.role, 'REVOKE_ALLOWLIST');
    const revoked = await this.control.revokeAllowlistEntry(tenantId, id, revocationCode, at);
    if (revoked) {
      await this.record({
        tenantId,
        category: 'ALLOWLIST',
        code: 'ALLOWLIST_REVOKED',
        actor,
        at,
        subjectId: id,
        salt: [revocationCode],
      });
    }
    return revoked;
  }

  // ── Credential metadata (#358 §G) ─────────────────────────────────────────

  /** เก็บได้เฉพาะ reference/metadata; ค่าจริงอยู่ Keychain และผ่าน `LineCredentialBoundary` เท่านั้น */
  async registerCredential(
    actor: LineControlActor,
    command: RegisterLineCredentialCommand,
    at: Date,
  ): Promise<DlLineCredentialRef> {
    assertControlAuthority(actor.role, 'REGISTER_CREDENTIAL');
    const credential = await this.control.registerCredentialRef({
      id: this.newId(),
      ...command,
    });
    await this.record({
      tenantId: command.tenantId,
      category: 'CREDENTIAL',
      code: 'CREDENTIAL_REGISTERED',
      actor,
      at,
      subjectId: credential.id,
      salt: [command.credentialKind, String(command.version)],
    });
    return credential;
  }

  /**
   * activate ได้ต่อเมื่อ verify แล้วและ `client_id` ตรงกับ Channel ID ของ credential นั้น
   * (#358 §G) — ไม่ตรงคือสัญญาณ auth failure จริง: ไม่ activate และให้ผู้เรียก kill scope
   */
  async verifyAndActivateCredential(
    actor: LineControlActor,
    tenantId: string,
    credentialId: string,
    verification: LineCredentialVerification,
    at: Date,
  ): Promise<LineControlOutcome<DlLineCredentialRef> & { signal?: LineControlSignal }> {
    assertControlAuthority(actor.role, 'ACTIVATE_CREDENTIAL');
    const candidate = await this.control.findCredentialRef(tenantId, credentialId);
    if (!candidate) return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    if (candidate.channelAccountId !== verification.channelAccountId) {
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE', signal: 'AUTH_FAILURE' };
    }
    if (candidate.expiresAt !== null && candidate.expiresAt.getTime() <= at.getTime()) {
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    }
    const activated = await this.control.activateCredentialRef(
      tenantId,
      credentialId,
      verification.verifiedAt,
      at,
    );
    if (!activated) return { status: 'STALE' };
    await this.record({
      tenantId,
      category: 'CREDENTIAL',
      code: 'CREDENTIAL_ACTIVATED',
      actor,
      at,
      subjectId: activated.id,
      salt: [String(activated.version)],
    });
    return { status: 'APPLIED', value: activated };
  }

  async revokeCredential(
    actor: LineControlActor,
    tenantId: string,
    credentialId: string,
    at: Date,
  ): Promise<boolean> {
    assertControlAuthority(actor.role, 'REVOKE_CREDENTIAL');
    const revoked = await this.control.revokeCredentialRef(tenantId, credentialId, at);
    if (revoked) {
      await this.record({
        tenantId,
        category: 'CREDENTIAL',
        code: 'CREDENTIAL_REVOKED',
        actor,
        at,
        subjectId: credentialId,
        salt: [at.toISOString()],
      });
    }
    return revoked;
  }

  // ── Run authorization (#358 §E) ───────────────────────────────────────────

  /**
   * proposal เป็น immutable: digest คิดจาก binding ทั้งชุดที่ approver มองเห็น ผู้ execute
   * จึงแก้ค่าใดหลัง approval ไม่ได้โดยที่ digest ยังเท่าเดิม caps/TTL pin จาก profile ตรง ๆ
   */
  async proposeRun(
    actor: LineControlActor,
    command: ProposeLineRunCommand,
    at: Date,
  ): Promise<LineControlOutcome<DlLineRunAuthorization>> {
    assertControlAuthority(actor.role, 'PROPOSE_RUN');
    const { gate, allowlistEntry, credential } = command;
    if (gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    if (allowlistEntry.gateId !== gate.id || allowlistEntry.revokedAt) {
      return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
    }
    if (
      allowlistEntry.validFrom.getTime() > command.proposedAt.getTime() ||
      allowlistEntry.validUntil.getTime() <= command.proposedAt.getTime()
    ) {
      return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
    }
    if (gate.configDigest !== allowlistEntry.configDigest) {
      return { status: 'DENIED', code: 'CONFIG_DIGEST_MISMATCH' };
    }
    if (credential.status !== 'ACTIVE' || !ACCESS_TOKEN_KINDS.includes(credential.credentialKind)) {
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    }
    const expiresAt = lineRunExpiry(command.proposedAt);
    if (credential.expiresAt !== null && credential.expiresAt.getTime() <= expiresAt.getTime()) {
      // token ที่จะหมดอายุก่อน authorization หมดอายุ ทำให้ worker ข้าม barrier ด้วย token ตาย
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    }

    const capProviderAttempts = Math.min(
      command.capProviderAttempts ?? LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery,
      LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery,
    );
    const proposalDigest = lineRunProposalDigest({
      tenantId: command.tenantId,
      gateId: gate.id,
      channelAccountId: gate.channelAccountId,
      senderIdentityId: gate.senderIdentityId,
      purpose: gate.purpose,
      contactKind: gate.contactKind,
      allowlistEntryId: allowlistEntry.id,
      recipientFingerprint: allowlistEntry.recipientFingerprint,
      contentDigest: allowlistEntry.contentDigest,
      configDigest: allowlistEntry.configDigest,
      credentialRefId: credential.id,
      credentialVersion: credential.version,
      capLogicalDeliveries: LINE_PILOT_CAPS.logicalDeliveriesPerRun,
      capProviderAttempts,
      proposedBy: actor.ref,
      proposalRef: command.proposalRef,
      proposedAt: command.proposedAt,
      expiresAt,
    });

    const run = await this.control.proposeRun({
      id: this.newId(),
      tenantId: command.tenantId,
      gateId: gate.id,
      allowlistEntryId: allowlistEntry.id,
      credentialRefId: credential.id,
      credentialVersion: credential.version,
      proposalDigest,
      configDigest: allowlistEntry.configDigest,
      capLogicalDeliveries: LINE_PILOT_CAPS.logicalDeliveriesPerRun,
      capProviderAttempts,
      proposedBy: actor.ref,
      proposedAt: command.proposedAt,
      expiresAt,
    });
    await this.record({
      tenantId: command.tenantId,
      category: 'RUN_AUTHORIZATION',
      code: 'RUN_PROPOSED',
      actor,
      at,
      subjectId: run.id,
      salt: [proposalDigest],
    });
    return { status: 'APPLIED', value: run };
  }

  /**
   * ผู้เสนอ approve ตัวเองไม่ได้ (#358 §E) — คนเดียวถือได้ทั้ง Tenant Admin และ Compliance
   * แต่ต้องยืนยันสองครั้งแยกกัน และห้ามเป็นคนเดียวกับผู้เสนอ/ผู้ execute
   */
  async approveRun(
    actor: LineControlActor,
    tenantId: string,
    runId: string,
    at: Date,
  ): Promise<LineControlOutcome<DlLineRunAuthorization>> {
    const action =
      actor.role === 'COMPLIANCE' ? 'APPROVE_RUN_COMPLIANCE' : 'APPROVE_RUN_TENANT_ADMIN';
    assertControlAuthority(actor.role, action);
    const run = await this.control.findRun(tenantId, runId);
    if (!run) return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    if (run.proposedBy === actor.ref) {
      return { status: 'DENIED', code: 'LINE_GATE_AUTHORIZATION_DENIED' };
    }
    if (run.state !== 'PROPOSED') return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    if (run.expiresAt.getTime() < at.getTime()) {
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_EXPIRED' };
    }
    const approved = await this.control.approveRun(
      tenantId,
      runId,
      actor.role === 'COMPLIANCE' ? 'COMPLIANCE' : 'TENANT_ADMIN',
      actor.ref,
      at,
    );
    if (!approved) return { status: 'STALE' };
    await this.record({
      tenantId,
      category: 'RUN_AUTHORIZATION',
      code: actor.role === 'COMPLIANCE' ? 'RUN_APPROVED_COMPLIANCE' : 'RUN_APPROVED_TENANT_ADMIN',
      actor,
      at,
      subjectId: runId,
      salt: [run.proposalDigest],
    });
    return { status: 'APPLIED', value: approved };
  }

  async closeRun(
    actor: LineControlActor,
    tenantId: string,
    runId: string,
    state: 'EXPIRED' | 'REVOKED',
    at: Date,
  ): Promise<boolean> {
    assertControlAuthority(actor.role, 'CLOSE_RUN');
    const closed = await this.control.closeRun(tenantId, runId, state, at);
    if (closed) {
      await this.record({
        tenantId,
        category: 'RUN_AUTHORIZATION',
        code: `RUN_${state}`,
        actor,
        at,
        subjectId: runId,
        salt: [at.toISOString()],
      });
    }
    return closed;
  }

  // ── Fail-closed evaluation (#358 §A) ──────────────────────────────────────

  /**
   * read-only: ไม่เปลี่ยนสถานะใด ๆ เพื่อให้เรียกซ้ำได้ทุกจุด (preflight, หลัง restart, ก่อน barrier)
   * การปฏิเสธที่ไม่ใช่ความผิดของ scope คืน code กลาง ๆ และไม่บอกว่า gate/allowlist/recipient
   * มีอยู่จริงหรือไม่ (#358 §B) — ผู้เรียกจึงเอา code ไปแยกแยะข้อมูลของ tenant อื่นไม่ได้
   */
  async evaluate(request: LineGateEvaluationRequest): Promise<LineGateDecision> {
    const gate = await this.control.findGate(request.scope);
    if (!gate) return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
    if (gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    if (!gate.technicalSwitchOn) {
      return { status: 'DENIED', code: 'LINE_GATE_TECHNICAL_SWITCH_OFF' };
    }
    if (!allowsOperation(gate.businessState, request.operation)) {
      return { status: 'DENIED', code: 'LINE_GATE_AUTHORIZATION_DENIED' };
    }
    if (!needsProviderCredential(request.operation)) {
      // DRY_RUN ต้อง resolve/validate allowlist ให้จริงเมื่อผู้เรียกระบุ recipient/content มาด้วย
      // (#358 §A) — ต่างกันแค่ตรงที่ไม่มี network I/O ไม่ใช่ข้ามการตรวจ
      if (request.recipientFingerprint !== undefined || request.contentDigest !== undefined) {
        const entry = await this.matchedAllowlistEntry(gate, request);
        if (!entry) return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
        return { status: 'ALLOWED', gate, allowlistEntry: entry, alreadyConsumed: false };
      }
      return { status: 'ALLOWED', gate, alreadyConsumed: false };
    }

    if (!gate.configDigest || gate.configDigest !== request.configDigest) {
      return { status: 'DENIED', code: 'CONFIG_DIGEST_MISMATCH' };
    }
    const credential = await this.control.findActiveCredentialRef(
      request.scope.tenantId,
      gate.channelAccountId,
      'ACCESS_TOKEN',
    );
    if (!credential) return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    if (credential.expiresAt !== null && credential.expiresAt.getTime() <= request.at.getTime()) {
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    }

    const quota = evaluateQuotaAdvisory(request.quota, request.at);
    if (quota !== 'OK') {
      return {
        status: 'DENIED',
        code: 'LINE_GATE_AUTHORIZATION_DENIED',
        ...(quota === 'EXHAUSTED' ? { signal: 'QUOTA_EXHAUSTED' as const } : {}),
      };
    }

    if (request.operation !== 'PUSH') {
      return { status: 'ALLOWED', gate, credential, alreadyConsumed: false };
    }

    if (!request.runAuthorizationId || !request.recipientFingerprint || !request.contentDigest) {
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    }
    const run = await this.control.findRun(request.scope.tenantId, request.runAuthorizationId);
    if (!run || run.gateId !== gate.id) {
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    }
    if (run.configDigest !== gate.configDigest) {
      return {
        status: 'DENIED',
        code: 'CONFIG_DIGEST_MISMATCH',
        signal: 'ALLOWLIST_BINDING_MISMATCH',
      };
    }

    const allowlistEntry = await this.control.findAllowlistEntry(
      request.scope.tenantId,
      run.allowlistEntryId,
    );
    if (
      !allowlistEntry ||
      allowlistEntry.revokedAt ||
      allowlistEntry.validFrom.getTime() > request.at.getTime() ||
      allowlistEntry.validUntil.getTime() <= request.at.getTime()
    ) {
      return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
    }
    // binding mismatch ภายใน run ที่อนุมัติแล้วคือ bypass จริง ไม่ใช่ scope นอก allowlist ธรรมดา
    if (
      allowlistEntry.recipientFingerprint !== request.recipientFingerprint ||
      allowlistEntry.contentDigest !== request.contentDigest ||
      allowlistEntry.configDigest !== request.configDigest
    ) {
      return {
        status: 'DENIED',
        code: 'LINE_GATE_SCOPE_NOT_ALLOWED',
        signal: 'ALLOWLIST_BINDING_MISMATCH',
      };
    }

    if (run.credentialRefId !== credential.id || run.credentialVersion !== credential.version) {
      return { status: 'DENIED', code: 'CREDENTIAL_VERSION_MISMATCH' };
    }

    if (run.state === 'CONSUMED') {
      if (request.deliveryId && run.consumedDeliveryId === request.deliveryId) {
        return { status: 'ALLOWED', gate, credential, allowlistEntry, run, alreadyConsumed: true };
      }
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_CONSUMED' };
    }
    if (run.state === 'EXPIRED') return { status: 'DENIED', code: 'RUN_AUTHORIZATION_EXPIRED' };
    if (run.state !== 'APPROVED') return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    if (run.expiresAt.getTime() < request.at.getTime()) {
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_EXPIRED' };
    }

    return { status: 'ALLOWED', gate, credential, allowlistEntry, run, alreadyConsumed: false };
  }

  /** allowlist ที่ตรง tuple ที่ผู้เรียกถืออยู่จริง และยังอยู่ในช่วงใช้งาน */
  private async matchedAllowlistEntry(
    gate: DlLineScopeGate,
    request: LineGateEvaluationRequest,
  ): Promise<DlLineAllowlistEntry | null> {
    if (!request.recipientFingerprint || !request.contentDigest || !request.configDigest) {
      return null;
    }
    const entry = await this.control.findAllowlistEntryByTuple(
      request.scope.tenantId,
      gate.id,
      request.recipientFingerprint,
      request.contentDigest,
      request.configDigest,
    );
    if (!entry || entry.revokedAt) return null;
    if (
      entry.validFrom.getTime() > request.at.getTime() ||
      entry.validUntil.getTime() <= request.at.getTime()
    ) {
      return null;
    }
    return entry;
  }

  // ── One-shot run + atomic caps ────────────────────────────────────────────

  /**
   * barrier ของ control plane: อ่าน durable state ให้ครบก่อน แล้วจึง consume one-shot
   * ลำดับ consume ก่อน reserve เป็นเจตนา — cap ที่ปฏิเสธหลัง consume จะเผา authorization ทิ้ง
   * และบังคับให้ต้องเสนอ/อนุมัติใหม่ ซึ่งเป็นด้าน fail-closed ที่ถูกต้องของ one-shot
   *
   * เรียกซ้ำด้วย deliveryId เดิมหลัง restart ได้ผลเดิม: `evaluate` เห็นว่า authorization ถูก
   * consume โดย delivery ใบนี้แล้ว จึงข้าม `consumeRun` และ cap reservation คืน replay เดิม
   */
  async beginRun(actor: LineControlActor, command: BeginLineRunCommand): Promise<LineRunResult> {
    assertControlAuthority(actor.role, 'EXECUTE_RUN');
    const decision = await this.evaluate({
      scope: command.scope,
      operation: 'PUSH',
      at: command.at,
      configDigest: command.configDigest,
      quota: command.quota,
      runAuthorizationId: command.runAuthorizationId,
      deliveryId: command.deliveryId,
      recipientFingerprint: command.recipientFingerprint,
      contentDigest: command.contentDigest,
    });
    if (decision.status === 'DENIED') {
      return this.denyRun(actor, command, decision);
    }
    const { gate, run, allowlistEntry, credential } = decision;
    if (!run || !allowlistEntry || !credential) {
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    }

    // unknown-reconciling ค้างอยู่ = auto-pause งานใหม่ แต่ reconciliation ของใบเดิมยังเดินต่อได้
    const unknown = await this.control.listActiveCapEntries(
      command.tenantId,
      gate.id,
      'CONCURRENT_UNKNOWN',
    );
    if (unknown.some((entry) => entry.deliveryId !== command.deliveryId)) {
      return this.denyRun(actor, command, {
        status: 'DENIED',
        code: 'CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED',
      });
    }

    if (!decision.alreadyConsumed) {
      const consumed = await this.control.consumeRun(
        command.tenantId,
        run.id,
        command.deliveryId,
        command.at,
      );
      if (consumed.status === 'DENIED') {
        return this.denyRun(actor, command, { status: 'DENIED', code: consumed.code });
      }
      await this.record({
        tenantId: command.tenantId,
        category: 'RUN_AUTHORIZATION',
        code: 'RUN_CONSUMED',
        actor,
        at: command.at,
        subjectId: run.id,
        deliveryId: command.deliveryId,
        salt: [command.deliveryId],
      });
    }

    const logical = await this.reserve(command, gate.id, run.id, 'LOGICAL_DELIVERY', {
      runCapProviderAttempts: run.capProviderAttempts,
    });
    if (logical.status === 'DENIED') {
      return this.denyRun(actor, command, { status: 'DENIED', code: logical.code });
    }
    // delivery ที่ release ไปแล้วถูกปลุกกลับมาใหม่ = การนับ cap เชื่อไม่ได้อีกต่อไป (#358 §F)
    if (logical.entry.state === 'RELEASED') {
      return this.denyRun(actor, command, {
        status: 'DENIED',
        code: 'CAP_ACCOUNTING_INCONSISTENCY',
        signal: 'CAP_ACCOUNTING_INCONSISTENCY',
      });
    }
    // restart หลังข้าม barrier: หน่วยถูก commit ไปแล้ว ห้ามจอง slot ใหม่และห้าม submit ใหม่
    if (logical.entry.state === 'COMMITTED') {
      return {
        status: 'AUTHORIZED',
        gate,
        run,
        allowlistEntry,
        credential,
        logicalDelivery: logical.entry,
        barrier: 'POST',
      };
    }

    const slot = await this.reserve(command, gate.id, run.id, 'CONCURRENT_SUBMISSION', {});
    if (slot.status === 'DENIED') {
      // ยังไม่ข้าม barrier: คืนหน่วย logical delivery ที่เพิ่งจองเพื่อไม่ให้กิน budget ของวัน
      if (!logical.replay) {
        await this.control.settleCap(
          command.tenantId,
          command.deliveryId,
          'LOGICAL_DELIVERY',
          0,
          'RELEASED',
          command.at,
        );
      }
      return this.denyRun(actor, command, { status: 'DENIED', code: slot.code });
    }
    if (slot.entry.state !== 'RESERVED') {
      return this.denyRun(actor, command, {
        status: 'DENIED',
        code: 'CAP_ACCOUNTING_INCONSISTENCY',
        signal: 'CAP_ACCOUNTING_INCONSISTENCY',
      });
    }

    // replay ของ reservation เดิมไม่ใช่การจองใหม่ จึงไม่มีแถว audit เพิ่ม
    if (!logical.replay) {
      await this.record({
        tenantId: command.tenantId,
        category: 'CAP',
        code: 'CAP_RESERVED',
        actor,
        at: command.at,
        subjectId: logical.entry.id,
        deliveryId: command.deliveryId,
        salt: [command.deliveryId, 'LOGICAL_DELIVERY'],
      });
    }
    return {
      status: 'AUTHORIZED',
      gate,
      run,
      allowlistEntry,
      credential,
      logicalDelivery: logical.entry,
      barrier: 'PRE',
      concurrencySlot: slot.entry,
    };
  }

  private reserve(
    command: BeginLineRunCommand,
    gateId: string,
    runAuthorizationId: string,
    capKind: LineCapKind,
    options: { runCapProviderAttempts?: number; attemptNo?: number },
  ): Promise<ReserveLineCapResult> {
    return this.control.reserveCap({
      id: this.newId(),
      tenantId: command.tenantId,
      gateId,
      runAuthorizationId,
      deliveryId: command.deliveryId,
      capKind,
      ...(options.attemptNo === undefined ? {} : { attemptNo: options.attemptNo }),
      recipientFingerprint: command.recipientFingerprint,
      reservedAt: command.at,
      limits: lineCapLimits({
        capKind,
        at: command.at,
        ...(options.runCapProviderAttempts === undefined
          ? {}
          : { runCapProviderAttempts: options.runCapProviderAttempts }),
      }),
    });
  }

  /** ปฏิเสธหนึ่งครั้ง = audit หนึ่งแถว และ kill ทันทีถ้าเป็นสัญญาณตาม #358 §F */
  private async denyRun(
    actor: LineControlActor,
    command: BeginLineRunCommand,
    denied: LineGateDenied,
  ): Promise<LineGateDenied> {
    if (denied.signal) {
      const gate = await this.control.findGate(command.scope);
      if (gate) await this.killOnSignal(gate, denied.signal, command.at);
    }
    await this.record({
      tenantId: command.tenantId,
      category: 'RUN_AUTHORIZATION',
      code: 'RUN_DENIED',
      actor,
      at: command.at,
      subjectId: command.runAuthorizationId,
      deliveryId: command.deliveryId,
      salt: [command.deliveryId, denied.code, command.at.toISOString()],
    });
    return denied;
  }

  /**
   * provider attempt หนึ่งครั้ง (รวม attempt แรก) — เกิน cap ของ run คือสัญญาณ
   * `PROVIDER_ATTEMPTS_EXHAUSTED` ที่ต้อง kill + quarantine ห้ามออก key ใหม่ (#358 §C)
   */
  async reserveProviderAttempt(
    actor: LineControlActor,
    command: BeginLineRunCommand,
    gate: DlLineScopeGate,
    run: DlLineRunAuthorization,
    attemptNo: number,
  ): Promise<LineControlOutcome<DlLineCapLedgerEntry>> {
    assertControlAuthority(actor.role, 'EXECUTE_RUN');
    if (gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    const reserved = await this.reserve(command, gate.id, run.id, 'PROVIDER_ATTEMPT', {
      runCapProviderAttempts: run.capProviderAttempts,
      attemptNo,
    });
    if (reserved.status === 'DENIED') {
      if (reserved.code === 'PROVIDER_ATTEMPT_CAP_EXCEEDED') {
        await this.killOnSignal(gate, 'PROVIDER_ATTEMPTS_EXHAUSTED', command.at);
      }
      return { status: 'DENIED', code: reserved.code };
    }
    return { status: 'APPLIED', value: reserved.entry };
  }

  /** ข้าม barrier แล้ว: หน่วย logical delivery กลายเป็น COMMITTED และคืน slot ของ concurrency */
  async commitDelivery(tenantId: string, deliveryId: string, at: Date): Promise<boolean> {
    const committed = await this.control.settleCap(
      tenantId,
      deliveryId,
      'LOGICAL_DELIVERY',
      0,
      'COMMITTED',
      at,
    );
    await this.control.settleCap(tenantId, deliveryId, 'CONCURRENT_SUBMISSION', 0, 'RELEASED', at);
    return committed;
  }

  /**
   * ก่อน barrier เท่านั้น: คืนทั้งหน่วยและ slot — ถ้าหน่วย commit ไปแล้วคืนไม่ได้และผู้เรียก
   * ต้องไปทาง exact-key reconciliation แทน (#358 §F, #362 §11)
   */
  async releaseDelivery(tenantId: string, deliveryId: string, at: Date): Promise<boolean> {
    const released = await this.control.settleCap(
      tenantId,
      deliveryId,
      'LOGICAL_DELIVERY',
      0,
      'RELEASED',
      at,
    );
    await this.control.settleCap(tenantId, deliveryId, 'CONCURRENT_SUBMISSION', 0, 'RELEASED', at);
    return released;
  }

  /** unknown outcome: จอง slot ที่มีได้ทีละหนึ่ง แล้ว pause งานใหม่ของ scope นี้ (#358 §C) */
  async enterUnknownReconciling(
    command: BeginLineRunCommand,
    gateId: string,
    runAuthorizationId: string,
  ): Promise<LineControlOutcome<DlLineCapLedgerEntry>> {
    const reserved = await this.reserve(
      command,
      gateId,
      runAuthorizationId,
      'CONCURRENT_UNKNOWN',
      {},
    );
    if (reserved.status === 'DENIED') return { status: 'DENIED', code: reserved.code };
    return { status: 'APPLIED', value: reserved.entry };
  }

  exitUnknownReconciling(tenantId: string, deliveryId: string, at: Date): Promise<boolean> {
    return this.control.settleCap(tenantId, deliveryId, 'CONCURRENT_UNKNOWN', 0, 'RELEASED', at);
  }
}
