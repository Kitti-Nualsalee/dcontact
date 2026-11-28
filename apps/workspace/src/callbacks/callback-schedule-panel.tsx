/**
 * #1061 "Callback" tab of the work panel: schedule a callback to the customer of the work being handled.
 * Rendered with `key={workId}`, so a draft belongs to one work item; nothing is stored in localStorage (PII).
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Select, TextField, toastQueue } from '@d-contact/ui-react';
import { useTranslation } from '@d-contact/i18n/react';
import type { LinkedCustomer } from '../work-customer-panel.js';
import type { CallbackApi, CallbackOptions } from './callback-api.js';
import {
  CALLBACK_NOTE_MAX,
  callbackErrorKey,
  slotInstant,
  suggestedSlot,
  type CallbackErrorKey,
} from './callback-model.js';
import { CallbackSkeleton, SlotFields, useCallbackWhen } from './callback-list.js';
import './callbacks.css';

interface Props {
  api: CallbackApi;
  workId: string;
  /** undefined = not loaded yet, null = no customer linked */
  customer: LinkedCustomer | null | undefined;
  locale: string;
  onPickCustomer(): void;
  onShowList(): void;
  onScheduled(): void;
  /** changes when the callbacks list changes (a callback cancelled or moved), so "already scheduled" is read again */
  listRevision: string;
}

type Load =
  | { status: 'loading' }
  | { status: 'ready'; options: CallbackOptions }
  | { status: 'failed'; error: CallbackErrorKey };

