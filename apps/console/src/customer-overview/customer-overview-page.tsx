import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { CustomersApiError } from '../customers/api.js';
import { Skeleton } from '../customers/skeleton.js';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import type { CustomerOverviewApi, CustomerOverview, TagOverview, FieldRules } from './api.js';
import '../customers/customers.css';
import './customer-overview.css';
type Props = {
  api: CustomerOverviewApi;
  identityKey: string;
  signedIn: boolean;
  onSignIn(): void;
  mode: 'overview' | 'rules';
  shell: Omit<ConsoleShellProps, 'appId' | 'children'>;
};
type Result<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'failed' };
export function CustomerOverviewPage(props: Props) {
  return (
    <ConsoleShell
      {...props.shell}
      appId={props.mode === 'rules' ? 'customer-rules' : 'customer-overview'}
    >
      <OverviewSession key={props.identityKey} {...props} />
    </ConsoleShell>
  );
}
function OverviewSession({ api, signedIn, onSignIn, mode }: Props) {
  const { t: translate } = useTranslation('customerOverview');
  const t = translate as (key: string) => string;
  const [customers, setCustomers] = useState<Result<CustomerOverview>>({ state: 'loading' });
  const [tags, setTags] = useState<Result<TagOverview>>({ state: 'loading' });
  const [rules, setRules] = useState<Result<FieldRules>>({ state: 'loading' });
  const [blocked, setBlocked] = useState<false | 'session' | 'access'>(false);
  const [refresh, setRefresh] = useState({ customers: 0, tags: 0, rules: 0 });
  const generation = useRef(0);
  const priorContext = useRef({ api, signedIn });
  if (priorContext.current.api !== api || priorContext.current.signedIn !== signedIn) {
    priorContext.current = { api, signedIn };
    generation.current += 1;
    setCustomers({ state: 'loading' });
    setTags({ state: 'loading' });
    setRules({ state: 'loading' });
    setBlocked(false);
  }

  useEffect(() => {
    generation.current += 1;
    setBlocked(false);
    return () => {
      generation.current += 1;
    };
  }, [api, signedIn]);
  const deny = (error: unknown) => {
    if (!(error instanceof CustomersApiError) || ![401, 403, 404].includes(error.status)) return;
    generation.current += 1;
    setBlocked(error.status === 401 ? 'session' : 'access');
    setCustomers({ state: 'failed' });
    setTags({ state: 'failed' });
    setRules({ state: 'failed' });
  };
  useEffect(() => {
    if (!signedIn || blocked || mode !== 'overview') return;
    const current = generation.current;
    const abort = new AbortController();
    setCustomers({ state: 'loading' });
    void api
      .customers(abort.signal)
      .then((data) => {
        if (!abort.signal.aborted && current === generation.current)
          setCustomers({ state: 'ready', data });
      })
      .catch((error) => {
        if (!abort.signal.aborted && current === generation.current) {
          setCustomers({ state: 'failed' });
          deny(error);
        }
      });
    return () => abort.abort();
  }, [api, signedIn, blocked, mode, refresh.customers]);
  useEffect(() => {
    if (!signedIn || blocked || mode !== 'overview') return;
    const current = generation.current;
    const abort = new AbortController();
    setTags({ state: 'loading' });
    void api
      .tags(abort.signal)
      .then((data) => {
        if (!abort.signal.aborted && current === generation.current)
          setTags({ state: 'ready', data });
      })
      .catch((error) => {
        if (!abort.signal.aborted && current === generation.current) {
          setTags({ state: 'failed' });
          deny(error);
        }
      });
    return () => abort.abort();
  }, [api, signedIn, blocked, mode, refresh.tags]);
  useEffect(() => {
    if (!signedIn || blocked || mode !== 'rules') return;
    const current = generation.current;
    const abort = new AbortController();
    setRules({ state: 'loading' });
    void api
      .rules(abort.signal)
      .then((data) => {
        if (!abort.signal.aborted && current === generation.current)
          setRules({ state: 'ready', data });
      })
      .catch((error) => {
        if (!abort.signal.aborted && current === generation.current) {
          setRules({ state: 'failed' });
          deny(error);
        }
      });
    return () => abort.abort();
  }, [api, signedIn, blocked, mode, refresh.rules]);
  const reload = (key: keyof typeof refresh) =>
    setRefresh((previous) => ({ ...previous, [key]: previous[key] + 1 }));
  const state = <T extends { asOf: string }>(
    key: keyof typeof refresh,
    result: Result<T>,
    render: (data: T) => React.ReactNode,
  ) => (
    <section className="cu-card" aria-label={t(key)}>
      <h2>{t(key)}</h2>
      {result.state === 'loading' ? (
        <div role="status">
          <Skeleton label={t('loading')} rows={2} />
          <span>{t('loading')}</span>
        </div>
      ) : result.state === 'failed' ? (
        <div role="alert">
          <p>{t('unavailable')}</p>
          <Button onPress={() => reload(key)}>{t('retry')}</Button>
        </div>
      ) : (
        <>
          {render(result.data)}
          <p className="cu-muted">
            {t('asOf')}: <time dateTime={result.data.asOf}>{result.data.asOf}</time>
          </p>
          <Button onPress={() => reload(key)}>{t('refresh')}</Button>
        </>
      )}
    </section>
  );
  return (
    <main className="cu-root cu-overview">
      <h1>{t(mode === 'rules' ? 'rules' : 'title')}</h1>
      {!signedIn || blocked ? (
        <div role="alert">
          <p>{t(!signedIn || blocked === 'session' ? 'session' : 'access')}</p>
          {!signedIn || blocked === 'session' ? (
            <Button onPress={onSignIn}>{t('signIn')}</Button>
          ) : null}
        </div>
      ) : mode === 'overview' ? (
        <>
          {state('customers', customers, (data) => (
            <p>
              {data.count === '0' ? (
                t('emptyCustomers')
              ) : (
                <>
                  {t('count')}: <strong>{data.count}</strong>
                </>
              )}
            </p>
          ))}
          {state('tags', tags, (data) => (
            <>
              <p>
                {t('active')}: <strong>{data.activeCount}</strong>
              </p>
              <p>
                {t('retired')}: <strong>{data.retiredCount}</strong>
              </p>
              {data.activeCount === '0' && data.retiredCount === '0' ? (
                <p>{t('emptyTags')}</p>
              ) : null}
            </>
          ))}
        </>
      ) : (
        state('rules', rules, (data) => (
          <>
            <p>
              {t('version')}: <bdi>{data.version}</bdi>
            </p>
            <dl>
              {data.fields.map((field) => (
                <div key={field.name}>
                  <dt>{t(`fields.${field.name}`)}</dt>
                  <dd>
                    <p>
                      {t('type')}: {field.type}; {t(field.required ? 'required' : 'optional')}
                    </p>
                    <p>
                      {t('constraints')}:{' '}
                      {field.constraints === null ? t('absent') : JSON.stringify(field.constraints)}
                    </p>
                    <p>
                      {t('normalization')}: {field.normalization ?? t('absent')}
                    </p>
                    <p>
                      {t('version')}: {field.normalizationVersion ?? t('absent')}
                    </p>
                  </dd>
                </div>
              ))}
            </dl>
          </>
        ))
      )}
    </main>
  );
}
