/**
 * #1054: Customer channels › LINE settings
 *
 * - `ADMIN` edits; `SUPERVISOR` sees the same page read-only (the API says which with `canEdit`)
 * - the switch is part of the form and saved with the other fields, so there is one primary button
 * - a stored channel secret / access token is never shown: only "Saved (…abcd)" and a way to replace it
 * - real permission is at the API on every request — `canEdit` here only decides what to draw
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Button, Select, StatusChip, Switch, TextField, toastQueue } from '@d-contact/ui-react';
import { useShellTokens } from '../shell/tokens.js';
import { LineApiError, type LineApi, type LineSettings } from './api.js';
import {
  DEFAULT_IDLE_MINUTES,
  FIELD_ORDER,
  IDLE_MINUTES_RANGE,
  MAX_AUTO_REPLY,
  draftFrom,
  enableRequirements,
  hintText,
  isDirty,
  saveInput,
  serverFieldError,
  validateDraft,
  webhookUrl,
  type FieldErrors,
  type FieldKey,
  type LineDraft,
} from './model.js';
import './line-settings.css';

type Loaded =
  | { phase: 'loading' }
  | { phase: 'ready'; settings: LineSettings }
  | { phase: 'failed'; status: number };

type SaveFailure =
  'network' | 'conflict' | 'forbidden' | 'lineUnavailable' | 'secretStore' | 'rejected';

const COPIED_MS = 2000;

/** moves focus to the first control inside a field wrapper after React has drawn the new state */
function focusField(key: FieldKey) {
  window.setTimeout(() => {
    document
      .getElementById(`lc-field-${key}`)
      ?.querySelector<HTMLElement>('button:not([disabled]), input, textarea')
      ?.focus();
  }, 0);
}

