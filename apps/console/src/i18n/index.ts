import { createI18n, DEFAULT_LOCALE } from '@d-contact/i18n';
import { DEFAULT_NAMESPACE, resources } from './resources.js';

/** instance เดียวต่อแอป — ภาษาจริงถูก resolve และตั้งโดย `SessionLocaleProvider` */
export const appI18n = createI18n({
  resources,
  locale: DEFAULT_LOCALE,
  defaultNamespace: DEFAULT_NAMESPACE,
});
