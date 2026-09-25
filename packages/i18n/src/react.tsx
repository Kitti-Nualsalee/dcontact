/**
 * D1.11 (#450): React binding ของระบบภาษา — ครอบแอปครั้งเดียวที่ root
 *
 * สลับภาษาด้วย `i18n.changeLanguage` + state ของ React เท่านั้น ห้าม reload หรือ remount root:
 * Workspace ต้องสลับภาษาระหว่างมีสายได้โดย SIP session และ WS connection เดิมอยู่ครบ (Phase Contract)
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
  /** สลับภาษาทันที แล้วเรียก `onLocaleChange` เพื่อบันทึก — reject ถ้าบันทึกไม่สำเร็จ (จอสลับไปแล้ว) */
  setLocale(locale: SupportedLocale): Promise<void>;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export interface LocaleProviderProps {
  i18n: I18nInstance;
  /** ภาษาที่ resolve แล้ว (`resolveLocale`) — เปลี่ยนค่าได้เมื่อรู้ภาษาของผู้ใช้หลัง login */
  locale: SupportedLocale;
  /** timezone ที่ resolve แล้ว (`resolveTimeZone`) */
  timeZone: string;
  /** บันทึกภาษาที่ผู้ใช้เลือก เช่น `saveUserLocale` ไป Keycloak */
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

  // ภาษาที่ผู้ใช้เพิ่งเลือกเอง — token เดิมยังถือ claim `locale` เก่าจนกว่าจะ renew
  const chosen = useRef<SupportedLocale | null>(null);

  // ภาษาที่ resolve ใหม่จากต้นทาง (claim ของผู้ใช้/ค่า tenant ที่มาถึงทีหลัง) ชนะค่าที่ใช้ระหว่างรอ
  // ยกเว้นเมื่อผู้ใช้เพิ่งเลือกเองและต้นทางยังตามไม่ทัน
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
  /** claims ของ ID token (`auth.user.profile`) — อ่าน `locale` และ `zoneinfo` */
  claims: Record<string, unknown> | undefined;
  accessToken: string;
  /** base URL ของ D-Contact API สำหรับค่าเริ่มต้นของ tenant */
  apiBaseUrl: string;
  /** issuer ของ Keycloak realm สำหรับบันทึกภาษาของผู้ใช้ */
  issuer: string;
}

export interface SessionLocaleProviderProps {
  i18n: I18nInstance;
  /** ไม่มี session (ยังไม่ login/e2e) → ใช้ภาษา browser และไม่บันทึกอะไร */
  session?: LocaleSession;
  children: ReactNode;
}

function browserLanguages(): readonly string[] {
  return typeof navigator === 'undefined' ? [] : navigator.languages;
}

/**
 * ประกอบลำดับ ผู้ใช้ → tenant → browser → `th` จาก session แล้วครอบ `LocaleProvider`
 * ค่าของ tenant ถูกดึงครั้งเดียวต่อ session (ไม่ดึงซ้ำทุกครั้งที่ access token หมุน)
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
      // ค่า tenant เป็นแค่ขั้นหนึ่งของลำดับ — ดึงไม่ได้ก็ไหลไป browser → th โดยไม่ขวางการทำงาน
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
  if (!value) throw new Error('useLocale ต้องอยู่ภายใต้ <LocaleProvider>');
  return value;
}

export function useFormatters(): Formatters {
  return useLocale().formatters;
}

export { useTranslation, Trans } from 'react-i18next';
