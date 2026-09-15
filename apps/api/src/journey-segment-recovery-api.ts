/**
 * J3.8 (#219) — sanitized query API ของ segment membership stream
 *
 * หลักสามข้อที่บังคับทุก endpoint ในไฟล์นี้:
 *
 * 1. **generic 404** — stream ของ tenant อื่นต้องแยกไม่ออกจาก stream ที่ไม่เคยมีอยู่จริง
 *    ถ้าตอบต่างกัน ผู้เรียกจะ probe ได้ว่า contact/segment ไหนมีอยู่ใน tenant อื่น
 * 2. **ETag จากสถานะจริง** — ประกอบจาก `lastAppliedRevision` กับ `updatedAt` ของ head
 *    ไม่ใช่ hash ของ response body ที่จะเปลี่ยนทุกครั้งที่เราแก้รูปแบบ view
 * 3. **ไม่มี payload/digest ออกไป** — `JourneySegmentQuery` ไม่อ่านคอลัมน์พวกนั้นขึ้นมาตั้งแต่ต้น
 *    ที่นี่จึงไม่ต้องกรองซ้ำ (กรองซ้ำคือกติกาชุดที่สองที่ต้องคอยให้ตรงกัน)
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

/** forensic tool — จำกัดที่ role ที่ดูแล incident เหมือน owner recovery API ของ J2.8 */
const SEGMENT_QUERY_ROLES = ['admin', 'compliance'];

/** opaque id เท่านั้น — ปฏิเสธก่อนแตะฐานข้อมูลเพื่อไม่ให้ path กลายเป็นช่องส่ง free text */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;

function actor(request: AuthenticatedGatewayRequest): { tenantId: string; actorId: string } {
  const identity = request.gatewayIdentity;
  if (!identity) throw new UnauthorizedException();
  return { tenantId: identity.tenantId, actorId: identity.userId };
}

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

/**
 * body รับได้แค่สามอย่าง — field อื่นถูกปฏิเสธ ไม่ใช่เพิกเฉย
 *
 * ถ้าเพิกเฉย operator จะเข้าใจว่าส่ง payload ทดแทนเข้ามาแล้วมีผล ทั้งที่ระบบไม่เคยอ่านมันเลย
 * และการเปิดให้แก้เนื้อหาตอน recovery เท่ากับเปิดทางปลอม membership fact ผ่านช่อง forensic
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
      message: `recovery ไม่รับ field: ${unknownFields.join(', ')}`,
    });
  }
  const evidenceRef = payload.evidenceRef;
  if (
    evidenceRef !== undefined &&
    (typeof evidenceRef !== 'string' || !OPAQUE_ID.test(evidenceRef))
  ) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'evidenceRef ต้องเป็น opaque reference',
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
  // generic โดยตั้งใจ: เป้าหมายของ tenant อื่นต้องแยกไม่ออกจากเป้าหมายที่ไม่เคยมี
  if (error instanceof SegmentRecoveryNotFoundError) {
    throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
  }
  throw error;
}

/**
 * รูปแบบที่ผิดตอบ 404 ไม่ใช่ 400
 *
 * 400 บอกผู้เรียกว่า "รูปแบบผิด" ซึ่งแปลว่ารูปแบบที่ถูกจะได้คำตอบอื่น — เปิดทางให้ไล่เดา
 * ที่นี่ทุกอย่างที่หาไม่เจอด้วยเหตุใดก็ตามตอบเหมือนกันหมด
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
