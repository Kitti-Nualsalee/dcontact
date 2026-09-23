/**
 * Owner: Delivery/Channels — one-shot proposal ที่แสดงให้ผู้ใช้ยืนยันก่อน `S2-LINE-PR02` (S2.6 #366)
 *
 * Authority: #360 §C, #358 §E
 *
 * view นี้รวมทุกค่าที่ผู้อนุมัติต้องเห็นไว้ในที่เดียวแล้วผูกด้วย `presentationDigest`:
 * final main SHA + config/migration/registry digests, tenant/channel/sender แบบ opaque,
 * recipient fingerprint (ไม่ใช่ LINE user ID), fixture + ข้อความ + content digest, credential
 * version/fingerprint/expiry, cap/quota snapshot, retry UUID และเวลาหมดอายุ 30 นาที
 *
 * ผู้ใช้ยืนยันด้วย digest ตรงตัวอักษร; ค่าใดเปลี่ยน digest ก็เปลี่ยนและ approval เดิมใช้ไม่ได้
 * ข้อความ fixture อยู่ได้เฉพาะใน view นี้ — `lineRunProposalEvidence` ตัดออกเหลือ content digest
 * ก่อนเข้า immutable artifact (#360 §E)
 */
import { LINE_PILOT_CAPS } from '@d-contact/cxa-contracts';
import { isLineRetryKey, lineContentDigest, resolveLineFixture } from './line-push-request.js';
import { lineChannelFingerprint } from './line-provider-conformance.js';
import { stableSha256 } from './line-provider-evidence-bundle.js';

export interface LineRunProposalViewInput {
  finalMainSha: string;
  digests: { config: string; migrations: string; registry: string };
  run: {
    id: string;
    tenantId: string;
    proposalDigest: string;
    configDigest: string;
    credentialRefId: string;
    credentialVersion: number;
    capLogicalDeliveries: number;
    capProviderAttempts: number;
    proposedAt: Date;
    expiresAt: Date;
  };
  gate: {
    channelAccountId: string;
    senderIdentityId: string;
    purpose: string;
    contactKind: string;
  };
  allowlistEntry: { recipientFingerprint: string; contentRef: string; contentDigest: string };
  credential: { fingerprint: string; expiresAt: Date | null; credentialKind: string };
  /** ยอดใช้ cap ปัจจุบันจาก ledger ของ gate — ไม่ใช่ค่าคงที่ของ profile */
  capUsage: { recipientLast24h: number; last24h: number; lifetime: number };
  quota: {
    type: 'limited' | 'none';
    targetLimit: number | null;
    totalUsage: number;
    observedAt: Date;
  };
  retryKey: string;
}

export interface LineRunProposalView {
  type: 'line.run-proposal';
  runAuthorizationId: string;
  proposalDigest: string;
  finalMainSha: string;
  digests: { config: string; migrations: string; registry: string };
  tenantId: string;
  channelAccountId: string;
  senderIdentityId: string;
  purpose: string;
  contactKind: string;
  recipientFingerprint: string;
  fixture: { contentRef: string; version: number; text: string[]; contentDigest: string };
  credential: {
    refId: string;
    version: number;
    kind: string;
    fingerprint: string;
    expiresAt: string | null;
  };
  caps: {
    logicalDeliveriesPerRun: number;
    providerAttemptsPerLogicalDelivery: number;
    recipientPer24h: { used: number; max: number };
    per24h: { used: number; max: number };
    lifetime: { used: number; max: number };
  };
  quota: {
    type: 'limited' | 'none';
    targetLimit: number | null;
    totalUsage: number;
    observedAt: string;
  };
  retryKey: string;
  proposedAt: string;
  expiresAt: string;
  presentationDigest: string;
}

