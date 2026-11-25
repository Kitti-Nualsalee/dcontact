import { useCallback, useState, type ReactNode } from 'react';
import { createI18n, type SupportedLocale } from '@d-contact/i18n';
import { LocaleProvider } from '@d-contact/i18n/react';
import { PLATFORM_TIME_ZONE, resolvePlatformLocale, savePlatformLocale } from './locale.js';
import { DEFAULT_NAMESPACE, resources } from './resources.js';

/** wraps the single root both before/after login; not tied to the session or the tenant being viewed */
export function PlatformLocaleProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => {
    const locale = resolvePlatformLocale({
      storage: () => window.sessionStorage,
      browser: navigator.languages,
    });
    return {
      locale,
      i18n: createI18n({ resources, locale, defaultNamespace: DEFAULT_NAMESPACE }),
    };
  });
  const persist = useCallback(async (locale: SupportedLocale) => {
    savePlatformLocale(locale, () => window.sessionStorage);
  }, []);

  return (
    <LocaleProvider
      i18n={initial.i18n}
      locale={initial.locale}
      timeZone={PLATFORM_TIME_ZONE}
      onLocaleChange={persist}
    >
      {children}
    </LocaleProvider>
  );
}
