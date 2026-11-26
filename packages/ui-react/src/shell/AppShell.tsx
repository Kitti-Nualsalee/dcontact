import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useUiText } from '../i18n.js';
import styles from './AppShell.module.css';

const InShellContext = createContext(false);

/**
 * page content uses this to decide whether it must draw its own old chrome (skip link, header, main) —
 * when inside the AppShell it must not draw it again (nested landmarks confuse screen readers)
 */
export function useInShell(): boolean {
  return useContext(InShellContext);
}

const PageNavContext = createContext(false);

/**
 * #658: the shell draws the app's sub-pages in the sub-menu — page content must not draw the same tabs again
 * (when the sub-menu has no sub-pages, e.g. an older API, the content must use its own tabs)
 */
export function useShellPageNav(): boolean {
  return useContext(PageNavContext);
}

export function ShellPageNavProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <PageNavContext.Provider value={value}>{children}</PageNavContext.Provider>;
}

export interface AppShellProps {
  rail: ReactNode;
  /** Console has a sub-menu panel; Workspace does not (D1.2) */
  subNav?: ReactNode;
  topBar: ReactNode;
  children: ReactNode;
}

/**
 * shared frame of Console/Workspace: rail | (SubNav) | top bar + content
 * has a skip link to the content because the rail + SubNav have dozens of links before the main content
 */
export function AppShell({ rail, subNav, topBar, children }: AppShellProps) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const lastFocus = useRef<'close' | 'trigger' | 'navigation' | 'other'>('other');
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    const media = window.matchMedia('(min-width: 769px)');
    const remember = (target: EventTarget | null) => {
      if (target === closeButton.current) lastFocus.current = 'close';
      else if (target === trigger.current) lastFocus.current = 'trigger';
      else if (target instanceof Node && navigation.current?.contains(target))
        lastFocus.current = 'navigation';
      else lastFocus.current = 'other';
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target !== document.body) remember(event.target);
    };
    const onPointer = (event: PointerEvent) => remember(event.target);
    const onResize = () => {
      const active = document.activeElement;
      if (media.matches) {
        setOpen(false);
        if (
          active === closeButton.current ||
          active === trigger.current ||
          (active === document.body &&
            (lastFocus.current === 'close' || lastFocus.current === 'trigger'))
        ) {
          const first =
            navigation.current?.querySelector<HTMLElement>('nav a[href]') ??
            navigation.current?.querySelector<HTMLElement>('nav button:not([disabled])');
          first?.focus();
        }
      } else if (
        (active && navigation.current?.contains(active)) ||
        (active === document.body && lastFocus.current === 'navigation')
      ) {
        trigger.current?.focus();
      }
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('pointerdown', onPointer);
    media.addEventListener('change', onResize);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('pointerdown', onPointer);
      media.removeEventListener('change', onResize);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !(target instanceof Element && target.closest('[data-shell-launcher]'))
      ) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
  return (
    <div className={styles.shell} data-has-subnav={subNav ? 'true' : undefined}>
      <a className={styles.skip} href="#dc-main">
        {t('shell.skipToContent')}
      </a>
      <section
        ref={navigation}
        id="dc-navigation-drawer"
        className={styles.drawer}
        data-open={open ? 'true' : 'false'}
        aria-label={t('shell.navigation')}
      >
        <div className={styles.drawerHeader}>
          <span>{t('shell.navigation')}</span>
          <button
            ref={closeButton}
            type="button"
            className={styles.closeNavigation}
            aria-label={t('shell.closeNavigation')}
            onClick={close}
          >
            ×
          </button>
        </div>
        <div
          className={styles.drawerNavigation}
          onClickCapture={(event) => {
            const target = event.target;
            if (
              open &&
              target instanceof Element &&
              target.closest('a') &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              close();
            }
          }}
        >
          {rail}
          {subNav}
        </div>
      </section>
      <div className={styles.column}>
        <div className={styles.topBarRow}>
          <button
            ref={trigger}
            type="button"
            className={styles.navigationTrigger}
            aria-label={t('shell.openNavigation')}
            aria-expanded={open}
            aria-controls="dc-navigation-drawer"
            onClick={() => setOpen(true)}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path d="M3 5h14M3 10h14M3 15h14" strokeWidth="2" />
            </svg>
          </button>
          {topBar}
        </div>
        <main id="dc-main" className={styles.main} tabIndex={-1}>
          <InShellContext.Provider value={true}>{children}</InShellContext.Provider>
        </main>
      </div>
    </div>
  );
}
