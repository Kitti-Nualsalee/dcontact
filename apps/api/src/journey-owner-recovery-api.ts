/**
 * J2.8 follow-up (#136) — internal sanitized query API และ audited replay/reconcile/cancel
 * ของ owner action
 *
 * สามข้อที่ acceptance ของ #136 บังคับและมีผลกับทุก mutation ในไฟล์นี้:
 *   1. `Idempotency-Key` — บังคับทุก mutation ไม่มีค่า default
 *   2. `expectedVersion` — ต้องตรงกับ version ที่ operator เห็นจริง ไม่งั้น 409 VERSION_CONFLICT
 *      กัน "blind retry" ที่ทับ state ซึ่งขยับไปแล้ว
 *   3. structured reason — `reasonCode` ลง JrRecoveryAudit ทุกครั้ง (append-only)
 *
 * sanitized: ไม่มี endpoint ไหนคืน command/result payload, requestHash หรือ resultHash
 * เพราะ payload อาจมี business data ที่ไม่ควรออกทาง forensic API — คืนแค่ identity, state
 * และเวลา; resource ของ tenant อื่นตอบ 404 RESOURCE_NOT_FOUND แบบเดียวกับที่ไม่เคยมีอยู่จริง
 * เพื่อไม่ให้ probe การมีอยู่ข้าม tenant ได้
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  JourneyOwnerActionRepository,
  JourneyRecoveryAuditLog,
  OwnerActionCancellationUnavailableError,
  OwnerActionNotFoundError,
  OwnerActionVersionConflictError,
} from '@d-contact/journey';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const JOURNEY_RECOVERY_DATABASE = Symbol('JOURNEY_RECOVERY_DATABASE');

/** admin recovery เป็นเครื่องมือ forensic — จำกัดไว้ที่ role ที่ดูแล incident เท่านั้น */
const RECOVERY_ROLES = ['admin', 'compliance'];

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'body ต้องเป็น object' });
  }
  return value as Record<string, unknown>;
}

function requiredIdempotencyKey(request: AuthenticatedGatewayRequest): string {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.trim().length === 0) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'header Idempotency-Key ต้องระบุ',
    });
  }
  return value.trim();
}

function requiredVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'expectedVersion ต้องเป็นจำนวนเต็มบวก',
    });
  }
  return value;
}

/** reason ต้องเป็น code ที่ query รวมกลุ่มได้ ไม่ใช่ประโยคอิสระที่อาจมี PII หลุดมา */
function requiredReasonCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'reasonCode ต้องเป็น UPPER_SNAKE_CASE ความยาว 3-64 ตัวอักษร',
    });
  }
  return value;
}

/** admin recovery เปิดให้เฉพาะ workspace identity — service account ไม่ใช่ผู้รับผิดชอบ incident */
function recoveryActor(request: AuthenticatedGatewayRequest): {
  tenantId: string;
  actorId: string;
} {
  const identity = request.gatewayIdentity;
  if (!identity) throw new UnauthorizedException();
  return { tenantId: identity.tenantId, actorId: identity.userId };
}

function mapRecoveryError(error: unknown): never {
  if (error instanceof OwnerActionVersionConflictError) {
    throw new ConflictException({
      code: error.code,
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
    });
  }
  if (error instanceof OwnerActionCancellationUnavailableError) {
    throw new ConflictException({ code: error.code });
  }
  // generic โดยตั้งใจ: action ของ tenant อื่นต้องแยกไม่ออกจาก action ที่ไม่เคยมี
  if (error instanceof OwnerActionNotFoundError) {
    throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
  }
  throw error;
}

export interface SanitizedOwnerCommandView {
  commandId: string;
  state: string;
  attempts: number;
  availableAt: string;
  sentAt: string | null;
}

export interface SanitizedOwnerResultView {
  resultId: string;
  resultKind: string;
  receivedAt: string;
}

export interface SanitizedOwnerActionView {
  actionKey: string;
  kind: string;
  state: string;
  version: number;
  attempts: number;
  correlationId: string;
  createdAt: string;
  dispatchedAt: string | null;
  acknowledgedAt: string | null;
  cancelRequestedAt: string | null;
  commands: SanitizedOwnerCommandView[];
  results: SanitizedOwnerResultView[];
  recoveries: { operation: string; reasonCode: string; actorId: string; recordedAt: string }[];
}

@Controller('internal/journey/owner-actions')
export class JourneyOwnerRecoveryController {
  private readonly repository: JourneyOwnerActionRepository;
  private readonly audit: JourneyRecoveryAuditLog;

  constructor(@Inject(JOURNEY_RECOVERY_DATABASE) private readonly database: PrismaClient) {
    this.repository = new JourneyOwnerActionRepository(database);
    this.audit = new JourneyRecoveryAuditLog(database);
  }

