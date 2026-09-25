/**
 * D1.11 (#450): สร้าง i18next instance ของแต่ละแอป
 *
 * - bundle ทั้ง `th` และ `en` ถูก import ตั้งแต่เริ่ม (ไม่มี lazy backend) เพื่อให้ `changeLanguage`
 *   สลับได้ทันทีโดยไม่มี request — Workspace สลับภาษาระหว่างมีสายได้โดยไม่แตะ WebRTC/WS
 * - instance แยกต่อแอปผ่าน `createInstance` ไม่ใช้ singleton ของ i18next
 * - key ถูกตรวจชนิดผ่าน `CustomTypeOptions` ที่แต่ละแอปประกาศเอง และ CI ตรวจว่า key ครบสองภาษา
 *   (`dc-i18n-check`) fallback ไป `th` จึงเป็นแค่ตาข่ายกันจอว่าง ไม่ใช่ทางปกติ
 */
import i18next, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from './locale.js';

export type LocaleCatalog = Record<string, Record<string, unknown>>;

export interface CreateI18nInput {
  /** `{ th: { common: {...}, journeys: {...} }, en: {...} }` — namespace ต้องตรงกันทั้งสองภาษา */
  resources: Record<SupportedLocale, LocaleCatalog>;
  locale: SupportedLocale;
  defaultNamespace: string;
}

export function createI18n(input: CreateI18nInput): I18nInstance {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources: input.resources,
    lng: input.locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: Object.keys(input.resources[DEFAULT_LOCALE]),
    defaultNS: input.defaultNamespace,
    // React escape ให้อยู่แล้ว; escape ซ้ำจะทำให้ชื่อที่มี & แสดงเป็น &amp;
    interpolation: { escapeValue: false },
    // resources อยู่ในหน่วยความจำ จึง init แบบ sync ได้ ไม่มีจังหวะที่จอแสดง key ดิบ
    initAsync: false,
    returnNull: false,
  });
  return instance;
}
