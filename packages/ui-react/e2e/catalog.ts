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

/**
 * Expected component text read from the `ui` catalog, so specs assert on keys instead of
 * hardcoding Thai copy. Use `th` in suites that run with `locale: 'th-TH'` and `en` otherwise:
 *
 *   page.getByRole('link', { name: th('shell.skipToContent') })
 */
export const th = i18n.getFixedT('th', UI_NAMESPACE);
export const en = i18n.getFixedT('en', UI_NAMESPACE);
