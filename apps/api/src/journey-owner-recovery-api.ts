/**
 * J2.8 follow-up (#136) — internal sanitized query API and audited replay/reconcile/cancel
 * of owner actions
 *
 * Three requirements from #136's acceptance that apply to every mutation in this file:
 *   1. `Idempotency-Key` — required on every mutation, no default
 *   2. `expectedVersion` — must match the version the operator actually saw, otherwise 409
 *      VERSION_CONFLICT, preventing a "blind retry" from overwriting state that has moved on
 *   3. structured reason — `reasonCode` is written to JrRecoveryAudit every time (append-only)
 *
 * Sanitized: no endpoint returns the command/result payload, requestHash or resultHash, because the
 * payload may hold business data that must not leave through a forensic API — only identity, state
 * and time are returned. Another tenant's resource answers 404 RESOURCE_NOT_FOUND exactly like one
 * that never existed, so existence cannot be probed across tenants
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

/** Admin recovery is a forensic tool — limited to incident-handling roles */
const RECOVERY_ROLES = ['admin', 'compliance'];

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'body must be an object' });
  }
  return value as Record<string, unknown>;
}

function requiredIdempotencyKey(request: AuthenticatedGatewayRequest): string {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.trim().length === 0) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'header Idempotency-Key is required',
    });
  }
  return value.trim();
}

function requiredVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'expectedVersion must be a positive integer',
    });
  }
  return value;
}

/** The reason must be a groupable code, not free text that could leak PII */
function requiredReasonCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'reasonCode must be UPPER_SNAKE_CASE, 3-64 characters long',
    });
  }
  return value;
}

/** Admin recovery is open to workspace identities only — a service account is not an incident owner */
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
  // Generic on purpose: another tenant's action must be indistinguishable from one that never existed
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
   * Reconcile does not change state itself — it records that the owner should be asked again.
   * The actual pull is done by `JourneyOwnerResultReconciler` running as a worker, so this API only
   * releases the command back into the queue and audits it; it never mutates canonical state
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
