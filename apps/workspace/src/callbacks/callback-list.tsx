/**
 * #1061 the "Callbacks" tab of the work list: due callbacks first, each with call / move / cancel.
 * The parent (WorkspaceApp) owns the data and the API calls; this file only shows them.
 */
import { useState } from 'react';
import { Button, Dialog, StatusChip, TextField } from '@d-contact/ui-react';
import { useTranslation } from '@d-contact/i18n/react';
import type { AgentCallback } from './callback-api.js';
import { localParts, slotInstant } from './callback-model.js';
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
    item.customerVisible ? (item.contactName ?? item.number ?? '—') : t('callback.customerHidden');

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
      <p className="aw-copy">…</p>
    ) : (
      <div className="aw-empty">
        <strong>{t('callback.empty')}</strong>
        <span>{t('callback.emptyHint')}</span>
      </div>
    );
  }

  const chosen = slotInstant(slot.date, slot.time, new Date(now));
  const problem = 'problem' in chosen ? chosen.problem : undefined;

  return (
    <>
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
                  onPress={() => onDial(item)}
                >
                  {t('callback.dial')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy}
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
        title={t('callback.rescheduleTitle')}
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
        <div className="aw-callback-slot">
          <TextField
            type="date"
            label={t('callback.date')}
            isRequired
            value={slot.date}
            onChange={(date) => setSlot((current) => ({ ...current, date }))}
            isInvalid={attempted && problem !== undefined}
          />
          <TextField
            type="time"
            label={t('callback.time')}
            isRequired
            value={slot.time}
            onChange={(time) => setSlot((current) => ({ ...current, time }))}
            isInvalid={attempted && problem !== undefined}
          />
        </div>
        <p
          className="aw-callback-help"
          data-invalid={attempted && problem ? 'true' : undefined}
          role={attempted && problem ? 'alert' : undefined}
        >
          {attempted && problem
            ? t(
                problem === 'missing'
                  ? 'callback.timeMissing'
                  : problem === 'tooSoon'
                    ? 'callback.timeTooSoon'
                    : 'callback.timeTooFar',
              )
            : t('callback.timeHelp')}
        </p>
      </Dialog>
      <Dialog
        role="alertdialog"
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
                void onCancel(cancelling).then((done) => done && close());
              }}
            >
              {t('callback.cancelConfirm')}
            </Button>
          </>
        )}
      >
        <p className="aw-copy">
          {cancelling
            ? t('callback.cancelCopy', { name: name(cancelling), when: when(cancelling) })
            : null}
        </p>
      </Dialog>
    </>
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
