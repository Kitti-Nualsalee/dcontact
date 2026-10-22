import { useEffect, useState } from 'react';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import { VoiceRouting } from './voice-routing.js';
import { ConfigPanel } from './config-panel.js';
import { useShellPageNav } from '@d-contact/ui-react';
import { useTranslation } from '@d-contact/i18n/react';
import type { CatalogApi, CatalogKind } from './api.js';

type ShellProps = Omit<ConsoleShellProps, 'appId' | 'pageId' | 'onPageSelect' | 'children'>;
type Page = CatalogKind | 'destinations' | 'agent-skills';
const currentKind = (): Page => {
  const section = new URL(window.location.href).searchParams.get('section');
  return section === 'skills' || section === 'destinations' || section === 'agent-skills'
    ? section
    : 'queues';
};

/** ADR-034: หน้าถือ section ให้เมนู shell และ fallback ใช้สถานะเดียวกัน */
export function VoiceRoutingPage({
  shell,
  api,
  identityKey,
  onSignIn,
}: {
  shell: ShellProps;
  api: CatalogApi;
  identityKey: string;
  onSignIn?: () => void;
}) {
  const [kind, setKind] = useState(currentKind);
  useEffect(() => {
    const onPop = () => setKind(currentKind());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  function go(next: Page) {
    if (next === kind) return;
    const url = new URL(window.location.href);
    url.searchParams.set('section', next);
    url.searchParams.delete('resource');
    window.history.pushState(null, '', url);
    setKind(next);
    requestAnimationFrame(() => document.getElementById('voice-catalog-title')?.focus());
  }
  return (
    <ConsoleShell
      {...shell}
      appId="voice-routing"
      pageId={kind}
      onPageSelect={(pageId) => {
        if (
          pageId === 'queues' ||
          pageId === 'skills' ||
          pageId === 'destinations' ||
          pageId === 'agent-skills'
        )
          go(pageId);
      }}
    >
      <RoutingContent kind={kind} api={api} identityKey={identityKey} onSignIn={onSignIn} go={go} />
    </ConsoleShell>
  );
}
function RoutingContent({
  kind,
  api,
  identityKey,
  onSignIn,
  go,
}: {
  kind: Page;
  api: CatalogApi;
  identityKey: string;
  onSignIn?: () => void;
  go: (page: Page) => void;
}) {
  const inShell = useShellPageNav();
  const { t } = useTranslation('voiceRouting');
  return (
    <>
      {!inShell ? (
        <nav aria-label={t('catalog')}>
          {(['queues', 'skills', 'destinations', 'agent-skills'] as const).map((page) => (
            <button
              key={page}
              type="button"
              aria-current={kind === page ? 'page' : undefined}
              onClick={() => go(page)}
            >
              {page === 'agent-skills'
                ? t('config.agentSkills')
                : page === 'destinations'
                  ? t('config.destinations')
                  : t(page)}
            </button>
          ))}
        </nav>
      ) : null}
      {kind === 'destinations' || kind === 'agent-skills' ? (
        api.config ? (
          <ConfigPanel
            api={api.config}
            identityKey={identityKey}
            mode={kind === 'destinations' ? 'destinations' : 'agentSkills'}
          />
        ) : null
      ) : (
        <VoiceRouting
          suppressFallbackNav
          api={api}
          identityKey={identityKey}
          kind={kind}
          onKindSelect={go}
          onSignIn={onSignIn}
        />
      )}
    </>
  );
}
