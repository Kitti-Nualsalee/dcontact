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
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import type { PrismaClient } from '@d-contact/db';
import { JourneySegmentQuery, type SegmentStreamView } from '@d-contact/journey';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const JOURNEY_SEGMENT_DATABASE = Symbol('JOURNEY_SEGMENT_DATABASE');

/** forensic tool — จำกัดที่ role ที่ดูแล incident เหมือน owner recovery API ของ J2.8 */
const SEGMENT_QUERY_ROLES = ['admin', 'compliance'];

/** opaque id เท่านั้น — ปฏิเสธก่อนแตะฐานข้อมูลเพื่อไม่ให้ path กลายเป็นช่องส่ง free text */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;

function actor(request: AuthenticatedGatewayRequest): { tenantId: string } {
  const identity = request.gatewayIdentity;
  if (!identity) throw new UnauthorizedException();
  return { tenantId: identity.tenantId };
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

  constructor(@Inject(JOURNEY_SEGMENT_DATABASE) database: PrismaClient) {
    this.query = new JourneySegmentQuery(database);
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
}
