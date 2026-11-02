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
import { errorKind, fieldErrorKey, type ErrorKind } from './model.js';

interface Props {
  api: CustomersApi;
  onOpen(contactId: string): void;
  onSignIn?: () => void;
}

type Applied = { type: SearchType; query: string };
type View =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; kind: ErrorKind; retryAfter?: number };

const SEARCH_TYPES = ['NAME', 'PHONE', 'EMAIL'] as const;

/** รายการ + ค้นหาลูกค้า (Console A): ผลทั้งหมดมาจาก server ตามสิทธิ์; ไม่มี query ใน URL */
export function CustomerDirectory({ api, onOpen, onSignIn }: Props) {
  const { t: translate } = useTranslation('customers');
  const t = translate as (key: string, options?: Record<string, unknown>) => string;
  const [type, setType] = useState<(typeof SEARCH_TYPES)[number]>('NAME');
  const [query, setQuery] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [applied, setApplied] = useState<Applied>({ type: 'DIRECTORY', query: '' });
  const [items, setItems] = useState<CustomerListItem[]>([]);
  const [page, setPage] = useState<Pick<CustomerSearchPage, 'scope' | 'accessibleCount'>>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [view, setView] = useState<View>({ state: 'loading' });
  const [more, setMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);

  // ปิด PII ทั้งหมดเมื่อสิทธิ์/session เปลี่ยน (ไม่เก็บผลเก่าไว้ใน state)
  const closeData = useCallback(() => {
    setItems([]);
    setCursor(null);
    setPage(undefined);
  }, []);

  useEffect(() => {
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
          // validation: คงผลเดิมไว้ และแจ้งใต้ช่อง ไม่เปลี่ยนเป็นหน้า error
          setFieldError(key);
          setView({ state: 'ready' });
          return;
        }
        closeData();
        setView({
          state: 'error',
          kind,
          retryAfter: failure instanceof CustomersApiError ? failure.retryAfterSeconds : undefined,
        });
      });
    return () => controller.abort();
  }, [api, applied, revision, closeData]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setFieldError(undefined);
    if (query.trim().length === 0) {
      setFieldError('QUERY_REQUIRED');
      return;
    }
    setApplied({ type, query });
  }

  function clear() {
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
        type: applied.type,
        ...(applied.type === 'DIRECTORY' ? {} : { query: applied.query }),
        cursor,
      })
      .then((result) => {
        if (mine !== sequence.current) return;
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
        setView({ state: 'error', kind: errorKind(failure) });
      })
      .finally(() => setMore(false));
  }

  const kind = view.state === 'error' ? view.kind : undefined;
  const name = (item: CustomerListItem) => item.displayName?.trim() || t('list.noName');
  const queryLabel = t(`search.query.${type}`);
  const incomplete = page?.scope.state === 'INCOMPLETE';

  return (
    <section aria-labelledby="customers-search-title" className="cu-section">
      <h2 id="customers-search-title">{t('search.title')}</h2>
      <form className="cu-search" onSubmit={submit} noValidate>
        <Select
          label={t('search.type')}
          options={SEARCH_TYPES.map((value) => ({ id: value, label: t(`search.types.${value}`) }))}
          selectedKey={type}
          onSelectionChange={(key) => {
            setType(key as (typeof SEARCH_TYPES)[number]);
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

      <h2>{t('list.title')}</h2>
      {view.state === 'loading' ? (
        <p role="status" aria-busy="true" className="cu-skeleton">
          {t('loading')}
        </p>
      ) : null}
      {kind ? (
        <div role="alert" className="cu-alert">
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
          {applied.type === 'DIRECTORY' && page.accessibleCount ? (
            <p className="cu-muted">
              {page.accessibleCount.state === 'AVAILABLE'
                ? t('list.count', { count: page.accessibleCount.value })
                : t('list.countUnavailable')}
            </p>
          ) : null}
          {incomplete ? (
            <p role="status" className="cu-notice">
              {t('list.incomplete')}
            </p>
          ) : null}
          {items.length === 0 && !incomplete ? (
            <p>{applied.type === 'DIRECTORY' ? t('list.empty') : t('list.emptySearch')}</p>
          ) : null}
          {items.length > 0 ? (
            <div className="cu-scroll">
              <Table aria-label={t('list.label')}>
                <TableHeader>
                  <Column isRowHeader>{t('list.columns.name')}</Column>
                  <Column>{t('list.columns.company')}</Column>
                  <Column>{t('list.columns.status')}</Column>
                  <Column>{t('list.columns.match')}</Column>
                  <Column>{t('list.columns.open')}</Column>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <Row key={item.contactId} id={item.contactId}>
                      <Cell>
                        <span className="cu-name">{name(item)}</span>
                      </Cell>
                      <Cell>{item.company?.trim() || t('list.noCompany')}</Cell>
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
                      <Cell>
                        <Button
                          size="sm"
                          aria-label={t('list.openItem', { name: name(item) })}
                          onPress={() => onOpen(item.contactId)}
                        >
                          {t('list.open')}
                        </Button>
                      </Cell>
                    </Row>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          {cursor ? (
            <Button isDisabled={more} onPress={loadMore}>
              {more ? t('loading') : t('list.more')}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
