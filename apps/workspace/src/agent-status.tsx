/**
 * #938 status picker page after login and the status selector in Workspace (docs/agent-readiness-setup.md)
 * display only — the order of preparing for calls and the API calls live in workspace-app.tsx (same view, no remount)
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select, type SelectOption } from '@d-contact/ui-react';
import type { AfterWork, NotReadyReason } from './agent-api.js';

export type StatusChoice =
  | { state: 'AVAILABLE' }
  | { state: 'BREAK'; reasonCode: string }
  | {
      state: 'OFFLINE';
    };
export type PrepStep = 'lease' | 'mic' | 'phone' | 'ready';
export type PrepStatus = 'wait' | 'run' | 'done' | 'fail';
export type PrepFailure = 'lease' | 'mic' | 'phone' | 'ready';

const LAST_CHOICE_KEY = 'dcontact.workspace.lastStatus';
const PREP_STEPS: PrepStep[] = ['lease', 'mic', 'phone', 'ready'];

/** latest status the Agent chose (remembered per browser), Ready the first time — owner decision item 6 */
export function lastStatusChoice(): StatusChoice {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAST_CHOICE_KEY) ?? 'null');
    if (value && typeof value === 'object' && 'state' in value) {
      const choice = value as Record<string, unknown>;
      if (choice.state === 'AVAILABLE' || choice.state === 'OFFLINE')
        return { state: choice.state };
      if (choice.state === 'BREAK' && typeof choice.reasonCode === 'string')
        return { state: 'BREAK', reasonCode: choice.reasonCode };
    }
  } catch {
    // unreadable = default
  }
  return { state: 'AVAILABLE' };
}

export function rememberStatusChoice(choice: StatusChoice): void {
  try {
    localStorage.setItem(LAST_CHOICE_KEY, JSON.stringify(choice));
  } catch {
    // if it cannot be remembered, keep using it in this page
  }
}

export function useReasonLabel(): (
  reasons: NotReadyReason[],
  code: string | null | undefined,
) => string {
  const { i18n } = useTranslation('workspace');
  const english = i18n.language.startsWith('en');
  return (reasons, code) => {
    const reason = reasons.find((item) => item.code === code);
    return reason ? (english ? reason.labelEn : reason.labelTh) : (code ?? '');
  };
}

