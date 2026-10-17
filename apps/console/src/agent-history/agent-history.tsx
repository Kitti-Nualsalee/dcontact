import { useEffect, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Button, Table, TableHeader, Column, TableBody, Row, Cell } from '@d-contact/ui-react';
import { useShellTokens } from '../shell/tokens.js';
import {
  HistoryApiError,
  type AgentHistoryApi,
  type HistoryDetail,
  type HistoryItem,
} from './api.js';
import './agent-history.css';

interface Props {
  api: AgentHistoryApi;
  identityKey: string;
  onSignIn?: () => void;
}

export function AgentHistory(props: Props) {
  return <HistorySession key={props.identityKey} {...props} />;
}

function HistorySession({ api, onSignIn }: Props) {
  const { t } = useTranslation('history');
  const { locale } = useLocale();
  const ready = useShellTokens();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(() =>
    new URL(window.location.href).searchParams.get('interaction'),
  );
  const [detail, setDetail] = useState<HistoryDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<number>();
  const [revision, setRevision] = useState(0);
  const [pageCursor, setPageCursor] = useState<string>();
  const format = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
          new Date(value),
        )
      : t('unavailable');
  const disposition = (value: string | null) =>
    value === 'CUSTOMER_ASSISTED'
      ? t('assisted')
      : value === 'FOLLOW_UP_REQUIRED'
        ? t('followUp')
        : (value ?? t('unavailable'));
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setDetail(undefined);
    if (!selected && !pageCursor) setItems([]);
    const request = selected ? api.result(selected) : api.list(pageCursor);
    void request
      .then((result) => {
        if (!active) return;
        if ('items' in result) {
          setItems((current) => (pageCursor ? [...current, ...result.items] : result.items));
          setCursor(result.nextCursor);
        } else setDetail(result);
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof HistoryApiError ? failure.status : 500);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, selected, pageCursor, revision]);
  function open(interactionId?: string) {
    const url = new URL(window.location.href);
    if (interactionId) url.searchParams.set('interaction', interactionId);
    else url.searchParams.delete('interaction');
    window.history.replaceState(null, '', url);
    setSelected(interactionId ?? null);
    setPageCursor(undefined);
  }
  if (!ready) return null;
  const errorKey =
    error === 401
      ? 'unauthorized'
      : error === 403
        ? 'forbidden'
        : error === 404
          ? 'notFound'
          : 'failed';
  return (
    <main className="ah-root">
      <h1>{t('title')}</h1>
      <p>{t('readOnly')}</p>
      {selected ? (
        <Button onPress={() => open()}>{t('back')}</Button>
      ) : (
        <Button
          isDisabled={loading}
          onPress={() => {
            setPageCursor(undefined);
            setRevision((current) => current + 1);
          }}
        >
          {t('refresh')}
        </Button>
      )}
      {loading ? <p role="status">{t('loading')}</p> : null}
      {error ? (
        <section role="alert">
          <p>{t(errorKey)}</p>
          {error === 401 && onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
          <Button onPress={() => setRevision((current) => current + 1)}>{t('retry')}</Button>
        </section>
      ) : null}
      {!selected && !error && !loading && items.length === 0 ? <p>{t('empty')}</p> : null}
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
                  <Cell>{disposition(item.disposition)}</Cell>
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
      {!selected && cursor ? (
        <Button isDisabled={loading} onPress={() => setPageCursor(cursor)}>
          {t('more')}
        </Button>
      ) : null}
      {selected && detail && !error ? (
        <article>
          <h2>{t('detail')}</h2>
          <p>{detail.interactionId}</p>
          <p>{disposition(detail.disposition)}</p>
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
