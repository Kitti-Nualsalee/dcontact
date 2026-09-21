export type Cg5AlertState = 'OPEN' | 'ACKED' | 'RESOLVED' | 'SUPPRESSED';
export type Cg5AlertSeverity = 'WARNING' | 'CRITICAL';
export type Cg5EvidenceLevel = 'SUMMARY' | 'EVIDENCE';

export interface Cg5MetricBucket {
  metricKey: string;
  granularity: 'FIVE_MIN' | 'HOUR' | 'DAY';
  bucketStart: string;
  channel: string | null;
  purpose: string | null;
  decision: string | null;
  gate: string | null;
  reasonCode: string | null;
  teamId: string | null;
  value: string;
  sampleCount: string;
  updatedAt: string;
}

export interface Cg5Alert {
  id: string;
  ruleCode: string;
  state: Cg5AlertState;
  severity: Cg5AlertSeverity;
  channel: string | null;
  purpose: string | null;
  teamId: string | null;
  value: string;
  threshold: string;
  consecutiveHits: number;
  openedAt: string | null;
  ackedAt: string | null;
  resolvedAt: string | null;
  version: number;
  updatedAt: string;
}

export interface Cg5ExportJob {
  exportId: string;
  datasets: string[];
  rangeFrom: string;
  rangeTo: string;
  filters: unknown;
  evidenceLevel: Cg5EvidenceLevel;
  state: string;
  manifestDigest: string | null;
  rowCounts: unknown;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  requestedByRef: string;
}

export class Cg5ConsoleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(code ?? `CG5 API failed with HTTP ${status}`);
    this.name = 'Cg5ConsoleApiError';
  }
}

export interface Cg5ConsoleApi {
  metrics(input: {
    metricKey?: string;
    limit?: number;
  }): Promise<{ asOf: string | null; items: Cg5MetricBucket[] }>;
  alerts(input?: {
    states?: Cg5AlertState[];
    severities?: Cg5AlertSeverity[];
  }): Promise<{ asOf: string | null; items: Cg5Alert[] }>;
  acknowledgeAlert(input: {
    alertId: string;
    version: number;
  }): Promise<{ alertId: string; version: number }>;
  exports(): Promise<Cg5ExportJob[]>;
  requestExport(input: {
    datasets: string[];
    rangeFrom: string;
    rangeTo: string;
    evidenceLevel: Cg5EvidenceLevel;
    reason: string;
    idempotencyKey: string;
  }): Promise<Cg5ExportJob>;
}

const BASE = '/api/v1/contact-governance';

export function createCg5ConsoleApi(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): Cg5ConsoleApi {
  const request = input.fetch ?? globalThis.fetch;
  const call = async <T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string } = {},
  ) => {
    const token = input.accessToken();
    if (!token) throw new Cg5ConsoleApiError(401, 'AUTHORIZATION_CONTEXT_UNAVAILABLE');
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
    const response = await request(`${input.baseUrl.replace(/\/$/, '')}${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        { code?: string } | undefined;
      throw new Cg5ConsoleApiError(response.status, payload?.code);
    }
    return (await response.json()) as T;
  };
  return {
    metrics: (filter) => {
      const query = new URLSearchParams({
        granularity: 'FIVE_MIN',
        limit: String(filter.limit ?? 50),
      });
      if (filter.metricKey) query.set('metricKey', filter.metricKey);
      return call(`/metrics?${query}`);
    },
    alerts: (filter = {}) => {
      const query = new URLSearchParams({ limit: '50' });
      if (filter.states?.length) query.set('state', filter.states.join(','));
      if (filter.severities?.length) query.set('severity', filter.severities.join(','));
      return call(`/alerts?${query}`);
    },
    acknowledgeAlert: ({ alertId, version }) =>
      call(`/alerts/${encodeURIComponent(alertId)}/ack`, { method: 'POST', body: { version } }),
    exports: async () => (await call<{ items: Cg5ExportJob[] }>('/exports')).items,
    requestExport: ({ idempotencyKey, ...body }) =>
      call('/exports', { method: 'POST', body, idempotencyKey }),
  };
}
