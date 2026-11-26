import { createI18n } from '@d-contact/i18n';
import { DEFAULT_NAMESPACE, resources } from '../../src/i18n/resources';

const i18n = createI18n({ resources, locale: 'th', defaultNamespace: DEFAULT_NAMESPACE });

/** Throws on a missing key instead of returning the key text, so a wrong key fails loudly. */
function strict(lng: 'th' | 'en') {
  const t = i18n.getFixedT(lng);
  return ((key: string, options?: Record<string, unknown>) => {
    if (!i18n.exists(key, { ...options, lng })) throw new Error(`Missing catalog key: ${key}`);
    return t(key as never, options as never);
  }) as unknown as typeof t;
}

/**
 * Expected UI text read from the app's own catalogs, so specs assert on keys instead of
 * hardcoding Thai copy. Use `th` in suites that run with `locale: 'th-TH'` and `en` otherwise:
 *
 *   page.getByRole('button', { name: th('journeys:list.filterAll') })
 */
export const th = strict('th');
export const en = strict('en');
