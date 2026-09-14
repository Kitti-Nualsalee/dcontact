/**
 * CG4.9 (#192): logic ของ Hybrid Console ที่ไม่มี I/O
 *
 * ไม่มีการตัดสิน policy หรือ quorum ในนี้ (#174 §1 ห้าม alternate evaluator) — มีเพียงการเรียงคิว
 * การแสดง reference ที่ถูกปกปิด การแปลง error ของ server เป็น recovery state (#180) และคำศัพท์
 * ที่ต้องแยก Approve / ALLOW / Activate / Development Complete / Release Enabled ให้ชัด
 */
import {
  GovernanceApiError,
  type ExceptionSeries,
  type MaybeRedacted,
  type RiskTier,
} from './governance-api.js';

export type GovernanceViewer = 'SUPERVISOR' | 'TENANT_ADMIN' | 'COMPLIANCE';
export type GovernanceSection = 'overview' | 'exceptions' | 'policies' | 'audit';

/** คำศัพท์เดียวทั้ง Console: approval ไม่ใช่ runtime decision และไม่ใช่การเปิด traffic */
export const DECISION_VOCABULARY = Object.freeze({
  approve: 'Approve = บันทึกการตัดสินของ checker หนึ่งคน ยังไม่ใช่ ALLOW และยังไม่ Activate',
  allow:
    'ALLOW = ผลของ runtime ต่อการติดต่อหนึ่งครั้ง ตัดสินโดย Contact Governance ตอนส่งจริงเท่านั้น',
  activate: 'Activate = policy head ของ scope เปลี่ยนตามเวลาที่ publish ไว้',
  developmentComplete:
    'Development Complete ≠ Release Enabled: approve หรือ publish ใน Console ไม่เปิด provider traffic',
});

const RISK_RANK: Readonly<Record<RiskTier, number>> = { EMERGENCY: 0, HIGH: 1, STANDARD: 2 };

/** คิวเรียง: รายการที่ยังรอตัดสินก่อน แล้วความเสี่ยงสูงก่อน แล้วหมดอายุก่อน (#180 A) */
export function sortExceptionQueue(items: readonly ExceptionSeries[]): ExceptionSeries[] {
  return [...items].sort((left, right) => {
    const pending =
      Number(right.workflowState === 'PENDING') - Number(left.workflowState === 'PENDING');
    if (pending !== 0) return pending;
    const risk = RISK_RANK[left.riskTier] - RISK_RANK[right.riskTier];
    if (risk !== 0) return risk;
    return new Date(left.expiresAt).getTime() - new Date(right.expiresAt).getTime();
  });
}

export function isRedacted(
  ref: MaybeRedacted | undefined,
): ref is { redacted: true; digest: string } {
  return typeof ref === 'object' && ref !== null && ref.redacted === true;
}

/** reference ที่ปกปิดแสดงเป็น digest สั้นเสมอ ไม่มีทางเผยเนื้อหาจากฝั่ง Console */
export function referenceLabel(ref: MaybeRedacted | undefined): string {
  if (ref === undefined) return '—';
  if (isRedacted(ref)) return `ปกปิด · digest …${ref.digest.slice(-6)}`;
  return ref;
}

export function digestLabel(digest: string | undefined): string {
  return digest ? `…${digest.slice(-8)}` : '—';
}

/** สถานะต้องมีข้อความและสัญลักษณ์ประกอบ ไม่ใช้สีเพียงอย่างเดียว */
export function riskLabel(tier: RiskTier): string {
  return { EMERGENCY: '▲▲ EMERGENCY', HIGH: '▲ HIGH', STANDARD: '● STANDARD' }[tier];
}

export function stateLabel(state: string): string {
  const symbol =
    state === 'ACTIVE' || state === 'APPROVED'
      ? '✓'
      : state === 'PENDING' || state === 'IN_REVIEW' || state === 'SCHEDULED'
        ? '○'
        : state === 'REJECTED' || state === 'REVOKED' || state === 'CANCELLED'
          ? '✕'
          : '•';
  return `${symbol} ${state.replaceAll('_', ' ')}`;
}

