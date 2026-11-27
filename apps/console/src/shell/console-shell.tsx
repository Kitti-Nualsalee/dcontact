/**
 * D1.13 (#452): the new Console shell behind the tenant-level flag `ui.shell.v2`
 *
 * - the flag comes from the Navigation API (`features.shellV2`) and is decided once per page load;
 *   turning the flag off restores the old pages exactly on the next load, with no deploy
 * - tokens (`@d-contact/ui/tokens.css`) are loaded dynamically only when the shell is on, because they hold global rules for
 *   html/body — so the old page with the flag off does not change, not even the font
 * - page content (Journeys/Governance) is wrapped without touching its inner layout — moving pages for real is D1.14
 */
import type { ReactNode } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import {
  ShellFrame,
  Breadcrumb,
  LanguageSwitch,
  TopBar,
  TopBarLinks,
  UserMenu,
  type ShellNavigationState,
  ShellPageNavProvider,
  SubNav,
  areaOf,
  ToastRegion,
  toastQueue,
  useShellNavigation,
  type HostApp,
  type ShellArea,
  type ShellApp,
  type ShellUser,
  type UserMenuProps,
} from '@d-contact/ui-react';
import { useShellTokens } from './tokens.js';
import { useConsoleNavigation } from './console-navigation.js';

export type ConsoleShellApp =
  | 'home'
  | 'core-settings'
  | 'voice-routing'
  | 'tenant-people'
  | 'customers'
  | 'customer-tags'
  | 'customer-import'
  | 'customer-access'
  | 'customer-overview'
  | 'customer-rules'
  | 'customer-activity'
  | 'agent-history'
  | 'team-cases'
  | 'team-recordings'
  | 'team-history'
  | 'team-evaluations'
  | 'my-quality'
  | 'qm-forms'
  | 'journeys'
  | 'contact-governance'
  | 'dphone-embedding'
  | 'webchat-settings'
  | 'line-settings'
  // AC5 (#598): account page — not in the app registry, so no app is selected in the rail
  | 'account'
  | 'account-policy';

export function hostOrigins(): Partial<Record<HostApp, string>> {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    console: env.VITE_CONSOLE_URL ?? window.location.origin,
    // production must set VITE_WORKSPACE_URL — if unset, that app is not shown in the shell (no guessing localhost)
    workspace:
      env.VITE_WORKSPACE_URL ?? (import.meta.env.DEV ? 'http://localhost:5173' : undefined),
  };
}

/**
 * #651/#758: the submenu shows the area groups in the order the server sends; pins exist only on Home.
 * The item icon = the app id (ShellIcon uses a fallback icon when the id is unknown)
 */
export function areaSections(
  area: ShellArea,
  /** #658: choose a sub-page of the open app without reloading the page */
  page?: { appId: string; onSelect: (pageId: string) => void },
) {
  const item = (app: {
    id: string;
    pageId?: string;
    label: string;
    href: string;
    external: boolean;
  }) => ({
    // sub-pages use a dedicated id (`<appId>:<pageId>`) so one page is highlighted at a time; the icon stays the app's
    id: app.pageId ? subNavItemId(app.id, app.pageId) : app.id,
    label: app.label,
    href: app.href,
    icon: app.id,
    external: app.external,
    ...(page && app.pageId && app.id === page.appId
      ? { onSelect: () => page.onSelect(app.pageId!) }
      : {}),
  });
  return area.sections.map((section) => ({
    id: section.id,
    label: section.label,
    items: section.items.map(item),
  }));
}

/** id of a sub-page item in the submenu — used as `currentItemId` */
export function subNavItemId(appId: string, pageId: string) {
  return `${appId}:${pageId}`;
}

function legacySubNav(app: ShellApp | undefined) {
  if (!app) return undefined;
  return (
    <SubNav
      title={app.label}
      currentItemId={app.id}
      sections={[
        {
          id: 'work',
          items: [{ id: app.id, label: app.label, href: app.href, icon: app.id }],
        },
      ]}
    />
  );
}

export interface ConsoleShellProps {
  apiBaseUrl: string;
  accessToken: () => string | undefined;
  tenantAlias?: string;
  appId: ConsoleShellApp;
  /** #588: user menu on the top bar (name, organization, role and sign out) */
  account?: { user: ShellUser; onSignOut: () => Promise<void> };
  /**
   * #658: the open sub-page of the app (when the server sends `pages`) and the page switcher without reloading —
   * the page content owns page state; the shell only draws the menu
   */
  pageId?: string;
  onPageSelect?: (pageId: string) => void;
  /** Home uses a render function to read the same Navigation API request as the shell, including the legacy fallback */
  children: ReactNode | ((navigation: ShellNavigationState) => ReactNode);
}

