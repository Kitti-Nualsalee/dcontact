import { CustomersApiError } from '../customers/api.js';

export const ACTIVITY_TYPES = [
  'ALL',
  'CONTACT_CREATED',
  'PROFILE_UPDATED',
  'TAG_CREATED',
  'TAG_RENAMED',
  'TAG_RETIRED',
  'TAG_ATTACHED',
  'TAG_DETACHED',
] as const;
export type ActivityFilter = (typeof ACTIVITY_TYPES)[number];
type Operation = Exclude<ActivityFilter, 'ALL'>;
export type ActivityQuery = { type: ActivityFilter; from?: string; to?: string; cursor?: string };
type Window = { from: string; to: string; types: Operation[] };
export type ActivityPage = {
  items: {
    id: string;
    occurredAt: string;
    actorDisplay: string | null;
    operation: Operation;
    resourceType: 'CONTACT' | 'TAG';
    resourceRef: string;
    changedFields: string[];
  }[];
  coverage: {
    status: 'KNOWN' | 'PARTIAL' | 'UNKNOWN';
    intervals: (Window & { sourceVersion: string; evidenceRef: string })[];
    gaps: (Window & { reasonCode: 'NO_EVIDENCE' | 'UNMAPPED_EVENT' })[];
  };
  asOf: string;
  nextCursor: string | null;
};

export function createCustomerActivityApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}) {
  return async (query: ActivityQuery, signal: AbortSignal): Promise<ActivityPage> => {
    const token = options.accessToken();
    if (!token) throw new CustomersApiError(401, 'SESSION_REQUIRED');
    const params = new URLSearchParams({ type: query.type });
    if (query.from && query.to) {
      params.set('from', query.from);
      params.set('to', query.to);
    }
    if (query.cursor) params.set('cursor', query.cursor);
    let response: Response;
    try {
      response = await fetch(
        `${options.baseUrl.replace(/\/$/, '')}/api/v1/customer-360/activity?${params}`,
        {
          signal,
          cache: 'no-store',
          headers: { authorization: `Bearer ${token}` },
        },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new CustomersApiError(0, 'NETWORK_ERROR', true);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new CustomersApiError(
        response.status,
        typeof body.error?.code === 'string' ? body.error.code : 'REQUEST_FAILED',
        body.error?.retryable === true,
      );
    }
    return response.json() as Promise<ActivityPage>;
  };
}
export type CustomerActivityApi = ReturnType<typeof createCustomerActivityApi>;
