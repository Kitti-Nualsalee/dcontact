import { resolveLocale, type SupportedLocale } from '@d-contact/i18n';

export const PLATFORM_LOCALE_KEY = 'dcontact.platform.locale';
export const PLATFORM_TIME_ZONE = 'Asia/Bangkok';

type LocaleStorage = Pick<Storage, 'getItem' | 'setItem'>;
type StorageSource = () => LocaleStorage;

/** storage is a callback because the browser may refuse as early as reading window.sessionStorage */
export function resolvePlatformLocale(input: {
  storage: StorageSource;
  browser: readonly string[];
}): SupportedLocale {
  try {
    const stored = input.storage().getItem(PLATFORM_LOCALE_KEY);
    if (stored === 'th' || stored === 'en') return stored;
  } catch {
    // an unusable preference must not block opening the app, and no API call is needed to find a fallback
  }
  return resolveLocale({ browser: input.browser });
}

export function savePlatformLocale(locale: SupportedLocale, storage: StorageSource): void {
  try {
    storage().setItem(PLATFORM_LOCALE_KEY, locale);
  } catch {
    // LocaleProvider changes the language in memory even if storage is blocked or full
  }
}
