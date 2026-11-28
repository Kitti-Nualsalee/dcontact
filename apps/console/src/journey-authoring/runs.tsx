/**
 * #1067 — what a journey did at runtime: one row per enrollment with the outcome that triggered it and the
 * owner action it asked for. The server filters by `journey.read`; the linked case opens under the viewer's own
 * case permission (a viewer outside the case's team gets "not found" on the case page).
 */
import { useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { casesHref } from '../cases/model.js';
import { useConsoleNavigation } from '../shell/console-navigation.js';
import { JourneyAuthoringApiError, type JourneyAuthoringApi, type JourneyRun } from './api.js';
import { errorMessage } from './model.js';
import { runResult } from './run-result.js';
import { serverTime } from './server-time.js';

const codeOf = (error: unknown) =>
  error instanceof JourneyAuthoringApiError ? error.code : undefined;

function CaseLink({ caseId }: { caseId: string }) {
  const { t } = useTranslation('journeys');
  const navigate = useConsoleNavigation();
  // start from the bare page so no journey parameter leaks into the cases view; keep the tenant alias
  const current = new URL(window.location.href);
  const base = new URL(current.origin + current.pathname);
  const tenant = current.searchParams.get('tenant');
  if (tenant) base.searchParams.set('tenant', tenant);
  const href = casesHref(base, { status: 'NOT_CLOSED', assignee: 'team', caseId });
  const relative = href.pathname + href.search;
  return (
    <a
      className="j5-link"
      href={relative}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (navigate?.(relative)) event.preventDefault();
      }}
    >
      {t('runs.openCase')}
    </a>
  );
}

export function RunResults({ api, journeyId }: { api: JourneyAuthoringApi; journeyId: string }) {
  const { t } = useTranslation('journeys');
  const { formatters } = useLocale();
  const [items, setItems] = useState<JourneyRun[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string } | null>(null);
  const load = async (after?: string) => {
    setBusy(true);
    setError(null);
    try {
      const page = await api.runs(journeyId, after ? { cursor: after } : {});
      setItems((current) => (after ? [...(current ?? []), ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (failure) {
      setError({ code: codeOf(failure) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="j5-panel" aria-labelledby="j5-runs-heading">
      <h2 id="j5-runs-heading">{t('runs.heading')}</h2>
      <p className="j5-help">{t('runs.help')}</p>
      <Button isDisabled={busy} onPress={() => void load()}>
        {items === null ? t('runs.show') : t('runs.reload')}
      </Button>
      {error ? (
        <p className="j5-status-error" role="alert">
          {errorMessage(error.code)}
        </p>
      ) : null}
      {items?.length === 0 ? <p role="status">{t('runs.empty')}</p> : null}
      {items && items.length > 0 ? (
        <div className="j5-table-scroll">
          <table className="j5-table">
            <caption className="j5-sr">{t('runs.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('runs.col.startedAt')}</th>
                <th scope="col">{t('runs.col.trigger')}</th>
                <th scope="col">{t('runs.col.version')}</th>
                <th scope="col">{t('runs.col.action')}</th>
                <th scope="col">{t('runs.col.result')}</th>
                <th scope="col">{t('runs.col.link')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((run) => {
                const action = run.actions.at(-1);
                const result = runResult(run);
                return (
                  <tr key={run.enrollmentId}>
                    <td>
                      <time dateTime={run.startedAt}>{serverTime(formatters, run.startedAt)}</time>
                    </td>
                    <td>
                      {run.trigger?.outcomeCode ?? run.trigger?.outcomeType ?? t('common.none')}
                      {run.trigger?.interactionId ? (
                        <>
                          {' '}
                          <code title={run.trigger.interactionId}>
                            {run.trigger.interactionId.slice(0, 8)}
                          </code>
                        </>
                      ) : null}
                    </td>
                    <td>{run.journeyVersion}</td>
                    <td>{action ? action.kind : t('common.none')}</td>
                    <td
                      title={[run.state, run.runState, action?.state].filter(Boolean).join(' · ')}
                    >
                      {t(`runs.result.${result}`)}
                    </td>
                    <td>
                      {action?.kind === 'ENSURE_CASE' && action.ownerAggregateId ? (
                        <CaseLink caseId={action.ownerAggregateId} />
                      ) : (
                        t('common.none')
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {cursor ? (
        <Button isDisabled={busy} onPress={() => void load(cursor)}>
          {t('common.loadMore')}
        </Button>
      ) : null}
    </section>
  );
}