export function CallbackSchedulePanel({
  api,
  workId,
  customer,
  locale,
  onPickCustomer,
  onShowList,
  onScheduled,
  listRevision,
}: Props) {
  const { t } = useTranslation('workspace');
  const formatWhen = useCallbackWhen(locale);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [identityId, setIdentityId] = useState('');
  const [slot, setSlot] = useState(() => suggestedSlot(new Date()));
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [phase, setPhase] = useState<'editing' | 'pending' | 'scheduled'>('editing');
  const [error, setError] = useState<CallbackErrorKey>();
  const [scheduledWhen, setScheduledWhen] = useState('');
  const commandId = useRef(crypto.randomUUID());
  const titleRef = useRef<HTMLHeadingElement>(null);
  const customerId = customer?.id;

  // the server knows which customer the work is linked to; the Customer 360 panel only says when it changes
  useEffect(() => {
    let active = true;
    setLoad({ status: 'loading' });
    api.options(workId).then(
      (options) => {
        if (!active) return;
        setLoad({ status: 'ready', options });
        const first = options.numbers.find((number) => number.dialable);
        setIdentityId((current) =>
          options.numbers.some((number) => number.identityId === current && number.dialable)
            ? current
            : (first?.identityId ?? ''),
        );
      },
      (reason: unknown) =>
        active && setLoad({ status: 'failed', error: callbackErrorKey(reason).key }),
    );
    return () => {
      active = false;
    };
  }, [api, workId, customerId, listRevision]);

  const chosen = slotInstant(slot.date, slot.time, new Date());
  const timeProblem = 'problem' in chosen ? chosen.problem : undefined;
  const options = load.status === 'ready' ? load.options : undefined;
  const dialable = options?.numbers.filter((number) => number.dialable) ?? [];
  const locked = phase === 'pending';
  const blockedReason =
    customer === null || (load.status === 'failed' && load.error === 'contactRequired')
      ? 'unlinked'
      : options?.existingCallbackId
        ? 'existing'
        : options && !options.queue
          ? 'noVoiceQueue'
          : options && dialable.length === 0
            ? 'noNumber'
            : undefined;

  async function submit() {
    if (!options || blockedReason || locked) return;
    setAttempted(true);
    if (!('at' in chosen) || !identityId) {
      document.getElementById(identityId ? 'callback-date' : 'callback-number')?.focus();
      return;
    }
    setPhase('pending');
    setError(undefined);
    try {
      await api.schedule({
        commandId: commandId.current,
        interactionId: workId,
        identityId,
        requestedFor: chosen.at.toISOString(),
        note: note.trim(),
      });
      const when = formatWhen(chosen.at.toISOString());
      setScheduledWhen(when);
      setPhase('scheduled');
      toastQueue.add(
        {
          title: t('callback.scheduledToast', {
            name: options.contactName ?? t('callback.customerMissing'),
            when,
          }),
          tone: 'success',
        },
        { timeout: 6000 },
      );
      onScheduled();
      requestAnimationFrame(() => titleRef.current?.focus());
    } catch (reason) {
      const outcome = callbackErrorKey(reason);
      if (!outcome.retry) commandId.current = crypto.randomUUID();
      setError(outcome.key);
      setPhase('editing');
    }
  }

  if (phase === 'scheduled') {
    return (
      <section className="aw-callback" aria-live="polite">
        <h3 ref={titleRef} tabIndex={-1} className="aw-detail-title">
          {t('callback.scheduled')}
        </h3>
        <dl className="aw-case-summary">
          <div>
            <dt>{t('callback.customer')}</dt>
            <dd>{options?.contactName ?? t('callback.customerMissing')}</dd>
          </div>
          <div>
            <dt>{t('callback.time')}</dt>
            <dd>{scheduledWhen}</dd>
          </div>
        </dl>
        <p className="aw-copy">{t('callback.scheduledCopy')}</p>
        <Button size="sm" variant="secondary" onPress={onShowList}>
          {t('callback.showList')}
        </Button>
      </section>
    );
  }

  return (
    <section className="aw-callback" aria-labelledby="callback-title">
      <h3 id="callback-title" ref={titleRef} tabIndex={-1} className="aw-detail-title">
        {t('callback.title')}
      </h3>
      <p className="aw-copy">{t('callback.copy')}</p>
      <dl className="aw-case-summary">
        <div>
          <dt>{t('callback.customer')}</dt>
          <dd>
            {options?.contactName ??
              customer?.displayName ??
              (load.status === 'loading' ? '' : t('callback.customerMissing'))}
          </dd>
        </div>
        {options?.queue ? (
          <div>
            <dt>{t('callback.queue')}</dt>
            <dd>{options.queue.name}</dd>
          </div>
        ) : null}
      </dl>
      {blockedReason === 'unlinked' ? (
        <div className="aw-case-banner" data-tone="attention" role="status">
          <p>{t('callback.unlinked')}</p>
          <Button size="sm" variant="secondary" onPress={onPickCustomer}>
            {t('callback.pickCustomer')}
          </Button>
        </div>
      ) : blockedReason === 'existing' ? (
        <div className="aw-case-banner" data-tone="brand" role="status">
          <p>{t('callback.existing')}</p>
          <Button size="sm" variant="secondary" onPress={onShowList}>
            {t('callback.showList')}
          </Button>
        </div>
      ) : blockedReason === 'noVoiceQueue' ? (
        <p className="aw-case-banner" data-tone="attention" role="status">
          {t('callback.error.noVoiceQueue')}
        </p>
      ) : blockedReason === 'noNumber' ? (
        <p className="aw-case-banner" data-tone="attention" role="status">
          {options?.numbers.length ? t('callback.numberNotDialable') : t('callback.numberNone')}
        </p>
      ) : null}
      {load.status === 'failed' && load.error !== 'contactRequired' ? (
        <p className="aw-case-banner" data-tone="critical" role="alert">
          {t(`callback.error.${load.error}`)}
        </p>
      ) : null}
      {error ? (
        <p className="aw-case-banner" data-tone="critical" role="alert">
          {t(`callback.error.${error}`)}
        </p>
      ) : null}
      {options && !blockedReason ? (
        <form
          className="aw-case-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Select
            id="callback-number"
            label={t('callback.number')}
            isRequired
            isDisabled={locked}
            selectedKey={identityId || null}
            onSelectionChange={(key) => setIdentityId(String(key ?? ''))}
            options={options.numbers.map((number) => ({
              id: number.identityId,
              label: number.value,
              isDisabled: !number.dialable,
            }))}
            description={
              options.numbers.length > dialable.length ? t('callback.numberNotDialable') : undefined
            }
          />
          <SlotFields
            idPrefix="callback"
            slot={slot}
            onChange={setSlot}
            problem={attempted ? timeProblem : undefined}
            readOnly={locked}
          />
          <TextField
            id="callback-note"
            multiline
            label={t('callback.note')}
            isReadOnly={locked}
            maxLength={CALLBACK_NOTE_MAX}
            value={note}
            onChange={setNote}
            description={`${t('callback.noteHelp')} · ${t('callback.noteCount', {
              count: [...note.trim()].length,
            })}`}
          />
          <div className="aw-callback-actions">
            <Button type="submit" variant="primary" isDisabled={locked}>
              {locked ? t('callback.pending') : t('callback.submit')}
            </Button>
          </div>
        </form>
      ) : load.status === 'loading' ? (
        <CallbackSkeleton label={t('callback.loading')} />
      ) : null}
    </section>
  );
}
