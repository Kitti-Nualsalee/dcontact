import { createI18n, DEFAULT_LOCALE } from '@d-contact/i18n';
import { DEFAULT_NAMESPACE, resources } from './resources.js';

/** a single instance per app — the real language is resolved and set by `SessionLocaleProvider` */
export const appI18n = createI18n({
  resources,
  locale: DEFAULT_LOCALE,
  defaultNamespace: DEFAULT_NAMESPACE,
});
