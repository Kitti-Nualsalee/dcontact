/**
 * E1.14 (#488): UI ของ dphone ที่ถูกฝัง — `WorkspaceApp variant="embedded"` (component/logic เดียวกับ D1.15)
 * + prompt ของ click-to-call ที่ host กรอกเบอร์ให้ (agent ต้องกดโทรเอง)
 */
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionLocaleProvider, useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { createAgentWorkspaceApi, type AgentWorkspaceApi } from '../agent-api.js';
import { BrowserDphone } from '../dphone/dphone.js';
import { SipJsBrowserTransport } from '../dphone/sip-js-transport.js';
import { appI18n } from '../i18n/index.js';
import { WorkspaceApp, type DphoneFactory } from '../workspace-app.js';
import { createWorkSessionApi } from '../work-session.js';
import type { EmbedRuntime, PrefillState } from './embed-runtime.js';
import type { EmbeddedAuth } from './embedded-auth.js';
import type { HostOriginLock } from './origin-lock.js';
import '../workspace-app.css';

const createProductionDphone: DphoneFactory = (remoteAudio, callbacks) =>
  new BrowserDphone(new SipJsBrowserTransport(remoteAudio, callbacks));

export interface EmbeddedAppProps {
  auth: EmbeddedAuth;
  runtime: EmbedRuntime;
  lock: HostOriginLock;
  apiBaseUrl: string;
  tenant: string;
  createDphone?: DphoneFactory;
}

function ClickToCallPrompt({ runtime }: { runtime: EmbedRuntime }) {
  const { t } = useTranslation('dphone');
  const [state, setState] = useState<PrefillState>(runtime.state);
  useEffect(() => runtime.subscribe(setState), [runtime]);
  if (state.phase === 'idle') return null;
  return (
    <section className="aw-panel dphone-embed-call" aria-label={t('embedCall.label')}>
      <p className="aw-step">{t('embedCall.fromHost')}</p>
      <p className="dphone-embed-call__number">{state.request.number}</p>
      {state.phase === 'result' ? (
        <p role="status">{t(`embedCall.result.${state.result.status}`)}</p>
      ) : null}
      {state.phase === 'dialing' ? <p role="status">{t('embedCall.checking')}</p> : null}
      <div className="dphone-embed-call__actions">
        {state.phase === 'prefilled' ? (
          <Button variant="primary" onPress={() => void runtime.dial()}>
            {t('embedCall.dial')}
          </Button>
        ) : null}
        {state.phase !== 'dialing' ? (
          <Button variant="ghost" onPress={() => void runtime.cancel()}>
            {state.phase === 'result' ? t('embedCall.close') : t('embedCall.cancel')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function EmbeddedApp({ auth, runtime, lock, apiBaseUrl, createDphone }: EmbeddedAppProps) {
  const [status, setStatus] = useState(auth.status);
  useEffect(() => auth.subscribe(setStatus), [auth]);
  const fetchWithToken = useMemo(
    () => (url: string, init: RequestInit) => auth.fetch(url, init),
    [auth],
  );
  const api = useMemo<AgentWorkspaceApi>(() => {
    const base = createAgentWorkspaceApi({
      baseUrl: apiBaseUrl,
      accessToken: () => auth.accessToken(),
      authorizedFetch: fetchWithToken,
    });
    return {
      ...base,
      // `embed.origin.revoked` ของ origin ที่ล็อกไว้ → หยุดรับ/ส่งข้อความกับ host นั้นทันที (E1.5 ข้อ 3)
      subscribeLive: (handlers, options) =>
        base.subscribeLive!(
          {
            ...handlers,
            onEvent: (event) => {
              const candidate = event as { type?: unknown; origin?: unknown };
              if (
                candidate?.type === 'embed.origin.revoked' &&
                typeof candidate.origin === 'string'
              ) {
                lock.revoke(candidate.origin);
              }
              handlers.onEvent(event);
            },
          },
          options,
        ),
    };
  }, [apiBaseUrl, auth, fetchWithToken, lock]);
  const workSession = useMemo(
    () =>
      createWorkSessionApi({
        baseUrl: apiBaseUrl,
        accessToken: () => auth.accessToken(),
        authorizedFetch: fetchWithToken,
        hostOrigin: lock.origin,
      }),
    [apiBaseUrl, auth, fetchWithToken, lock],
  );
  // ยังไม่เคย login = แถบ login (DOM) ทำงานอยู่แล้ว; เคย login แล้วคง dphone ไว้แม้ต้อง login ใหม่ (สายไม่หลุด)
  const [started, setStarted] = useState(status === 'signed-in');
  useEffect(() => {
    if (status === 'signed-in') setStarted(true);
  }, [status]);
  if (!started) return null;
  return (
    <>
      <ClickToCallPrompt runtime={runtime} />
      <WorkspaceApp
        api={api}
        workSession={workSession}
        workSessionSurface="embedded"
        variant="embedded"
        createDphone={createDphone ?? createProductionDphone}
        onCallEvent={(event) => runtime.onCallEvent(event)}
        onLeaseChange={(leaseId) => runtime.setLease(leaseId)}
      />
    </>
  );
}

export function mountEmbeddedApp(root: HTMLElement, props: EmbeddedAppProps) {
  createRoot(root).render(
    <StrictMode>
      <SessionLocaleProvider i18n={appI18n}>
        <EmbeddedApp {...props} />
      </SessionLocaleProvider>
    </StrictMode>,
  );
}
