/** Cus360 C2 (#792): client ของ /api/v1/customer-360 (อ่านอย่างเดียว) — ไม่มี method เขียนใด ๆ */

export type SearchType = 'DIRECTORY' | 'NAME' | 'PHONE' | 'EMAIL';
export type IdentityState = 'ACTIVE' | 'MERGED' | 'AMBIGUOUS' | 'LEGACY_MISSING_HEAD';

export interface CustomerListItem {
  contactId: string;
  displayName: string | null;
  company: string | null;
  vip: boolean;
  identity: 'ACTIVE' | 'AMBIGUOUS' | 'LEGACY_MISSING_HEAD';
  reviewRequired: boolean;
  matchedChannel?: { kind: 'PHONE' | 'EMAIL'; masked: string };
}

export interface CustomerSearchPage {
  items: CustomerListItem[];
  nextCursor: string | null;
  scope: { state: 'COMPLETE' | 'INCOMPLETE' };
  accessibleCount?: { state: 'AVAILABLE'; value: number } | { state: 'UNAVAILABLE'; value: null };
}

export interface CustomerProfile {
  contact: {
    id: string;
    displayName: string | null;
    company: string | null;
    vip: boolean;
    vipSource: string;
  };
  contactPoints: {
    id: string;
    kind: 'PHONE' | 'EMAIL';
    value: string;
    state: 'ACTIVE' | 'REVIEW_REQUIRED';
    sourceKind: string;
  }[];
  tags: { id: string; name: string; state: string }[];
  revisions: { profile: string; tag: string; lineage: number | null };
  identity: { state: IdentityState; reviewRequired: boolean; canonicalContactId?: string };
  capabilities: { read: true; manage: boolean };
  source: { authorizationBasis: string; vipSource: string };
}

export type Section<T> =
  | ({ state: 'READY'; asOf: string } & { data: T })
  | { state: 'UNAVAILABLE'; asOf: string; reason: string; retryable: boolean };

export interface TimelinePage {
  items: { startedAt: string; endedAt: string | null; channel: string; state: string }[];
  nextCursor: string | null;
  coverage: 'COMPLETE' | 'LIMITED';
}

export type GovernanceSummary =
  | { state: 'CONTEXT_REQUIRED'; asOf: string }
  | { state: 'UNAVAILABLE'; asOf: string; reason: string; retryable: boolean }
  | {
      state: 'READY';
      asOf: string;
      contactPermission: 'NOT_EVALUATED';
      context: { channel: string; purpose: string };
      preference: { decision: 'ALLOW' | 'BLOCK' | 'DEFER'; version: number } | null;
      callbackPending: boolean;
      activeExceptionCount: number;
      activeRestrictionCount: number;
    };

export interface GovernanceContext {
  channel: string;
  purpose: string;
}

export class CustomersApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
    readonly fieldErrors: readonly { field: string; code: string }[] = [],
  ) {
    super(code);
  }
}

export interface ProfileCommandInput {
  commandId?: string;
  expectedRevision?: string;
  command: {
    action: 'SET_NAME' | 'SET_COMPANY' | 'SET_VIP' | 'ADD_POINT' | 'RETIRE_POINT' | 'REPLACE_POINT' | 'ADD_TAG' | 'REMOVE_TAG';
    contactId: string;
    displayName?: string;
    company?: string;
    vip?: boolean;
    kind?: 'PHONE' | 'EMAIL' | 'TAG';
    value?: string;
    tagId?: string;
    pointId?: string;
    newPointValue?: string;
    explicitCountry?: string;
  };
}

export interface ProfileCommandResult {
  state: 'PENDING' | 'IN_PROGRESS' | 'TERMINAL';
  commandId: string;
  command?: {
    id: string;
    contactId: string;
    revision: string;
    effects: unknown[];
  };
  retryAfterSeconds?: number;
}

export interface CustomersApi {
  search(input: {
    type: SearchType;
    query?: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<CustomerSearchPage>;
  profile(contactId: string, signal?: AbortSignal): Promise<CustomerProfile>;
  timeline(
    contactId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Section<TimelinePage>>;
  governance(
    contactId: string,
    context?: GovernanceContext,
    signal?: AbortSignal,
  ): Promise<GovernanceSummary>;
  submitCommand(input: ProfileCommandInput, signal?: AbortSignal): Promise<ProfileCommandResult>;
  lookupCommand(commandId: string, signal?: AbortSignal): Promise<ProfileCommandResult>;
  reconcileCommand(commandId: string, payload?: unknown, signal?: AbortSignal): Promise<ProfileCommandResult>;
}

export const customerUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function createCustomersApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): CustomersApi {
  async function request<T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {},
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
      let code = 'REQUEST_FAILED';
      let retryable = response.status >= 500;
      let fieldErrors: { field: string; code: string }[] = [];
      try {
        const body = (await response.json()) as {
          error?: {
            code?: unknown;
            retryable?: unknown;
            fieldErrors?: { field: string; code: string }[];
          };
        };
        if (typeof body.error?.code === 'string') code = body.error.code;
        if (typeof body.error?.retryable === 'boolean') retryable = body.error.retryable;
        if (Array.isArray(body.error?.fieldErrors)) fieldErrors = body.error.fieldErrors;
      } catch {
        // ตอบไม่ใช่ JSON (เช่น proxy) — ใช้ค่าเริ่มต้นตาม status
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new CustomersApiError(
        response.status,
        code,
        retryable,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        fieldErrors,
      );
    }
    return (await response.json()) as T;
  }
  const id = (contactId: string) => {
    // ไม่ส่ง path ที่ไม่ใช่ UUID ไป server และตอบเหมือนไม่พบ
    if (!customerUuid(contactId)) throw new CustomersApiError(404, 'RESOURCE_NOT_FOUND');
    return encodeURIComponent(contactId);
  };
  return {
    search: ({ type, query, cursor, signal }) =>
      request('contacts/search', {
        method: 'POST',
        signal,
        body: {
          type,
          ...(type !== 'DIRECTORY' && query !== undefined ? { query } : {}),
          ...(cursor ? { cursor } : {}),
        },
      }),
    async profile(contactId, signal) {
      return request(`contacts/${id(contactId)}`, { signal });
    },
    async timeline(contactId, cursor, signal) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return request(`contacts/${id(contactId)}/timeline${query}`, { signal });
    },
    async governance(contactId, context, signal) {
      return request(`contacts/${id(contactId)}/governance-summary`, {
        method: 'POST',
        signal,
        body: context ?? {},
      });
    },
    async submitCommand(input, signal) {
      return request('commands', {
        method: 'POST',
        signal,
        body: input,
      });
    },
    async lookupCommand(commandId, signal) {
      return request(`commands/${encodeURIComponent(commandId)}`, { signal });
    },
    async reconcileCommand(commandId, payload, signal) {
      return request(`commands/${encodeURIComponent(commandId)}/reconcile`, {
        method: 'POST',
        signal,
        body: payload ?? {},
      });
    },
  };
}
