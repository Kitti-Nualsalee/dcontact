import { useEffect, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Button, Table, TableHeader, Column, TableBody, Row, Cell } from '@d-contact/ui-react';
import { useShellTokens } from '../shell/tokens.js';
import {
  HistoryApiError,
  type AgentHistoryApi,
  type HistoryDetail,
  type HistoryItem,
  type HistorySummary,
} from './api.js';
import {
  SUMMARY_PERIODS,
  dispositionCount,
  dispositionFrom,
  filterHref,
  formatTalk,
  periodFrom,
  type SummaryPeriod,
} from './model.js';
import './agent-history.css';

interface Props {
  api: AgentHistoryApi;
  identityKey: string;
  onSignIn?: () => void;
}

type SummaryState =
  | { phase: 'loading'; summary?: HistorySummary }
  | { phase: 'ready'; summary: HistorySummary }
  | { phase: 'error'; status: number };

/** ชื่อเขตเวลาที่อ่านง่าย เช่น "เวลาอินโดจีน" — ใช้ IANA id เมื่อ Intl ไม่มีชื่อ */
function zoneName(locale: string, timeZone: string): string {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'longGeneric' })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')?.value ?? timeZone
    );
  } catch {
    return timeZone;
  }
}

const statusOf = (failure: unknown) => (failure instanceof HistoryApiError ? failure.status : 500);

export function AgentHistory(props: Props) {
  return <HistorySession key={props.identityKey} {...props} />;
}

