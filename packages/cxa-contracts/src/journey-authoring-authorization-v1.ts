/**
 * J5.3 (#341): port ของ authorization สำหรับ Journey authoring (คำตัดสิน #331 §1, §4, §6, §10, §13)
 *
 * IAM เป็น authority เดียว: ทุก mutation/review/publish/lifecycle resolve subject, grant, delegation,
 * team active-state, authorization epoch และ scope version ใหม่จาก store ปัจจุบันใน transaction เดียวกับ
 * command — role/team/capability จาก token หรือ browser ไม่ใช่ authority (stop condition #341)
 */
import type { JourneyAuthoringErrorCode } from './journey-authoring-errors-v1.js';
import type { JourneyAuthoringCapability } from './journey-authoring-v1.js';

/** presence เป็น advisory soft lease เท่านั้น — ไม่ให้สิทธิ์และไม่ใช่ lock (#331 §7) */
export const JOURNEY_PRESENCE_TTL_SECONDS = 60;
export const JOURNEY_PRESENCE_HEARTBEAT_SECONDS = 20;

/** strong auth ต้องสดพอสำหรับ unilateral publish (#331 §10) */
export const JOURNEY_STRONG_AUTH_MAX_AGE_SECONDS = 10 * 60;

export interface JourneyAuthoringAuthentication {
  readonly strength: 'STANDARD' | 'STRONG';
  /** เวลายืนยันตัวตนจาก verified token (`auth_time`) — เป็นหลักฐาน authentication ไม่ใช่ authorization */
  readonly authenticatedAt: string;
}

export interface JourneyAuthoringAuthorizationScope {
  /** owner team จาก canonical head เสมอ ไม่ใช่ค่าที่ client ส่งมา */
  readonly teamId: string;
  /** resource ที่ delegation แบบแคบถึงระดับ object อ้างได้ */
  readonly resource?: { readonly kind: 'JOURNEY' | 'TEMPLATE'; readonly id: string };
}

export interface JourneyAuthoringAuthorizationRequest {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly capability: JourneyAuthoringCapability;
  readonly scope: JourneyAuthoringAuthorizationScope;
  /** approve/publish/lifecycle/transfer/audit ใช้ delegation ไม่ได้ */
  readonly requireDirect?: boolean;
  /** pause/deprecate/transfer ทำได้แม้ team inactive; edit/review/publish/resume ทำไม่ได้ */
  readonly allowInactiveTeam?: boolean;
  /**
   * template ที่ visibility = TENANT อ่านได้ทุกคนใน tenant ที่ถือ capability นี้ใน scope ใดก็ได้
   * (#330 §2) — ใช้กับ capability อ่านเท่านั้น
   */
  readonly anyTeam?: boolean;
}

export type JourneyAuthoringAuthorizationDecision =
  | {
      readonly allowed: true;
      readonly source: 'DIRECT' | 'DELEGATION';
      readonly delegationId: string | null;
      readonly authorizationEpoch: number;
      readonly scopeVersion: number;
      readonly directReviewAuthority: boolean;
      readonly authenticationStrength: 'STANDARD' | 'STRONG';
    }
  | { readonly allowed: false; readonly code: JourneyAuthoringErrorCode };

export interface JourneyAuthoringAuthorizationPort<TTransaction = unknown> {
  authorize(
    transaction: TTransaction,
    request: JourneyAuthoringAuthorizationRequest,
  ): Promise<JourneyAuthoringAuthorizationDecision>;
}
