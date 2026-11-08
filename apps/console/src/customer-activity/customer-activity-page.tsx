import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  Button,
  Cell,
  Column,
  Row,
  Select,
  Table,
  TableBody,
  TableHeader,
  TextField,
} from '@d-contact/ui-react';
import { CustomersApiError } from '../customers/api.js';
import { Skeleton } from '../customers/skeleton.js';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import {
  ACTIVITY_TYPES,
  type ActivityFilter,
  type ActivityPage,
  type ActivityQuery,
  type CustomerActivityApi,
} from './api.js';
import '../customers/customers.css';
import './customer-activity.css';

type Props = {
  api: CustomerActivityApi;
  identityKey: string;
  signedIn: boolean;
  onSignIn(): void;
  shell: Omit<ConsoleShellProps, 'appId' | 'children'>;
};
type State =
  | { kind: 'loading' }
  | { kind: 'ready'; page: ActivityPage }
  | { kind: 'error'; error: 'session' | 'access' | 'unavailable' | 'restart' | 'invalidWindow' };
const DEFAULT_QUERY: ActivityQuery = { type: 'ALL' };

export function CustomerActivityPage(props: Props) {
  return (
    <ConsoleShell {...props.shell} appId="customer-activity">
      <ActivitySession key={props.identityKey} {...props} />
    </ConsoleShell>
  );
}

function errorKey(error: unknown): Extract<State, { kind: 'error' }>['error'] {
  if (!(error instanceof CustomersApiError)) return 'unavailable';
  if (error.status === 401) return 'session';
  if (error.status === 403 || error.status === 404) return 'access';
  if (['CURSOR_EXPIRED', 'CURSOR_CONTEXT_CHANGED', 'INVALID_CURSOR'].includes(error.code))
    return 'restart';
  return error.status === 400 ? 'invalidWindow' : 'unavailable';
}

