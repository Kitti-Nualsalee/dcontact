/**
 * D1.11 (#450): React binding for the i18n system — wrap the app once at the root
 *
 * switch language only with `i18n.changeLanguage` + React state; never reload or remount the root:
 * Workspace must switch language during a call with the existing SIP session and WS connection fully intact (Phase Contract)
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createFormatters, type Formatters } from './format.js';
import { readUserLocalePreference, saveUserLocale } from './keycloak-locale.js';
import { resolveLocale, resolveTimeZone, type SupportedLocale } from './locale.js';
import { fetchTenantLocaleDefaults, type TenantLocaleDefaults } from './tenant-defaults.js';

export interface LocaleContextValue {
  locale: SupportedLocale;
  timeZone: string;
  formatters: Formatters;
  /** switches language immediately, then calls `onLocaleChange` to save — rejects if saving fails (the screen has already switched) */
  setLocale(locale: SupportedLocale): Promise<void>;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export interface LocaleProviderProps {
  i18n: I18nInstance;
  /** resolved language (`resolveLocale`) — can change once the user's language is known after login */
  locale: SupportedLocale;
  /** resolved timezone (`resolveTimeZone`) */
  timeZone: string;
  /** saves the language the user chose, e.g. `saveUserLocale` to Keycloak */
  onLocaleChange?: (locale: SupportedLocale) => Promise<void>;
  children: ReactNode;
}

function applyDocumentLanguage(locale: SupportedLocale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

export function LocaleProvider(props: LocaleProviderProps) {
  const { i18n, timeZone, onLocaleChange, children } = props;
  const [locale, setLocaleState] = useState<SupportedLocale>(props.locale);

  const apply = useCallback(
    async (next: SupportedLocale) => {
      if (i18n.language !== next) await i18n.changeLanguage(next);
      applyDocumentLanguage(next);
      setLocaleState(next);
    },
    [i18n],
  );

  // the language the user just chose themselves — the old token still holds the old `locale` claim until renewed
  const chosen = useRef<SupportedLocale | null>(null);

  // a language resolved anew from the source (user claim/tenant value that arrived later) wins over the value used while waiting
  // unless the user just chose it themselves and the source has not caught up
  useEffect(() => {
    if (chosen.current && chosen.current !== props.locale) return;
    chosen.current = null;
    void apply(props.locale);
  }, [apply, props.locale]);

  const setLocale = useCallback(
    async (next: SupportedLocale) => {
      chosen.current = next;
      await apply(next);
      await onLocaleChange?.(next);
    },
    [apply, onLocaleChange],
  );

  const formatters = useMemo(() => createFormatters({ locale, timeZone }), [locale, timeZone]);
  const value = useMemo(
    () => ({ locale, timeZone, formatters, setLocale }),
    [locale, timeZone, formatters, setLocale],
  );

  return (
    <I18nextProvider i18n={i18n}>
      <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
    </I18nextProvider>
  );
}

export interface LocaleSession {
  /** claims of the ID token (`auth.user.profile`) — reads `locale` and `zoneinfo` */
  claims: Record<string, unknown> | undefined;
  accessToken: string;
  /** base URL of the D-Contact API for the tenant defaults */
  apiBaseUrl: string;
  /** Keycloak realm issuer for saving the user's language */
  issuer: string;
}

export interface SessionLocaleProviderProps {
  i18n: I18nInstance;
  /** no session (not logged in / e2e) → use the browser language and save nothing */
  session?: LocaleSession;
  children: ReactNode;
}

function browserLanguages(): readonly string[] {
  return typeof navigator === 'undefined' ? [] : navigator.languages;
}

/**
 * composes the order user → tenant → browser → `th` from the session, then wraps `LocaleProvider`
 * the tenant value is fetched once per session (not again every time the access token rotates)
 */
export function SessionLocaleProvider({ i18n, session, children }: SessionLocaleProviderProps) {
  const [tenant, setTenant] = useState<TenantLocaleDefaults | null>(null);
  const token = useRef(session?.accessToken);
  token.current = session?.accessToken;
  const hasSession = session !== undefined;
  const apiBaseUrl = session?.apiBaseUrl;
  const issuer = session?.issuer;

  useEffect(() => {
    if (!hasSession || apiBaseUrl === undefined || !token.current) return;
    let active = true;
    fetchTenantLocaleDefaults({ apiBaseUrl, accessToken: token.current })
      .then((defaults) => active && setTenant(defaults))
      // the tenant value is only one step in the order — if it cannot be fetched, fall through to browser → th without blocking
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hasSession, apiBaseUrl]);

  const user = readUserLocalePreference(session?.claims);
  const locale = resolveLocale({
    user: user.locale,
    tenant: tenant?.locale,
    browser: browserLanguages(),
  });
  const timeZone = resolveTimeZone({ user: user.timeZone, tenant: tenant?.timeZone });

  const onLocaleChange = useMemo(
    () =>
      issuer === undefined
        ? undefined
        : async (next: SupportedLocale) => {
            if (!token.current) return;
            await saveUserLocale({ issuer, accessToken: token.current, locale: next });
          },
    [issuer],
  );

  return (
    <LocaleProvider i18n={i18n} locale={locale} timeZone={timeZone} onLocaleChange={onLocaleChange}>
      {children}
    </LocaleProvider>
  );
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used within <LocaleProvider>');
  return value;
}

export function useFormatters(): Formatters {
  return useLocale().formatters;
}

export { useTranslation, Trans } from 'react-i18next';
