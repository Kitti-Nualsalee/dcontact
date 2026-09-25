/**
 * D1.11 (#450): ภาษาและ timezone ของผู้ใช้เก็บใน Keycloak (D1.5) เพื่อให้หน้า login และอีเมลของ
 * Keycloak ตรงกับแอป และตามผู้ใช้ข้ามเครื่อง
 *
 * - อ่าน: claim `locale` และ `zoneinfo` ที่ scope `profile` ของ Keycloak ใส่ใน ID token อยู่แล้ว
 * - เขียน: Keycloak Account REST API (`{issuer}/account`) ด้วย access token ของผู้ใช้เอง
 *   API ของ D-Contact จึงไม่ต้องถือสิทธิ์ admin ของ realm เพื่อแก้ข้อมูลผู้ใช้
 */
import { normalizeLocale, isIanaTimeZone, type SupportedLocale } from './locale.js';

export interface UserLocalePreference {
  locale?: SupportedLocale;
  timeZone?: string;
}

/** รับ `profile` ของ oidc-client-ts (claims ของ ID token) */
export function readUserLocalePreference(
  claims: Record<string, unknown> | undefined,
): UserLocalePreference {
  const locale = normalizeLocale(claims?.locale);
  const timeZone = isIanaTimeZone(claims?.zoneinfo) ? claims.zoneinfo : undefined;
  return { ...(locale ? { locale } : {}), ...(timeZone ? { timeZone } : {}) };
}

export interface SaveUserLocaleInput {
  /** issuer ของ realm เช่น `http://localhost:8081/realms/dcontact` */
  issuer: string;
  accessToken: string;
  locale: SupportedLocale;
  fetch?: typeof fetch;
}

export class UserLocaleSaveError extends Error {
  constructor(readonly status: number) {
    super(`บันทึกภาษาของผู้ใช้ไม่สำเร็จ (${status})`);
    this.name = 'UserLocaleSaveError';
  }
}

/**
 * Account API แทนที่ทั้ง representation จึงต้องอ่านของเดิมก่อนแล้วเปลี่ยนเฉพาะ `attributes.locale`
 * ไม่เช่นนั้นชื่อ/อีเมลที่ไม่ได้ส่งไปจะถูกล้าง
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
