/**
 * S2.5 (#369): `POST /webhook/line` — public HTTP เดียวของ S2 (#362 §4)
 *
 * controller ทำแค่สามอย่าง: หยิบ raw bytes, ส่งให้ ingress ของ owner และแปลงผลเป็น HTTP status
 * การ verify signature, dedupe, persist และตัดสิน code ทั้งหมดอยู่ใน `LineWebhookIngress`
 *
 * - ไม่มี bearer token: provider ไม่ได้ถือ token ของเรา authority คือ HMAC บน raw body (#359 §B)
 *   route จึงประกาศ `@GatewayPublic()` และ ingress verify เองก่อนแตะ payload
 * - ต้องใช้ raw body ที่ไม่ถูก reserialize — `main.ts` เปิด `rawBody: true` ให้ Nest เก็บไว้
 * - ห้าม log signature/body และไม่คืนรายละเอียดของ payload กลับไปให้ผู้เรียก
 * - singleton binding ของ S2 เท่านั้น; production multi-account ต้องเปลี่ยนเป็น opaque endpoint key
 */
import { Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { LineWebhookIngress } from '@d-contact/delivery';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';
import { GatewayPublic } from './gateway-auth.js';

export const LINE_WEBHOOK_INGRESS = Symbol('LINE_WEBHOOK_INGRESS');

interface RawBodyRequest extends AuthenticatedGatewayRequest {
  rawBody?: Buffer;
}

interface StatusResponse {
  status(code: number): StatusResponse;
  json(body: unknown): void;
}

@Controller('webhook')
export class LineWebhookController {
  constructor(
    @Inject(LINE_WEBHOOK_INGRESS)
    private readonly ingress: LineWebhookIngress,
  ) {}

  @Post('line')
  @GatewayPublic()
  @HttpCode(200)
  async receive(@Req() request: RawBodyRequest, @Res() response: StatusResponse): Promise<void> {
    const signature = request.headers['x-line-signature'];
    const result = await this.ingress.handle({
      rawBody: request.rawBody ?? Buffer.alloc(0),
      signature: Array.isArray(signature) ? signature[0] : signature,
      receivedAt: new Date(),
    });
    // ตอบเฉพาะ machine code — ไม่มี event ID, payload หรือเหตุผลเชิงเนื้อหากลับไปหาผู้เรียก
    response.status(result.status).json({ code: result.code });
  }
}
