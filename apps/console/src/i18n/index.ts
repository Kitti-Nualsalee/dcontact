import { createI18n, DEFAULT_LOCALE } from '@d-contact/i18n';
import { DEFAULT_NAMESPACE, resources } from './resources.js';

/** one instance per app — the actual language is resolved and set by `SessionLocaleProvider` */
export const appI18n = createI18n({
  resources,
  locale: DEFAULT_LOCALE,
  defaultNamespace: DEFAULT_NAMESPACE,
});
