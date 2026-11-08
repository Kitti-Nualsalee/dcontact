import { CustomersApiError } from '../customers/api.js';
export type FieldRules = {
  version: string;
  asOf: string;
  fields: {
    name: string;
    type: string;
    required: boolean;
    constraints: Record<string, unknown> | null;
    normalization: string | null;
    normalizationVersion: string | null;
  }[];
};
export type CustomerOverview = { count: string; asOf: string };
export type TagOverview = { activeCount: string; retiredCount: string; asOf: string };
export function createCustomerOverviewApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}) {
  async function read<T>(path: string, signal: AbortSignal): Promise<T> {
    const token = options.accessToken();
    if (!token) throw new CustomersApiError(401, 'SESSION_REQUIRED');
    let response: Response;
    try {
      response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/api/v1/customer-360/${path}`, {
        signal,
        cache: 'no-store',
        headers: { authorization: `Bearer ${token}` },
      });
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
    return response.json() as Promise<T>;
  }
  return {
    customers: (signal: AbortSignal) => read<CustomerOverview>('overview/customers', signal),
    tags: (signal: AbortSignal) => read<TagOverview>('overview/tags', signal),
    rules: (signal: AbortSignal) => read<FieldRules>('field-rules', signal),
  };
}
export type CustomerOverviewApi = ReturnType<typeof createCustomerOverviewApi>;
