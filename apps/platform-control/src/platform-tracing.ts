/**
 * Owner: Platform operations — distributed trace ของ Platform provisioning (A1.8b #473, #388 checkpoint 2)
 *
 * - OpenTelemetry SDK + OTLP (decision ใน #473): เปิดเมื่อตั้ง `OTEL_EXPORTER_OTLP_ENDPOINT` เท่านั้น
 *   — ไม่ตั้ง = API ของ OTel เป็น no-op ทั้งหมด และ provisioning ทำงานเหมือนเดิม; collector ล่มก็ไม่กระทบ
 *   (BatchSpanProcessor ทิ้ง span เอง ไม่ throw กลับมา)
 * - ไม่ใช้ auto-instrumentation: URL/query/SQL มีโอกาสมี email/slug/domain — span เขียนเองเฉพาะจุด
 *   และ attribute ผ่าน `safeAttributes` ที่รับเฉพาะ key ในรายการ + ค่าที่เป็น id/code เท่านั้น
 * - trace เดียวต่อคำขอ: Platform API เก็บ W3C traceparent ลง `pf_provisioning_requests` /
 *   `pf_operator_commands` แล้ว worker ใช้เป็น parent ของ span — ต่อกันได้แม้ worker restart
 */
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export const PLATFORM_TRACER = 'dcontact-platform-provisioning';

/** attribute ที่อนุญาต — ค่าเป็น opaque id, enum หรือ stable code เท่านั้น */
const ALLOWED = new Set([
  'dcontact.request_id',
  'dcontact.tenant_id',
  'dcontact.command_id',
  'dcontact.correlation_id',
  'dcontact.step_key',
  'dcontact.attempt',
  'dcontact.action',
  'dcontact.command_kind',
  'dcontact.outcome',
  'dcontact.code',
  'dcontact.adopted',
  'dcontact.state_before',
  'dcontact.state_after',
  'dcontact.worker_id',
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'keycloak.operation',
]);
const SAFE_TEXT = /^[A-Za-z0-9._:/{}-]{1,160}$/;

export function safeAttributes(input: Record<string, unknown>): Attributes {
  const output: Attributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED.has(key) || value === undefined || value === null) continue;
    if (typeof value === 'number' || typeof value === 'boolean') output[key] = value;
    // ค่าที่มี '@' หรืออักขระนอกชุด id/code ถูกทิ้ง — กัน email/ข้อความอิสระหลุด
    else if (typeof value === 'string' && SAFE_TEXT.test(value)) output[key] = value;
  }
  return output;
}

function tracer() {
  return trace.getTracer(PLATFORM_TRACER);
}

const propagator = new W3CTraceContextPropagator();

/** traceparent ของ span ที่ active อยู่ — ไม่มี span ที่ sample = null (tracing ปิด) */
export function currentTraceparent(): string | null {
  const span = trace.getActiveSpan();
  if (!span?.spanContext().traceFlags) return null;
  const carrier: Record<string, string> = {};
  propagator.inject(context.active(), carrier, {
    set: (target, key, value) => {
      target[key] = value;
    },
  });
  return carrier.traceparent ?? null;
}

function parentContext(traceparent: string | null | undefined): Context {
  if (!traceparent) return context.active();
  return propagator.extract(
    ROOT_CONTEXT,
    { traceparent },
    {
      get: (carrier, key) => carrier[key as 'traceparent'],
      keys: (carrier) => Object.keys(carrier),
    },
  );
}

/**
 * รัน `work` ใน span ใหม่ — `parent` = traceparent ที่เก็บไว้ใน DB (ถ้ามี) ไม่อย่างนั้นใช้ context ปัจจุบัน
 * error ถูกบันทึกเป็นชื่อ class เท่านั้น (message อาจมีข้อมูลจาก dependency)
 */
export async function withSpan<T>(
  name: string,
  options: { parent?: string | null; attributes?: Record<string, unknown>; kind?: SpanKind },
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: safeAttributes(options.attributes ?? {}),
    },
    parentContext(options.parent),
    async (span) => {
      try {
        return await work(span);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute('error.type', error instanceof Error ? error.name : 'Unknown');
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function setSpanAttributes(span: Span, attributes: Record<string, unknown>) {
  span.setAttributes(safeAttributes(attributes));
}

/** ชื่อ operation ของ Keycloak Admin API: method + path ที่แทน id ด้วย `{id}` และตัด query ทิ้ง */
export function keycloakOperation(method: string, path: string): string {
  const template = path
    .split('?')[0]!
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}');
  return `${method} ${template}`;
}

export interface PlatformTracing {
  enabled: boolean;
  shutdown(): Promise<void>;
}

/**
 * เปิด tracing ของ process — `exporter` ใช้ในเทสต์ (in-memory) นอกนั้นอ่าน OTLP จาก env มาตรฐานของ OTel
 */
export function startPlatformTracing(options: {
  serviceName: string;
  env?: NodeJS.ProcessEnv;
  exporter?: SpanExporter;
}): PlatformTracing {
  const env = options.env ?? process.env;
  if (
    !options.exporter &&
    !env.OTEL_EXPORTER_OTLP_ENDPOINT &&
    !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  ) {
    return { enabled: false, shutdown: async () => undefined };
  }
  const processor: SpanProcessor = options.exporter
    ? new SimpleSpanProcessor(options.exporter)
    : new BatchSpanProcessor(new OTLPTraceExporter());
  const provider = new NodeTracerProvider({
    resource: new Resource({ 'service.name': options.serviceName }),
    spanProcessors: [processor],
  });
  provider.register({ propagator });
  return { enabled: true, shutdown: () => provider.shutdown() };
}
