/**
 * J3.8 (#219) — sanitized query API for the segment membership stream
 *
 * Three rules every endpoint in this file enforces:
 *
 * 1. **generic 404** — another tenant's stream must be indistinguishable from one that never existed;
 *    different answers would let a caller probe which contact/segment exists in another tenant
 * 2. **ETag from real state** — built from the head's `lastAppliedRevision` and `updatedAt`,
 *    not a hash of the response body, which would change whenever the view shape changes
 * 3. **no payload/digest leaves** — `JourneySegmentQuery` never reads those columns, so nothing
 *    is filtered again here (a second filter would be a second rule set to keep in sync)
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
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import type { PrismaClient } from '@d-contact/db';
import {
  JourneySegmentQuery,
  JourneySegmentRecovery,
  SegmentRecoveryNotAllowedError,
  SegmentRecoveryNotFoundError,
  SegmentRecoveryVersionConflictError,
  type SegmentRecoveryResult,
  type SegmentStreamView,
} from '@d-contact/journey';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const JOURNEY_SEGMENT_DATABASE = Symbol('JOURNEY_SEGMENT_DATABASE');

/** Forensic tool — limited to incident-handling roles, like the J2.8 owner recovery API */
const SEGMENT_QUERY_ROLES = ['admin', 'compliance'];

/** Opaque ids only — rejected before touching the database so the path cannot carry free text */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;

function actor(request: AuthenticatedGatewayRequest): { tenantId: string; actorId: string } {
  const identity = request.gatewayIdentity;
  if (!identity) throw new UnauthorizedException();
  return { tenantId: identity.tenantId, actorId: identity.userId };
}

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

/**
 * The body accepts only three fields — any other field is rejected, not ignored.
 *
 * Ignoring it would let an operator believe a replacement payload took effect when it was never read,
 * and allowing content edits during recovery would open a way to forge membership facts via forensics
 */
const ALLOWED_RECOVERY_FIELDS = new Set(['expectedVersion', 'reasonCode', 'evidenceRef']);

function recoveryRequest(
  request: AuthenticatedGatewayRequest,
  raw: unknown,
): { expectedVersion: number; reasonCode: string; evidenceRef?: string } {
  requiredIdempotencyKey(request);
  const payload = body(raw);
  const unknownFields = Object.keys(payload).filter((key) => !ALLOWED_RECOVERY_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `recovery does not accept fields: ${unknownFields.join(', ')}`,
    });
  }
  const evidenceRef = payload.evidenceRef;
  if (
    evidenceRef !== undefined &&
    (typeof evidenceRef !== 'string' || !OPAQUE_ID.test(evidenceRef))
  ) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'evidenceRef must be an opaque reference',
    });
  }
  return {
    expectedVersion: requiredVersion(payload.expectedVersion),
    reasonCode: requiredReasonCode(payload.reasonCode),
    ...(evidenceRef ? { evidenceRef } : {}),
  };
}

function mapRecoveryError(error: unknown): never {
  if (error instanceof SegmentRecoveryVersionConflictError) {
    throw new ConflictException({
      code: error.code,
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
    });
  }
  if (error instanceof SegmentRecoveryNotAllowedError) {
    throw new ConflictException({ code: error.code, state: error.state });
  }
  // Generic on purpose: another tenant's target must be indistinguishable from one that never existed
  if (error instanceof SegmentRecoveryNotFoundError) {
    throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
  }
  throw error;
}

/**
 * A malformed id answers 404, not 400.
 *
 * A 400 tells the caller "wrong format", implying a well-formed id gets a different answer — an
 * opening for guessing. Here everything not found, for any reason, answers the same way
 */
function opaque(value: string): string {
  if (!OPAQUE_ID.test(value)) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
  return value;
}

function streamEtag(view: SegmentStreamView): string {
  return `"jr-segment:${view.lastAppliedRevision}:${Date.parse(view.updatedAt)}"`;
}

@Controller('internal/journey/segment-streams')
export class JourneySegmentRecoveryController {
  private readonly query: JourneySegmentQuery;
  private readonly recovery: JourneySegmentRecovery;

  constructor(@Inject(JOURNEY_SEGMENT_DATABASE) database: PrismaClient) {
    this.query = new JourneySegmentQuery(database);
    this.recovery = new JourneySegmentRecovery(database);
  }

  @Get(':contactId/:segmentId')
  @GatewayRoles(...SEGMENT_QUERY_ROLES)
  async readStream(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('contactId') contactId: string,
    @Param('segmentId') segmentId: string,
  ): Promise<SegmentStreamView | undefined> {
    const { tenantId } = actor(request);
    const view = await this.query.readStream(tenantId, opaque(contactId), opaque(segmentId));
    if (!view) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });

    const etag = streamEtag(view);
    response.setHeader('ETag', etag);

    const requested = request.headers['if-none-match'];
    const provided = Array.isArray(requested) ? requested[0] : requested;
    if (provided === etag) {
      response.statusCode = 304;
      return undefined;
    }
    return view;
  }

  @Post('receipts/:eventId/replay')
  @GatewayRoles(...SEGMENT_QUERY_ROLES)
  async replay(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('eventId') eventId: string,
    @Body() raw: unknown,
  ): Promise<SegmentRecoveryResult> {
    const { tenantId, actorId } = actor(request);
    const input = recoveryRequest(request, raw);
    try {
      return await this.recovery.replayReceipt({
        tenantId,
        targetRef: opaque(eventId),
        actorId,
        ...input,
      });
    } catch (error) {
      mapRecoveryError(error);
    }
  }

  @Post('receipts/:eventId/skip-quarantine')
  @GatewayRoles(...SEGMENT_QUERY_ROLES)
  async skipQuarantine(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('eventId') eventId: string,
    @Body() raw: unknown,
  ): Promise<SegmentRecoveryResult> {
    const { tenantId, actorId } = actor(request);
    const input = recoveryRequest(request, raw);
    try {
      return await this.recovery.skipQuarantine({
        tenantId,
        targetRef: opaque(eventId),
        actorId,
        ...input,
      });
    } catch (error) {
      mapRecoveryError(error);
    }
  }

  @Post('refilters/:cursorId/revalidate')
  @GatewayRoles(...SEGMENT_QUERY_ROLES)
  async revalidate(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('cursorId') cursorId: string,
    @Body() raw: unknown,
  ): Promise<SegmentRecoveryResult> {
    const { tenantId, actorId } = actor(request);
    const input = recoveryRequest(request, raw);
    try {
      return await this.recovery.revalidateRefilter({
        tenantId,
        targetRef: opaque(cursorId),
        actorId,
        ...input,
      });
    } catch (error) {
      mapRecoveryError(error);
    }
  }
}
