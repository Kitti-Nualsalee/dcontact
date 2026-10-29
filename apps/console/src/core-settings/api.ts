export interface Organization {
  id: string;
  displayName: string;
  defaults: null | { locale: string; timeZone: string; initializationSource: string };
  revision: string;
}
export interface CoreCapabilities {
  organization: { read: boolean; write: boolean };
  teams?: { read: boolean; create: boolean; rename: boolean; deactivate: boolean };
}
export interface CoreReceipt<T = Organization> {
  command: {
    id: string;
    action: string | null;
    resourceId: string | null;
    outcome: 'APPLIED' | 'NO_OP' | 'REJECTED' | 'NOT_APPLIED';
    committedRevision: string | null;
    resourceSnapshot: T | null;
    error: null | {
      code: string;
      fieldErrors?: Record<string, string>;
      blockers?: { kind: string; count: number }[];
    };
  };
}
export type CommandLookup = CoreReceipt | { state: 'PENDING' | 'ADMITTED'; commandId: string };
export interface OrganizationPatch {
  displayName?: string;
  defaults?: { locale: string; timeZone: string };
}
export interface CoreApi {
  capabilities(): Promise<CoreCapabilities>;
  organization(): Promise<Organization>;
  save(body: {
    commandId: string;
    expectedRevision: string;
    patch: OrganizationPatch;
  }): Promise<CoreReceipt>;
  command(id: string): Promise<CommandLookup>;
  reconcile(id: string): Promise<CommandLookup>;
}
export class CoreApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly receipt?: CoreReceipt,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(code);
  }
}
export function createCoreApi(options: {
  baseUrl: string;
  accessToken: () => string | undefined;
}): CoreApi & { teams: CoreTeamsApi } {
  async function request(path: string, method = 'GET', body?: unknown) {
    const token = options.accessToken();
    if (!token) throw new CoreApiError(401, 'CORE_ACCESS_DENIED');
    const res = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/api/v1/tenant/core-settings/${path}`,
      {
        method,
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const data = await res.json();
    if (!res.ok)
      throw new CoreApiError(
        res.status,
        data.error?.code ?? 'REQUEST_FAILED',
        data.command ? data : undefined,
        data.error?.fieldErrors,
      );
    return data;
  }
  return {
    teams: {
      list: (cursor) =>
        request(`teams?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
      read: async (id) => (await request(`teams/${encodeURIComponent(id)}`)).team,
      create: (body) => request('teams', 'POST', body),
      rename: (id, body) => request(`teams/${encodeURIComponent(id)}`, 'PATCH', body),
      deactivate: (id, body) => request(`teams/${encodeURIComponent(id)}/deactivate`, 'POST', body),
      command: (id) => request(`commands/${encodeURIComponent(id)}`),
      reconcile: (id) => request(`commands/${encodeURIComponent(id)}/reconcile`, 'POST', {}),
    },
    capabilities: () => request('capabilities'),
    organization: async () => (await request('organization')).organization,
    save: (body) => request('organization', 'PATCH', body),
    command: (id) => request(`commands/${encodeURIComponent(id)}`),
    reconcile: (id) => request(`commands/${encodeURIComponent(id)}/reconcile`, 'POST', {}),
  };
}

export interface Team {
  id: string;
  name: string;
  isActive: boolean;
  revision: string;
}
export interface CoreTeamsApi {
  list(cursor?: string): Promise<{ teams: Team[]; nextCursor: string | null }>;
  read(id: string): Promise<Team>;
  create(body: { commandId: string; teamId: string; name: string }): Promise<CoreReceipt<Team>>;
  rename(
    id: string,
    body: { commandId: string; expectedRevision: string; patch: { name: string } },
  ): Promise<CoreReceipt<Team>>;
  deactivate(
    id: string,
    body: { commandId: string; expectedRevision: string },
  ): Promise<CoreReceipt<Team>>;
  command(id: string): Promise<CoreReceipt<Team> | { state: string; commandId: string }>;
  reconcile(id: string): Promise<CoreReceipt<Team> | { state: string; commandId: string }>;
}
