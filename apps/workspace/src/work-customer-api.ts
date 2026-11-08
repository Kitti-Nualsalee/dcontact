export interface WorkCustomerView {
  interactionId: string;
  state: 'LINKED' | 'UNLINKED';
  linkageRevision: string;
  canLink: boolean;
  contact?: { id: string; displayName: string | null; company: string | null };
  revisions?: { profile: string; tag: string; lineage: string | null };
  canEdit?: boolean;
  identity?: string;
}
export interface WorkCandidate {
  candidateRef: string;
  displayName: string | null;
  company: string | null;
  matchingChannel: string;
}
export interface WorkCommand {
  state: 'PENDING' | 'UNKNOWN' | 'TERMINAL';
  commandId?: string;
  command?: {
    commandId: string;
    outcome: 'APPLIED' | 'NO_OP' | 'REJECTED';
    code: string | null;
    committedRevisions: Record<string, string>;
  };
}
export class WorkCustomerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export interface WorkCustomerApi {
  read(workId: string, leaseId: string): Promise<WorkCustomerView>;
  search(
    workId: string,
    leaseId: string,
    input: { type: 'PHONE' | 'EMAIL'; query: string; cursor?: string },
  ): Promise<{ items: WorkCandidate[]; nextCursor: string | null; verified: false }>;
  mutate(
    workId: string,
    leaseId: string,
    operation: 'link' | 'update',
    input: Record<string, unknown>,
  ): Promise<WorkCommand>;
  receipt(
    workId: string,
    leaseId: string,
    commandId: string,
    reconcile?: boolean,
  ): Promise<WorkCommand>;
  reauthenticate(workId: string, leaseId: string): Promise<void>;
}
export function createWorkCustomerApi(
  send: (path: string, init: RequestInit) => Promise<Response>,
): WorkCustomerApi {
  async function call<T>(
    workId: string,
    leaseId: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    const response = await send(`/api/v1/customer-360/work/${encodeURIComponent(workId)}/${path}`, {
      method,
      cache: 'no-store',
      headers: {
        'x-work-session-lease-id': leaseId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    if (!response.ok && !(data && 'state' in data))
      throw new WorkCustomerError(response.status, data?.error?.code ?? 'REQUEST_FAILED');
    return data as T;
  }
  return {
    read: (w, l) => call(w, l, 'customer'),
    search: (w, l, b) => call(w, l, 'candidates/search', 'POST', b),
    mutate: (w, l, op, b) =>
      call(w, l, op === 'link' ? 'customer-link' : 'customer', op === 'link' ? 'POST' : 'PATCH', b),
    receipt: (w, l, id, reconcile) =>
      call(
        w,
        l,
        `commands/${encodeURIComponent(id)}${reconcile ? '/reconcile' : ''}`,
        reconcile ? 'POST' : 'GET',
        reconcile ? {} : undefined,
      ),
    reauthenticate: async (w, l) => {
      await call(w, l, 'reauthenticate', 'POST', {});
    },
  };
}
