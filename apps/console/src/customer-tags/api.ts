import { customerUuid, CustomersApiError } from '../customers/api.js';

export type TagState = 'ACTIVE' | 'RETIRED';
export type TagFilter = TagState | 'ALL';
export interface CatalogTag {
  id: string;
  name: string;
  state: TagState;
  revision: string;
  createdAt: string;
  retiredAt: string | null;
}
export type TagCommandResult =
  | {
      state: 'TERMINAL';
      command: {
        outcome: 'APPLIED' | 'NO_OP' | 'REJECTED';
        code: string | null;
        resourceRefs: { type: string; id: string }[];
        committedRevisions: Record<string, string>;
      };
    }
  | { state: 'PENDING' | 'UNKNOWN'; commandId: string };

export function createCustomerTagsApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}) {
  async function request<T>(
    path: string,
    init: {
      method?: 'POST' | 'PATCH';
      body?: unknown;
      signal?: AbortSignal;
      command?: boolean;
    } = {},
  ): Promise<T> {
    const token = options.accessToken();
    if (!token) throw new CustomersApiError(401, 'SESSION_REQUIRED');
    let response: Response;
    try {
      response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/api/v1/customer-360/${path}`, {
        method: init.method ?? 'GET',
        cache: 'no-store',
        signal: init.signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new CustomersApiError(0, 'NETWORK_ERROR', true);
    }
    if (!response.ok) {
      let body: {
        state?: unknown;
        error?: {
          code?: unknown;
          retryable?: unknown;
          fieldErrors?: { field: string; code: string }[];
        };
      } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        /* ใช้ status เมื่อ proxy ไม่ส่ง JSON */
      }
      if (init.command && (body.state === 'TERMINAL' || body.state === 'UNKNOWN')) return body as T;
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new CustomersApiError(
        response.status,
        typeof body.error?.code === 'string' ? body.error.code : 'REQUEST_FAILED',
        body.error?.retryable === true || response.status >= 500,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        Array.isArray(body.error?.fieldErrors) ? body.error.fieldErrors : [],
      );
    }
    return response.json() as Promise<T>;
  }
  const id = (value: string) => {
    if (!customerUuid(value)) throw new CustomersApiError(404, 'RESOURCE_NOT_FOUND');
    return encodeURIComponent(value);
  };
  return {
    list: ({
      state,
      cursor,
      signal,
    }: {
      state: TagFilter;
      cursor?: string;
      signal?: AbortSignal;
    }) => {
      const query = new URLSearchParams({ state });
      if (cursor) query.set('cursor', cursor);
      return request<{ items: CatalogTag[]; nextCursor: string | null; asOf: string }>(
        `tags?${query}`,
        { signal },
      );
    },
    detail: async (tagId: string, signal?: AbortSignal) =>
      request<CatalogTag & { asOf: string }>(`tags/${id(tagId)}`, { signal }),
    create: (body: { commandId: string; name: string }) =>
      request<TagCommandResult>('tags', { method: 'POST', body, command: true }),
    rename: async (
      tagId: string,
      body: { commandId: string; expectedRevision: string; name: string },
    ) => request<TagCommandResult>(`tags/${id(tagId)}`, { method: 'PATCH', body, command: true }),
    retire: async (tagId: string, body: { commandId: string; expectedRevision: string }) =>
      request<TagCommandResult>(`tags/${id(tagId)}/retire`, {
        method: 'POST',
        body,
        command: true,
      }),
    command: async (commandId: string) =>
      request<TagCommandResult>(`commands/${id(commandId)}`, { command: true }),
    reconcile: async (commandId: string) =>
      request<TagCommandResult>(`commands/${id(commandId)}/reconcile`, {
        method: 'POST',
        body: {},
        command: true,
      }),
  };
}
export type CustomerTagsApi = ReturnType<typeof createCustomerTagsApi>;
