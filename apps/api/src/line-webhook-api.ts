/**
 * S2.5 (#369): `POST /webhook/line` — the single public HTTP of S2 (#362 §4)
 *
 * the controller does only three things: take the raw bytes, hand them to the owner's ingress and map the result to an HTTP status
 * signature verification, dedupe, persistence and deciding the code all live in `LineWebhookIngress`
 *
 * - no bearer token: the provider does not hold our token, the authority is an HMAC over the raw body (#359 §B)
 *   so the route declares `@GatewayPublic()` and the ingress verifies itself before touching the payload
 * - needs a raw body that is not reserialized — `main.ts` turns on `rawBody: true` for Nest to keep it
 * - never log the signature/body and never return payload details to the caller
 * - the S2 singleton binding only; production multi-account must change to an opaque endpoint key
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
    // answers only a machine code — no event ID, payload or content-level reason goes back to the caller
    response.status(result.status).json({ code: result.code });
  }
}
