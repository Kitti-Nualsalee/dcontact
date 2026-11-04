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
  /** กลับมาจากโปรไฟล์: ย้าย focus ไปหัวข้อเพื่อไม่ให้ผู้ใช้คีย์บอร์ดหลุดกลางหน้า */
  focusHeading?: boolean;
}

type Applied = { type: SearchType; query: string };
type View =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; kind: ErrorKind; retryAfter?: number };

const SEARCH_TYPES = ['NAME', 'PHONE', 'EMAIL'] as const;
const DIRECTORY_SEARCH: Applied = { type: 'DIRECTORY', query: '' };

/** รายการ + ค้นหาลูกค้า (Console A): ผลทั้งหมดมาจาก server ตามสิทธิ์; ไม่มี query ใน URL */
export function CustomerDirectory({ api, onOpen, onSignIn, focusHeading }: Props) {
  const { t: translate } = useTranslation('customers');
  const t = translate as (key: string, options?: Record<string, unknown>) => string;
  const [type, setType] = useState<(typeof SEARCH_TYPES)[number]>('NAME');
  const [query, setQuery] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  // applied = คำขอล่าสุด; shown = ชุดที่ผลบนจอเป็นของจริง (validation ล้มแล้วผลเดิมยังเป็นของ shown)
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

  // ปิด PII ทั้งหมดเมื่อสิทธิ์/session เปลี่ยน (ไม่เก็บผลเก่าไว้ใน state)
  const closeData = useCallback(() => {
    setItems([]);
    setCursor(null);
    setPage(undefined);
  }, []);

  const closeSearchContext = useCallback(() => {
    setQuery('');
    setFieldError(undefined);
    setApplied(DIRECTORY_SEARCH);
    setShown(DIRECTORY_SEARCH);
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
          // validation: คงผลเดิมไว้ และแจ้งใต้ช่อง ไม่เปลี่ยนเป็นหน้า error
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
      if (document.visibilityState !== 'visible') return;
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
  // หัวข้อตามคำขอล่าสุดทันทีที่ส่งค้นหา (ระหว่างโหลดใช้ applied; หลังได้ผลใช้ shown ซึ่งตรงกับผลบนจอ)
  const searching = (view.state === 'loading' ? applied : shown).type !== 'DIRECTORY';

  useEffect(() => {
    if (focusHeading) headingRef.current?.focus();
  }, [focusHeading]);
  // โหลดเพิ่มแล้ว focus ไปรายการแรกที่เพิ่ม เพื่อให้ผู้ใช้คีย์บอร์ดอ่านต่อได้ทันที
  // แถวใหม่ของ Table (react-aria) render หลัง state เปลี่ยน — รอจนเจอ element จริงค่อย focus แล้วเคลียร์ id
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
  // ลองใหม่/ข้อผิดพลาด: ย้าย focus ไปหัวข้อผลหรือข้อความ state ใหม่ ไม่ให้หลุดไป BODY
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
            // คำค้นของชนิดเดิมใช้กับชนิดใหม่ไม่ได้ (เช่น ชื่อ → เบอร์) จึงล้างพร้อมข้อผิดพลาดเดิม
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
