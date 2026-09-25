/**
 * D1.11 (#450): typed keys — `t('...')` ที่ไม่มีใน catalog ภาษาไทย (ต้นแบบ) ตกที่ typecheck
 * ความครบของ catalog ภาษาอังกฤษตรวจโดย `pnpm i18n:check`
 */
import 'i18next';
import type { DEFAULT_NAMESPACE, resources } from './resources.js';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    resources: (typeof resources)['th'];
  }
}