export class LineRunProposalViewError extends Error {
  constructor(
    readonly code:
      | 'CONTENT_DIGEST_MISMATCH'
      | 'CONFIG_DIGEST_MISMATCH'
      | 'RETRY_KEY_INVALID'
      | 'PROPOSAL_TTL_INVALID'
      | 'CAP_SNAPSHOT_EXCEEDED'
      | 'FINAL_MAIN_SHA_INVALID',
  ) {
    super(`สร้าง proposal view ไม่ได้: ${code}`);
    this.name = 'LineRunProposalViewError';
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * ตรวจก่อนแสดง: view ที่ผู้ใช้เห็นต้องตรงกับสิ่งที่ worker จะส่งจริง ถ้า content digest ของ allowlist
 * ไม่ตรง fixture หรือ cap เต็มแล้ว ให้ล้มตั้งแต่ตรงนี้ ไม่ใช่ให้ผู้ใช้อนุมัติสิ่งที่ส่งไม่ได้
 */
export function buildLineRunProposalView(input: LineRunProposalViewInput): LineRunProposalView {
  if (!FULL_SHA.test(input.finalMainSha)) {
    throw new LineRunProposalViewError('FINAL_MAIN_SHA_INVALID');
  }
  const { run, gate, allowlistEntry, credential } = input;
  const fixture = resolveLineFixture(allowlistEntry.contentRef);
  if (lineContentDigest(allowlistEntry.contentRef) !== allowlistEntry.contentDigest) {
    throw new LineRunProposalViewError('CONTENT_DIGEST_MISMATCH');
  }
  if (run.configDigest !== input.digests.config) {
    throw new LineRunProposalViewError('CONFIG_DIGEST_MISMATCH');
  }
  if (!isLineRetryKey(input.retryKey)) throw new LineRunProposalViewError('RETRY_KEY_INVALID');
  const ttl = run.expiresAt.getTime() - run.proposedAt.getTime();
  if (ttl <= 0 || ttl > LINE_PILOT_CAPS.runAuthorizationTtlMinutes * 60_000) {
    throw new LineRunProposalViewError('PROPOSAL_TTL_INVALID');
  }
  const caps = {
    logicalDeliveriesPerRun: run.capLogicalDeliveries,
    providerAttemptsPerLogicalDelivery: run.capProviderAttempts,
    recipientPer24h: {
      used: input.capUsage.recipientLast24h,
      max: LINE_PILOT_CAPS.logicalDeliveriesPerRecipientPer24h,
    },
    per24h: { used: input.capUsage.last24h, max: LINE_PILOT_CAPS.logicalDeliveriesPer24h },
    lifetime: { used: input.capUsage.lifetime, max: LINE_PILOT_CAPS.logicalDeliveriesLifetime },
  };
  if (
    caps.recipientPer24h.used >= caps.recipientPer24h.max ||
    caps.per24h.used >= caps.per24h.max ||
    caps.lifetime.used >= caps.lifetime.max
  ) {
    throw new LineRunProposalViewError('CAP_SNAPSHOT_EXCEEDED');
  }

  const view: Omit<LineRunProposalView, 'presentationDigest'> = {
    type: 'line.run-proposal',
    runAuthorizationId: run.id,
    proposalDigest: run.proposalDigest,
    finalMainSha: input.finalMainSha,
    digests: { ...input.digests },
    tenantId: run.tenantId,
    channelAccountId: gate.channelAccountId,
    senderIdentityId: gate.senderIdentityId,
    purpose: gate.purpose,
    contactKind: gate.contactKind,
    recipientFingerprint: allowlistEntry.recipientFingerprint,
    fixture: {
      contentRef: allowlistEntry.contentRef,
      version: fixture.version,
      text: fixture.messages.map((message) => String(message.text ?? '')),
      contentDigest: allowlistEntry.contentDigest,
    },
    credential: {
      refId: run.credentialRefId,
      version: run.credentialVersion,
      kind: credential.credentialKind,
      fingerprint: credential.fingerprint,
      expiresAt: credential.expiresAt?.toISOString() ?? null,
    },
    caps,
    quota: {
      type: input.quota.type,
      targetLimit: input.quota.targetLimit,
      totalUsage: input.quota.totalUsage,
      observedAt: input.quota.observedAt.toISOString(),
    },
    retryKey: input.retryKey,
    proposedAt: run.proposedAt.toISOString(),
    expiresAt: run.expiresAt.toISOString(),
  };
  return { ...view, presentationDigest: stableSha256(view) };
}

/** ตรวจว่าค่าที่ผู้ใช้พิมพ์ยืนยันตรง digest ทุกตัวอักษร — ไม่รับ prefix หรือ case ต่าง */
export function lineProposalApprovalMatches(
  view: LineRunProposalView,
  confirmedDigest: string,
): boolean {
  const { presentationDigest, ...body } = view;
  return presentationDigest === stableSha256(body) && confirmedDigest === presentationDigest;
}

/**
 * รูปที่เข้า immutable artifact ได้: ไม่มีข้อความ fixture และ Channel ID เหลือแค่ fingerprint
 * digest ของ view เต็มยังอยู่ จึงพิสูจน์ย้อนได้ว่าผู้ใช้อนุมัติ view ใด
 */
export function lineRunProposalEvidence(view: LineRunProposalView) {
  const { fixture, channelAccountId, ...rest } = view;
  return {
    ...rest,
    type: 'line.run-proposal.evidence' as const,
    channelAccountFingerprint: lineChannelFingerprint(channelAccountId),
    fixture: {
      contentRef: fixture.contentRef,
      version: fixture.version,
      contentDigest: fixture.contentDigest,
    },
  };
}

/** ข้อความสำหรับหน้าจอ/ticket ที่ผู้ใช้อ่านก่อนยืนยัน — บรรทัดสุดท้ายคือ digest ที่ต้องพิมพ์ตอบ */
export function renderLineRunProposal(view: LineRunProposalView): string {
  const lines = [
    'LINE capped pilot — one-shot proposal (S2-LINE-PR02)',
    `final main SHA: ${view.finalMainSha}`,
    `config digest: ${view.digests.config}`,
    `migrations digest: ${view.digests.migrations}`,
    `registry digest: ${view.digests.registry}`,
    `tenant: ${view.tenantId}`,
    `channel: ${view.channelAccountId} / sender: ${view.senderIdentityId}`,
    `purpose/contact kind: ${view.purpose} / ${view.contactKind}`,
    `recipient fingerprint: ${view.recipientFingerprint}`,
    `fixture: ${view.fixture.contentRef} v${view.fixture.version}`,
    ...view.fixture.text.map((text) => `  ข้อความ: ${text}`),
    `content digest: ${view.fixture.contentDigest}`,
    `credential: ${view.credential.kind} #${view.credential.version} fingerprint ${view.credential.fingerprint} หมดอายุ ${view.credential.expiresAt ?? 'ไม่ระบุ'}`,
    `caps: ${view.caps.logicalDeliveriesPerRun} delivery/run, attempts ≤ ${view.caps.providerAttemptsPerLogicalDelivery}, recipient 24h ${view.caps.recipientPer24h.used}/${view.caps.recipientPer24h.max}, 24h ${view.caps.per24h.used}/${view.caps.per24h.max}, lifetime ${view.caps.lifetime.used}/${view.caps.lifetime.max}`,
    `quota: ${view.quota.type} ${view.quota.totalUsage}/${view.quota.targetLimit ?? '∞'} ณ ${view.quota.observedAt}`,
    `retry key: ${view.retryKey}`,
    `proposal digest: ${view.proposalDigest}`,
    `หมดอายุ: ${view.expiresAt}`,
    `ยืนยันด้วย presentation digest: ${view.presentationDigest}`,
  ];
  return `${lines.join('\n')}\n`;
}
