/**
 * #1061 the "Callbacks" tab of the work list: due callbacks first, each with call / move / cancel.
 * The parent (WorkspaceApp) owns the data and the API calls; this file only shows them.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, StatusChip, TextField } from '@d-contact/ui-react';
import { useTranslation } from '@d-contact/i18n/react';
import type { AgentCallback } from './callback-api.js';
import { localParts, slotInstant, slotProblemKey, type SlotProblem } from './callback-model.js';
import './callbacks.css';

/** "Today 14:30" or "29 Nov 14:30" in the Agent's language */
export function useCallbackWhen(locale: string) {
  const { t } = useTranslation('workspace');
  return (iso: string, now: Date = new Date()) => {
    const at = new Date(iso);
    const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    return at.toDateString() === now.toDateString()
      ? t('callback.whenToday', { time })
      : t('callback.whenOther', {
          date: at.toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
          time,
        });
  };
}

interface Props {
  items: readonly AgentCallback[];
  status: 'loading' | 'ready' | 'failed';
  now: number;
  locale: string;
  /** the callback whose command is being sent, so its buttons wait */
  busyId: string | null;
  /** false while the Agent cannot dial (another call, not Ready); the reason is in `dialHint` */
  canDial: boolean;
  dialHint?: string;
  onRetry(): void;
  onDial(item: AgentCallback): void;
  onReschedule(item: AgentCallback, requestedFor: string): Promise<boolean>;
  onCancel(item: AgentCallback): Promise<boolean>;
}

