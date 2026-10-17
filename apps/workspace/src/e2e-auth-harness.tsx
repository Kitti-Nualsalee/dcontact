import { useMemo } from 'react';
import { AuthProvider } from 'react-oidc-context';
import { User, UserManager } from 'oidc-client-ts';
import { AuthenticatedWorkspace, WorkspacePopupCallback } from './auth-root.js';
import { createOidcSettings } from './auth-session.js';
import { createDeterministicDphone, type DphoneFactory } from './workspace-app.js';
import { useLocale } from '@d-contact/i18n/react';

const createPhone: DphoneFactory = (_audio, callbacks) => createDeterministicDphone(callbacks);

export function E2eAuthHarness() {
  const { locale, setLocale } = useLocale();
  const manager = useMemo(() => {
    const settings = createOidcSettings({
      issuer: `${window.location.origin}/oidc`,
      clientId: 'agent-desktop',
      origin: window.location.origin,
      tenantAlias: 'demo',
      stateStorage: sessionStorage,
    });
    const callback = `${window.location.origin}/?tenant=demo&authHarness=1`;
    return new UserManager({
      ...settings,
      redirect_uri: callback,
      popup_redirect_uri: callback,
      automaticSilentRenew: false,
      monitorSession: false,
    });
  }, []);
  if (window.opener && new URL(window.location.href).searchParams.has('state')) {
    return <WorkspacePopupCallback settings={manager.settings} />;
  }
  async function authenticate(subject: string, token: string) {
    const user = new User({
      access_token: token,
      token_type: 'Bearer',
      scope: 'openid',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      profile: {
        iss: `${window.location.origin}/oidc`,
        sub: subject,
        aud: 'agent-desktop',
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        tenant_id: '00000000-0000-4000-8000-000000000001',
        tenant_slug: 'demo',
        dc_user_id: subject,
      },
    });
    await manager.storeUser(user);
    await manager.events.load(user);
  }
  return (
    <>
      <aside aria-label="OIDC test controls">
        <button onClick={() => void authenticate('agent-one', 'token-one')}>Sign in fixture</button>
        <button onClick={() => void authenticate('agent-one', 'token-two')}>Refresh fixture</button>
        <button onClick={() => void manager.removeUser()}>Expire fixture</button>
        <button onClick={() => void authenticate('agent-two', 'token-other')}>Other fixture</button>
        <button onClick={() => void setLocale(locale === 'th' ? 'en' : 'th')}>
          Locale fixture
        </button>
      </aside>
      <AuthProvider userManager={manager}>
        <AuthenticatedWorkspace
          apiBaseUrl={window.location.origin}
          tenantAlias="demo"
          createDphone={createPhone}
        />
      </AuthProvider>
    </>
  );
}
