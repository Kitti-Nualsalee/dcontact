import { resolveLocale, type SupportedLocale } from '@d-contact/i18n';

export const PLATFORM_LOCALE_KEY = 'dcontact.platform.locale';
export const PLATFORM_TIME_ZONE = 'Asia/Bangkok';

type LocaleStorage = Pick<Storage, 'getItem' | 'setItem'>;
type StorageSource = () => LocaleStorage;

/** storage เป็น callback เพราะ browser อาจปฏิเสธตั้งแต่การอ่าน window.sessionStorage */
export function resolvePlatformLocale(input: {
  storage: StorageSource;
  browser: readonly string[];
}): SupportedLocale {
  try {
    const stored = input.storage().getItem(PLATFORM_LOCALE_KEY);
    if (stored === 'th' || stored === 'en') return stored;
  } catch {
    // preference ใช้ไม่ได้ไม่ขวางการเปิดแอป และไม่ต้องเรียก API เพื่อหาค่าสำรอง
  }
  return resolveLocale({ browser: input.browser });
}

export function savePlatformLocale(locale: SupportedLocale, storage: StorageSource): void {
  try {
    storage().setItem(PLATFORM_LOCALE_KEY, locale);
  } catch {
    // LocaleProvider เปลี่ยนภาษาใน memory แล้ว แม้ storage ถูกปิดหรือเต็ม
  }
}
