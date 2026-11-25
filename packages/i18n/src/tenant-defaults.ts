/**
 * D1.11 (#450): client of `GET /api/v1/tenant/locale-defaults` — the tenant's default language/timezone
 * the tenant comes from the server-side bearer token, so there is no tenant parameter here
 */
export interface TenantLocaleDefaults {
  locale: string | null;
  timeZone: string | null;
}

export async function fetchTenantLocaleDefaults(input: {
  apiBaseUrl: string;
  accessToken: string;
  fetch?: typeof fetch;
}): Promise<TenantLocaleDefaults> {
  const request = input.fetch ?? fetch;
  const response = await request(
    `${input.apiBaseUrl.replace(/\/+$/, '')}/api/v1/tenant/locale-defaults`,
    { headers: { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' } },
  );
  if (!response.ok) throw new Error(`tenant locale defaults ${response.status}`);
  const body = (await response.json()) as Partial<TenantLocaleDefaults>;
  return {
    locale: typeof body.locale === 'string' ? body.locale : null,
    timeZone: typeof body.timeZone === 'string' ? body.timeZone : null,
  };
}
