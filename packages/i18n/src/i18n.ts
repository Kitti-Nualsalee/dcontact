/**
 * D1.11 (#450): creates the i18next instance for each app
 *
 * - both `th` and `en` bundles are imported up front (no lazy backend) so `changeLanguage`
 *   switches instantly with no request — Workspace can switch language during a call without touching WebRTC/WS
 * - one instance per app via `createInstance`, not the i18next singleton
 * - keys are type-checked through `CustomTypeOptions`, which each app declares itself, and CI checks that keys exist in both languages
 *   (`dc-i18n-check`); the fallback to `th` is therefore only a safety net against a blank screen, not a normal path
 */
import i18next, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from './locale.js';

export type LocaleCatalog = Record<string, Record<string, unknown>>;

export interface CreateI18nInput {
  /** `{ th: { common: {...}, journeys: {...} }, en: {...} }` — namespaces must match in both languages */
  resources: Record<SupportedLocale, LocaleCatalog>;
  locale: SupportedLocale;
  defaultNamespace: string;
}

export function createI18n(input: CreateI18nInput): I18nInstance {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources: input.resources,
    lng: input.locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: Object.keys(input.resources[DEFAULT_LOCALE]),
    defaultNS: input.defaultNamespace,
    // React already escapes; escaping twice would show names containing & as &amp;
    interpolation: { escapeValue: false },
    // resources are in memory, so init can be sync and the screen never shows a raw key
    initAsync: false,
    returnNull: false,
  });
  return instance;
}
