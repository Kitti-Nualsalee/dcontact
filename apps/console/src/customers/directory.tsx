import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  Badge,
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
import {
  CustomersApiError,
  type CustomerListItem,
  type CustomerSearchPage,
  type CustomersApi,
  type SearchType,
} from './api.js';
import { closesCustomerData, errorKind, fieldErrorKey, type ErrorKind } from './model.js';
import { Skeleton } from './skeleton.js';

interface Props {
  api: CustomersApi;
  onOpen(contactId: string): void;
  onSignIn?: () => void;
  /** coming back from a profile: move focus to the heading so keyboard users are not lost mid-page */
  focusHeading?: boolean;
}

type Applied = { type: SearchType; query: string };
type View =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; kind: ErrorKind; retryAfter?: number };

const SEARCH_TYPES = ['NAME', 'PHONE', 'EMAIL'] as const;
const DIRECTORY_SEARCH: Applied = { type: 'DIRECTORY', query: '' };

/** list + customer search (Console A): all results come from the server per permission; no query in the URL */
export function CustomerDirectory({ api, onOpen, onSignIn, focusHeading }: Props) {
  const { t: translate } = useTranslation('customers');
  const t = translate as (key: string, options?: Record<string, unknown>) => string;
  const [type, setType] = useState<(typeof SEARCH_TYPES)[number]>('NAME');
  const [query, setQuery] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  // applied = the latest request; shown = the set the on-screen results really belong to (after a validation failure the old results still belong to shown)
  const [applied, setApplied] = useState<Applied>(DIRECTORY_SEARCH);
  const [shown, setShown] = useState<Applied>(DIRECTORY_SEARCH);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusId, setFocusId] = useState<string>();
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const pendingResultsFocus = useRef(false);
  const [items, setItems] = useState<CustomerListItem[]>([]);
  const [page, setPage] = useState<Pick<CustomerSearchPage, 'scope' | 'accessibleCount'>>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [view, setView] = useState<View>({ state: 'loading' });
  const [more, setMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const searchPaused = useRef(false);

  // close all PII when permission/session changes (do not keep old results in state)
  const closeData = useCallback(() => {
    setItems([]);
    setCursor(null);
    setPage(undefined);
  }, []);

  const closeSearchContext = useCallback(() => {
    searchPaused.current = true;
    setQuery('');
    setFieldError(undefined);
    setApplied(DIRECTORY_SEARCH);
    setShown(DIRECTORY_SEARCH);
  }, []);

  useEffect(() => {
    if (searchPaused.current) return;
    const mine = ++sequence.current;
    const controller = new AbortController();
    setView({ state: 'loading' });
    setMore(false);
    void api
      .search({
        type: applied.type,
        ...(applied.type === 'DIRECTORY' ? {} : { query: applied.query }),
        signal: controller.signal,
      })
      .then((result) => {
        if (mine !== sequence.current) return;
        setItems(result.items);
        setCursor(result.nextCursor);
        setPage({ scope: result.scope, accessibleCount: result.accessibleCount });
        setShown(applied);
        setFieldError(undefined);
        setView({ state: 'ready' });
      })
      .catch((failure: unknown) => {
        if (
          mine !== sequence.current ||
          (failure instanceof DOMException && failure.name === 'AbortError')
        )
          return;
        const kind = errorKind(failure);
        const key = fieldErrorKey(failure);
        if (key) {
          // validation: keep the old results and report under the field, do not switch to an error page
          setFieldError(key);
          setView({ state: 'ready' });
          return;
        }
        closeData();
        if (closesCustomerData(kind)) closeSearchContext();
        setView({
          state: 'error',
          kind,
          retryAfter: failure instanceof CustomersApiError ? failure.retryAfterSeconds : undefined,
        });
      });
    return () => controller.abort();
  }, [api, applied, revision, closeData, closeSearchContext]);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== 'visible' || searchPaused.current) return;
      sequence.current += 1;
      closeData();
      setView({ state: 'loading' });
      setRevision((current) => current + 1);
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [closeData]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setFieldError(undefined);
    if (query.trim().length === 0) {
      setFieldError('QUERY_REQUIRED');
      return;
    }
    searchPaused.current = false;
    setApplied({ type, query });
  }

  function clear() {
    searchPaused.current = false;
    setQuery('');
    setFieldError(undefined);
    setApplied({ type: 'DIRECTORY', query: '' });
  }

  function loadMore() {
    if (!cursor || more) return;
    const mine = sequence.current;
    setMore(true);
    api
      .search({
        type: shown.type,
        ...(shown.type === 'DIRECTORY' ? {} : { query: shown.query }),
        cursor,
      })
      .then((result) => {
        if (mine !== sequence.current) return;
        const fresh = result.items.filter(
          (item) => !items.some((c) => c.contactId === item.contactId),
        );
        setFocusId(fresh[0]?.contactId);
        setItems((current) => [
          ...current,
          ...result.items.filter((item) => !current.some((c) => c.contactId === item.contactId)),
        ]);
        setCursor(result.nextCursor);
        setPage({ scope: result.scope, accessibleCount: page?.accessibleCount });
      })
      .catch((failure: unknown) => {
        if (mine !== sequence.current) return;
        closeData();
        const kind = errorKind(failure);
        if (closesCustomerData(kind)) closeSearchContext();
        setView({ state: 'error', kind });
      })
      .finally(() => setMore(false));
  }

  const kind = view.state === 'error' ? view.kind : undefined;
  const name = (item: CustomerListItem) => item.displayName?.trim() || t('list.noName');
  const queryLabel = t(`search.query.${type}`);
  const incomplete = page?.scope.state === 'INCOMPLETE';
  // heading follows the latest request as soon as a search is sent (while loading use applied; once results arrive use shown, which matches the on-screen results)
  const searching = (view.state === 'loading' ? applied : shown).type !== 'DIRECTORY';

  useEffect(() => {
    if (focusHeading) headingRef.current?.focus();
  }, [focusHeading]);
  // after load-more, focus the first added item so keyboard users can keep reading immediately
  // new Table rows (react-aria) render after the state change — wait until the real element is found, then focus and clear the id
  useEffect(() => {
    if (!focusId) return;
    let frame = 0;
    let tries = 0;
    const tick = () => {
      const target = document.querySelector<HTMLElement>(`[data-cu-open="${focusId}"]`);
      if (target) {
        target.focus();
        setFocusId(undefined);
      } else if (tries++ < 60) frame = requestAnimationFrame(tick);
      else setFocusId(undefined);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [focusId]);
  // retry/error: move focus to the results heading or the new state's text so it does not fall to BODY
  useEffect(() => {
    if (pendingResultsFocus.current && view.state === 'ready') {
      pendingResultsFocus.current = false;
      resultsRef.current?.focus();
    }
    if (view.state === 'error') alertRef.current?.focus();
  }, [view]);

  return (
    <section aria-labelledby="customers-search-title" className="cu-section">
      <h2 id="customers-search-title" ref={headingRef} tabIndex={-1}>
        {t('search.title')}
      </h2>
      <form className="cu-search" onSubmit={submit} noValidate>
        <Select
          label={t('search.type')}
          options={SEARCH_TYPES.map((value) => ({ id: value, label: t(`search.types.${value}`) }))}
          selectedKey={type}
          onSelectionChange={(key) => {
            setType(key as (typeof SEARCH_TYPES)[number]);
            // a query of the old type cannot be used with the new type (e.g. name → phone), so clear it together with the old error
            setQuery('');
            setFieldError(undefined);
          }}
        />
        <TextField
          label={queryLabel}
          value={query}
          onChange={(value) => {
            setQuery(value);
            setFieldError(undefined);
          }}
          description={t(`search.hints.${type}`)}
          isInvalid={fieldError !== undefined}
          errorMessage={fieldError ? t(`search.errors.${fieldError}`) : undefined}
          validationBehavior="aria"
          autoComplete="off"
          inputMode={type === 'PHONE' ? 'tel' : type === 'EMAIL' ? 'email' : 'text'}
        />
        <div className="cu-actions">
          <Button type="submit" variant="primary" isDisabled={view.state === 'loading'}>
            {t('search.submit')}
          </Button>
          <Button onPress={clear} isDisabled={applied.type === 'DIRECTORY' && query === ''}>
            {t('search.clear')}
          </Button>
        </div>
      </form>

      <h2 ref={resultsRef} tabIndex={-1}>
        {searching ? t('list.resultsTitle') : t('list.title')}
      </h2>
      {view.state === 'loading' ? <Skeleton label={t('loading')} rows={6} /> : null}
      {kind ? (
        <div role="alert" className="cu-alert" ref={alertRef} tabIndex={-1}>
          <p>
            {kind === 'session'
              ? t('errors.unauthorized')
              : kind === 'forbidden'
                ? t('errors.forbidden')
                : kind === 'scope'
                  ? t('errors.scope')
                  : kind === 'rateLimited'
                    ? view.state === 'error' && view.retryAfter
                      ? t('errors.rateLimited', { seconds: view.retryAfter })
                      : t('errors.rateLimitedNow')
                    : kind === 'cursor'
                      ? t('errors.cursor')
                      : t('errors.failed')}
          </p>
          {kind === 'session' ? (
            onSignIn ? (
              <Button onPress={onSignIn}>{t('signIn')}</Button>
            ) : null
          ) : (
            <Button
              onPress={() => {
                searchPaused.current = false;
                setApplied((current) =>
                  kind === 'cursor' ? { type: 'DIRECTORY', query: '' } : { ...current },
                );
                setRevision((value) => value + 1);
              }}
            >
              {t('retry')}
            </Button>
          )}
        </div>
      ) : null}

      {view.state === 'ready' && page ? (
        <>
          {!searching && page.accessibleCount ? (
            <p className="cu-muted">
              {page.accessibleCount.state === 'AVAILABLE'
                ? t('list.count', { count: page.accessibleCount.value })
                : t('list.countUnavailable')}
            </p>
          ) : null}
          {incomplete ? (
            <div role="status" className="cu-notice">
              <p>{t('list.incomplete')}</p>
              <Button
                onPress={() => {
                  pendingResultsFocus.current = true;
                  setRevision((value) => value + 1);
                }}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          {items.length === 0 && !incomplete ? (
            <p role={searching ? 'status' : undefined}>
              {searching ? t('list.emptySearch') : t('list.empty')}
            </p>
          ) : null}
          {items.length > 0 ? (
            <Table
              aria-label={t('list.label')}
              className="cu-table"
              onRowAction={(key) => onOpen(String(key))}
            >
              <TableHeader>
                <Column isRowHeader>{t('list.columns.name')}</Column>
                <Column>{t('list.columns.company')}</Column>
                <Column>{t('list.columns.status')}</Column>
                <Column>{t('list.columns.match')}</Column>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <Row key={item.contactId} id={item.contactId}>
                    <Cell>
                      <Button
                        variant="ghost"
                        className="cu-name"
                        data-cu-open={item.contactId}
                        aria-label={t('list.openItem', { name: name(item) })}
                        onPress={() => onOpen(item.contactId)}
                      >
                        {name(item)}
                      </Button>
                    </Cell>
                    <Cell>
                      <span className="cu-wrap">{item.company?.trim() || t('list.noCompany')}</span>
                    </Cell>
                    <Cell>
                      <span className="cu-badges">
                        {item.vip ? <Badge tone="attention">{t('badges.vip')}</Badge> : null}
                        {item.identity === 'AMBIGUOUS' ? (
                          <Badge tone="critical">{t('badges.review')}</Badge>
                        ) : item.identity === 'LEGACY_MISSING_HEAD' ? (
                          <Badge tone="neutral">{t('badges.legacy')}</Badge>
                        ) : (
                          <Badge tone="neutral">{t('badges.active')}</Badge>
                        )}
                      </span>
                    </Cell>
                    <Cell>{item.matchedChannel?.masked ?? '—'}</Cell>
                  </Row>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {cursor ? (
            <div className="cu-more">
              <Button isDisabled={more} onPress={loadMore}>
                {more ? t('loading') : t('list.more')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