/** self-ticking time in state (m:ss or h:mm:ss) */
export function useElapsed(since: string | null | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [since]);
  if (!since) return '';
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1_000));
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function StatusGate({
  agentName,
  reasons,
  initial,
  preparing,
  steps,
  failure,
  onEnter,
  onFallback,
}: {
  agentName: string;
  reasons: NotReadyReason[];
  initial: StatusChoice;
  preparing: boolean;
  steps: Partial<Record<PrepStep, PrepStatus>>;
  failure?: PrepFailure;
  onEnter: (choice: StatusChoice) => void;
  onFallback: () => void;
}) {
  const { t } = useTranslation('workspace');
  const reasonLabel = useReasonLabel();
  const titleId = useId();
  const [state, setState] = useState<StatusChoice['state']>(initial.state);
  const [reasonCode, setReasonCode] = useState<string | undefined>(
    initial.state === 'BREAK' && reasons.some((reason) => reason.code === initial.reasonCode)
      ? initial.reasonCode
      : undefined,
  );
  const choice: StatusChoice | undefined =
    state === 'BREAK' ? (reasonCode ? { state, reasonCode } : undefined) : { state };
  const showSteps = preparing || failure !== undefined;

  return (
    <section className="aw-gate" aria-labelledby={titleId}>
      <div className="aw-gate-card">
        <p className="aw-gate-eyebrow">{t('agentStatus.gate.eyebrow')}</p>
        <h2 id={titleId}>{t('agentStatus.gate.title', { name: agentName })}</h2>
        <p className="aw-gate-lead">{t('agentStatus.gate.lead')}</p>
        <fieldset className="aw-gate-options" disabled={preparing}>
          <legend className="aw-visually-hidden">{t('agentStatus.gate.legend')}</legend>
          {(['AVAILABLE', 'BREAK', 'OFFLINE'] as const).map((option) => (
            <div
              key={option}
              className={`aw-gate-option${state === option ? ' aw-gate-option-on' : ''}`}
            >
              <label className="aw-gate-option-label">
                <input
                  type="radio"
                  name="aw-gate-state"
                  value={option}
                  checked={state === option}
                  onChange={() => setState(option)}
                />
                <span
                  className={`aw-gate-dot aw-gate-dot-${option.toLowerCase()}`}
                  aria-hidden="true"
                />
                <span className="aw-gate-option-copy">
                  <strong>{t(`agentStatus.state.${option}`)}</strong>
                  <small>{t(`agentStatus.gate.hint.${option}`)}</small>
                </span>
              </label>
              {option === 'BREAK' && state === 'BREAK' ? (
                <div
                  className="aw-gate-reasons"
                  role="radiogroup"
                  aria-label={t('agentStatus.reasonLabel')}
                >
                  {reasons.map((reason) => (
                    <label
                      key={reason.code}
                      className={`aw-gate-pill${reasonCode === reason.code ? ' aw-gate-pill-on' : ''}`}
                    >
                      <input
                        type="radio"
                        name="aw-gate-reason"
                        value={reason.code}
                        checked={reasonCode === reason.code}
                        onChange={() => setReasonCode(reason.code)}
                      />
                      {reasonLabel(reasons, reason.code)}
                    </label>
                  ))}
                  {reasons.length === 0 ? <p>{t('agentStatus.noReasons')}</p> : null}
                </div>
              ) : null}
            </div>
          ))}
        </fieldset>
        {showSteps ? (
          <ol className="aw-gate-steps" aria-label={t('agentStatus.gate.stepsLabel')}>
            {PREP_STEPS.map((step) => (
              <li key={step} className={`aw-gate-step aw-gate-step-${steps[step] ?? 'wait'}`}>
                <span className="aw-gate-step-mark" aria-hidden="true" />
                {t(`agentStatus.prep.${step}`)}
                <span className="aw-visually-hidden">
                  {' '}
                  {t(`agentStatus.prepStatus.${steps[step] ?? 'wait'}`)}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        {failure ? (
          <div className="aw-gate-failure" role="alert">
            <strong>{t(`agentStatus.failure.${failure}.title`)}</strong>
            <span>{t(`agentStatus.failure.${failure}.fix`)}</span>
            <div className="aw-gate-actions">
              <Button variant="primary" onPress={() => choice && onEnter(choice)}>
                {t('agentStatus.gate.retry')}
              </Button>
              <Button onPress={onFallback} isDisabled={reasons.length === 0}>
                {t('agentStatus.gate.fallback', {
                  reason: reasonLabel(reasons, fallbackReason(reasons)),
                })}
              </Button>
            </div>
          </div>
        ) : (
          <div className="aw-gate-actions">
            <Button
              variant="primary"
              isDisabled={!choice || preparing}
              onPress={() => choice && onEnter(choice)}
            >
              {t(preparing ? 'agentStatus.gate.preparing' : 'agentStatus.gate.enter')}
            </Button>
            {state === 'BREAK' && !reasonCode ? (
              <span className="aw-gate-note">{t('agentStatus.gate.pickReason')}</span>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/** reason used when preparing for calls fails: back-office work, or if none = the first enabled reason */
export function fallbackReason(reasons: NotReadyReason[]): string | undefined {
  return (reasons.find((reason) => reason.code === 'BACK_OFFICE') ?? reasons[0])?.code;
}

const choiceKey = (choice: StatusChoice) =>
  choice.state === 'BREAK' ? `BREAK:${choice.reasonCode}` : choice.state;
const keyChoice = (key: string): StatusChoice =>
  key.startsWith('BREAK:')
    ? { state: 'BREAK', reasonCode: key.slice('BREAK:'.length) }
    : { state: key === 'AVAILABLE' ? 'AVAILABLE' : 'OFFLINE' };

export function StatusSelector({
  state,
  reasonCode,
  since,
  reasons,
  afterWork,
  changedBy,
  pending,
  systemLabel,
  onChange,
  onAfterWork,
}: {
  state: 'OFFLINE' | 'AVAILABLE' | 'RESERVED' | 'BUSY' | 'ACW' | 'BREAK';
  /** #1044 what the system state means when it comes from web chat instead of a call */
  systemLabel?: string;
  reasonCode: string | null | undefined;
  changedBy?: 'AGENT' | 'SUPERVISOR' | 'SYSTEM';
  since: string | null | undefined;
  reasons: NotReadyReason[];
  afterWork: AfterWork;
  pending: boolean;
  onChange: (choice: StatusChoice) => void;
  onAfterWork: (afterWork: AfterWork) => void;
}) {
  const { t } = useTranslation('workspace');
  const reasonLabel = useReasonLabel();
  const elapsed = useElapsed(since);
  const system = state === 'RESERVED' || state === 'BUSY' || state === 'ACW';
  // a BREAK set by the system without a reason = router cooldown (did not take an offered call)
  const cooldown = state === 'BREAK' && !reasonCode && changedBy !== 'SUPERVISOR';
  const options: SelectOption[] = [
    { id: 'AVAILABLE', label: t('agentStatus.state.AVAILABLE') },
    ...reasons.map((reason) => ({
      id: `BREAK:${reason.code}`,
      label: t('agentStatus.notReadyWith', { reason: reasonLabel(reasons, reason.code) }),
    })),
    // a reason the Admin already disabled but the Agent is still in — still show the current value
    ...(state === 'BREAK' && reasonCode && !reasons.some((reason) => reason.code === reasonCode)
      ? [
          {
            id: `BREAK:${reasonCode}`,
            label: t('agentStatus.notReadyWith', { reason: reasonCode }),
            isDisabled: true,
          },
        ]
      : []),
    // a Supervisor set Not Ready without choosing a reason from the list
    ...(state === 'BREAK' && !reasonCode
      ? [{ id: 'BREAK:', label: t('agentStatus.state.BREAK'), isDisabled: true }]
      : []),
    { id: 'OFFLINE', label: t('agentStatus.state.OFFLINE') },
  ];
  const afterWorkOptions: SelectOption[] = [
    { id: 'AVAILABLE', label: t('agentStatus.state.AVAILABLE') },
    ...reasons.map((reason) => ({
      id: `BREAK:${reason.code}`,
      label: t('agentStatus.notReadyWith', { reason: reasonLabel(reasons, reason.code) }),
    })),
  ];
  return (
    <div className="aw-status-select">
      {system || cooldown ? (
        <>
          <span
            className={`aw-chip aw-status-system aw-status-${state.toLowerCase()}`}
            role="status"
          >
            {cooldown
              ? t('agentStatus.cooldown')
              : system && systemLabel
                ? systemLabel
                : t(`agentState.${state}`)}
            {elapsed ? <span className="aw-status-elapsed"> · {elapsed}</span> : null}
          </span>
          {system ? (
            <Select
              className="aw-status-afterwork"
              label={t('agentStatus.afterWork')}
              options={afterWorkOptions}
              selectedKey={
                afterWork.state === 'BREAK' ? `BREAK:${afterWork.reasonCode}` : 'AVAILABLE'
              }
              isDisabled={pending}
              onSelectionChange={(key) => {
                const choice = keyChoice(String(key));
                onAfterWork(
                  choice.state === 'BREAK'
                    ? { state: 'BREAK', reasonCode: choice.reasonCode }
                    : { state: 'AVAILABLE' },
                );
              }}
            />
          ) : null}
        </>
      ) : (
        <>
          <span className={`aw-gate-dot aw-gate-dot-${state.toLowerCase()}`} aria-hidden="true" />
          <Select
            className="aw-status-current"
            aria-label={t('agentStatus.selectorLabel')}
            options={options}
            selectedKey={
              state === 'BREAK'
                ? `BREAK:${reasonCode ?? ''}`
                : choiceKey({ state: state === 'AVAILABLE' ? 'AVAILABLE' : 'OFFLINE' })
            }
            isDisabled={pending}
            onSelectionChange={(key) => onChange(keyChoice(String(key)))}
          />
          {elapsed ? (
            <span
              className="aw-status-elapsed"
              aria-label={t('agentStatus.elapsedLabel', { time: elapsed })}
            >
              {elapsed}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

export function SupervisorNotice({
  name,
  state,
  reasonLabel,
  note,
  since,
  onAcknowledge,
}: {
  name: string | null | undefined;
  state: 'OFFLINE' | 'AVAILABLE' | 'RESERVED' | 'BUSY' | 'ACW' | 'BREAK';
  reasonLabel?: string;
  note: string | null | undefined;
  since: string | null | undefined;
  onAcknowledge: () => void;
}) {
  const { t, i18n } = useTranslation('workspace');
  const time = since
    ? new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(
        new Date(since),
      )
    : '';
  return (
    <div className="aw-supervisor-notice" role="status">
      <span>
        {t('agentStatus.supervisor.changed', {
          name: name ?? t('agentStatus.supervisor.someone'),
          time,
          state: reasonLabel
            ? t('agentStatus.notReadyWith', { reason: reasonLabel })
            : t(
                `agentStatus.state.${state === 'AVAILABLE' ? 'AVAILABLE' : state === 'BREAK' ? 'BREAK' : 'OFFLINE'}`,
              ),
        })}
        {note ? <> · {t('agentStatus.supervisor.note', { note })}</> : null}
      </span>
      <Button size="sm" onPress={onAcknowledge}>
        {t('agentStatus.supervisor.acknowledge')}
      </Button>
    </div>
  );
}