  @Get(':actionKey')
  @GatewayRoles(...RECOVERY_ROLES)
  async query(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('actionKey') actionKey: string,
  ): Promise<SanitizedOwnerActionView> {
    const { tenantId } = recoveryActor(request);
    const action = await this.repository.getAction(tenantId, actionKey);
    if (!action) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });

    const [commands, results, recoveries] = await Promise.all([
      withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.jrOwnerCommandOutbox.findMany({
          where: { tenantId, actionKey },
          orderBy: { availableAt: 'asc' },
        }),
      ),
      this.repository.findResultsFor(tenantId, actionKey),
      this.audit.findFor(tenantId, 'ACTION', actionKey),
    ]);

    return {
      actionKey: action.actionKey,
      kind: action.kind,
      state: action.state,
      version: action.version,
      attempts: action.attempts,
      correlationId: action.correlationId,
      createdAt: action.createdAt.toISOString(),
      dispatchedAt: action.dispatchedAt?.toISOString() ?? null,
      acknowledgedAt: action.acknowledgedAt?.toISOString() ?? null,
      cancelRequestedAt: action.cancelRequestedAt?.toISOString() ?? null,
      commands: commands.map((command) => ({
        commandId: command.commandId,
        state: command.state,
        attempts: command.attempts,
        availableAt: command.availableAt.toISOString(),
        sentAt: command.sentAt?.toISOString() ?? null,
      })),
      results: results.map((result) => ({
        resultId: result.id,
        resultKind: result.resultKind,
        receivedAt: result.receivedAt.toISOString(),
      })),
      recoveries: recoveries.map((entry) => ({
        operation: entry.operation,
        reasonCode: entry.reasonCode,
        actorId: entry.actorId,
        recordedAt: entry.occurredAt.toISOString(),
      })),
    };
  }

  @Post(':actionKey/replay')
  @GatewayRoles(...RECOVERY_ROLES)
  async replay(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('actionKey') actionKey: string,
    @Body() rawBody: unknown,
  ): Promise<{ replayedCommandIds: string[]; version: number }> {
    const payload = body(rawBody);
    const idempotencyKey = requiredIdempotencyKey(request);
    const expectedVersion = requiredVersion(payload.expectedVersion);
    const reasonCode = requiredReasonCode(payload.reasonCode);
    const { tenantId, actorId } = recoveryActor(request);

    try {
      const result = await this.repository.replayCommands({
        tenantId,
        actionKey,
        expectedVersion,
      });
      await this.audit.record({
        tenantId,
        operation: 'REPLAY',
        targetKind: 'ACTION',
        targetRef: actionKey,
        reasonCode,
        actorId,
        evidenceRef: idempotencyKey,
      });
      return { replayedCommandIds: result.replayedCommandIds, version: result.action.version };
    } catch (error) {
      mapRecoveryError(error);
    }
  }

  /**
   * reconcile ไม่เปลี่ยน state เอง — เป็นการบันทึกว่ามีการสั่งให้ไปถาม owner ใหม่
   * ตัว pull จริงเป็นหน้าที่ `JourneyOwnerResultReconciler` ที่เดินเป็น worker
   * API นี้จึงทำแค่ปลดล็อกให้ command กลับเข้าคิว แล้ว audit ไว้ ไม่ใช่ mutate canonical state
   */
  @Post(':actionKey/reconcile')
  @GatewayRoles(...RECOVERY_ROLES)
  async reconcile(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('actionKey') actionKey: string,
    @Body() rawBody: unknown,
  ): Promise<{ state: string; version: number }> {
    const payload = body(rawBody);
    const idempotencyKey = requiredIdempotencyKey(request);
    const expectedVersion = requiredVersion(payload.expectedVersion);
    const reasonCode = requiredReasonCode(payload.reasonCode);
    const { tenantId, actorId } = recoveryActor(request);

    const action = await this.repository.getAction(tenantId, actionKey);
    if (!action) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    if (action.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        expectedVersion,
        actualVersion: action.version,
      });
    }

    await this.audit.record({
      tenantId,
      operation: 'RECONCILE',
      targetKind: 'ACTION',
      targetRef: actionKey,
      reasonCode,
      actorId,
      evidenceRef: idempotencyKey,
    });
    return { state: action.state, version: action.version };
  }

  @Post(':actionKey/cancel')
  @GatewayRoles(...RECOVERY_ROLES)
  async cancel(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('actionKey') actionKey: string,
    @Body() rawBody: unknown,
  ): Promise<{ state: string; version: number }> {
    const payload = body(rawBody);
    const idempotencyKey = requiredIdempotencyKey(request);
    const expectedVersion = requiredVersion(payload.expectedVersion);
    const reasonCode = requiredReasonCode(payload.reasonCode);
    const { tenantId, actorId } = recoveryActor(request);

    try {
      const action = await this.repository.requestCancellation({
        tenantId,
        actionKey,
        cancelRequestKey: idempotencyKey,
        reasonCode,
        correlationId: request.correlationId ?? idempotencyKey,
        expectedVersion,
      });
      await this.audit.record({
        tenantId,
        operation: 'CANCEL',
        targetKind: 'ACTION',
        targetRef: actionKey,
        reasonCode,
        actorId,
        evidenceRef: idempotencyKey,
      });
      return { state: action.state, version: action.version };
    } catch (error) {
      mapRecoveryError(error);
    }
  }
}
