import { createConfigApi, type ConfigApi } from './config-api.js';
export type CatalogKind = 'queues' | 'skills';
export interface CatalogItem {
  id: string;
  name: string;
  teamId: string | null;
  legacy: boolean;
  voiceConfigVersion: number | null;
  configRevision?: number;
  revision?: number;
  code?: string | null;
  isActive?: boolean;
  policy?: { offerTimeoutSec: number; maxTotalPreanswerSec: number; terminalAction: string } | null;
}
export interface Capabilities {
  version: number;
  canWrite: boolean;
  configuration: { ready: boolean; reasons: string[] };
  managedRouting: { ready: boolean; reasons: string[] };
  policyRevision: number | null;
  sourceKind: string | null;
  limits: Record<string, { used: number; limit: number }> | null;
}
export class CatalogApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export interface CatalogApi {
  config?: ConfigApi;
  capabilities(): Promise<Capabilities>;
  teams(): Promise<{ items: { id: string; name: string }[] }>;
  list(
    kind: CatalogKind,
    cursor?: string,
  ): Promise<{ items: CatalogItem[]; nextCursor: string | null }>;
  detail(kind: CatalogKind, id: string): Promise<CatalogItem>;
  create(
    kind: CatalogKind,
    body: { commandId: string; name: string; teamId: string; code?: string },
  ): Promise<CatalogItem>;
  command(id: string): Promise<{ state: 'SUCCEEDED'; result: CatalogItem }>;
}
export function createCatalogApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): CatalogApi {
  async function request(path: string, body?: unknown) {
    const token = options.accessToken();
    if (!token) throw new CatalogApiError(401, 'UNAUTHORIZED');
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/api/v1/tenant-voice/${path}`,
      {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok) {
      let code =
        response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : 'FAILED';
      try {
        const data = await response.json();
        if (typeof data.code === 'string') code = data.code;
      } catch {}
      throw new CatalogApiError(response.status, code);
    }
    return response.json();
  }
  return {
    config: createConfigApi(options),
    capabilities: () => request('capabilities'),
    teams: () => request('teams'),
    list: (kind, cursor) =>
      request(`${kind}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    detail: (kind, id) => request(`${kind}/${encodeURIComponent(id)}`),
    create: (kind, body) => request(kind, body),
    command: (id) => request(`commands/${encodeURIComponent(id)}`),
  };
}
