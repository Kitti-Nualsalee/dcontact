import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { resolveConsoleView, resolveTenantAlias } from '../auth-session.js';

type Navigate = (href: string) => boolean;
const NavigationContext = createContext<Navigate | undefined>(undefined);
export const ConsoleNavigationProvider = NavigationContext.Provider;
export const useConsoleNavigation = () => useContext(NavigationContext);
const INDEX = 'dcontact.console.navigationIndex';
const VIEWS = new Set([
  'home',
  'agent-history',
  'governance',
  'journeys',
  'dphone-embedding',
  'voice-routing',
  'tenant-people',
  'core-settings',
  'line-inbound',
  'account',
  'account-policy',
]);

/** รับเฉพาะหน้าภายใน tenant เดิม; callback/identity action ต้องใช้ flow เดิม */
export function isConsoleNavigation(current: URL, target: URL): boolean {
  try {
    return (
      target.origin === current.origin &&
      target.pathname === current.pathname &&
      resolveTenantAlias(target) === resolveTenantAlias(current) &&
      VIEWS.has(resolveConsoleView(target) ?? '') &&
      !['code', 'state', 'error', 'token', 'verify', 'verifyToken', 'context'].some((key) =>
        target.searchParams.has(key),
      )
    );
  } catch {
    return false;
  }
}

/** AuthProvider อยู่เหนือ route และไม่ถูก remount; history state เก็บเฉพาะลำดับ ไม่มี token */
export function useConsoleRouter(
  onRoute: (url: URL) => void,
  confirmLeave: () => boolean,
): Navigate {
  const callbacks = useRef({ onRoute, confirmLeave });
  callbacks.current = { onRoute, confirmLeave };
  const navigate = useRef<Navigate | undefined>(undefined);
  useEffect(() => {
    const history = window.history;
    const push = history.pushState;
    const replace = history.replaceState;
    let index = typeof history.state?.[INDEX] === 'number' ? history.state[INDEX] : 0;
    let accepted = new URL(window.location.href);
    let restoring = false;
    const indexed = (state: unknown, value: number) => ({
      ...(state && typeof state === 'object' ? state : {}),
      [INDEX]: value,
    });
    const tenantUrl = (url: string | URL | null | undefined) => {
      if (url == null) return url;
      const next = new URL(url, window.location.href);
      if (
        next.origin === accepted.origin &&
        next.pathname === accepted.pathname &&
        !next.searchParams.has('tenant')
      ) {
        next.searchParams.set('tenant', resolveTenantAlias(accepted));
      }
      return next;
    };
    replace.call(history, indexed(history.state, index), '');
    // หน้าย่อยมี pushState ของตนเอง จึงติดลำดับด้วยเพื่อย้อนกลับได้ตรง entry เมื่อผู้ใช้ยกเลิก
    const pushEntry: History['pushState'] = (state, title, url) => {
      const next = index + 1;
      push.call(history, indexed(state, next), title, tenantUrl(url));
      index = next;
      accepted = new URL(window.location.href);
    };
    const replaceEntry: History['replaceState'] = (state, title, url) => {
      replace.call(history, indexed(state, index), title, tenantUrl(url));
      accepted = new URL(window.location.href);
    };
    history.pushState = pushEntry;
    history.replaceState = replaceEntry;
    const mayLeave = () => {
      // ใช้คำเตือนร่าง/pending ที่หน้าปัจจุบันลงทะเบียนไว้ โดยไม่ unload document จริง
      const event = new Event('beforeunload', { cancelable: true });
      return window.dispatchEvent(event) || callbacks.current.confirmLeave();
    };
    navigate.current = (href) => {
      const current = new URL(window.location.href);
      const target = new URL(href, current);
      if (!isConsoleNavigation(current, target)) return false;
      if (target.href === current.href || !mayLeave()) return true;
      history.pushState(null, '', target);
      callbacks.current.onRoute(target);
      return true;
    };
    const pop = (event: PopStateEvent) => {
      if (restoring) {
        restoring = false;
        event.stopImmediatePropagation();
        return;
      }
      const target = new URL(window.location.href);
      const nextIndex = event.state?.[INDEX];
      if (!isConsoleNavigation(accepted, target) || typeof nextIndex !== 'number') {
        window.location.reload();
        return;
      }
      if (resolveConsoleView(accepted) === resolveConsoleView(target)) {
        // หน้าย่อยใช้ popstate ของตนเองต่อไป ไม่ remount/reset state โดย root router
        index = nextIndex;
        accepted = target;
        return;
      }
      event.stopImmediatePropagation();
      if (!mayLeave()) {
        restoring = true;
        history.go(index - nextIndex);
        return;
      }
      index = nextIndex;
      accepted = target;
      callbacks.current.onRoute(target);
    };
    window.addEventListener('popstate', pop, true);
    return () => {
      navigate.current = undefined;
      window.removeEventListener('popstate', pop, true);
      if (history.pushState === pushEntry) history.pushState = push;
      if (history.replaceState === replaceEntry) history.replaceState = replace;
    };
  }, []);
  return useCallback((href: string) => navigate.current?.(href) ?? false, []);
}
