import type { ExpressionContext } from '@d-contact/cxa-contracts';

export type JourneyExecutionStatus =
  'ACTIVE' | 'WAITING' | 'SUBMITTING' | 'COMPLETED' | 'EXITED' | 'CANCELLED' | 'FAILED';

export type JourneyExecutionTerminalReason =
  | 'JOURNEY_EXIT'
  | 'CANCELLED'
  | 'GOAL_REACHED'
  | 'EXIT_RULE'
  | 'MAX_AGE_EXCEEDED'
  | 'EXECUTION_FAILED';

export interface EnrollExecutionInput {
  tenantId: string;
  journeyId: string;
  journeyVersion: number;
  /** คีย์ idempotency ของการ enroll ครั้งนี้ — eventInboxId สำหรับ EVENT trigger หรือคีย์ occurrence ของ SCHEDULE */
  enrollmentKey: string;
  correlationId: string;
}

export interface AdvanceExecutionInput {
  tenantId: string;
  executionId: string;
  /** ข้อมูลอ่านอย่างเดียวสำหรับประเมิน BRANCH — เรียกสดทุกครั้ง ไม่ persist เพื่อไม่เก็บ PII ค้างใน Journey */
  context: ExpressionContext;
  correlationId: string;
  causationId?: string;
}

export interface SubmitExecutionInput {
  tenantId: string;
  executionId: string;
  correlationId: string;
  causationId?: string;
}

export interface CancelExecutionInput {
  tenantId: string;
  executionId: string;
  reason: string;
  correlationId: string;
}

export interface RecordGoalReachedInput {
  tenantId: string;
  executionId: string;
  correlationId: string;
}

export interface RecordExitEventInput {
  tenantId: string;
  executionId: string;
  eventType: string;
  correlationId: string;
}

export interface JourneyExecutionSnapshot {
  tenantId: string;
  id: string;
  journeyId: string;
  journeyVersion: number;
  enrollmentKey: string;
  status: JourneyExecutionStatus;
  currentStepId: string;
  pendingActionKey?: string;
  stepVersion: number;
  waitUntil?: string;
  cancelledAt?: string;
  cancelReason?: string;
  goalReachedAt?: string;
  exitEventType?: string;
  exitEventAt?: string;
  terminalReason?: JourneyExecutionTerminalReason;
  terminalAt?: string;
  correlationId: string;
  enrolledAt: string;
  updatedAt: string;
}

/** ผลลัพธ์ของ SEND step หนึ่ง — port จริงเป็นของ C1.6 (Governance/Delivery composition) */
export type JourneyActionResult =
  { status: 'SUBMITTED' } | { status: 'SKIPPED'; reasonCode: string };

export interface JourneyActionCommand {
  tenantId: string;
  executionId: string;
  stepId: string;
  actionKey: string;
  channel: string;
  contentRef: string;
  correlationId: string;
  causationId?: string;
}

/**
 * Owner: Journey เปิด boundary นี้ไว้ให้ C1.6 wire Governance/Delivery จริง —
 * C1.5 ส่งมอบแค่ durable submission barrier (`SUBMITTING` persisted ก่อนเรียก) และ
 * `actionKey` ที่คงที่ (`enrollmentKey:journeyVersion:stepId`); การเรียก port ต้อง
 * idempotent ต่อ actionKey เดิมตามวินัยเดียวกับ DeliveryPort/ContactGovernancePort
 */
export interface JourneyActionPort {
  send(command: JourneyActionCommand): Promise<JourneyActionResult>;
}

export class JourneyExecutionNotFoundError extends Error {
  readonly code = 'EXECUTION_NOT_FOUND' as const;

  constructor(readonly executionId: string) {
    super(`ไม่พบ Journey execution: ${executionId}`);
    this.name = 'JourneyExecutionNotFoundError';
  }
}

export class JourneyDefinitionNotPublishedError extends Error {
  readonly code = 'DEFINITION_NOT_PUBLISHED' as const;

  constructor(
    readonly journeyId: string,
    readonly version: number,
  ) {
    super(`Journey version ยังไม่ถูก publish: ${journeyId}:${version}`);
    this.name = 'JourneyDefinitionNotPublishedError';
  }
}

export class JourneyEnrollmentConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(
    readonly journeyId: string,
    readonly enrollmentKey: string,
  ) {
    super(`enrollmentKey ถูกใช้กับ journey version อื่นแล้ว: ${journeyId}:${enrollmentKey}`);
    this.name = 'JourneyEnrollmentConflictError';
  }
}

export class JourneySubmissionBarrierError extends Error {
  readonly code = 'SUBMISSION_BARRIER_ACTIVE' as const;

  constructor(readonly executionId: string) {
    super(
      `Execution อยู่หลัง submission barrier แล้ว ต้อง reconcile ไม่ใช่ cancel: ${executionId}`,
    );
    this.name = 'JourneySubmissionBarrierError';
  }
}

export class JourneyExecutionNotSubmittingError extends Error {
  readonly code = 'NOT_SUBMITTING' as const;

  constructor(readonly executionId: string) {
    super(`Execution ไม่ได้อยู่ในสถานะ SUBMITTING: ${executionId}`);
    this.name = 'JourneyExecutionNotSubmittingError';
  }
}
