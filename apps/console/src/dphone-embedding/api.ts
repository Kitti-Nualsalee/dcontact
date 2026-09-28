/**
 * E1.11 (#485): Console client ของ `/api/v1/tenant/embed-origins`
 *
 * tenant และผู้ทำมาจาก bearer token ที่ gateway ตรวจแล้ว — body มีแค่ข้อมูลของ origin
 */

export interface EmbedOrigin {
  id: string;
  origin: string;
  label: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  activeSessions: number;
}

export interface EmbedOriginList {
  entitled: boolean;
  flagEnabled: boolean;
  limit: number;
  origins: EmbedOrigin[];
}

export class EmbedOriginApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly field?: string,
    readonly reason?: string,
  ) {
    super(code ?? `embed origin API failed with HTTP ${status}`);
    this.name = 'EmbedOriginApiError';
  }
}

export interface EmbedOriginApi {
  list(): Promise<EmbedOriginList>;
  create(input: { origin: string; label: string; reason?: string }): Promise<EmbedOrigin>;
  update(
    origin: EmbedOrigin,
    change: { label?: string; enabled?: boolean; reason?: string },
  ): Promise<EmbedOrigin>;
  remove(origin: EmbedOrigin, reason?: string): Promise<void>;
}

const BASE = '/api/v1/tenant/embed-origins';

export function createEmbedOriginApi(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): EmbedOriginApi {
  const request = input.fetch ?? globalThis.fetch;
  const call = async <T>(
    path: string,
    init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
  ): Promise<T> => {
    const token = input.accessToken();
    if (!token) throw new EmbedOriginApiError(401, 'AUTHORIZATION_CONTEXT_UNAVAILABLE');
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await request(`${input.baseUrl.replace(/\/$/, '')}${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        { code?: string; field?: string; reason?: string } | undefined;
      throw new EmbedOriginApiError(
        response.status,
        payload?.code,
        payload?.field,
        payload?.reason,
      );
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  };
  return {
    list: () => call<EmbedOriginList>(''),
    create: (body) => call<EmbedOrigin>('', { method: 'POST', body }),
    update: (origin, change) =>
      call<EmbedOrigin>(`/${encodeURIComponent(origin.id)}`, {
        method: 'PATCH',
        body: { expectedRevision: origin.revision, ...change },
      }),
    remove: (origin, reason) =>
      call<void>(`/${encodeURIComponent(origin.id)}`, {
        method: 'DELETE',
        body: { expectedRevision: origin.revision, ...(reason ? { reason } : {}) },
      }),
  };
}
