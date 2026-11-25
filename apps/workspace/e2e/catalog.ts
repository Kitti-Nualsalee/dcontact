import { createI18n } from '@d-contact/i18n';
import { DEFAULT_NAMESPACE, resources } from '../src/i18n/resources';

const i18n = createI18n({ resources, locale: 'th', defaultNamespace: DEFAULT_NAMESPACE });

/**
 * Expected UI text read from the app's own catalogs, so specs assert on keys instead of
 * hardcoding Thai copy. Use `th` in suites that run with `locale: 'th-TH'` and `en` otherwise:
 *
 *   page.getByRole('button', { name: th('common:actions.save') })
 */
export const th = i18n.getFixedT('th');
export const en = i18n.getFixedT('en');
