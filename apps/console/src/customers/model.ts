import { CustomersApiError, customerUuid } from './api.js';

/** Cus360 C2 (#792): pure logic of the Customers page (tested in `customers.test.ts`) */

export type ErrorKind =
  | 'session'
  | 'forbidden'
  | 'notFound'
  | 'scope'
  | 'rateLimited'
  | 'cursor'
  | 'validation'
  | 'failed';

/**
 * a DENY 404 and not-found are always the same message (existence is not revealed), and a 503 SCOPE_UNAVAILABLE
 * is not interpreted as empty or no permission — it is "permission not ready yet", which can be retried
 */
export function errorKind(error: unknown): ErrorKind {
  if (!(error instanceof CustomersApiError)) return 'failed';
  if (error.status === 401) return 'session';
  if (error.status === 403) return 'forbidden';
  if (error.status === 404) return 'notFound';
  if (error.status === 429) return 'rateLimited';
  if (error.status === 503 && error.code === 'SCOPE_UNAVAILABLE') return 'scope';
  if (error.code === 'CURSOR_INVALID' || error.code === 'CURSOR_EXPIRED') return 'cursor';
  if (error.status === 400) return 'validation';
  return 'failed';
}

/** errors that must immediately close the customer data being shown (permission/session/scope changed) */
export function closesCustomerData(kind: ErrorKind): boolean {
  return kind === 'session' || kind === 'forbidden' || kind === 'notFound' || kind === 'scope';
}

const FIELD_ERRORS = new Set([
  'NAME_TOO_SHORT',
  'NAME_INVALID',
  'PHONE_INTERNATIONAL_REQUIRED',
  'PHONE_INVALID',
  'EMAIL_INVALID',
  'QUERY_REQUIRED',
]);

/** fieldErrors code → message key under the field (an unknown code uses a generic message and does not show the entered value) */
export function fieldErrorKey(error: unknown): string | undefined {
  if (!(error instanceof CustomersApiError) || error.status !== 400) return undefined;
  const code = error.fieldErrors.find((entry) => entry.field === 'query')?.code;
  return code && FIELD_ERRORS.has(code) ? code : 'GENERIC';
}

export interface CustomersRoute {
  /** undefined = customer list; null = the id in the URL is not a UUID (shown as not found) */
  contactId?: string | null;
}

/** the search query is not in the URL (no PII); only the UUID of the open profile is */
export function parseCustomersRoute(url: URL): CustomersRoute {
  const contact = url.searchParams.get('contact');
  if (contact === null) return {};
  return { contactId: customerUuid(contact) ? contact.toLowerCase() : null };
}

export function customersHref(tenantAlias: string | undefined, contactId?: string): string {
  const url = new URL('/', 'https://console.invalid');
  url.searchParams.set('view', 'customers');
  if (contactId) url.searchParams.set('contact', contactId);
  if (tenantAlias) url.searchParams.set('tenant', tenantAlias);
  return `${url.pathname}${url.search}`;
}

export const GOVERNANCE_CHANNELS = [
  'VOICE',
  'WEBCHAT',
  'LINE',
  'FACEBOOK',
  'WHATSAPP',
  'EMAIL',
] as const;

/** the client checks only what the server would reject anyway (1–64 characters, no control characters) so no empty request is sent */
export function validPurpose(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
}