export function ConsoleShell({
  apiBaseUrl,
  accessToken,
  tenantAlias,
  appId,
  account,
  pageId,
  onPageSelect,
  children,
}: ConsoleShellProps) {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const onNavigate = useConsoleNavigation();
  const { t: homeText } = useTranslation('home');
  const translate = t as unknown as (key: string) => string;
  const nav = useShellNavigation({
    apiBaseUrl,
    accessToken,
    currentHost: 'console',
    hostOrigins: hostOrigins(),
    tenantAlias,
    translate,
    onPinError: () =>
      toastQueue.add(
        { title: translate('shell.pinSaveFailed'), tone: 'attention' },
        { timeout: 6000 },
      ),
  });
  const tokensReady = useShellTokens(nav.status === 'ready' || appId === 'home');
  const content = typeof children === 'function' ? children(nav) : children;

  if (nav.status === 'legacy' && appId !== 'home') return <>{content}</>;
  if (nav.status === 'loading' || !tokensReady) {
    return (
      <main className="empty" aria-busy="true">
        <p>{t('shell.loading')}</p>
      </main>
    );
  }

  const withTenant = (path: string) => {
    const url = new URL(path, window.location.origin);
    if (tenantAlias) url.searchParams.set('tenant', tenantAlias);
    return `${url.pathname}${url.search}`;
  };
  // #588: a failed sign-out redirect (e.g. metadata could not load) must be shown to the user, not silently swallowed
  const userMenu = ({
    user,
    onSignOut,
  }: NonNullable<ConsoleShellProps['account']>): UserMenuProps => ({
    user,
    // AC5 (#598): the Console account page opens in the same tab
    accountLink: { href: withTenant('/?view=account') },
    onSignOut: () =>
      onSignOut().catch(() => {
        toastQueue.add({ title: t('shell.signOutFailed'), tone: 'attention' }, { timeout: 6000 });
      }),
  });
  const brand = (
    <>
      <img src="/d-contact-icon-64.png" alt="" width={24} height={24} />
      <span>{t('shell.brand')}</span>
    </>
  );
  const onLanguageChange = (next: 'th' | 'en') => {
    void setLocale(next).catch(() =>
      toastQueue.add({ title: t('language.saveFailed'), tone: 'attention' }, { timeout: 6000 }),
    );
  };
  const liveApps = (nav.apps ?? []).flatMap((app) => {
    const label =
      app.id === 'agent-workspace'
        ? t('shell.liveWorkspace')
        : app.id === 'supervisor-workspace'
          ? t('shell.liveSupervisor')
          : undefined;
    return label ? [{ ...app, label }] : [];
  });
  const liveLinks = <TopBarLinks apps={liveApps} label={t('shell.liveSystems')} />;
  // Home can still open when the shell is off; the rail is not shown until the flag is on, per the original rollout
  if (nav.status === 'legacy')
    return (
      <div className="home-shell">
        <TopBar brand={brand} breadcrumb={[]}>
          {liveLinks}
          <LanguageSwitch value={locale} onChange={onLanguageChange} />
          {account ? <UserMenu {...userMenu(account)} /> : null}
        </TopBar>
        <Breadcrumb items={[t('navigation.apps.home')]} placement="content" />
        <main>{content}</main>
        <ToastRegion />
      </div>
    );
  const homeApps = nav.apps.filter((app) => app.id !== 'home');
  const homeItem = (app: ShellApp) => ({
    ...app,
    label:
      app.id === 'agent-workspace'
        ? app.label
        : homeText(`names.${app.id}`, { defaultValue: app.label }),
    icon: app.id === 'dphone-embedding' ? 'area-integrations' : app.id,
  });
  // Home now has a permanent link; pins are used only for apps the server allows and keep the user's order
  const homePins = nav.pinnedIds.flatMap((id) => {
    const app = homeApps.find((candidate) => candidate.id === id);
    return app ? [homeItem(app)] : [];
  });
  const homeSubNav = (
    <SubNav
      title={t('navigation.apps.home')}
      currentItemId="home"
      sections={[
        {
          id: 'home',
          items: [
            {
              id: 'home',
              label: t('navigation.apps.home'),
              href: withTenant('/?view=home'),
              icon: 'area-home',
            },
          ],
        },
        ...(homePins.length ? [{ id: 'pinned', label: t('shell.pinned'), items: homePins }] : []),
        {
          id: 'account',
          items: [
            {
              id: 'account',
              label: t('shell.account.mine'),
              href: withTenant('/?view=account'),
              icon: 'settings',
            },
          ],
        },
      ]}
    />
  );
  const journeysVisible = nav.apps.some((app) => app.id === 'journeys');
  const isAdmin = account?.user.roles.includes('admin') ?? false;
  const accountPage = appId === 'account' || appId === 'account-policy';
  const area = accountPage ? undefined : nav.areas.find((a) => a.id === areaOf(nav.areas, appId));
  // #658: the submenu has sub-pages for this app → the content does not need to draw its own tabs
  const hasPages =
    area?.sections.some((section) =>
      section.items.some((entry) => entry.id === appId && entry.pageId !== undefined),
    ) ?? false;
  const pageLabel = hasPages
    ? area?.sections
        .flatMap((section) => section.items)
        .find((entry) => entry.id === appId && entry.pageId === pageId)?.label
    : undefined;
  const subNav =
    appId === 'home' ? (
      homeSubNav
    ) : accountPage ? (
      <SubNav
        eyebrow={t('shell.account.eyebrow')}
        title={t('shell.account.title')}
        currentItemId={appId}
        sections={[
          {
            id: 'account',
            label: t('shell.account.section'),
            items: [
              {
                id: 'account',
                label: t('shell.account.mine'),
                href: withTenant('/?view=account'),
                icon: 'settings',
              },
              // the role only hides the link — the API checks admin on every request
              ...(isAdmin
                ? [
                    {
                      id: 'account-policy',
                      label: t('shell.account.policy'),
                      href: withTenant('/?view=account-policy'),
                      icon: 'settings' as const,
                    },
                  ]
                : []),
            ],
          },
        ]}
      />
    ) : area ? (
      // #651: the submenu is computed from the areas the server sends — adding a new page does not require editing this file
      <SubNav
        title={area.label}
        currentItemId={hasPages && pageId ? subNavItemId(appId, pageId) : appId}
        sections={areaSections(
          area,
          hasPages && onPageSelect ? { appId, onSelect: onPageSelect } : undefined,
        )}
      />
    ) : (
      // older API that does not send `areas` yet (API rollback under the new Console): a single submenu item for this app
      legacySubNav(nav.apps.find((app) => app.id === appId))
    );

  const frame = (
    <>
      <ShellFrame
        apps={nav.apps}
        groups={nav.groups}
        pinnedIds={nav.pinnedIds}
        maxPins={nav.maxPins}
        onTogglePin={nav.togglePin}
        currentAppId={appId}
        onNavigate={onNavigate}
        areas={nav.areas}
        railExcludedAppIds={liveApps.map((app) => app.id)}
        brand={brand}
        topBarActions={liveLinks}
        breadcrumbPlacement="content"
        breadcrumb={
          appId === 'home'
            ? [t('navigation.apps.home')]
            : appId === 'account' || appId === 'account-policy'
              ? [
                  t('shell.account.title'),
                  t(appId === 'account' ? 'shell.account.mine' : 'shell.account.policy'),
                ]
              : appId === 'core-settings'
                ? [t('navigation.apps.coreSettings'), ...(pageLabel ? [pageLabel] : [])]
                : appId === 'voice-routing'
                  ? [t('navigation.apps.voiceRouting'), ...(pageLabel ? [pageLabel] : [])]
                  : appId === 'tenant-people'
                    ? [t('navigation.apps.tenantPeople')]
                    : appId === 'customers'
                      ? [t('navigation.apps.customers')]
                      : appId === 'customer-overview' || appId === 'customer-rules'
                        ? [
                            t('navigation.apps.customers'),
                            t(
                              appId === 'customer-rules'
                                ? 'navigation.apps.customerRules'
                                : 'navigation.apps.customerOverview',
                            ),
                          ]
                        : appId === 'customer-activity'
                          ? [t('navigation.apps.customers'), t('navigation.apps.customerActivity')]
                          : appId === 'customer-tags'
                            ? [t('navigation.apps.customers'), t('navigation.apps.customerTags')]
                            : appId === 'customer-import'
                              ? [
                                  t('navigation.apps.customers'),
                                  t('navigation.apps.customerImport'),
                                ]
                              : appId === 'customer-access'
                                ? [
                                    t('navigation.apps.customers'),
                                    t('navigation.apps.customerAccess'),
                                  ]
                                : appId === 'journeys'
                                  ? [
                                      t('navigation.groups.automation'),
                                      t('navigation.apps.journeys'),
                                    ]
                                  : appId === 'dphone-embedding'
                                    ? [
                                        t('navigation.groups.settings'),
                                        t('navigation.apps.dphoneEmbedding'),
                                      ]
                                    : appId === 'contact-governance'
                                      ? [
                                          t('navigation.groups.quality'),
                                          t('navigation.apps.contactGovernance'),
                                          ...(pageLabel ? [pageLabel] : []),
                                        ]
                                      : // other pages follow the menu: area / app (e.g. Quality / Team call evaluation)
                                        [
                                          ...(area ? [area.label] : []),
                                          nav.apps.find((app) => app.id === appId)?.label ?? '',
                                          ...(pageLabel ? [pageLabel] : []),
                                        ].filter(Boolean)
        }
        language={locale}
        onLanguageChange={onLanguageChange}
        subNav={appId === 'home' ? <div className="home-sidebar">{subNav}</div> : subNav}
        user={account ? userMenu(account) : undefined}
        createActions={
          journeysVisible
            ? [
                {
                  id: 'journey',
                  label: t('shell.create.journey'),
                  href: withTenant('/?view=journeys'),
                  external: false,
                },
              ]
            : []
        }
      >
        <ShellPageNavProvider value={hasPages}>{content}</ShellPageNavProvider>
      </ShellFrame>
      <ToastRegion />
    </>
  );
  return appId === 'home' ? <div className="home-shell">{frame}</div> : frame;
}
