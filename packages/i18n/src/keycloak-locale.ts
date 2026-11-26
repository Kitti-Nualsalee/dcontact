/**
 * D1.11 (#450): the user's language and timezone are stored in Keycloak (D1.5) so the Keycloak login page and emails
 * match the app, and follow the user across devices
 *
 * - read: the `locale` and `zoneinfo` claims that Keycloak's `profile` scope already puts in the ID token
 * - write: Keycloak Account REST API (`{issuer}/account`) with the user's own access token,
 *   so the D-Contact API does not need realm admin rights to edit user data
 */
import { normalizeLocale, isIanaTimeZone, type SupportedLocale } from './locale.js';

export interface UserLocalePreference {
  locale?: SupportedLocale;
  timeZone?: string;
}

/** takes the `profile` of oidc-client-ts (ID token claims) */
export function readUserLocalePreference(
  claims: Record<string, unknown> | undefined,
): UserLocalePreference {
  const locale = normalizeLocale(claims?.locale);
  const timeZone = isIanaTimeZone(claims?.zoneinfo) ? claims.zoneinfo : undefined;
  return { ...(locale ? { locale } : {}), ...(timeZone ? { timeZone } : {}) };
}

export interface SaveUserLocaleInput {
  /** realm issuer, e.g. `http://localhost:8081/realms/dcontact` */
  issuer: string;
  accessToken: string;
  locale: SupportedLocale;
  fetch?: typeof fetch;
}

export class UserLocaleSaveError extends Error {
  constructor(readonly status: number) {
    super(`failed to save the user's language (${status})`);
    this.name = 'UserLocaleSaveError';
  }
}

/**
 * The Account API replaces the whole representation, so read the existing one first and change only `attributes.locale`,
 * otherwise the name/email that was not sent would be cleared
 */
export async function saveUserLocale(input: SaveUserLocaleInput): Promise<void> {
  const request = input.fetch ?? fetch;
  const url = `${input.issuer.replace(/\/+$/, '')}/account`;
  const headers = { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' };
  const current = await request(url, { headers });
  if (!current.ok) throw new UserLocaleSaveError(current.status);
  const account = (await current.json()) as { attributes?: Record<string, unknown> };
  const updated = await request(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      ...account,
      attributes: { ...account.attributes, locale: [input.locale] },
    }),
  });
  if (!updated.ok) throw new UserLocaleSaveError(updated.status);
}
