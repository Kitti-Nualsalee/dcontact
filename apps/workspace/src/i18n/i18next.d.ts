/**
 * D1.11 (#450): typed keys — a `t('...')` missing from the Thai catalog (the prototype) fails at typecheck
 * completeness of the English catalog is checked by `pnpm i18n:check`
 */
import 'i18next';
import type { DEFAULT_NAMESPACE, resources } from './resources.js';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    resources: (typeof resources)['th'];
  }
}