export function CallbackList({
  items,
  status,
  now,
  locale,
  busyId,
  canDial,
  dialHint,
  onRetry,
  onDial,
  onReschedule,
  onCancel,
}: Props) {
  const { t } = useTranslation('workspace');
  const [moving, setMoving] = useState<AgentCallback | null>(null);
  const [cancelling, setCancelling] = useState<AgentCallback | null>(null);
  const [slot, setSlot] = useState({ date: '', time: '' });
  const [attempted, setAttempted] = useState(false);
  const formatWhen = useCallbackWhen(locale);
  const when = (item: AgentCallback) => formatWhen(item.requestedFor, new Date(now));
  const name = (item: AgentCallback) =>
    item.customerVisible
      ? (item.contactName ?? item.number ?? '—')
      : t('callback.customerHiddenShort');
  // after a cancel the row is gone: focus moves to the next row (its move button: the call button may be
  // disabled), or to the empty state; after the dialog has given focus back, which would land on <body>
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusAfter) return;
    const target = focusAfter;
    setFocusAfter(null);
    // not cancelled on the re-render that clearing `focusAfter` causes
    requestAnimationFrame(() => {
      const next = document.querySelector<HTMLElement>(`[data-callback-move="${target}"]`);
      if (next) next.focus();
      else emptyRef.current?.focus();
    });
  }, [items, focusAfter]);

  if (status === 'failed' && items.length === 0) {
    return (
      <div className="aw-empty">
        <strong>{t('callback.loadFailed')}</strong>
        <Button size="sm" variant="secondary" onPress={onRetry}>
          {t('callback.retry')}
        </Button>
      </div>
    );
  }
  if (items.length === 0) {
    return status === 'loading' ? (
      <CallbackSkeleton label={t('callback.loading')} />
    ) : (
      <div className="aw-empty" ref={emptyRef} tabIndex={-1}>
        <strong>{t('callback.empty')}</strong>
        <span>{t('callback.emptyHint')}</span>
      </div>
    );
  }

  const chosen = slotInstant(slot.date, slot.time, new Date(now));
  const problem = 'problem' in chosen ? chosen.problem : undefined;

  return (
    <>
      {status === 'failed' ? (
        <div className="aw-callback-stale" role="status">
          <span>{t('callback.stale')}</span>
          <Button size="sm" variant="secondary" onPress={onRetry}>
            {t('callback.retry')}
          </Button>
        </div>
      ) : null}
      {!canDial && dialHint ? <p className="aw-copy aw-callback-hint">{dialHint}</p> : null}
      <ul className="aw-v3-items aw-callback-items" aria-label={t('callback.listLabel')}>
        {items.map((item) => {
          const due = item.state === 'SCHEDULED' && Date.parse(item.requestedFor) <= now;
          const busy = busyId === item.id || item.state === 'ORIGINATING';
          return (
            <li
              key={item.id}
              className="aw-v3-item aw-callback-item"
              data-due={due ? 'true' : undefined}
            >
              <div className="aw-callback-row">
                <span className="aw-v3-item-icon">
                  <CallbackIcon />
                </span>
                <span className="aw-v3-item-copy">
                  <span className="aw-work-row">
                    <strong>{name(item)}</strong>
                    <span className="aw-work-time">{when(item)}</span>
                  </span>
                  {item.customerVisible && item.number && item.contactName ? (
                    <span className="aw-work-meta aw-v3-mono">{item.number}</span>
                  ) : null}
                  <span className="aw-callback-chips">
                    {item.state === 'ORIGINATING' ? (
                      <StatusChip status="info">{t('callback.dialing')}</StatusChip>
                    ) : due ? (
                      <StatusChip status="attention">{t('callback.due')}</StatusChip>
                    ) : (
                      <StatusChip status="neutral">{t('callback.upcoming')}</StatusChip>
                    )}
                    {item.team ? (
                      <StatusChip status="accent">{t('callback.teamBadge')}</StatusChip>
                    ) : null}
                  </span>
                  {item.team && item.createdByName ? (
                    <span className="aw-work-meta">
                      {t('callback.teamHint', { name: item.createdByName })}
                    </span>
                  ) : null}
                  {item.note ? <span className="aw-callback-note">{item.note}</span> : null}
                  {item.lastReasonCode === 'AGENT_NOT_ANSWERED' ? (
                    <span className="aw-work-meta">{t('callback.lastNotAnswered')}</span>
                  ) : null}
                </span>
              </div>
              <div className="aw-callback-actions">
                <Button
                  size="sm"
                  variant={due ? 'primary' : 'secondary'}
                  isDisabled={busy || !canDial}
                  aria-label={t('callback.dialLabel', { name: name(item) })}
                  data-callback-dial={item.id}
                  onPress={() => onDial(item)}
                >
                  {t('callback.dial')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy}
                  aria-label={t('callback.rescheduleLabel', { name: name(item) })}
                  data-callback-move={item.id}
                  onPress={() => {
                    setSlot(
                      localParts(
                        new Date(Math.max(Date.parse(item.requestedFor), now + 15 * 60_000)),
                      ),
                    );
                    setAttempted(false);
                    setMoving(item);
                  }}
                >
                  {t('callback.reschedule')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy}
                  aria-label={t('callback.cancelLabel', { name: name(item) })}
                  onPress={() => setCancelling(item)}
                >
                  {t('callback.cancel')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <Dialog
        isOpen={moving !== null}
        onOpenChange={(open) => !open && setMoving(null)}
        title={
          moving
            ? t('callback.rescheduleTitleFor', { name: name(moving) })
            : t('callback.rescheduleTitle')
        }
        footer={(close) => (
          <>
            <Button variant="secondary" onPress={close}>
              {t('callback.close')}
            </Button>
            <Button
              variant="primary"
              isDisabled={busyId === moving?.id}
              onPress={() => {
                setAttempted(true);
                if (!moving || !('at' in chosen)) return;
                void onReschedule(moving, chosen.at.toISOString()).then((done) => done && close());
              }}
            >
              {t('callback.rescheduleSave')}
            </Button>
          </>
        )}
      >
        <SlotFields
          idPrefix="callback-move"
          slot={slot}
          onChange={setSlot}
          problem={attempted ? problem : undefined}
        />
      </Dialog>
      <Dialog
        role="alertdialog"
        describedBy="callback-cancel-copy"
        isOpen={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={t('callback.cancelTitle')}
        footer={(close) => (
          <>
            <Button variant="secondary" onPress={close}>
              {t('callback.keep')}
            </Button>
            <Button
              variant="danger"
              isDisabled={busyId === cancelling?.id}
              onPress={() => {
                if (!cancelling) return;
                const index = items.findIndex((item) => item.id === cancelling.id);
                const next = items[index + 1] ?? items[index - 1];
                void onCancel(cancelling).then((done) => {
                  if (!done) return;
                  close();
                  setFocusAfter(next?.id ?? 'none');
                });
              }}
            >
              {t('callback.cancelConfirm')}
            </Button>
          </>
        )}
      >
        <p className="aw-copy" id="callback-cancel-copy">
          {cancelling
            ? t('callback.cancelCopy', { name: name(cancelling), when: when(cancelling) })
            : null}
        </p>
      </Dialog>
    </>
  );
}

/** date and time of a callback; the message for a time that cannot be used belongs to the date field */
export function SlotFields({
  idPrefix,
  slot,
  onChange,
  problem,
  readOnly = false,
}: {
  idPrefix: string;
  slot: { date: string; time: string };
  onChange(slot: { date: string; time: string }): void;
  /** shown only after the Agent tried to save */
  problem: SlotProblem | undefined;
  readOnly?: boolean;
}) {
  const { t } = useTranslation('workspace');
  const message = problem ? t(slotProblemKey(problem)) : undefined;
  return (
    <div className="aw-callback-slot">
      <TextField
        id={`${idPrefix}-date`}
        type="date"
        label={t('callback.date')}
        isRequired
        isReadOnly={readOnly}
        value={slot.date}
        onChange={(date) => onChange({ ...slot, date })}
        description={t('callback.timeHelp')}
        isInvalid={message !== undefined}
        errorMessage={message}
      />
      <TextField
        id={`${idPrefix}-time`}
        type="time"
        label={t('callback.time')}
        isRequired
        isReadOnly={readOnly}
        value={slot.time}
        onChange={(time) => onChange({ ...slot, time })}
        isInvalid={message !== undefined}
      />
    </div>
  );
}

/** placeholder rows the size of real ones while the list loads */
export function CallbackSkeleton({ label }: { label: string }) {
  return (
    <div className="aw-callback-skeleton" role="status" aria-busy="true" aria-label={label}>
      {[0, 1].map((row) => (
        <span key={row} className="aw-callback-skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}

function CallbackIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
      <path d="M15 3h6v6M21 3l-6 6" />
    </svg>
  );
}
