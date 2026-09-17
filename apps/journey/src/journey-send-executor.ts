/**
 * Owner: Journey — C1.6 SEND composition
 *
 * เชื่อม JourneyExecutionService (C1.5) เข้ากับ Contact Governance และ Delivery ผ่าน
 * port เท่านั้น (`TeamContactScopeAuthorizer` / `ContactGovernancePort` / `DeliveryPort`)
 * ไม่มี concrete cross-app import — BRANCH เดินอยู่แล้วใน `advance()`; ไฟล์นี้รับผิดชอบ
 * เฉพาะตอน `advance()` คืน `AWAITING_SEND`
 *
 * ลำดับที่ห้ามสลับ:
 *   1. trusted team scope ก่อน authorize/reserve เสมอ
 *   2. enqueue หลัง reservation binding (`authorizeAndReserve` ALLOW) เท่านั้น
 *   3. ตรวจ enrollment ซ้ำหลังจองแต่ก่อน enqueue — cancel ที่แซงเข้ามาต้อง release ไม่ใช่ enqueue ต่อ
 *   4. `completeSend` เดิน cursor เสมอไม่ว่า SEND จะถูกส่งจริง ถูก suppress หรือ scope deny —
 *      Governance เป็น single writer ของเหตุผลที่ถูกกด ไม่สร้าง log ซ้ำใน Journey
 */