function HistorySession({ api, onSignIn }: Props) {
  const { t } = useTranslation('history');
  const { locale } = useLocale();
  const ready = useShellTokens();
  const initial = new URL(window.location.href).searchParams;
  const [period, setPeriod] = useState<SummaryPeriod>(() => periodFrom(initial.get('period')));
  const [disposition, setDisposition] = useState<string | null | undefined>(() =>
    dispositionFrom(initial.get('disposition')),
  );
  const [summaryState, setSummaryState] = useState<SummaryState>({ phase: 'loading' });
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => initial.get('interaction'));
  const [detail, setDetail] = useState<HistoryDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<number>();
  const [revision, setRevision] = useState(0);
  const [pageCursor, setPageCursor] = useState<string>();
  const summary = summaryState.phase === 'ready' ? summaryState.summary : undefined;
  const windowFrom = summary?.period.from ?? null;
  const windowTo = summary?.period.to ?? null;
  const format = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
          new Date(value),
        )
      : t('unavailable');
  const dispositionLabel = (value: string | null) =>
    value === 'CUSTOMER_ASSISTED'
      ? t('assisted')
      : value === 'FOLLOW_UP_REQUIRED'
        ? t('followUp')
        : (value ?? t('unavailable'));
  const groupLabel = (value: string | null) =>
    value === null ? t('summary.noDisposition') : dispositionLabel(value);

  useEffect(() => {
    if (selected) return;
    let active = true;
    setSummaryState((current) => ({
      phase: 'loading',
      summary: current.phase === 'error' ? undefined : current.summary,
    }));
    void api
      .summary(period)
      .then((result) => {
        if (active) setSummaryState({ phase: 'ready', summary: result });
      })
      .catch((failure: unknown) => {
        if (active) setSummaryState({ phase: 'error', status: statusOf(failure) });
      });
    return () => {
      active = false;
    };
  }, [api, selected, period, revision]);

  useEffect(() => {
    if (!selected && summaryState.phase !== 'ready') {
      // รายการรอช่วงเวลาจากสรุป เพื่อให้ตัวเลขกับรายการใช้ช่วงเดียวกัน
      setLoading(summaryState.phase === 'loading');
      return;
    }
    let active = true;
    setLoading(true);
    setError(undefined);
    setDetail(undefined);
    if (!selected && !pageCursor) setItems([]);
    const request = selected
      ? api.result(selected)
      : api.list(pageCursor, { from: windowFrom, to: windowTo, disposition });
    void request
      .then((result) => {
        if (!active) return;
        if ('items' in result) {
          setItems((current) => (pageCursor ? [...current, ...result.items] : result.items));
          setCursor(result.nextCursor);
        } else setDetail(result);
      })
      .catch((failure: unknown) => {
        if (active) setError(statusOf(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // summaryState.phase เปลี่ยนตาม revision/period แล้ว — ไม่ใส่ object ทั้งก้อนเพื่อไม่โหลดซ้ำ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selected, pageCursor, revision, windowFrom, windowTo, disposition, summaryState.phase]);

  function open(interactionId?: string) {
    const url = new URL(window.location.href);
    if (interactionId) url.searchParams.set('interaction', interactionId);
    else url.searchParams.delete('interaction');
    window.history.replaceState(null, '', url);
    setSelected(interactionId ?? null);
    setPageCursor(undefined);
  }
  function applyFilter(nextPeriod: SummaryPeriod, nextDisposition: string | null | undefined) {
    window.history.replaceState(
      null,
      '',
      filterHref(window.location.href, nextPeriod, nextDisposition),
    );
    setPeriod(nextPeriod);
    setDisposition(nextDisposition);
    setPageCursor(undefined);
  }
  if (!ready) return null;
  const failure = summaryState.phase === 'error' ? summaryState.status : error;
  const errorKey =
    failure === 401
      ? 'unauthorized'
      : failure === 403
        ? 'forbidden'
        : failure === 404
          ? 'notFound'
          : 'failed';
  const periodLabel = (key: SummaryPeriod) => t(`summary.period.${key}`);
  const shownSummary = summaryState.phase === 'error' ? undefined : summaryState.summary;
  const range = (() => {
    if (!shownSummary?.period.from || !shownSummary.period.to) return t('summary.allTime');
    const dates = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeZone: shownSummary.period.timeZone,
    });
    const from = new Date(shownSummary.period.from);
    const last = new Date(new Date(shownSummary.period.to).getTime() - 1);
    const fromText = dates.format(from);
    const lastText = dates.format(last);
    return fromText === lastText ? fromText : `${fromText} – ${lastText}`;
  })();
  const filterCount = shownSummary
    ? dispositionCount(shownSummary.byDisposition, shownSummary.completed, disposition)
    : undefined;
  return (
    <main className="ah-root">
      <h1>{t('title')}</h1>
      <p>{t('readOnly')}</p>
      {selected ? (
        <Button onPress={() => open()}>{t('back')}</Button>
      ) : (
        <section className="ah-summary" aria-labelledby="ah-summary-title">
          <div className="ah-summary-head">
            <h2 id="ah-summary-title">{t('summary.title')}</h2>
            <div className="ah-segmented" role="group" aria-label={t('summary.periodLabel')}>
              {SUMMARY_PERIODS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={period === key}
                  onClick={() => applyFilter(key, disposition)}
                >
                  {periodLabel(key)}
                </button>
              ))}
            </div>
            <Button
              isDisabled={loading || summaryState.phase === 'loading'}
              onPress={() => {
                setPageCursor(undefined);
                setRevision((current) => current + 1);
              }}
            >
              {t('refresh')}
            </Button>
          </div>
          {shownSummary ? (
            <>
              <p className="ah-range">
                {t('summary.range', {
                  range,
                  timeZone: zoneName(locale, shownSummary.period.timeZone),
                })}
              </p>
              <dl className="ah-metrics">
                <div className="ah-metric">
                  <dt>{t('summary.completed')}</dt>
                  <dd>
                    <button
                      type="button"
                      className="ah-metric-value"
                      aria-pressed={disposition === undefined}
                      aria-label={t('summary.showAll', { count: shownSummary.completed })}
                      onClick={() => applyFilter(period, undefined)}
                    >
                      {shownSummary.completed}
                    </button>
                  </dd>
                </div>
                <div className="ah-metric">
                  <dt>{t('summary.talk')}</dt>
                  <dd>
                    {shownSummary.talk.averageSeconds === null ? (
                      <span className="ah-metric-empty">{t('summary.noTalk')}</span>
                    ) : (
                      <span className="ah-metric-value">
                        {formatTalk(shownSummary.talk.averageSeconds)}
                      </span>
                    )}
                    <span className="ah-metric-note">
                      {t('summary.talkBasis', { count: shownSummary.talk.measuredCount })}
                    </span>
                  </dd>
                </div>
              </dl>
              {shownSummary.byDisposition.length ? (
                <>
                  <h3>{t('summary.byDisposition')}</h3>
                  <ul className="ah-breakdown">
                    {shownSummary.byDisposition.map((group) => (
                      <li key={group.disposition ?? ''}>
                        <button
                          type="button"
                          aria-pressed={disposition === group.disposition}
                          onClick={() =>
                            applyFilter(
                              period,
                              disposition === group.disposition ? undefined : group.disposition,
                            )
                          }
                        >
                          <span>{groupLabel(group.disposition)}</span>
                          <span className="ah-count">{group.count}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : summaryState.phase === 'loading' ? (
            <div className="ah-metrics ah-placeholder" aria-hidden="true">
              <div className="ah-metric" />
              <div className="ah-metric" />
            </div>
          ) : null}
        </section>
      )}
      {loading ? <p role="status">{t('loading')}</p> : null}
      {failure ? (
        <section role="alert">
          <p>{t(errorKey)}</p>
          {failure === 401 && onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
          <Button onPress={() => setRevision((current) => current + 1)}>{t('retry')}</Button>
        </section>
      ) : null}
      {!selected && shownSummary && !failure ? (
        <h2 className="ah-list-title">
          {t('summary.listTitle', {
            period: periodLabel(period),
            disposition:
              disposition === undefined ? t('summary.allDispositions') : groupLabel(disposition),
            count: filterCount ?? 0,
          })}
        </h2>
      ) : null}
      {!selected && !failure && !loading && summary && items.length === 0 ? (
        <p>
          {disposition !== undefined
            ? t('summary.emptyFiltered')
            : period === 'all'
              ? t('empty')
              : t('summary.emptyPeriod')}
        </p>
      ) : null}
      {!selected && items.length > 0 ? (
        <div className="ah-scroll">
          <Table aria-label={t('list')}>
            <TableHeader>
              <Column isRowHeader>{t('interaction')}</Column>
              <Column>{t('started')}</Column>
              <Column>{t('ended')}</Column>
              <Column>{t('disposition')}</Column>
              <Column>{t('recorded')}</Column>
              <Column>{t('source')}</Column>
              <Column>{t('open')}</Column>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <Row key={item.interactionId} id={item.interactionId}>
                  <Cell>{item.interactionId}</Cell>
                  <Cell>{format(item.startedAt)}</Cell>
                  <Cell>{format(item.endedAt)}</Cell>
                  <Cell>{dispositionLabel(item.disposition)}</Cell>
                  <Cell>{format(item.recordedAt)}</Cell>
                  <Cell>{t(item.recordedAtSource)}</Cell>
                  <Cell>
                    <Button
                      aria-label={t('openItem', { interactionId: item.interactionId })}
                      onPress={() => open(item.interactionId)}
                    >
                      {t('open')}
                    </Button>
                  </Cell>
                </Row>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {!selected && cursor && !failure ? (
        <Button isDisabled={loading} onPress={() => setPageCursor(cursor)}>
          {t('more')}
        </Button>
      ) : null}
      {selected && detail && !error ? (
        <article>
          <h2>{t('detail')}</h2>
          <p>{detail.interactionId}</p>
          <p>{dispositionLabel(detail.disposition)}</p>
          <time dateTime={detail.recordedAt}>{format(detail.recordedAt)}</time>
          <p>{t(detail.recordedAtSource)}</p>
          {detail.legacy ? <p>{t('legacy')}</p> : null}
          <h3>{t('note')}</h3>
          <p className="ah-note">{detail.note ?? t('noNote')}</p>
        </article>
      ) : null}
    </main>
  );
}
