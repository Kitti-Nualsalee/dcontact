/**
 * A1.8b (#473): server span ต่อ HTTP request ของ Platform API
 *
 * - เป็น root ของ trace เสมอ — ไม่รับ `traceparent` จาก client (Console อยู่นอก trust boundary)
 * - ชื่อ span ใช้ route template (`/api/v1/provisioning-requests/:requestId`) ไม่ใช่ URL จริง และไม่มี query
 * - repository/intake อ่าน traceparent จาก context นี้ไปเก็บใน DB ให้ worker ต่อ trace เดียวกัน
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { PLATFORM_TRACER, safeAttributes } from '@d-contact/platform-control';

type RoutedRequest = IncomingMessage & { route?: { path?: string }; baseUrl?: string };

@Injectable()
export class PlatformTracingMiddleware implements NestMiddleware {
  use(request: RoutedRequest, response: ServerResponse, next: () => void) {
    const method = request.method ?? 'GET';
    const span = trace
      .getTracer(PLATFORM_TRACER)
      .startSpan(`HTTP ${method}`, { kind: SpanKind.SERVER }, ROOT_CONTEXT);
    response.once('finish', () => {
      const route = request.route?.path
        ? `${request.baseUrl ?? ''}${request.route.path}`
        : undefined;
      if (route) span.updateName(`HTTP ${method} ${route}`);
      span.setAttributes(
        safeAttributes({
          'http.request.method': method,
          'http.route': route,
          'http.response.status_code': response.statusCode,
        }),
      );
      if (response.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });
    context.with(trace.setSpan(ROOT_CONTEXT, span), next);
  }
}
