/**
 * D1.11 (#450): typed keys — a `t('...')` missing from the Thai catalog (the master) fails typecheck
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
