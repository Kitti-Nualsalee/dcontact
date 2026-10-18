import { useEffect, useState } from 'react';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import { VoiceRouting } from './voice-routing.js';
import type { CatalogApi, CatalogKind } from './api.js';

type ShellProps = Omit<ConsoleShellProps, 'appId' | 'pageId' | 'onPageSelect' | 'children'>;
const currentKind = (): CatalogKind =>
  new URL(window.location.href).searchParams.get('section') === 'skills' ? 'skills' : 'queues';

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
  function go(next: CatalogKind) {
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
        if (pageId === 'queues' || pageId === 'skills') go(pageId);
      }}
    >
      <VoiceRouting
        api={api}
        identityKey={identityKey}
        kind={kind}
        onKindSelect={go}
        onSignIn={onSignIn}
      />
    </ConsoleShell>
  );
}
