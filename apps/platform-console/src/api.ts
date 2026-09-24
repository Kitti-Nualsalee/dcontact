/**
 * Platform API client ของ Console (A1.7 #412) — ตาม #388 checkpoint 1
 *
 * - token มาจาก OIDC session ใน memory ทุก request (ไม่เก็บใน localStorage/URL)
 * - error ทุกแบบกลายเป็น `PlatformApiError` ที่ถือ envelope ของ API (network = code `NETWORK`)
 * - body ไม่มีช่อง tenantId/status: target resolve จาก path และ record ฝั่ง server เสมอ
 */
import type {
  ActionHistoryItem,
  CatalogView,
  CommandView,
  ErrorEnvelope,
  RecoveryOption,
  RequestView,
  SessionView,
  TenantSummary,
} from './model.js';

export class PlatformApiError extends Error {
  constructor(
    readonly envelope: ErrorEnvelope,
    readonly retryAfterSeconds?: number,
  ) {
    super(envelope.code);
    this.name = 'PlatformApiError';
  }
}

export interface PlatformApi {
  session(): Promise<SessionView>;
  catalog(): Promise<CatalogView>;
  searchTenants(input: { query?: string; status?: string; cursor?: string }): Promise<{
    items: TenantSummary[];
    nextCursor: string | null;
  }>;
  getRequest(requestId: string): Promise<RequestView>;
  createRequest(
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ replayed: boolean; request: RequestView }>;
  requestPreview(requestId: string, path: RecoveryOption['path']): Promise<CommandView>;
  getPreview(requestId: string, previewId: string): Promise<CommandView>;
  submitAction(
    requestId: string,
    path: RecoveryOption['path'] | 'resend-invitation',
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ command: CommandView; request: RequestView }>;
  getCommand(requestId: string, commandId: string): Promise<CommandView>;
  actionHistory(
    tenantId: string,
    cursor?: string,
  ): Promise<{ items: ActionHistoryItem[]; nextCursor: string | null }>;
}

export function createPlatformApi(options: {
  baseUrl: string;
  accessToken: () => string | undefined;
  fetch?: typeof fetch;
}): PlatformApi {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function call<T>(
    method: string,
    path: string,
    init: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const token = options.accessToken();
    let response: Response;
    try {
      response = await fetcher(`${options.baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new PlatformApiError({
        status: 0,
        code: 'NETWORK',
        title: 'network',
        correlationId: null,
        retryable: true,
      });
    }
    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const envelope = (body as ErrorEnvelope | undefined) ?? {
        status: response.status,
        code: 'INTERNAL',
        title: 'error',
        correlationId: null,
        retryable: response.status >= 500,
      };
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new PlatformApiError(
        envelope,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return body as T;
  }

  const id = encodeURIComponent;
  return {
    session: () => call('GET', '/api/v1/session'),
    catalog: () => call('GET', '/api/v1/catalog'),
    searchTenants: ({ query, status, cursor }) => {
      const params = new URLSearchParams();
      if (query) params.set('query', query);
      if (status) params.set('status', status);
      if (cursor) params.set('cursor', cursor);
      params.set('limit', '20');
      return call('GET', `/api/v1/tenants?${params}`);
    },
    getRequest: (requestId) => call('GET', `/api/v1/provisioning-requests/${id(requestId)}`),
    createRequest: (body, idempotencyKey) =>
      call('POST', '/api/v1/provisioning-requests', { body, idempotencyKey }),
    requestPreview: (requestId, path) =>
      call('POST', `/api/v1/provisioning-requests/${id(requestId)}/actions/${path}/previews`),
    getPreview: (requestId, previewId) =>
      call(
        'GET',
        `/api/v1/provisioning-requests/${id(requestId)}/actions/previews/${id(previewId)}`,
      ),
    submitAction: (requestId, path, body, idempotencyKey) =>
      call('POST', `/api/v1/provisioning-requests/${id(requestId)}/actions/${path}`, {
        body,
        idempotencyKey,
      }),
    getCommand: (requestId, commandId) =>
      call('GET', `/api/v1/provisioning-requests/${id(requestId)}/commands/${id(commandId)}`),
    actionHistory: (tenantId, cursor) =>
      call(
        'GET',
        `/api/v1/tenants/${id(tenantId)}/action-history${cursor ? `?cursor=${id(cursor)}` : ''}`,
      ),
  };
}