export type RecoveryKind =
  | 'STALE_APPROVAL'
  | 'VERSION_CONFLICT'
  | 'HEAD_CONFLICT'
  | 'OUTCOME_UNKNOWN'
  | 'FORBIDDEN'
  | 'LIFECYCLE_BLOCKED'
  | 'NOT_FOUND'
  | 'INVALID';

export interface RecoveryState {
  kind: RecoveryKind;
  code?: string;
  message: string;
  /**
   * - `RELOAD` โหลด canonical state แล้วตัดสินใหม่ด้วย intent ใหม่
   * - `SAME_KEY` ผลไม่แน่ชัด: โหลด state ก่อน ส่งซ้ำได้ด้วย Idempotency-Key เดิมเท่านั้น
   * - `NONE` ไม่มี action ที่ช่วยได้จากหน้านี้
   */
  recovery: 'RELOAD' | 'SAME_KEY' | 'NONE';
}

/** แปลง error ของ #179 §3 เป็น recovery state ของ #180 — ไม่มีกรณีใดเลือก winner หรือ merge เอง */
export function recoveryFor(error: unknown): RecoveryState {
  if (!(error instanceof GovernanceApiError)) {
    return {
      kind: 'OUTCOME_UNKNOWN',
      message:
        'ยังไม่ทราบว่าคำสั่งถูกบันทึกแล้วหรือไม่ ระบบ hold ไว้ก่อน: โหลด canonical state แล้วลองส่งซ้ำด้วยคำสั่งเดิมเท่านั้น',
      recovery: 'SAME_KEY',
    };
  }
  const { status, code, details } = error;
  if (code === 'APPROVAL_STALE') {
    return {
      kind: 'STALE_APPROVAL',
      code,
      message:
        'สิทธิ์หรือขอบเขตอนุมัติเปลี่ยนไปแล้ว (authorization epoch ไม่ตรง) ต้องโหลด scope ปัจจุบันและอนุมัติใหม่',
      recovery: 'RELOAD',
    };
  }
  if (code === 'VERSION_CONFLICT') {
    const versions =
      details.expectedVersion !== undefined && details.actualVersion !== undefined
        ? ` (คาด v${details.expectedVersion} แต่ปัจจุบันเป็น v${details.actualVersion})`
        : '';
    return {
      kind: 'VERSION_CONFLICT',
      code,
      message: `ข้อมูลถูกเปลี่ยนจากที่อื่นแล้ว${versions} ระบบไม่รวมการแก้ไขให้อัตโนมัติ: โหลด canonical version ก่อนตัดสินใหม่`,
      recovery: 'RELOAD',
    };
  }
  if (
    code === 'POLICY_HEAD_CONFLICT' ||
    code === 'SCHEDULE_CONFLICT' ||
    code === 'POLICY_SCOPE_AMBIGUOUS'
  ) {
    return {
      kind: 'HEAD_CONFLICT',
      code,
      message:
        'Policy head ของ scope ไม่ตรงกับที่คาดไว้ ระบบไม่เลือกผู้ชนะให้: โหลด head ปัจจุบันแล้วทดสอบและอนุมัติใหม่',
      recovery: 'RELOAD',
    };
  }
  if (code === 'IDEMPOTENCY_CONFLICT') {
    return {
      kind: 'INVALID',
      code,
      message: 'คำสั่งนี้เคยถูกส่งด้วยเนื้อหาอื่นแล้ว ระบบไม่ส่งซ้ำ: โหลดสถานะแล้วเริ่มคำสั่งใหม่',
      recovery: 'RELOAD',
    };
  }
  if (status === 403) {
    const reason =
      code === 'SELF_APPROVAL_FORBIDDEN'
        ? 'ผู้สร้างคำขออนุมัติคำขอของตัวเองไม่ได้'
        : code === 'DUPLICATE_CHECKER'
          ? 'checker คนนี้ลงความเห็นใน revision นี้ไปแล้ว'
          : code === 'DELEGATION_NOT_ALLOWED'
            ? 'สิทธิ์ที่ได้รับมอบหมายใช้กับรายการระดับนี้ไม่ได้'
            : 'สิทธิ์ปัจจุบันไม่ครอบคลุมคำสั่งนี้';
    return { kind: 'FORBIDDEN', code, message: reason, recovery: 'NONE' };
  }
  if (status === 404) {
    return {
      kind: 'NOT_FOUND',
      code,
      message: 'ไม่พบรายการนี้ หรือไม่อยู่ในสิทธิ์ที่เข้าถึงได้',
      recovery: 'NONE',
    };
  }
  if (status === 422) {
    const quorum =
      code === 'QUORUM_NOT_MET' && details.required !== undefined
        ? ` (${details.current ?? 0}/${details.required})`
        : '';
    return {
      kind: 'LIFECYCLE_BLOCKED',
      code,
      message: `ขั้นตอนนี้ยังทำไม่ได้: ${code ?? 'INVALID_LIFECYCLE_TRANSITION'}${quorum}`,
      recovery: 'RELOAD',
    };
  }
  if (status >= 500 || status === 0) {
    return {
      kind: 'OUTCOME_UNKNOWN',
      code,
      message:
        'Governance ตอบไม่ได้ในขณะนี้ ระบบ fail closed: ยังไม่ทราบผลของคำสั่ง โหลด canonical state แล้วส่งซ้ำด้วยคำสั่งเดิมเท่านั้น',
      recovery: 'SAME_KEY',
    };
  }
  return { kind: 'INVALID', code, message: `คำขอไม่ถูกต้อง: ${code ?? status}`, recovery: 'NONE' };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GovernanceLocation {
  section: GovernanceSection;
  contactId?: string;
  seriesId?: string;
  policyId?: string;
  versionId?: string;
}

/**
 * URL ของ Console รับเฉพาะ opaque UUID — ค่าอื่นถูกทิ้ง เพื่อไม่ให้ contact identity หรือ
 * evidence ใด ๆ ไปอยู่ใน URL, history หรือ telemetry (#180)
 */
export function parseGovernanceLocation(url: URL): GovernanceLocation {
  const section = url.searchParams.get('section');
  const pick = (name: string) => {
    const value = url.searchParams.get(name);
    return value && UUID.test(value) ? value : undefined;
  };
  const contactId = pick('contactId');
  const seriesId = pick('seriesId');
  const policyId = pick('policyId');
  const versionId = pick('versionId');
  return {
    section:
      section === 'exceptions' || section === 'policies' || section === 'audit'
        ? section
        : 'overview',
    ...(contactId ? { contactId } : {}),
    ...(seriesId ? { seriesId } : {}),
    ...(policyId ? { policyId } : {}),
    ...(versionId ? { versionId } : {}),
  };
}

export function governanceHref(location: GovernanceLocation): string {
  const params = new URLSearchParams({ view: 'governance', section: location.section });
  for (const key of ['contactId', 'seriesId', 'policyId', 'versionId'] as const) {
    const value = location[key];
    if (value && UUID.test(value)) params.set(key, value);
  }
  return `?${params}`;
}

/** viewer ที่ทำ command ได้ในแต่ละงาน — server re-authorize ทุกครั้ง นี่เป็นเพียงการซ่อนปุ่มที่รู้ว่าไม่ผ่าน */
export function canDecide(viewer: GovernanceViewer): boolean {
  return viewer === 'COMPLIANCE';
}

export function canRequestChanges(viewer: GovernanceViewer): boolean {
  return viewer === 'COMPLIANCE' || viewer === 'TENANT_ADMIN';
}

export function effectiveWindowLabel(startsAt: string, expiresAt: string): string {
  const format = (value: string) =>
    new Date(value).toLocaleString('th-TH', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  return `${format(startsAt)} – ${format(expiresAt)} UTC (สิ้นสุดแบบ exclusive)`;
}
