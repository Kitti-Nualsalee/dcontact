/**
 * #1044: the pieces the two history pages (`agent-history`, `team-history`) share for chats —
 * the channel badge and filter, the read-only conversation and the recorded-outcome list.
 * Every text comes from the `history` catalog so both pages say the same thing.
 */
import { useMemo, type ReactNode } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Button, ChatTranscript } from '@d-contact/ui-react';
import { HISTORY_CHANNELS, type HistoryChannel } from '../agent-history/model.js';
import { toTranscriptMessages, writtenCount } from './transcript.js';
import type { TranscriptState } from './use-transcript.js';
import './chat-history.css';

/** channel with no value (an older server) reads as a call, which is what every item was before chats */
export const channelOf = (item: { channel?: HistoryChannel }): HistoryChannel =>
  item.channel ?? 'VOICE';

const ICON: Record<HistoryChannel, ReactNode> = {
  VOICE: (
    <path
      d="M4 2h3l1.2 3-1.6 1a8 8 0 0 0 3.4 3.4l1-1.6 3 1.2v3a1.5 1.5 0 0 1-1.6 1.5A11 11 0 0 1 2.5 3.6 1.5 1.5 0 0 1 4 2Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  ),
  WEBCHAT: (
    <path
      d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8l-3 2.5v-2.5H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  ),
};

/** channel as icon + word, so colour is never the only cue */
export function ChannelBadge({ channel }: { channel: HistoryChannel }) {
  const { t } = useTranslation('history');
  return (
    <span className={`ch-badge ch-badge--${channel === 'WEBCHAT' ? 'webchat' : 'voice'}`}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        {ICON[channel]}
      </svg>
      {t(channel === 'WEBCHAT' ? 'channels.webchat' : 'channels.voice')}
    </span>
  );
}

/** "All channels | Calls | Chats" next to the period group; the choice lives in the URL as `channel=` */
export function ChannelFilter({
  value,
  onChange,
}: {
  value: HistoryChannel | undefined;
  onChange(channel: HistoryChannel | undefined): void;
}) {
  const { t } = useTranslation('history');
  const options: { key: HistoryChannel | undefined; label: string }[] = [
    { key: undefined, label: t('channels.all') },
    ...HISTORY_CHANNELS.map((channel) => ({
      key: channel,
      label: t(channel === 'WEBCHAT' ? 'channels.webchat' : 'channels.voice'),
    })),
  ];
  return (
    <div className="ah-segmented" role="group" aria-label={t('channelFilter')}>
      {options.map((option) => (
        <button
          key={option.key ?? 'all'}
          type="button"
          aria-pressed={value === option.key}
          onClick={() => onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** the channel's name as a word, for list titles and empty messages (`undefined` = every channel) */
export function useChannelLabel(): (channel: HistoryChannel | undefined) => string {
  const { t } = useTranslation('history');
  return (channel) =>
    t(
      channel === undefined
        ? 'channels.all'
        : channel === 'WEBCHAT'
          ? 'channels.webchat'
          : 'channels.voice',
    );
}

/** the read-only conversation, with its own loading / failed states so the recorded outcome stays visible */
export function ChatTranscriptPanel({
  state,
  onRetry,
  agentName,
}: {
  state: TranscriptState;
  onRetry(): void;
  /** name of the Agent who handled the chat, used for lines about them */
  agentName: string;
}) {
  const { t: translate } = useTranslation('history');
  const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
  const { locale } = useLocale();
  const transcript = state.phase === 'ready' ? state.transcript : undefined;
  const messages = useMemo(() => {
    if (!transcript) return [];
    const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
    return toTranscriptMessages(transcript, {
      visitor: t('chat.sender.customer'),
      agent: agentName,
      time: (at) => time.format(new Date(at)),
      system: (event) =>
        event === 'AGENT_JOINED' ||
        event === 'AGENT_ENDED' ||
        event === 'CUSTOMER_ENDED' ||
        event === 'CUSTOMER_LEFT' ||
        event === 'IDLE_TIMEOUT'
          ? t(`chat.system.${event}`, { agent: agentName })
          : t('chat.system.unknown'),
    });
    // `t` changes with the language, which is exactly when the lines must be rebuilt
  }, [transcript, locale, agentName, t]);
  return (
    <section className="ch-card" aria-labelledby="ch-transcript-title">
      <div className="ch-card-head">
        <h2 id="ch-transcript-title">{t('chat.transcript')}</h2>
        {transcript ? (
          <span className="ch-meta">
            {t('chat.transcriptMeta', { count: writtenCount(transcript) })}
          </span>
        ) : null}
      </div>
      {state.phase === 'failed' ? (
        <div className="ch-partial" role="alert">
          <p>{t('chat.transcriptFailed')}</p>
          <Button onPress={onRetry}>{t('chat.retry')}</Button>
        </div>
      ) : state.phase === 'ready' ? (
        <ChatTranscript
          className="ch-transcript"
          label={t('chat.transcript')}
          messages={messages}
          empty={t('chat.transcriptEmpty')}
        />
      ) : (
        <p role="status" aria-busy="true" className="ch-meta">
          {t('chat.transcriptLoading')}
        </p>
      )}
    </section>
  );
}

export interface ResultRow {
  label: string;
  value: ReactNode;
}

/** the recorded outcome beside a chat: label/value pairs, then the note */
export function ChatResultPanel({
  rows,
  note,
  noteLabel,
  noNote,
}: {
  rows: ResultRow[];
  note: string | null;
  noteLabel: string;
  noNote: string;
}) {
  const { t } = useTranslation('history');
  return (
    <section className="ch-card" aria-labelledby="ch-result-title">
      <h2 id="ch-result-title">{t('chat.result')}</h2>
      <dl className="ch-rows">
        {rows.map((row) => (
          <div key={row.label} className="ch-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <h3>{noteLabel}</h3>
      <p className="ah-note ch-note">{note ?? noNote}</p>
    </section>
  );
}