export function LineSettingsPage({
  api,
  apiBaseUrl,
  onSignIn,
}: {
  api: LineApi;
  /** base URL the Console reaches the API with; LINE must call the origin the API is served from */
  apiBaseUrl: string;
  onSignIn?: () => void;
}) {
  const { t: translate } = useTranslation('lineChannel');
  const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
  const { locale } = useLocale();
  const ready = useShellTokens();
  const headingId = useId();
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' });
  const [draft, setDraft] = useState<LineDraft>();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<SaveFailure>();
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  // focus waits until the form is enabled again: a field that is disabled while saving cannot take focus
  const [focusRequest, setFocusRequest] = useState<FieldKey>();

  const load = useCallback(async () => {
    setLoaded({ phase: 'loading' });
    try {
      const settings = await api.get();
      setLoaded({ phase: 'ready', settings });
      setDraft(draftFrom(settings.channel));
    } catch (error) {
      setLoaded({ phase: 'failed', status: error instanceof LineApiError ? error.status : 500 });
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  useEffect(() => {
    if (!focusRequest || pending) return;
    focusField(focusRequest);
    setFocusRequest(undefined);
  }, [focusRequest, pending]);

  const settings = loaded.phase === 'ready' ? loaded.settings : undefined;
  const base = useMemo(() => (settings ? draftFrom(settings.channel) : undefined), [settings]);
  const dirty = !!draft && !!base && isDirty(draft, base);
  // a page with unsaved edits asks before the tab closes or the Console router leaves (it re-dispatches this event)
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!ready || loaded.phase === 'loading' || (loaded.phase === 'ready' && !draft)) {
    return (
      <main className="lc" aria-busy="true">
        <p role="status" className="lc__sr">
          {t('loading')}
        </p>
        <div className="lc__skeleton" aria-hidden="true">
          <span className="lc__skeleton-line lc__skeleton-line--title" />
          <span className="lc__skeleton-block" />
          <span className="lc__skeleton-block" />
        </div>
      </main>
    );
  }

  if (loaded.phase === 'failed') {
    const { status } = loaded;
    if (status === 404 || status === 403) {
      const key = status === 404 ? 'locked' : 'forbidden';
      return (
        <main className="lc" aria-labelledby={headingId}>
          <h1 id={headingId} className="lc__title">
            {t('title')}
          </h1>
          <section className="lc__card lc__card--notice" role="status">
            <h2>{t(`${key}.title`)}</h2>
            <p>{t(`${key}.body`)}</p>
          </section>
        </main>
      );
    }
    return (
      <main className="lc" aria-labelledby={headingId}>
        <h1 id={headingId} className="lc__title">
          {t('title')}
        </h1>
        <div className="lc__banner lc__banner--critical" role="alert">
          <p>{status === 401 ? t('unauthorized') : t('loadFailed')}</p>
          {status === 401 && onSignIn ? (
            <Button size="sm" onPress={onSignIn}>
              {t('signIn')}
            </Button>
          ) : null}
          <Button size="sm" onPress={() => void load()}>
            {t('retryLoad')}
          </Button>
        </div>
      </main>
    );
  }

  if (!settings || !draft || !base) return null;
  const { channel, queues, canEdit } = settings;
  const first = channel.id === null;
  const disabled = !canEdit || pending;
  const requirements = enableRequirements(draft, channel);
  const missing =
    Number(!requirements.queue) + Number(!requirements.secret) + Number(!requirements.token);
  const statusKey = first ? 'notConfigured' : channel.enabled ? 'enabled' : 'disabled';
  const statusTone = channel.enabled && !first ? 'success' : 'neutral';
  const url = webhookUrl(channel.webhookPath, apiBaseUrl, window.location.origin);
  const queueOptions = queues.map((queue) => ({
    id: queue.id,
    label: queue.teamName ? `${queue.name} · ${queue.teamName}` : queue.name,
  }));
  // a saved queue that is no longer in the list must stay visible so the form does not silently change it
  const selectedQueue =
    draft.queueId && !queueOptions.some((option) => option.id === draft.queueId)
      ? [...queueOptions, { id: draft.queueId, label: draft.queueId }]
      : queueOptions;

  const update = (change: Partial<LineDraft>, clear: FieldKey[] = []) => {
    setDraft({ ...draft, ...change });
    setFailure(undefined);
    if (clear.length)
      setErrors((current) => {
        const next = { ...current };
        for (const key of clear) delete next[key];
        return next;
      });
  };

  const failFields = (next: FieldErrors) => {
    setErrors(next);
    const target = FIELD_ORDER.find((key) => next[key]);
    if (target) setFocusRequest(target);
  };

  const save = async () => {
    setAttempted(true);
    setFailure(undefined);
    const found = validateDraft(draft, channel);
    if (Object.keys(found).length) {
      failFields(found);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const saved = await api.save(saveInput(draft, channel.revision));
      setLoaded({ phase: 'ready', settings: saved });
      setDraft(draftFrom(saved.channel));
      setAttempted(false);
      toastQueue.add({ title: t('saved'), tone: 'success' }, { timeout: 4000 });
    } catch (error) {
      if (!(error instanceof LineApiError)) {
        setFailure('network');
      } else if (error.code === 'REVISION_CONFLICT') {
        // keep what the person typed; only the revision moves on so the next save is against the latest
        setFailure('conflict');
        try {
          const latest = await api.get();
          setLoaded({ phase: 'ready', settings: latest });
        } catch {
          // the banner already tells the person to reload
        }
      } else if (error.status === 403) {
        setFailure('forbidden');
      } else if (error.code === 'LINE_TOKEN_REJECTED') {
        // LINE did not accept the token: the message belongs under that field and the new token stays typed
        failFields({ accessToken: 'errors.tokenRejected' });
      } else if (error.code === 'LINE_UNAVAILABLE') {
        setFailure('lineUnavailable');
      } else if (error.code === 'SECRET_STORE_UNAVAILABLE') {
        setFailure('secretStore');
      } else if (error.code === 'VALIDATION_FAILED') {
        const mapped = serverFieldError(error, draft);
        if (mapped) failFields({ [mapped.field]: mapped.messageKey });
        else setFailure('rejected');
      } else {
        setFailure('network');
      }
    } finally {
      setPending(false);
    }
  };

  const copy = () => {
    if (!url) return;
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      })
      .catch(() => undefined);
  };

  const error = (key: FieldKey) =>
    errors[key] ? t(errors[key]!, { ...IDLE_MINUTES_RANGE, limit: MAX_AUTO_REPLY }) : undefined;

  /** a stored value shows as a hint with a "replace" button; an empty one (or a replacement) is a password field */
  const secretField = (input: {
    key: 'channelSecret' | 'accessToken';
    stored: boolean;
    hint: string | null;
    replacing: boolean;
    replaceKey: 'replaceSecret' | 'replaceToken';
    label: string;
    hintText: string;
    placeholder: string;
  }) => {
    const showInput = !input.stored || input.replacing;
    return (
      <div id={`lc-field-${input.key}`}>
        {showInput ? (
          <>
            <TextField
              type="password"
              label={input.label}
              value={draft[input.key]}
              onChange={(value) => update({ [input.key]: value }, [input.key])}
              isDisabled={disabled}
              isInvalid={!!errors[input.key]}
              description={input.hintText}
              errorMessage={error(input.key)}
              placeholder={input.placeholder}
              autoComplete="off"
              spellCheck="false"
            />
            {input.stored && canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                isDisabled={pending}
                onPress={() => {
                  update({ [input.key]: '', [input.replaceKey]: false } as Partial<LineDraft>, [
                    input.key,
                  ]);
                  // the button goes away: keep the keyboard on this field, at its "Replace" button
                  focusField(input.key);
                }}
              >
                {t('secret.keep')}
              </Button>
            ) : null}
          </>
        ) : (
          <div className="lc__stored" role="group" aria-label={input.label}>
            <p className="lc__stored-label">{input.label}</p>
            <p className="lc__stored-value">
              {input.hint
                ? t('secret.saved', { hint: hintText(input.hint) })
                : t('secret.savedNoHint')}
            </p>
            {canEdit ? (
              <Button
                size="sm"
                isDisabled={pending}
                aria-label={t('secret.replaceLabel', { name: input.label })}
                onPress={() => {
                  update({ [input.replaceKey]: true });
                  focusField(input.key);
                }}
              >
                {t('secret.replace')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  const verified =
    channel.credentialsVerifiedAt && channel.botName
      ? t('connection.verified', {
          bot: channel.botName,
          when: new Date(channel.credentialsVerifiedAt).toLocaleString(locale),
        })
      : channel.hasAccessToken
        ? t('connection.notVerified')
        : t('connection.none');

  const failureText: Record<SaveFailure, string> = {
    network: t('saveFailed'),
    conflict: t('conflict'),
    forbidden: t('readOnly'),
    lineUnavailable: t('lineUnavailable'),
    secretStore: t('secretStoreUnavailable'),
    rejected: t('errors.rejected'),
  };

  return (
    <main className="lc" aria-labelledby={headingId}>
      <header className="lc__header">
        <h1 id={headingId} className="lc__title">
          {t('title')}
          <StatusChip status={statusTone}>{t(`status.${statusKey}`)}</StatusChip>
        </h1>
        <p className="lc__lead">{t('description')}</p>
      </header>

      {!canEdit ? (
        <p className="lc__banner" role="status">
          {t('readOnly')}
        </p>
      ) : null}
      {first && canEdit ? (
        <p className="lc__banner" role="status">
          {t('firstTime', { minutes: DEFAULT_IDLE_MINUTES })}
        </p>
      ) : null}
      {failure ? (
        <div className="lc__banner lc__banner--critical" role="alert">
          <p>{failureText[failure]}</p>
          {failure === 'network' || failure === 'lineUnavailable' ? (
            <Button size="sm" isDisabled={pending} onPress={() => void save()}>
              {t('retrySave')}
            </Button>
          ) : null}
          {failure === 'conflict' ? (
            <Button
              size="sm"
              onPress={() => {
                setDraft(draftFrom(channel));
                setErrors({});
                setFailure(undefined);
              }}
            >
              {t('conflictUseLatest')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="lc__grid">
        <div className="lc__main">
          <section className="lc__card" aria-labelledby={`${headingId}-routing`}>
            <h2 id={`${headingId}-routing`}>{t('routing.title')}</h2>
            <p className="lc__sub">{t('routing.sub')}</p>
            <div className="lc__stack">
              <div id="lc-field-queue">
                <Select
                  label={t('routing.queue')}
                  placeholder={t('routing.queuePlaceholder')}
                  selectedKey={draft.queueId}
                  onSelectionChange={(key) =>
                    update({ queueId: key === null ? null : String(key) }, ['queue'])
                  }
                  options={selectedQueue}
                  isDisabled={disabled}
                  isInvalid={!!errors.queue}
                  description={t('routing.queueHint')}
                  errorMessage={error('queue')}
                />
              </div>
              <div id="lc-field-idle">
                <TextField
                  type="number"
                  inputMode="numeric"
                  label={t('routing.idle')}
                  value={draft.idleMinutes}
                  onChange={(value) => update({ idleMinutes: value }, ['idle'])}
                  isDisabled={disabled}
                  isInvalid={!!errors.idle}
                  description={t('routing.idleHint', IDLE_MINUTES_RANGE)}
                  errorMessage={error('idle')}
                />
              </div>
            </div>
          </section>

          <section className="lc__card" aria-labelledby={`${headingId}-connection`}>
            <h2 id={`${headingId}-connection`}>{t('connection.title')}</h2>
            <p className="lc__sub">{t('connection.sub')}</p>
            <div className="lc__stack">
              <div id="lc-field-lineChannelId">
                <TextField
                  inputMode="numeric"
                  label={t('connection.channelId')}
                  value={draft.lineChannelId}
                  onChange={(value) => update({ lineChannelId: value }, ['lineChannelId'])}
                  isDisabled={disabled}
                  isInvalid={!!errors.lineChannelId}
                  description={t('connection.channelIdHint')}
                  errorMessage={error('lineChannelId')}
                  autoComplete="off"
                />
              </div>
              {secretField({
                key: 'channelSecret',
                stored: channel.hasChannelSecret,
                hint: channel.channelSecretHint,
                replacing: draft.replaceSecret,
                replaceKey: 'replaceSecret',
                label: t('connection.secret'),
                hintText: t('connection.secretHint'),
                placeholder: t('connection.typeNew'),
              })}
              {secretField({
                key: 'accessToken',
                stored: channel.hasAccessToken,
                hint: channel.accessTokenHint,
                replacing: draft.replaceToken,
                replaceKey: 'replaceToken',
                label: t('connection.token'),
                hintText: t('connection.tokenHint'),
                placeholder: t('connection.typeNew'),
              })}
              <p className="lc__verified" role="status">
                {verified}
              </p>
            </div>
          </section>

          <section className="lc__card" aria-labelledby={`${headingId}-reply`}>
            <h2 id={`${headingId}-reply`}>{t('autoReply.title')}</h2>
            <p className="lc__sub">{t('autoReply.sub')}</p>
            <div id="lc-field-autoReply">
              <TextField
                multiline
                label={t('autoReply.label')}
                value={draft.autoReplyText}
                onChange={(value) => update({ autoReplyText: value }, ['autoReply'])}
                isDisabled={disabled}
                isInvalid={!!errors.autoReply}
                description={`${draft.autoReplyText ? '' : `${t('autoReply.emptyHint')} · `}${t('autoReply.count', { count: [...draft.autoReplyText].length, limit: MAX_AUTO_REPLY })}`}
                errorMessage={
                  errors.autoReply ? t(errors.autoReply, { limit: MAX_AUTO_REPLY }) : undefined
                }
              />
            </div>
          </section>

          <section className="lc__card" aria-labelledby={`${headingId}-webhook`}>
            <h2 id={`${headingId}-webhook`}>{t('webhook.title')}</h2>
            <p className="lc__sub">{t('webhook.sub')}</p>
            {url ? (
              <pre className="lc__code lc__url" aria-label={t('webhook.label')} tabIndex={0}>
                <code>{url}</code>
              </pre>
            ) : (
              <p className="lc__empty">{t('webhook.afterSave')}</p>
            )}
            <div className="lc__actions">
              <Button size="sm" isDisabled={!url} onPress={copy}>
                {copied ? t('webhook.copied') : t('webhook.copy')}
              </Button>
              <span role="status" className="lc__sr">
                {copied ? t('webhook.copied') : ''}
              </span>
            </div>
            <h3 className="lc__subhead">{t('steps.title')}</h3>
            <ol className="lc__steps">
              {(['credentials', 'save', 'webhook', 'verify', 'autoResponse'] as const).map(
                (step) => (
                  <li key={step}>{t(`steps.${step}`)}</li>
                ),
              )}
            </ol>
            <p className="lc__sub">{t('quota')}</p>
          </section>
        </div>

        <aside className="lc__side">
          <section className="lc__card" aria-labelledby={`${headingId}-state`}>
            <h2 id={`${headingId}-state`}>{t('state.title')}</h2>
            <Switch
              isSelected={draft.enabled}
              onChange={(value) =>
                update({ enabled: value }, ['queue', 'channelSecret', 'accessToken'])
              }
              isDisabled={disabled}
            >
              {t('state.toggle')}
            </Switch>
            <p className="lc__sub">{t(channel.enabled ? 'state.onHint' : 'state.offHint')}</p>
            <h3 className="lc__subhead">{t('state.required')}</h3>
            <ul className="lc__checklist">
              {(
                [
                  ['queue', requirements.queue, 'state.needQueue'],
                  ['channelSecret', requirements.secret, 'state.needSecret'],
                  ['accessToken', requirements.token, 'state.needToken'],
                ] as const
              ).map(([field, met, label]) => (
                <li key={field} className={met ? 'lc__check lc__check--met' : 'lc__check'}>
                  <span aria-hidden="true" className="lc__check-mark">
                    {met ? '✓' : '!'}
                  </span>
                  <span>{t(label)}</span>
                  {!met && canEdit ? (
                    <Button size="sm" variant="ghost" onPress={() => focusField(field)}>
                      {t('state.goToField')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {attempted && draft.enabled && missing > 0 ? (
              <p className="lc__error" role="alert">
                {t('state.cannotEnable', { count: missing })}
              </p>
            ) : null}
          </section>

          {canEdit ? (
            <div className="lc__buttons">
              <Button
                variant="primary"
                isDisabled={pending || (!dirty && !first)}
                onPress={() => void save()}
              >
                {pending ? t('saving') : first ? t('saveFirst') : t('save')}
              </Button>
              <Button
                isDisabled={pending || !dirty}
                onPress={() => {
                  setDraft(base);
                  setErrors({});
                  setFailure(undefined);
                  setAttempted(false);
                }}
              >
                {t('cancel')}
              </Button>
            </div>
          ) : null}
          {settings.lastSaved ? (
            <p className="lc__meta">
              {settings.lastSaved.byName
                ? t('lastSaved', {
                    when: new Date(settings.lastSaved.at).toLocaleString(locale),
                    name: settings.lastSaved.byName,
                  })
                : t('lastSavedUnknown', {
                    when: new Date(settings.lastSaved.at).toLocaleString(locale),
                  })}
            </p>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