function ActivitySession({ api, signedIn, onSignIn }: Props) {
  const { t } = useTranslation('customerActivity');
  const [type, setType] = useState<ActivityFilter>('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState<ActivityQuery>(DEFAULT_QUERY);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ api: CustomerActivityApi; value: State }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const current = signedIn && state?.api === api ? state.value : ({ kind: 'loading' } as const);

  function abort() {
    request.current?.abort();
    request.current = undefined;
  }
  function fetchPage(target: ActivityQuery, prior?: ActivityPage) {
    abort();
    const controller = new AbortController();
    request.current = controller;
    setLoadingMore(Boolean(prior));
    if (!prior) setState({ api, value: { kind: 'loading' } });
    void api(target, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        if (prior) {
          const ids = new Set(prior.items.map((item) => item.id));
          page = {
            ...page,
            items: [...prior.items, ...page.items.filter((item) => !ids.has(item.id))],
          };
        }
        setState({ api, value: { kind: 'ready', page } });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ api, value: { kind: 'error', error: errorKey(error) } });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMore(false);
      });
  }
  useEffect(() => {
    if (signedIn) fetchPage(query);
    else {
      setState(undefined);
      setLoadingMore(false);
    }
    return abort;
  }, [api, signedIn, query, version]);

  function apply() {
    abort();
    const start = from ? new Date(from) : undefined;
    const end = to ? new Date(to) : undefined;
    if (
      Boolean(start) !== Boolean(end) ||
      (start && end && (!Number.isFinite(+start) || !Number.isFinite(+end) || +start >= +end))
    ) {
      setLoadingMore(false);
      setState({ api, value: { kind: 'error', error: 'invalidWindow' } });
      return;
    }
    setState({ api, value: { kind: 'loading' } });
    setQuery({
      type,
      ...(start && end ? { from: start.toISOString(), to: end.toISOString() } : {}),
    });
  }
  function refresh() {
    abort();
    setState({ api, value: { kind: 'loading' } });
    setVersion((value) => value + 1);
  }
  function renderError(key: Extract<State, { kind: 'error' }>['error']) {
    return (
      <div role="alert">
        <p>{t(key)}</p>
        {key === 'session' ? (
          <Button onPress={onSignIn}>{t('signIn')}</Button>
        ) : key === 'access' || key === 'invalidWindow' ? null : (
          <Button onPress={refresh}>{t(key === 'restart' ? 'firstPage' : 'retry')}</Button>
        )}
      </div>
    );
  }
  const labels = (fields: string[]) =>
    fields.map((field) => t(`fields.${field}` as 'fields.name')).join(', ');
  const operation = (name: ActivityFilter) => t(`operations.${name}`);
  return (
    <main className="cu-root ca-root">
      <h1>{t('title')}</h1>
      <p className="cu-muted">{t('description')}</p>
      {!signedIn || (current.kind === 'error' && ['access', 'session'].includes(current.error)) ? (
        renderError(signedIn && current.kind === 'error' ? current.error : 'session')
      ) : (
        <>
          <form
            className="cu-search"
            aria-label={t('filters')}
            onSubmit={(event) => {
              event.preventDefault();
              apply();
            }}
          >
            <Select
              label={t('operation')}
              selectedKey={type}
              options={ACTIVITY_TYPES.map((id) => ({ id, label: operation(id) }))}
              onSelectionChange={(key) => {
                if (ACTIVITY_TYPES.includes(key as ActivityFilter)) setType(key as ActivityFilter);
              }}
            />
            <TextField type="datetime-local" label={t('from')} value={from} onChange={setFrom} />
            <TextField type="datetime-local" label={t('to')} value={to} onChange={setTo} />
            <Button type="submit" variant="primary">
              {t('apply')}
            </Button>
          </form>
          {current.kind === 'loading' ? (
            <Skeleton label={t('loading')} rows={5} />
          ) : current.kind === 'error' ? (
            renderError(current.error)
          ) : (
            <section className="cu-section" aria-label={t('results')}>
              <p role="status" className="cu-notice">
                {t(`coverage.${current.page.coverage.status}`)}
              </p>
              <p className="cu-muted">
                {t('asOf')}: <time dateTime={current.page.asOf}>{current.page.asOf}</time>
              </p>
              {current.page.coverage.status === 'PARTIAL' ? (
                <ul className="ca-coverage" aria-label={t('coverageGaps')}>
                  {current.page.coverage.gaps.map((gap, index) => (
                    <li key={index}>
                      {gap.from} – {gap.to} · {gap.types.map(operation).join(', ')}
                    </li>
                  ))}
                </ul>
              ) : null}
              {current.page.items.length ? (
                <div
                  className="ca-table-wrap"
                  role="region"
                  aria-label={t('tableRegion')}
                  tabIndex={0}
                >
                  <Table aria-label={t('title')} className="ca-table">
                    <TableHeader>
                      <Column isRowHeader>{t('occurredAt')}</Column>
                      <Column>{t('operation')}</Column>
                      <Column>{t('actor')}</Column>
                      <Column>{t('resource')}</Column>
                      <Column>{t('changedFields')}</Column>
                    </TableHeader>
                    <TableBody items={current.page.items}>
                      {(item) => (
                        <Row id={item.id}>
                          <Cell>
                            <time dateTime={item.occurredAt}>{item.occurredAt}</time>
                          </Cell>
                          <Cell>{operation(item.operation)}</Cell>
                          <Cell>{item.actorDisplay ?? t('unknownActor')}</Cell>
                          <Cell>
                            {t(`resources.${item.resourceType}`)}{' '}
                            <bdi className="ca-ref">{item.resourceRef}</bdi>
                          </Cell>
                          <Cell>{labels(item.changedFields) || '—'}</Cell>
                        </Row>
                      )}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p>{t(current.page.coverage.status === 'KNOWN' ? 'empty' : 'emptyUnconfirmed')}</p>
              )}
              <div className="cu-actions">
                <Button onPress={refresh}>{t('refresh')}</Button>
                {current.page.nextCursor ? (
                  <Button
                    isDisabled={loadingMore}
                    onPress={() =>
                      fetchPage({ ...query, cursor: current.page.nextCursor! }, current.page)
                    }
                  >
                    {t(loadingMore ? 'loading' : 'more')}
                  </Button>
                ) : null}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
