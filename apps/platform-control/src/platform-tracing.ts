/**
 * Owner: Platform operations — distributed trace of Platform provisioning (A1.8b #473, #388 checkpoint 2)
 *
 * - OpenTelemetry SDK + OTLP (decision in #473): enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
 *   — unset = the OTel API is a total no-op and provisioning works as before; a collector outage has no effect either
 *   (BatchSpanProcessor drops spans itself, never throws back)
 * - no auto-instrumentation: URLs/queries/SQL may contain an email/slug/domain — spans are written by hand at specific points
 *   and attributes go through `safeAttributes`, which accepts only keys on the list + id/code values
 * - one trace per request: the Platform API stores the W3C traceparent in `pf_provisioning_requests` /
 *   `pf_operator_commands` and the worker uses it as the span parent — it stays connected even across a worker restart
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

/** allowed attributes — values are opaque ids, enums or stable codes only */
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
    // a value containing '@' or characters outside the id/code set is dropped — keeps an email/free text from leaking
    else if (typeof value === 'string' && SAFE_TEXT.test(value)) output[key] = value;
  }
  return output;
}

function tracer() {
  return trace.getTracer(PLATFORM_TRACER);
}

const propagator = new W3CTraceContextPropagator();

/** traceparent of the active span — no sampled span = null (tracing off) */
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
 * runs `work` in a new span — `parent` = the traceparent stored in the DB (if any), otherwise the current context
 * an error is recorded by class name only (the message may carry data from a dependency)
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

/** operation name of the Keycloak Admin API: method + a path with ids replaced by `{id}` and the query dropped */
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
 * enables tracing for the process — `exporter` is for tests (in-memory), otherwise reads OTLP from the standard OTel env
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
