import i18next from 'i18next';
import { UI_NAMESPACE, uiResources } from '../src/i18n';

const i18n = i18next.createInstance();
void i18n.init({
  resources: uiResources,
  lng: 'th',
  fallbackLng: 'th',
  defaultNS: UI_NAMESPACE,
  interpolation: { escapeValue: false },
  initAsync: false,
});

/** Throws on a missing key instead of returning the key text, so a wrong key fails loudly. */
function strict(lng: 'th' | 'en') {
  const t = i18n.getFixedT(lng, UI_NAMESPACE);
  return (key: string, options?: Record<string, unknown>): string => {
    if (!i18n.exists(key, { ...options, lng, ns: UI_NAMESPACE }))
      throw new Error(`Missing catalog key: ${key}`);
    return t(key, options);
  };
}

/**
 * Expected component text read from the `ui` catalog, so specs assert on keys instead of
 * hardcoding Thai copy. Use `th` in suites that run with `locale: 'th-TH'` and `en` otherwise:
 *
 *   page.getByRole('link', { name: th('shell.skipToContent') })
 */
export const th = strict('th');
export const en = strict('en');