import {
  actionKey as toActionKey,
  contactId as toContactId,
  identityId as toIdentityId,
  reservationId as toReservationId,
  teamId as toTeamId,
  tenantId as toTenantId,
  type ContactGovernancePort,
  type DeliveryPort,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import {
  JourneyStepRaceError,
  type EnrollmentView,
  type JourneyDefinitionSource,
  type JourneyExecutionService,
} from './journey-execution.js';

export interface SendContact {
  contactId: string;
  identityId?: string;
}

export interface HandleSendInput {
  tenantId: string;
  enrollmentId: string;
  stepId: string;
  stepSequence: number;
  contact: SendContact;
  correlationId: string;
  causationId?: string;
}

export type SendCompositionResult =
  | { kind: 'SENT'; enrollment: EnrollmentView }
  | { kind: 'SUPPRESSED'; reasonCode: string; enrollment: EnrollmentView }
  | { kind: 'SCOPE_DENIED'; reasonCode: string; enrollment: EnrollmentView }
  | { kind: 'SCOPE_DEFERRED'; reasonCode: 'SCOPE_CONTEXT_STALE'; enrollment: EnrollmentView }
  | { kind: 'RACE_LOST'; enrollment: EnrollmentView }
  | { kind: 'RELEASED_BEFORE_SUBMIT'; enrollment: EnrollmentView };

export interface JourneySendExecutorOptions {
  now?: () => Date;
}

export class SendStepShapeError extends Error {
  readonly code = 'SEND_STEP_SHAPE_INVALID' as const;

  constructor(readonly stepId: string) {
    super(`step ${stepId} ไม่ใช่ SEND หรือไม่มีอยู่ใน graph`);
    this.name = 'SendStepShapeError';
  }
}

export class JourneyDefinitionMissingError extends Error {
  readonly code = 'DEFINITION_MISSING' as const;

  constructor(
    readonly journeyId: string,
    readonly version: number,
  ) {
    super(`ไม่พบ published definition: ${journeyId}:${version}`);
    this.name = 'JourneyDefinitionMissingError';
  }
}

/**
 * Adapter enqueue ต้องการ leaseExpiresAt ของตัวเอง (ไม่ใช่ของ Journey) — TEST_ADAPTER
 * ยัง submit ต่อทันทีในการเรียกเดียว จึง lease สั้นพอที่จะพิสูจน์ discipline โดยไม่ต้อง
 * renew จริงในเส้นทาง happy path ของ C1
 */
const DELIVERY_LEASE_MS = 5 * 60_000;

export class JourneySendExecutor {
  private readonly now: () => Date;

  constructor(
    private readonly execution: JourneyExecutionService,
    private readonly definitions: JourneyDefinitionSource,
    private readonly scope: TeamContactScopeAuthorizer,
    private readonly governance: ContactGovernancePort,
    private readonly delivery: DeliveryPort,
    options: JourneySendExecutorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async handleSend(input: HandleSendInput): Promise<SendCompositionResult> {
    const enrollment = await this.execution.describe(input.tenantId, input.enrollmentId);
    // ถ้า cursor เดินผ่านโหนดนี้ไปแล้ว (โดย call ก่อนหน้าหรือ worker อื่น) นี่คือ replay ที่
    // สายเกินไป — ต้องไม่ scope/authorize/enqueue ซ้ำ (leaseExpiresAt สดใหม่ทุกครั้งจะทำให้
    // input hash ของ enqueue ไม่ตรงเดิมและชน IDEMPOTENCY_CONFLICT โดยไม่จำเป็น)
    if (
      enrollment.currentStepId !== input.stepId ||
      enrollment.stepSequence !== input.stepSequence
    ) {
      return { kind: 'RACE_LOST', enrollment };
    }

    const definition = await this.definitions.getVersion(
      input.tenantId,
      enrollment.journeyId,
      enrollment.journeyVersion,
    );
    if (!definition) {
      throw new JourneyDefinitionMissingError(enrollment.journeyId, enrollment.journeyVersion);
    }
    const step = definition.graph.steps.find((candidate) => candidate.id === input.stepId);
    if (!step || step.type !== 'SEND') throw new SendStepShapeError(input.stepId);

    const at = this.now().toISOString();
    const scopeDecision = await this.scope.authorize({
      tenantId: toTenantId(input.tenantId),
      teamId: toTeamId(definition.ownerTeamId),
      contactId: toContactId(input.contact.contactId),
      permission: 'CONTACT',
      at,
    });
    if (scopeDecision.decision === 'DENY') {
      return this.finish(input, (view) => ({
        kind: 'SCOPE_DENIED',
        reasonCode: scopeDecision.reasonCode,
        enrollment: view,
      }));
    }
    if (scopeDecision.decision === 'DEFER') {
      // scope ที่ stale ยังยืนยัน CONTACT permission ไม่ได้ จึงต้องคง cursor ไว้ให้ worker
      // รอบถัดไป resolve IAM ใหม่ทั้งหมดก่อนเข้า Governance reservation หรือ Delivery.
      return {
        kind: 'SCOPE_DEFERRED',
        reasonCode: scopeDecision.reasonCode,
        enrollment,
      };
    }

    const actionKey = `${input.enrollmentId}:${input.stepSequence}`;
    const authorization = await this.governance.authorizeAndReserve(toTenantId(input.tenantId), {
      channel: step.channel,
      purpose: definition.purpose,
      source: 'JOURNEY',
      sourceId: input.enrollmentId,
      actionKey,
      policyVersion: 1,
      teamId: definition.ownerTeamId,
      contactId: input.contact.contactId,
      ...(input.contact.identityId ? { identityId: input.contact.identityId } : {}),
      correlationId: input.correlationId,
    });

    if (authorization.decision !== 'ALLOW' || !authorization.reservationId) {
      return this.finish(input, (view) => ({
        kind: 'SUPPRESSED',
        reasonCode: authorization.reasonCode,
        enrollment: view,
      }));
    }

    // cancel ที่แซงเข้ามาหลังจองแต่ก่อน enqueue ต้อง release สิทธิ์คืน ไม่ใช่ส่งต่อ
    const fresh = await this.execution.describe(input.tenantId, input.enrollmentId);
    if (fresh.runState === 'TERMINAL') {
      await this.governance.releaseBeforeSubmit({
        tenantId: toTenantId(input.tenantId),
        correlationId: input.correlationId,
        reservationId: toReservationId(authorization.reservationId),
        actionKey: toActionKey(actionKey),
        reason: 'CANCELLED_BEFORE_SUBMIT',
      });
      return { kind: 'RELEASED_BEFORE_SUBMIT', enrollment: fresh };
    }

    const enqueued = await this.delivery.enqueue({
      tenantId: toTenantId(input.tenantId),
      source: 'JOURNEY',
      actionKey: toActionKey(actionKey),
      reservationId: toReservationId(authorization.reservationId),
      channel: step.channel,
      contactId: toContactId(input.contact.contactId),
      ...(input.contact.identityId ? { identityId: toIdentityId(input.contact.identityId) } : {}),
      contentRef: step.contentRef,
      correlationId: input.correlationId,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      purpose: definition.purpose,
      senderIdentityId: definition.senderIdentityId,
      leaseExpiresAt: new Date(this.now().getTime() + DELIVERY_LEASE_MS).toISOString(),
    });
    if (enqueued.status === 'ERROR') {
      throw new Error(`Delivery enqueue ล้มเหลวหลัง reservation binding แล้ว: ${enqueued.code}`);
    }

    return this.finish(input, (view) => ({ kind: 'SENT', enrollment: view }));
  }

  /**
   * `completeSend` เดิน cursor แบบ idempotent อยู่แล้วที่ระดับ Journey — แต่ถ้า worker อื่น
   * ชนะไปก่อน (`JourneyStepRaceError`) แปลว่า SEND นี้ถูกจัดการไปแล้วจริง ไม่ใช่ความล้มเหลว
   */
  private async finish(
    input: HandleSendInput,
    onSent: (enrollment: EnrollmentView) => SendCompositionResult,
  ): Promise<SendCompositionResult> {
    try {
      const outcome = await this.execution.completeSend(input.tenantId, input.enrollmentId, {
        correlationId: input.correlationId,
        ...(input.causationId ? { causationId: input.causationId } : {}),
      });
      return onSent(outcome.enrollment);
    } catch (error) {
      if (error instanceof JourneyStepRaceError) {
        const enrollment = await this.execution.describe(input.tenantId, input.enrollmentId);
        return { kind: 'RACE_LOST', enrollment };
      }
      throw error;
    }
  }
}
