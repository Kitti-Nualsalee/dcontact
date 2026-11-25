/**
 * D1.13 (#452): the new Workspace shell behind the tenant-level flag `ui.shell.v2` — no SubNav (D1.2)
 * #651: the rail shows work areas from the Navigation API (`areas`) — Workspace has no submenus yet
 *
 * The shell must be decided **before** WorkspaceApp mounts and never change for the rest of the page load, because a remount would cut
 * the softphone/WS of a call in progress (ADR-026) — so while waiting for the answer it shows a screen-preparing state instead of rendering early
 * the tokens load dynamically only when the shell is on (they carry global html/body rules) — flag off = exactly the old page
 */
import type { ReactNode } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import {
  ShellFrame,
  ToastRegion,
  toastQueue,
  useShellNavigation,
  type HostApp,
  type ShellUser,
} from '@d-contact/ui-react';
import { useShellTokens } from './tokens.js';

export type WorkspaceShellApp = 'agent-workspace' | 'supervisor-workspace';

function hostOrigins(): Partial<Record<HostApp, string>> {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    // production must set VITE_CONSOLE_URL — unset = that app is not shown in the shell (do not guess localhost)
    console: env.VITE_CONSOLE_URL ?? (import.meta.env.DEV ? 'http://localhost:5174' : undefined),
    workspace: env.VITE_WORKSPACE_URL ?? window.location.origin,
  };
}

export interface WorkspaceShellProps {
  apiBaseUrl: string;
  accessToken: () => string | undefined;
  tenantAlias?: string;
  appId: WorkspaceShellApp;
  /** #588: user menu on the top bar (name, organization, role and sign out) */
  account?: { user: ShellUser; onSignOut: () => Promise<void> };
  /** #588: a call or wrap-up is pending → ask for confirmation before signing out */
  workInHand?: boolean;
  children: ReactNode;
}

export function WorkspaceShell({
  apiBaseUrl,
  accessToken,
  tenantAlias,
  appId,
  account,
  workInHand = false,
  children,
}: WorkspaceShellProps) {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const translate = t as unknown as (key: string) => string;
  const nav = useShellNavigation({
    apiBaseUrl,
    accessToken,
    currentHost: 'workspace',
    hostOrigins: hostOrigins(),
    tenantAlias,
    translate,
    onPinError: () =>
      toastQueue.add(
        { title: translate('shell.pinSaveFailed'), tone: 'attention' },
        { timeout: 6000 },
      ),
  });
  const tokensReady = useShellTokens(nav.status === 'ready');

  const consoleOrigin = hostOrigins().console;
  const consoleAccountHref = consoleOrigin
    ? (() => {
        const url = new URL('/', consoleOrigin);
        if (tenantAlias) url.searchParams.set('tenant', tenantAlias);
        url.searchParams.set('view', 'account');
        return url.href;
      })()
    : undefined;
  if (nav.status === 'legacy') return <>{children}</>;
  if (nav.status === 'loading' || !tokensReady) {
    return (
      <main className="auth-page" aria-busy="true">
        <p>{t('shell.loading')}</p>
      </main>
    );
  }
  return (
    <>
      <ShellFrame
        apps={nav.apps}
        groups={nav.groups}
        pinnedIds={nav.pinnedIds}
        maxPins={nav.maxPins}
        onTogglePin={nav.togglePin}
        currentAppId={appId}
        areas={nav.areas}
        brand={
          <>
            <img src="/d-contact-icon-64.png" alt="" width={24} height={24} />
            <span>{t('shell.brand')}</span>
          </>
        }
        breadcrumb={[
          t('navigation.groups.live'),
          appId === 'agent-workspace'
            ? t('navigation.apps.agentWorkspace')
            : t('navigation.apps.supervisorWorkspace'),
        ]}
        language={locale}
        onLanguageChange={(next) => {
          void setLocale(next).catch(() =>
            toastQueue.add(
              { title: t('language.saveFailed'), tone: 'attention' },
              { timeout: 6000 },
            ),
          );
        }}
        user={
          account
            ? {
                user: account.user,
                // AC5 (#598): my account lives in Console — open a new tab so Workspace is not remounted (ADR-026)
                ...(consoleAccountHref
                  ? { accountLink: { href: consoleAccountHref, newTab: true } }
                  : {}),
                // #588: a failed redirect to sign out must tell the user, not fail silently
                onSignOut: () =>
                  account.onSignOut().catch(() => {
                    toastQueue.add(
                      { title: t('shell.signOutFailed'), tone: 'attention' },
                      { timeout: 6000 },
                    );
                  }),
                signOutConfirm: workInHand
                  ? {
                      title: t('shell.signOutConfirm.title'),
                      description: t('shell.signOutConfirm.description'),
                      confirmLabel: t('shell.signOutConfirm.confirm'),
                    }
                  : undefined,
              }
            : undefined
        }
      >
        {children}
      </ShellFrame>
      <ToastRegion />
    </>
  );
}
