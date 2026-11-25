/**
 * demo page of the shell (`?view=shell`) — uses `useShellNavigation` with a simulated Navigation API in the page
 * so Playwright can check axe/keyboard of the rail + launcher and the real PUT request for pins
 */
import { useTranslation } from 'react-i18next';
import {
  AppLauncher,
  AppShell,
  LanguageSwitch,
  Rail,
  RailLink,
  SubNav,
  TopBar,
  TopBarLinks,
  UserMenu,
  shellUserFromClaims,
  useShellNavigation,
  type NavigationResponseV1,
} from '../src/index.js';

const mock: NavigationResponseV1 = {
  groups: [
    { id: 'live', labelKey: 'shellDemo.groups.live' },
    { id: 'automation', labelKey: 'shellDemo.groups.automation' },
    { id: 'quality', labelKey: 'shellDemo.groups.quality' },
  ],
  apps: [
    {
      id: 'agent-workspace',
      groupId: 'live',
      labelKey: 'shellDemo.apps.agentWorkspace',
      hostApp: 'workspace',
      path: '/',
    },
    {
      id: 'supervisor-workspace',
      groupId: 'live',
      labelKey: 'shellDemo.apps.supervisorWorkspace',
      hostApp: 'workspace',
      path: '/?view=supervisor',
    },
    {
      id: 'journeys',
      groupId: 'automation',
      labelKey: 'shellDemo.apps.journeys',
      hostApp: 'console',
      path: '/?view=journeys',
    },
    {
      id: 'contact-governance',
      groupId: 'quality',
      labelKey: 'shellDemo.apps.contactGovernance',
      hostApp: 'console',
      path: '/?view=governance',
    },
  ],
  pins: { appIds: ['agent-workspace', 'journeys'], source: 'SYSTEM', revision: 0 },
  limits: { maxPins: 3 },
  features: { shellV2: true },
};

// simulated Navigation API — keeps a real revision so tests can check expectedRevision
const store = { pins: [...mock.pins.appIds], revision: 0 };
const mockFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  (window as unknown as { __navRequests: unknown[] }).__navRequests ??= [];
  (window as unknown as { __navRequests: unknown[] }).__navRequests.push({
    url,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  if (url.endsWith('/me/navigation/pins')) {
    // delay like a real network — lets the test press again while the first request has not been answered
    await new Promise((resolve) => setTimeout(resolve, 150));
    const body = JSON.parse(String(init?.body)) as { appIds: string[]; expectedRevision: number };
    if (body.expectedRevision !== store.revision) {
      return Response.json({ code: 'REVISION_CONFLICT' }, { status: 409 });
    }
    store.pins = body.appIds;
    store.revision += 1;
    return Response.json({ appIds: store.pins, revision: store.revision });
  }
  return Response.json({
    ...mock,
    pins: { appIds: store.pins, source: 'SYSTEM', revision: store.revision },
  });
};

// #588: simulated claims — a role the menu does not know (offline_access) must not be shown
const demoUser = shellUserFromClaims(
  {
    name: 'สมชาย ใจดี', // allow-thai: Thai display-name fixture
    email: 'somchai@demo.example',
    realm_access: { roles: ['supervisor', 'agent', 'offline_access'] },
  },
  'demo',
);

function recordSignOut() {
  const w = window as unknown as { __signOuts?: number };
  w.__signOuts = (w.__signOuts ?? 0) + 1;
}

export function ShellDemo() {
  const { t, i18n } = useTranslation('preview');
  const nav = useShellNavigation({
    apiBaseUrl: 'https://api.example',
    accessToken: () => 'demo',
    currentHost: 'console',
    hostOrigins: { console: window.location.origin, workspace: 'https://workspace.example' },
    tenantAlias: 'demo',
    translate: (key) => t(key),
    fetch: mockFetch,
  });
  if (nav.status !== 'ready') return null;
  const pinnedApps = nav.pinnedIds
    .map((id) => nav.apps.find((app) => app.id === id))
    .filter((app) => app !== undefined);
  const language = i18n.language === 'en' ? 'en' : 'th';
  // `?signout=confirm` = simulates Workspace during a call (asks for confirmation before leaving)
  const confirmSignOut = new URL(window.location.href).searchParams.get('signout') === 'confirm';

  return (
    <AppShell
      rail={
        <Rail
          pinnedApps={pinnedApps}
          currentAppId="journeys"
          launcher={
            <AppLauncher
              apps={nav.apps}
              groups={nav.groups}
              pinnedIds={nav.pinnedIds}
              maxPins={nav.maxPins}
              onTogglePin={nav.togglePin}
              createActions={[
                {
                  id: 'journey',
                  label: t('shellDemo.createJourney'),
                  href: '/?view=journeys&new=1',
                  external: false,
                },
              ]}
            />
          }
          footer={<RailLink href="#settings" icon="settings" label={t('shellDemo.settings')} />}
        />
      }
      subNav={
        <SubNav
          eyebrow={t('shellDemo.groups.automation')}
          title={t('shellDemo.apps.journeys')}
          currentItemId="list"
          sections={[
            {
              id: 'work',
              label: t('shellDemo.sectionWork'),
              items: [
                { id: 'list', label: t('shellDemo.list'), href: '#list', icon: 'journeys' },
                {
                  id: 'templates',
                  label: t('shellDemo.templates'),
                  href: '#templates',
                  icon: 'fallback',
                },
                {
                  id: 'review',
                  label: t('shellDemo.review'),
                  href: '#review',
                  icon: 'contact-governance',
                  count: 3,
                },
              ],
            },
          ]}
        />
      }
      topBar={
        <TopBar
          brand="D-Contact"
          breadcrumb={[t('shellDemo.groups.automation'), t('shellDemo.apps.journeys')]}
        >
          <TopBarLinks
            apps={nav.apps.filter((app) =>
              ['agent-workspace', 'supervisor-workspace'].includes(app.id),
            )}
            label={t('shellDemo.groups.live')}
          />
          <LanguageSwitch
            value={language}
            onChange={(next) => {
              void i18n.changeLanguage(next);
              document.documentElement.lang = next;
            }}
          />
          <UserMenu
            user={demoUser}
            onSignOut={recordSignOut}
            // AC5 (#598): same as Workspace — opens the Console account page in a new tab
            accountLink={{ href: 'https://console.demo.example/?view=account', newTab: true }}
            signOutConfirm={
              confirmSignOut
                ? {
                    title: t('shellDemo.signOutConfirm.title'),
                    description: t('shellDemo.signOutConfirm.description'),
                    confirmLabel: t('shellDemo.signOutConfirm.confirm'),
                  }
                : undefined
            }
          />
        </TopBar>
      }
    >
      <div style={{ padding: 'var(--dc-space-8)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--dc-text-lg)' }}>{t('shellDemo.heading')}</h1>
        <p style={{ color: 'var(--dc-text-secondary)' }}>{t('shellDemo.body')}</p>
      </div>
    </AppShell>
  );
}
