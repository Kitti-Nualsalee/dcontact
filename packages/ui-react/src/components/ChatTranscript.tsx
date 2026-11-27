import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../cx.js';
import styles from './ChatTranscript.module.css';

/**
 * #1044 the messages of a chat, live in Workspace and read-only in the Console history.
 * It only draws what it is given: no data fetching, and every piece of text comes from the app's catalog.
 */
export interface ChatTranscriptMessage {
  id: string;
  /** `self` = written by the reader's side (right), `other` = the other party (left), `system` = a centred line */
  side: 'self' | 'other' | 'system';
  /** who wrote it, shown as text so the side and colour are never the only cue */
  author?: string;
  /** already formatted for the reader's locale */
  time?: string;
  text: string;
  /** a message of the reader that has not reached the server yet */
  status?: 'sending' | 'failed';
  /** text of the status, e.g. "Sending" or "Not sent" */
  statusLabel?: string;
  /** the text stands in for content this view cannot show (e.g. a sticker); drawn as a note with a dashed outline */
  placeholder?: boolean;
}

export interface ChatTranscriptProps {
  /** accessible name of the message list */
  label: string;
  messages: readonly ChatTranscriptMessage[];
  /** announce new messages and follow the conversation; off for a finished chat */
  live?: boolean;
  /** label of the button shown when messages arrived while the reader had scrolled up */
  newMessagesLabel?: (count: number) => string;
  /** actions under a failed message, e.g. try again and delete */
  renderFailedActions?: (message: ChatTranscriptMessage) => ReactNode;
  /** shown when there is no message */
  empty?: ReactNode;
  className?: string;
}

const NEAR_BOTTOM = 32;

export function ChatTranscript({
  label,
  messages,
  live = false,
  newMessagesLabel,
  renderFailedActions,
  empty,
  className,
}: ChatTranscriptProps) {
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const seen = useRef(messages.length);
  const [unseen, setUnseen] = useState(0);

  // A new message follows the conversation only while the reader is at the bottom; a reader who
  // scrolled up to read keeps their place and gets a button instead (docs/ui-principles.md item 4).
  useLayoutEffect(() => {
    const element = log.current;
    if (!element || !live) return;
    if (pinned.current) {
      element.scrollTop = element.scrollHeight;
      seen.current = messages.length;
      setUnseen(0);
    } else if (messages.length > seen.current) {
      setUnseen(messages.length - seen.current);
    }
  }, [live, messages]);

  useEffect(() => {
    const element = log.current;
    if (!element || !live) return;
    const onScroll = () => {
      pinned.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM;
      if (pinned.current) {
        seen.current = messages.length;
        setUnseen(0);
      }
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [live, messages.length]);

  return (
    <div className={cx(styles.wrap, className)}>
      <div
        ref={log}
        className={styles.log}
        role="log"
        aria-label={label}
        aria-live={live ? 'polite' : 'off'}
        tabIndex={0}
      >
        {messages.length === 0 && empty ? <div className={styles.empty}>{empty}</div> : null}
        {messages.map((message) =>
          message.side === 'system' ? (
            <div key={message.id} className={styles.system}>
              <span>
                {message.text}
                {message.time ? <time className={styles.systemTime}>{message.time}</time> : null}
              </span>
            </div>
          ) : (
            <div
              key={message.id}
              className={cx(
                styles.message,
                message.side === 'self' ? styles.self : styles.other,
                message.status === 'failed' && styles.failed,
                message.placeholder && styles.placeholder,
              )}
            >
              <div className={styles.meta}>
                {message.author ? <span className={styles.author}>{message.author}</span> : null}
                {message.time ? <time>{message.time}</time> : null}
              </div>
              <p className={styles.bubble}>{message.text}</p>
              {message.status ? (
                <div className={styles.status}>
                  {message.statusLabel ? (
                    <span className={message.status === 'failed' ? styles.statusFailed : undefined}>
                      {message.statusLabel}
                    </span>
                  ) : null}
                  {message.status === 'failed' ? renderFailedActions?.(message) : null}
                </div>
              ) : null}
            </div>
          ),
        )}
      </div>
      {live && unseen > 0 && newMessagesLabel ? (
        <button
          type="button"
          className={styles.jump}
          onClick={() => {
            const element = log.current;
            if (!element) return;
            pinned.current = true;
            element.scrollTop = element.scrollHeight;
            seen.current = messages.length;
            setUnseen(0);
          }}
        >
          {newMessagesLabel(unseen)}
        </button>
      ) : null}
    </div>
  );
}
