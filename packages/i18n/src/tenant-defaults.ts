/**
 * D1.11 (#450): client ของ `GET /api/v1/tenant/locale-defaults` — ค่าเริ่มต้นภาษา/timezone ของ tenant
 * tenant มาจาก bearer token ฝั่ง server จึงไม่มี parameter ของ tenant ที่นี่
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
