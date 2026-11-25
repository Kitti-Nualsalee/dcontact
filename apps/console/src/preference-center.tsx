import { useEffect, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  ConsoleApiError,
  type CallbackRequestInput,
  type ConsoleApi,
  type ContactChannel,
  type PreferenceDecision,
  type PreferenceHistory,
} from './console-api.js';

type Viewer = 'AGENT' | 'ADMIN' | 'COMPLIANCE';

/** Kept as a key so the text follows a language switch. */
interface Message {
  key:
    | 'loadFailed'
    | 'agentCannotAllow'
    | 'timezoneUnknown'
    | 'saved'
    | 'versionConflict'
    | 'relaxationNotAuthorized'
    | 'saveFailed'
    | 'callbackMissing'
    | 'callbackCreated'
    | 'callbackConflict'
    | 'callbackFailed'
    | 'reloadFailed';
  values?: Record<string, string | number>;
}

const channels: ContactChannel[] = ['LINE', 'EMAIL', 'VOICE', 'WEBCHAT', 'FACEBOOK', 'WHATSAPP'];
const purposes = ['SERVICE_NOTIFICATION', 'MARKETING', 'ACCOUNT_SECURITY'];

export function PreferenceCenter({
  api,
  contactId,
  viewer,
}: {
  api: ConsoleApi;
  contactId: string;
  viewer: Viewer;
}) {
  const { t, i18n } = useTranslation('governance');
  const [history, setHistory] = useState<PreferenceHistory>();
  const [channel, setChannel] = useState<ContactChannel>('LINE');
  const [purpose, setPurpose] = useState('SERVICE_NOTIFICATION');
  const [decision, setDecision] = useState<PreferenceDecision>('DEFER');
  const [timezone, setTimezone] = useState('Asia/Bangkok');
  const [windowStart, setWindowStart] = useState('09:00');
  const [windowEnd, setWindowEnd] = useState('18:00');
  const [evidenceRef, setEvidenceRef] = useState('customer-request');
  const [effective, setEffective] = useState<{
    decision?: PreferenceDecision;
    version: number;
    reason?: string;
  }>();
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<Message>();
  const [error, setError] = useState<Message>();
  const [callbackAt, setCallbackAt] = useState('');

  const refresh = async () => {
    const [nextHistory, nextEffective] = await Promise.all([
      api.preferenceHistory(contactId),
      api.effectivePreference({ contactId, channel, purpose }),
    ]);
    setHistory(nextHistory);
    setEffective(nextEffective);
  };

  useEffect(() => {
    void refresh().catch(() => setError({ key: 'loadFailed' }));
  }, [api, contactId, channel, purpose]);

  const version = history?.aggregateVersion ?? effective?.version ?? 0;
  const callbackVersion =
    history?.callbacks.find(
      (callback) => callback.channel === channel && callback.purpose === purpose,
    )?.version ?? 0;
  const cannotAllow = viewer === 'AGENT' && decision === 'ALLOW';
  const timezoneUnknown = timezone.trim().length === 0;

  async function savePreference() {
    if (cannotAllow) {
      setError({ key: 'agentCannotAllow' });
      return;
    }
    if (timezoneUnknown) {
      setError({ key: 'timezoneUnknown' });
      return;
    }
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await api.setPreference({
        contactId,
        channel,
        purpose,
        decision,
        timezone,
        preferredWindows: [
          { daysOfWeek: [1, 2, 3, 4, 5], startLocal: windowStart, endLocal: windowEnd },
        ],
        evidenceRef,
        expectedVersion: callbackVersion,
        commandId: crypto.randomUUID(),
      });
      setNotice({ key: 'saved', values: { version: result.aggregateVersion } });
      await refresh();
    } catch (caught) {
      if (caught instanceof ConsoleApiError && caught.code === 'VERSION_CONFLICT') {
        setError({ key: 'versionConflict' });
      } else if (
        caught instanceof ConsoleApiError &&
        caught.code === 'PREFERENCE_RELAXATION_NOT_AUTHORIZED'
      ) {
        setError({ key: 'relaxationNotAuthorized' });
      } else {
        setError({ key: 'saveFailed' });
      }
    } finally {
      setPending(false);
    }
  }

  async function requestCallback() {
    if (!callbackAt || timezoneUnknown) {
      setError({ key: 'callbackMissing' });
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const requestedAt = new Date(callbackAt).toISOString();
      const input: CallbackRequestInput = {
        contactId,
        channel,
        purpose,
        requestedAt,
        requestedTimezone: timezone,
        expiresAt: new Date(new Date(requestedAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
        evidenceRef,
        expectedVersion: version,
        commandId: crypto.randomUUID(),
      };
      await api.requestCallback(input);
      setNotice({ key: 'callbackCreated' });
      await refresh();
    } catch (caught) {
      setError({
        key:
          caught instanceof ConsoleApiError && caught.code === 'VERSION_CONFLICT'
            ? 'callbackConflict'
            : 'callbackFailed',
      });
    } finally {
      setPending(false);
    }
  }

  const historyEntries = [
    ...(history?.preferences ?? []).map((record) => ({
      id: `preference-${record.id}`,
      decision: record.decision ?? 'DEFER',
      title:
        record.mutationKind === 'REVOKE'
          ? t('preferenceCenter.history.revoked')
          : t('preferenceCenter.history.scope', {
              channel: record.channel ?? t('preferenceCenter.history.allChannels'),
              purpose: record.purpose ?? t('preferenceCenter.history.allPurposes'),
            }),
      at: record.occurredAt,
      version: record.version,
      actorClass: record.actorClass,
      outcome: record.mutationKind,
    })),
    ...(history?.callbacks ?? []).map((callback) => ({
      id: `callback-${callback.id}`,
      decision: 'DEFER' as PreferenceDecision,
      title: t('preferenceCenter.history.callback', {
        channel: callback.channel,
        purpose: callback.purpose,
      }),
      at: callback.requestedAt,
      version: callback.version,
      actorClass: callback.actorClass,
      outcome: callback.mutationKind,
    })),
  ].sort((left, right) => right.at.localeCompare(left.at));
  const visibleHistory = expanded ? historyEntries : historyEntries.slice(0, 3);
  return (
    <div className="preference-shell">
      <header className="preference-header">
        <strong>{t('preferenceCenter.brand')}</strong>
        <span>{t('preferenceCenter.product')}</span>
        <span className="preference-version">{t('preferenceCenter.version', { version })}</span>
      </header>
      <main className="preference-main">
        <div className="preference-heading">
          <div>
            <p className="eyebrow">{t('preferenceCenter.eyebrow')}</p>
            <h1>{t('preferenceCenter.title')}</h1>
            <p>{t('preferenceCenter.subtitle')}</p>
          </div>
          <span className="tenant-chip">{viewer}</span>
        </div>

        <section className="governance-status" aria-live="polite">
          <strong>
            {t('preferenceCenter.effective', {
              decision: effective?.decision ?? t('preferenceCenter.checking'),
            })}
          </strong>
          <span>{effective?.reason ?? t('preferenceCenter.allowMeaning')}</span>
        </section>
        {notice ? (
          <p className="governance-notice" role="status">
            {t(`preferenceCenter.messages.${notice.key}`, notice.values)}
          </p>
        ) : null}
        {error ? (
          <p className="warning" role="alert">
            {t(`preferenceCenter.messages.${error.key}`, error.values)}
          </p>
        ) : null}

        <div className="preference-grid">
          <section className="panel preference-form" aria-labelledby="preference-form-title">
            <div className="panel-title">
              <h2 id="preference-form-title">{t('preferenceCenter.form.title')}</h2>
              <Decision decision={decision} />
            </div>
            <label>
              {t('preferenceCenter.form.channel')}
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value as ContactChannel)}
              >
                {channels.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              {t('preferenceCenter.form.purpose')}
              <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
                {purposes.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>{t('preferenceCenter.form.decision')}</legend>
              <div className="decision-options">
                {(['BLOCK', 'DEFER', 'ALLOW'] as PreferenceDecision[]).map((item) => (
                  <label key={item} className={'decision-option ' + item.toLowerCase()}>
                    <input
                      type="radio"
                      name="decision"
                      checked={decision === item}
                      onChange={() => setDecision(item)}
                    />
                    {item}
                  </label>
                ))}
              </div>
            </fieldset>
            {viewer === 'AGENT' ? (
              <p className="field-note">{t('preferenceCenter.form.agentNote')}</p>
            ) : (
              <p className="field-note">{t('preferenceCenter.form.allowNote')}</p>
            )}
            <div className="form-row">
              <label>
                {t('preferenceCenter.form.timezone')}
                <input
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  aria-describedby="timezone-note"
                />
              </label>
              <label>
                {t('preferenceCenter.form.windowStart')}
                <input
                  type="time"
                  value={windowStart}
                  onChange={(event) => setWindowStart(event.target.value)}
                />
              </label>
              <label>
                {t('preferenceCenter.form.windowEnd')}
                <input
                  type="time"
                  value={windowEnd}
                  onChange={(event) => setWindowEnd(event.target.value)}
                />
              </label>
            </div>
            <p id="timezone-note" className="field-note">
              {t('preferenceCenter.form.timezoneNote')}
            </p>
            <label>
              {t('preferenceCenter.form.evidence')}
              <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} />
            </label>
            <button
              className="primary"
              disabled={pending || cannotAllow}
              onClick={() => void savePreference()}
            >
              {pending ? t('preferenceCenter.form.saving') : t('preferenceCenter.form.save')}
            </button>
          </section>

          <aside className="preference-side">
            <section className="panel" aria-labelledby="callback-title">
              <h2 id="callback-title">{t('preferenceCenter.callback.title')}</h2>
              <p className="field-note">{t('preferenceCenter.callback.note')}</p>
              <label>
                {t('preferenceCenter.callback.at')}
                <input
                  type="datetime-local"
                  value={callbackAt}
                  onChange={(event) => setCallbackAt(event.target.value)}
                />
              </label>
              <button
                className="secondary"
                disabled={pending}
                onClick={() => void requestCallback()}
              >
                {t('preferenceCenter.callback.submit')}
              </button>
            </section>
            <section className="panel">
              <h2>{t('preferenceCenter.propagation.title')}</h2>
              <p className="field-note">{t('preferenceCenter.propagation.note')}</p>
              <button
                className="secondary"
                disabled={pending}
                onClick={() => void refresh().catch(() => setError({ key: 'reloadFailed' }))}
              >
                {t('preferenceCenter.propagation.reload')}
              </button>
            </section>
          </aside>
        </div>

        <section className="panel preference-history" aria-labelledby="preference-history-title">
          <div className="panel-title">
            <div>
              <p className="eyebrow">{t('preferenceCenter.history.eyebrow')}</p>
              <h2 id="preference-history-title">{t('preferenceCenter.history.title')}</h2>
            </div>
            <span>{t('preferenceCenter.history.count', { count: historyEntries.length })}</span>
          </div>
          <ol>
            {visibleHistory.map((entry) => (
              <li key={entry.id}>
                <Decision decision={entry.decision} />
                <div>
                  <strong>{entry.title}</strong>
                  <span>
                    {t('preferenceCenter.history.versionPrefix', { version: entry.version })}{' '}
                    {new Intl.DateTimeFormat(i18n.language === 'en' ? 'en-GB' : 'th-TH', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(entry.at))}
                  </span>
                </div>
                <small>
                  {t('preferenceCenter.history.actor', {
                    actor: t(`preferenceCenter.actors.${actorKey(entry.actorClass)}`),
                    outcome: entry.outcome,
                  })}
                </small>
              </li>
            ))}
          </ol>
          {historyEntries.length > 3 ? (
            <button
              className="secondary"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded
                ? t('preferenceCenter.history.collapse')
                : t('preferenceCenter.history.expand')}
            </button>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function Decision({ decision }: { decision: PreferenceDecision }) {
  return <span className={'decision-badge ' + decision.toLowerCase()}>{decision}</span>;
}
function actorKey(actor: string): 'agent' | 'admin' | 'compliance' | 'system' {
  return actor === 'AGENT'
    ? 'agent'
    : actor === 'ADMIN'
      ? 'admin'
      : actor === 'COMPLIANCE'
        ? 'compliance'
        : 'system';
}
