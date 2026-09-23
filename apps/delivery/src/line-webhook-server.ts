/**
 * Owner: Delivery/Channels — HTTP adapter บาง ๆ ของ `POST /webhook/line` (S2.5 #369)
 *
 * หน้าที่เดียวคืออ่าน raw bytes ให้ครบโดยไม่ decode แล้วส่งให้ `LineWebhookIngress`
 * - route ตรงตัว `/webhook/line` เท่านั้น (ไม่มี query/path parameter ที่ใช้เลือก tenant/secret)
 * - หยุดอ่านทันทีที่เกินเพดาน — body ใหญ่ไม่ถูกเก็บใน memory ก่อน verify
 * - response body คงที่ (`{}`) ไม่สะท้อน error, payload หรือ signature กลับไป
 * - log เฉพาะ status + code + จำนวน ไม่มี header/body/event ID
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  LINE_WEBHOOK_MAX_BODY_BYTES,
  LINE_WEBHOOK_PATH,
  type LineWebhookIngress,
  type LineWebhookResult,
} from './line-webhook-ingress.js';

export interface LineWebhookServerOptions {
  ingress: Pick<LineWebhookIngress, 'handle'>;
  now?: () => Date;
  log?: (entry: { status: number; code: string; durationMs: number; counts?: object }) => void;
}

function readBody(request: IncomingMessage): Promise<Buffer | 'TOO_LARGE'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > LINE_WEBHOOK_MAX_BODY_BYTES) {
        settled = true;
        resolve('TOO_LARGE');
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks, size));
    });
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function respond(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end('{}');
}

export function createLineWebhookServer(options: LineWebhookServerOptions): Server {
  const now = options.now ?? (() => new Date());
  return createServer(async (request, response) => {
    const startedAt = Date.now();
    const finish = (result: Pick<LineWebhookResult, 'status' | 'code' | 'counts'>) => {
      respond(response, result.status);
      options.log?.({
        status: result.status,
        code: result.code,
        durationMs: Date.now() - startedAt,
        ...(result.counts ? { counts: result.counts } : {}),
      });
    };

    // ตรงตัวเท่านั้น: query string ไม่มีความหมายกับ binding และไม่ควรมีอะไรมากับ URL
    if (request.url !== LINE_WEBHOOK_PATH) {
      respond(response, 404);
      return;
    }
    try {
      const body = await readBody(request);
      if (body === 'TOO_LARGE') {
        finish({ status: 413, code: 'WEBHOOK_PAYLOAD_TOO_LARGE' });
        return;
      }
      finish(
        await options.ingress.handle({
          method: request.method ?? '',
          contentType: header(request, 'content-type'),
          signature: header(request, 'x-line-signature'),
          rawBody: body,
          receivedAt: now(),
        }),
      );
    } catch {
      // connection ขาดกลางทางหรือ error ที่ไม่คาด — ยังไม่ commit อะไร จึงให้ LINE redeliver
      finish({ status: 503, code: 'WEBHOOK_DURABILITY_UNAVAILABLE' });
    }
  });
}
