/**
 * D1.15 (#454): standalone `/dphone` page of apps/workspace
 *
 * In D1 it is a window detached from Agent Workspace: it has no SIP/WebRTC/WS of its own and controls the working tab's call
 * through BroadcastChannel (same-origin), so it needs no token and creates no second work point
 * using it as an iframe in an external system (popup auth, allowlist, postMessage API) belongs to map E1
 *
 * E1.12 (#486): this detached window does not take work itself, so it does not request a work-session lease — the lease stays with the Workspace that is the host
 * when the host loses the lease (and has no call in hand) the host closes the bridge; this window gets `closed` and closes itself
 */
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { useShellTokens } from '../shell/tokens.js';
import { createDphoneRemote, type DphoneView } from './dphone-bridge.js';
import { DphoneWidget, type DphoneSize } from './dphone-widget.js';
import './dphone.css';

type PageState = 'waiting' | 'no-host' | 'connected' | 'closed';

export function DphonePage() {
  const tokensReady = useShellTokens();
  const { t } = useTranslation('dphone');
  const { locale, setLocale } = useLocale();
  const [view, setView] = useState<DphoneView>();
  const [state, setState] = useState<PageState>('waiting');
  const [size, setSize] = useState<DphoneSize>('expanded');
  const remote = useRef<ReturnType<typeof createDphoneRemote>>(undefined);

  useEffect(() => {
    document.title = t('page.title');
  }, [t]);

  useEffect(() => {
    // id from the working tab when the window was detached — opened by itself with no id, no Workspace answers
    const remoteId = new URL(window.location.href).searchParams.get('remote');
    if (!remoteId) {
      setState('no-host');
      return;
    }
    const connection = createDphoneRemote({
      remote: remoteId,
      onView: (next) => {
        setView(next);
        setState('connected');
      },
      onClosed: () => {
        setState('closed');
        window.close();
      },
    });
    remote.current = connection;
    const timeout = window.setTimeout(
      () => setState((current) => (current === 'waiting' ? 'no-host' : current)),
      3_000,
    );
    const bye = () => connection.close();
    window.addEventListener('pagehide', bye);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('pagehide', bye);
      connection.close();
      remote.current = undefined;
    };
  }, []);

  // language follows the working tab — when the user switches language in Workspace the detached window follows
  useEffect(() => {
    if (view && view.locale !== locale) void setLocale(view.locale);
  }, [locale, setLocale, view]);

  if (!tokensReady) return null;
  return (
    <main className="dp-page">
      {state === 'connected' && view ? (
        <DphoneWidget
          view={view}
          size={size}
          onSizeChange={setSize}
          onCommand={(command) => remote.current?.send(command)}
        />
      ) : (
        <p className="dp-page-message" role="status">
          {state === 'no-host'
            ? t('page.noHost')
            : state === 'closed'
              ? t('page.closed')
              : t('page.waiting')}
        </p>
      )}
    </main>
  );
}
