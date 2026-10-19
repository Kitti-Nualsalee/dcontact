export interface Organization {
  id: string;
  displayName: string;
  defaults: null | { locale: string; timeZone: string; initializationSource: string };
  revision: string;
}
export interface CoreCapabilities {
  organization: { read: boolean; write: boolean };
}
export interface CoreReceipt {
  command: {
    id: string;
    action: string | null;
    resourceId: string | null;
    outcome: 'APPLIED' | 'NO_OP' | 'REJECTED' | 'NOT_APPLIED';
    committedRevision: string | null;
    resourceSnapshot: Organization | null;
    error: null | { code: string; fieldErrors?: Record<string, string> };
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
}): CoreApi {
  async function request(path: string, method = 'GET', body?: unknown) {
    const token = options.accessToken();
    if (!token) throw new CoreApiError(401, 'CORE_ACCESS_DENIED');
    const res = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/api/v1/tenant/core-settings/${path}`,
      {
        method,
        cache: 'no-store',
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
    capabilities: () => request('capabilities'),
    organization: async () => (await request('organization')).organization,
    save: (body) => request('organization', 'PATCH', body),
    command: (id) => request(`commands/${encodeURIComponent(id)}`),
    reconcile: (id) => request(`commands/${encodeURIComponent(id)}/reconcile`, 'POST', {}),
  };
}
