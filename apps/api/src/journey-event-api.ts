import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { EventIdempotencyConflictError, type EventInboxService } from '@d-contact/journey';
import type { InboundBusinessEvent } from '@d-contact/shared';
import { GatewayServiceRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const JOURNEY_EVENT_INBOX = Symbol('JOURNEY_EVENT_INBOX');

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new BadRequestException(`${field} ต้องมีความยาว 1-${maximum} ตัวอักษร`);
  }
  return value.trim();
}

function parseInboundBusinessEvent(body: unknown): InboundBusinessEvent {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('event body ต้องเป็น object');
  }
  const candidate = body as Record<string, unknown>;
  if (Object.hasOwn(candidate, 'tenantId')) {
    throw new BadRequestException('tenantId ต้องมาจาก access token ที่ตรวจสอบแล้ว');
  }
  const occurredAt = requiredString(candidate.occurredAt, 'occurredAt', 64);
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new BadRequestException('occurredAt ต้องเป็น timestamp รูปแบบ ISO-8601');
  }
  if (!Number.isInteger(candidate.schemaVersion) || (candidate.schemaVersion as number) < 1) {
    throw new BadRequestException('schemaVersion ต้องเป็นจำนวนเต็มบวก');
  }
  if (
    !candidate.contactRef ||
    typeof candidate.contactRef !== 'object' ||
    Array.isArray(candidate.contactRef)
  ) {
    throw new BadRequestException('contactRef ต้องเป็น object');
  }
  const contactRef = candidate.contactRef as Record<string, unknown>;
  const kind = contactRef.kind;
  if (kind !== 'PHONE' && kind !== 'EMAIL' && kind !== 'LINE' && kind !== 'CRM_ID') {
    throw new BadRequestException('contactRef.kind ต้องเป็น PHONE, EMAIL, LINE หรือ CRM_ID');
  }
  if (
    !candidate.payload ||
    typeof candidate.payload !== 'object' ||
    Array.isArray(candidate.payload)
  ) {
    throw new BadRequestException('payload ต้องเป็น object');
  }

  return {
    source: requiredString(candidate.source, 'source', 120),
    eventId: requiredString(candidate.eventId, 'eventId', 240),
    type: requiredString(candidate.type, 'type', 160),
    occurredAt,
    schemaVersion: candidate.schemaVersion as number,
    contactRef: {
      kind,
      value: requiredString(contactRef.value, 'contactRef.value', 512),
    },
    payload: candidate.payload as Record<string, unknown>,
  };
}

@Controller('api/v1/events')
export class JourneyEventController {
  constructor(@Inject(JOURNEY_EVENT_INBOX) private readonly inbox: EventInboxService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @GatewayServiceRoles('journey-ingress')
  async accept(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const identity = request.gatewayServiceIdentity;
    if (!identity) throw new UnauthorizedException();

    try {
      return await this.inbox.accept(identity.tenantId, parseInboundBusinessEvent(body));
    } catch (error) {
      if (error instanceof EventIdempotencyConflictError) {
        throw new ConflictException({
          code: error.code,
          source: error.source,
          eventId: error.eventId,
        });
      }
      throw error;
    }
  }
}
