import { CustomersApiError, customerUuid } from './api.js';

/** Cus360 C2 (#792): logic บริสุทธิ์ของหน้า Customers (ทดสอบใน `customers.test.ts`) */

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
 * 404 ของ DENY กับไม่พบเป็นข้อความเดียวกันเสมอ (ไม่เปิดเผยว่ามีอยู่) และ 503 SCOPE_UNAVAILABLE
 * ไม่ถูกตีความเป็นว่างหรือไม่มีสิทธิ์ — เป็น "สิทธิ์ยังไม่พร้อม" ที่ลองใหม่ได้
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

/** ข้อผิดพลาดที่ต้องปิดข้อมูลลูกค้าที่แสดงอยู่ทันที (สิทธิ์/session/scope เปลี่ยน) */
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

/** code ของ fieldErrors → key ข้อความใต้ช่อง (code ที่ไม่รู้จักใช้ข้อความทั่วไป ไม่แสดงค่าที่กรอก) */
export function fieldErrorKey(error: unknown): string | undefined {
  if (!(error instanceof CustomersApiError) || error.status !== 400) return undefined;
  const code = error.fieldErrors.find((entry) => entry.field === 'query')?.code;
  return code && FIELD_ERRORS.has(code) ? code : 'GENERIC';
}

export interface CustomersRoute {
  /** undefined = รายการลูกค้า; null = id ใน URL ไม่ใช่ UUID (แสดงเหมือนไม่พบ) */
  contactId?: string | null;
}

/** query ค้นหาไม่อยู่ใน URL (ไม่มี PII); มีเฉพาะ UUID ของโปรไฟล์ที่เปิดอยู่ */
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

/** ฝั่ง client ตรวจเท่าที่ server จะปฏิเสธอยู่แล้ว (1–64 ตัว ไม่มี control) เพื่อไม่ยิง request เปล่า */
export function validPurpose(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
}
