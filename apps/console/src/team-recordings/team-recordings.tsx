import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import {
  Badge,
  Button,
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from '@d-contact/ui-react';
import { useShellTokens } from '../shell/tokens.js';
import { RecordingApiError, type RecordingItem, type TeamRecordingsApi } from './api.js';
import { dateRange, defaultDates, formatClock, playbackFailure } from './model.js';
import { ChunkPlayer, type PlayerState } from './player.js';
import './team-recordings.css';

interface Props {
  api: TeamRecordingsApi;
  identityKey: string;
  onSignIn?: () => void;
}

/** เปลี่ยนผู้ใช้แล้วทิ้ง state และ session เปิดฟังของคนก่อนทั้งหมด */
export function TeamRecordings(props: Props) {
  return <RecordingsSession key={props.identityKey} {...props} />;
}

const statusOf = (failure: unknown) =>
  failure instanceof RecordingApiError ? failure.status : 500;

function RecordingsSession({ api, onSignIn }: Props) {
  const { t } = useTranslation('recordings');
  const { locale } = useLocale();
  const ready = useShellTokens();
  const fromId = useId();
  const listenId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const toId = useId();
  const [dates, setDates] = useState(() => defaultDates(new Date()));
  const [applied, setApplied] = useState(dates);
  const [items, setItems] = useState<RecordingItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<number>();
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<RecordingItem>();
  const range = dateRange(dates.from, dates.to);
  const rangeError = 'error' in range ? range.error : undefined;
  const format = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );

  useEffect(() => {
    const window = dateRange(applied.from, applied.to);
    if ('error' in window) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    void api
      .history({ ...window, ...(pageCursor ? { cursor: pageCursor } : {}) })
      .then((page) => {
        if (!active) return;
        setItems((current) => (pageCursor ? [...current, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
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
  }, [api, applied, pageCursor, revision]);

  if (!ready) return null;
  const errorKey =
    error === 401 ? 'unauthorized' : error === 403 ? 'forbidden' : error ? 'failed' : undefined;
  const title = (item: RecordingItem) =>
    t('itemTitle', { time: format(item.startedAt), agent: item.agentName ?? t('unknownAgent') });
  return (
    <main className="tr-root">
      <header className="tr-head">
        <h1 ref={heading} tabIndex={-1}>
          {t('title')}
        </h1>
        <p className="tr-muted">{t('scope')}</p>
      </header>
      <form
        className="tr-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (rangeError) return;
          setPageCursor(undefined);
          setApplied(dates);
          setRevision((current) => current + 1);
        }}
      >
        <div className="tr-field">
          <label htmlFor={fromId}>{t('from')}</label>
          <input
            id={fromId}
            type="date"
            value={dates.from}
            max={dates.to}
            aria-invalid={rangeError ? true : undefined}
            aria-describedby={rangeError ? `${fromId}-error` : undefined}
            onChange={(event) => setDates({ ...dates, from: event.target.value })}
          />
        </div>
        <div className="tr-field">
          <label htmlFor={toId}>{t('to')}</label>
          <input
            id={toId}
            type="date"
            value={dates.to}
            min={dates.from}
            aria-invalid={rangeError ? true : undefined}
            aria-describedby={rangeError ? `${fromId}-error` : undefined}
            onChange={(event) => setDates({ ...dates, to: event.target.value })}
          />
        </div>
        <Button type="submit" variant="primary" isDisabled={loading || !!rangeError}>
          {t('show')}
        </Button>
        {rangeError ? (
          <p id={`${fromId}-error`} className="tr-field-error" role="alert">
            {t(`range.${rangeError}`)}
          </p>
        ) : null}
      </form>
      {selected ? (
        <Player
          key={selected.recordingId}
          api={api}
          item={selected}
          title={title(selected)}
          onSignIn={onSignIn}
          onClose={() => {
            // คืน focus ให้ปุ่มฟังของแถวที่เปิดไว้ ถ้าแถวไม่อยู่แล้วไปที่หัวข้อหน้า
            const opener = document.getElementById(`${listenId}-${selected.recordingId}`);
            setSelected(undefined);
            (opener ?? heading.current)?.focus();
          }}
        />
      ) : null}
      {loading && items.length === 0 ? <p role="status">{t('loading')}</p> : null}
      {errorKey ? (
        <section role="alert" className="tr-alert">
          <p>{t(errorKey)}</p>
          {error === 401 && onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
          {error !== 403 ? (
            <Button onPress={() => setRevision((current) => current + 1)}>{t('retry')}</Button>
          ) : null}
        </section>
      ) : null}
      {!loading && !error && items.length === 0 ? <p className="tr-empty">{t('empty')}</p> : null}
      {items.length > 0 ? (
        <div className="tr-scroll" aria-busy={loading} data-stale={loading || undefined}>
          <Table aria-label={t('list')}>
            <TableHeader>
              <Column isRowHeader>{t('started')}</Column>
              <Column>{t('agent')}</Column>
              <Column>{t('queue')}</Column>
              <Column>{t('duration')}</Column>
              <Column>{t('status')}</Column>
              <Column>{t('listen')}</Column>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <Row key={item.recordingId} id={item.recordingId}>
                  <Cell>
                    <time className="tr-nowrap" dateTime={item.startedAt}>
                      {format(item.startedAt)}
                    </time>
                  </Cell>
                  <Cell>{item.agentName ?? t('unknownAgent')}</Cell>
                  <Cell>{item.queueName ?? t('unknownQueue')}</Cell>
                  <Cell>
                    {item.durationSec === null
                      ? t('unknownDuration')
                      : formatClock(item.durationSec)}
                  </Cell>
                  <Cell>
                    <Badge tone={item.capabilities.play ? 'success' : 'attention'}>
                      {t(`recordingStatus.${item.status}`)}
                    </Badge>
                  </Cell>
                  <Cell>
                    {item.capabilities.play ? (
                      <Button
                        id={`${listenId}-${item.recordingId}`}
                        size="sm"
                        aria-label={t('listenItem', { title: title(item) })}
                        aria-pressed={selected?.recordingId === item.recordingId}
                        onPress={() => setSelected(item)}
                      >
                        {t('listen')}
                      </Button>
                    ) : (
                      <span className="tr-muted">{t('notReadyShort')}</span>
                    )}
                  </Cell>
                </Row>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {nextCursor && !error ? (
        <Button isDisabled={loading} onPress={() => setPageCursor(nextCursor)}>
          {t('more')}
        </Button>
      ) : null}
    </main>
  );
}

function Player({
  api,
  item,
  title,
  onSignIn,
  onClose,
}: {
  api: TeamRecordingsApi;
  item: RecordingItem;
  title: string;
  onSignIn?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('recordings');
  const sliderId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const player = useRef<ChunkPlayer | undefined>(undefined);
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [state, setState] = useState<PlayerState>({
    phase: 'idle',
    position: 0,
    duration: item.durationSec,
  });
  const [scrub, setScrub] = useState<number>();

  useEffect(() => {
    const created = new ChunkPlayer(api, item.recordingId, (next) =>
      // ก่อนเปิด session ใช้ความยาวจากรายการ หลังเปิดใช้ความยาวจริงของไฟล์
      setState({ ...next, duration: next.duration ?? item.durationSec }),
    );
    player.current = created;
    heading.current?.focus();
    return () => {
      clearTimeout(scrubTimer.current);
      created.dispose();
    };
  }, [api, item.recordingId, item.durationSec]);

  /** ใช้ตำแหน่งที่ผู้ใช้เลื่อนค้างไว้ก่อนทำอย่างอื่น เพื่อไม่ให้เล่นจากตำแหน่งเก่า */
  const commitScrub = (target = scrub) => {
    clearTimeout(scrubTimer.current);
    if (target === undefined) return;
    player.current?.seek(target);
    setScrub(undefined);
  };
  const duration = state.duration ?? 0;
  const position = Math.min(scrub ?? state.position, duration);
  const active = state.phase === 'playing' || state.phase === 'loading';
  const failure = state.error ? playbackFailure(state.error.status, state.error.code) : undefined;
  return (
    <section className="tr-player" aria-labelledby={`${sliderId}-title`}>
      <div className="tr-player-head">
        <h2 id={`${sliderId}-title`} ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <Button variant="ghost" size="sm" onPress={onClose}>
          {t('player.close')}
        </Button>
      </div>
      <div className="tr-player-controls">
        <Button
          variant="primary"
          className="tr-toggle"
          onPress={() => {
            commitScrub();
            if (active) player.current?.pause();
            else void player.current?.play();
          }}
        >
          {active ? t('player.pause') : t('player.play')}
        </Button>
        <label className="tr-visually-hidden" htmlFor={sliderId}>
          {t('player.position')}
        </label>
        <input
          id={sliderId}
          className="tr-slider"
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={1}
          value={Math.floor(position)}
          // ก่อนเล่นครั้งแรกยังไม่มี session จึงยังเลื่อนไม่ได้
          disabled={state.phase === 'idle' || duration === 0}
          aria-valuetext={t('player.clock', {
            position: formatClock(position),
            duration: formatClock(duration),
          })}
          onChange={(event) => {
            const target = Number(event.target.value);
            setScrub(target);
            clearTimeout(scrubTimer.current);
            // ลากแถบเวลาสร้าง change ถี่ จึงรอให้นิ่งก่อนขอเสียงช่วงใหม่
            scrubTimer.current = setTimeout(() => commitScrub(target), 250);
          }}
        />
        <span className="tr-clock" aria-hidden="true">
          {t('player.clock', { position: formatClock(position), duration: formatClock(duration) })}
        </span>
      </div>
      <p className="tr-muted" role="status">
        {failure || state.phase === 'error' ? '' : t(`player.phase.${state.phase}`)}
      </p>
      {failure ? (
        <div role="alert" className="tr-alert">
          <p>{t(`player.error.${failure}`)}</p>
          {failure === 'signIn' && onSignIn ? (
            <Button onPress={onSignIn}>{t('signIn')}</Button>
          ) : null}
          {failure === 'unavailable' || failure === 'failed' || failure === 'notReady' ? (
            <Button onPress={() => void player.current?.play()}>{t('retry')}</Button>
          ) : null}
        </div>
      ) : null}
      <p className="tr-muted">{t('player.notice')}</p>
    </section>
  );
}
