import 'i18next';
import type { DEFAULT_NAMESPACE, resources } from './resources.js';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    resources: (typeof resources)['th'];
  }
}
