import { useCallback, useEffect, useRef, useState } from 'react';
import { useShellTokens } from '../shell/tokens.js';
import type { CasesApi } from './api.js';
import { CaseDetailView } from './case-detail.js';
import { CaseList } from './case-list.js';
import { casesHref, parseCasesRoute, type CaseFilterState, type CasesRoute } from './model.js';
import './cases.css';

export interface CasesPageProps {
  api: CasesApi;
  identityKey: string;
  /** the viewer's `dc_user_id` — used only to label "You" and the "(You)" option; permission is decided at the server */
  viewerUserId: string;
  onSignIn?: () => void;
}

/** identity change = start a new session, clearing the list, note drafts and every pending command */
export function CasesPage(props: CasesPageProps) {
  return <CasesSession key={props.identityKey} {...props} />;
}

function CasesSession({ api, viewerUserId, onSignIn }: CasesPageProps) {
  const ready = useShellTokens();
  const [route, setRoute] = useState<CasesRoute>(() =>
    parseCasesRoute(new URL(window.location.href)),
  );
  // opening a detail from the list (pushState) → the browser Back returns to the original filter; a deep link must walk the route itself
  const pushedFromList = useRef(false);
  const lastOpened = useRef<string | undefined>(undefined);

  useEffect(() => {
    const onPop = () => setRoute(parseCasesRoute(new URL(window.location.href)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const routeRef = useRef(route);
  routeRef.current = route;
  const go = useCallback((next: CasesRoute, mode: 'push' | 'replace') => {
    const url = casesHref(new URL(window.location.href), next);
    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    setRoute(next);
  }, []);

  const changeFilter = useCallback(
    (filter: CaseFilterState) => go({ ...filter, caseId: null }, 'replace'),
    [go],
  );

  const openCase = useCallback(
    (caseId: string) => {
      lastOpened.current = caseId;
      pushedFromList.current = true;
      go({ ...routeRef.current, caseId }, 'push');
    },
    [go],
  );

  const backToList = useCallback(() => {
    if (pushedFromList.current) {
      pushedFromList.current = false;
      window.history.back();
      return;
    }
    go({ ...routeRef.current, caseId: null }, 'push');
  }, [go]);

  if (!ready) return null;
  return (
    <main className="cs-root">
      {route.caseId ? (
        <CaseDetailView
          key={route.caseId}
          api={api}
          caseId={route.caseId}
          viewerUserId={viewerUserId}
          onBack={backToList}
          onSignIn={onSignIn}
        />
      ) : (
        <CaseList
          api={api}
          filter={route}
          viewerUserId={viewerUserId}
          focusCaseId={lastOpened.current}
          onFilterChange={changeFilter}
          onOpen={openCase}
          onSignIn={onSignIn}
        />
      )}
    </main>
  );
}
