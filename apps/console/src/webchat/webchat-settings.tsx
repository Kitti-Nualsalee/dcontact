/**
 * #1044: Customer channels › Web Chat settings
 *
 * - `ADMIN` edits; `SUPERVISOR` sees the same page read-only (the API says which with `canEdit`)
 * - the switch is part of the form and saved with the other fields, so there is one primary button
 * - real permission is at the API on every request — `canEdit` here only decides what to draw
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, Select, StatusChip, Switch, TextField, toastQueue } from '@d-contact/ui-react';
import { useShellTokens } from '../shell/tokens.js';
import { WebchatApiError, type WebchatApi, type WebchatSettings } from './api.js';
import {
  CAPACITY_RANGE,
  DEFAULT_CAPACITY,
  DEFAULT_IDLE_MINUTES,
  FIELD_ORDER,
  IDLE_MINUTES_RANGE,
  MAX_GREETING,
  MAX_ORIGINS,
  checkOrigin,
  draftFrom,
  embedSnippet,
  enableRequirements,
  isDirty,
  previewUrl,
  resolveApiBase,
  saveInput,
  serverFieldError,
  validateDraft,
  type FieldErrors,
  type FieldKey,
  type WebchatDraft,
} from './model.js';
import './webchat-settings.css';

type Loaded =
  | { phase: 'loading' }
  | { phase: 'ready'; settings: WebchatSettings }
  | { phase: 'failed'; status: number };

type SaveFailure = 'network' | 'conflict' | 'forbidden';

const COPIED_MS = 2000;

/** moves focus to the first control inside a field wrapper after React has drawn the new state */
function focusField(key: FieldKey | 'origin-input') {
  window.setTimeout(() => {
    document
      .getElementById(`wc-field-${key}`)
      ?.querySelector<HTMLElement>('button:not([disabled]), input, textarea')
      ?.focus();
  }, 0);
}

export function WebchatSettingsPage({
  api,
  apiBaseUrl,
  onSignIn,
}: {
  api: WebchatApi;
  /** base URL the Console reaches the API with; the embed code must use the one visitors can reach */
  apiBaseUrl: string;
  onSignIn?: () => void;
}) {
  const { t: translate } = useTranslation('webchat');
  const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
  const ready = useShellTokens();
  const headingId = useId();
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' });
  const [draft, setDraft] = useState<WebchatDraft>();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<SaveFailure>();
  const [pending, setPending] = useState(false);
  const [newOrigin, setNewOrigin] = useState('');
  const [originError, setOriginError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    setLoaded({ phase: 'loading' });
    try {
      const settings = await api.get();
      setLoaded({ phase: 'ready', settings });
      setDraft(draftFrom(settings.widget));
    } catch (error) {
      setLoaded({ phase: 'failed', status: error instanceof WebchatApiError ? error.status : 500 });
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const settings = loaded.phase === 'ready' ? loaded.settings : undefined;
  const base = useMemo(() => (settings ? draftFrom(settings.widget) : undefined), [settings]);
  const dirty = !!draft && !!base && isDirty(draft, base);
  // a page with unsaved edits asks before the tab closes or the Console router leaves (it re-dispatches this event)
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const apiBase = useMemo(() => resolveApiBase(apiBaseUrl, window.location.origin), [apiBaseUrl]);

  if (!ready || loaded.phase === 'loading' || (loaded.phase === 'ready' && !draft)) {
    return (
      <main className="wc" aria-busy="true">
        <p role="status" className="wc__sr">
          {t('loading')}
        </p>
        <div className="wc__skeleton" aria-hidden="true">
          <span className="wc__skeleton-line wc__skeleton-line--title" />
          <span className="wc__skeleton-block" />
          <span className="wc__skeleton-block" />
        </div>
      </main>
    );
  }

  if (loaded.phase === 'failed') {
    const { status } = loaded;
    if (status === 404 || status === 403) {
      const key = status === 404 ? 'locked' : 'forbidden';
      return (
        <main className="wc" aria-labelledby={headingId}>
          <h1 id={headingId} className="wc__title">
            {t('title')}
          </h1>
          <section className="wc__card wc__card--notice" role="status">
            <h2>{t(`${key}.title`)}</h2>
            <p>{t(`${key}.body`)}</p>
          </section>
        </main>
      );
    }
    return (
      <main className="wc" aria-labelledby={headingId}>
        <h1 id={headingId} className="wc__title">
          {t('title')}
        </h1>
        <div className="wc__banner wc__banner--critical" role="alert">
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
  const { widget, queues, canEdit, tenantId } = settings;
  const first = widget.id === null;
  const disabled = !canEdit || pending;
  const requirements = enableRequirements(draft);
  const missing = Number(!requirements.queue) + Number(!requirements.origin);
  const statusKey = first ? 'notConfigured' : widget.enabled ? 'enabled' : 'disabled';
  const statusTone = widget.enabled && !first ? 'success' : 'neutral';
  const snippet = widget.id ? embedSnippet({ apiBase, tenantId, widgetId: widget.id }) : undefined;
  const preview =
    widget.id && widget.enabled
      ? previewUrl({ apiBase, tenantId, widgetId: widget.id })
      : undefined;
  const queueOptions = queues.map((queue) => ({
    id: queue.id,
    label: queue.teamName ? `${queue.name} · ${queue.teamName}` : queue.name,
  }));
  // a saved queue that is no longer in the list must stay visible so the form does not silently change it
  const selectedQueue =
    draft.queueId && !queueOptions.some((option) => option.id === draft.queueId)
      ? [...queueOptions, { id: draft.queueId, label: draft.queueId }]
      : queueOptions;

  const update = (change: Partial<WebchatDraft>, clear: FieldKey[] = []) => {
    setDraft({ ...draft, ...change });
    setFailure(undefined);
    if (clear.length)
      setErrors((current) => {
        const next = { ...current };
        for (const key of clear) delete next[key];
        return next;
      });
  };

  const addOrigin = () => {
    const check = checkOrigin(newOrigin, draft.origins);
    if (!check) return;
    if (!check.ok) {
      setOriginError(check.messageKey);
      return;
    }
    update({ origins: [...draft.origins, check.origin] }, ['origins']);
    setNewOrigin('');
    setOriginError(undefined);
    focusField('origin-input');
  };
  const removeOrigin = (origin: string) => {
    const index = draft.origins.indexOf(origin);
    update({ origins: draft.origins.filter((value) => value !== origin) });
    // focus the row that moved up, or the add field when the last row went
    window.setTimeout(() => {
      const rows = document.querySelectorAll<HTMLElement>('.wc__origin-remove');
      (
        rows[index] ??
        rows[index - 1] ??
        document.querySelector<HTMLElement>('#wc-field-origin-input input')
      )?.focus();
    }, 0);
  };

  const failFields = (next: FieldErrors) => {
    setErrors(next);
    const first = FIELD_ORDER.find((key) => next[key]);
    if (first) focusField(first === 'origins' ? 'origin-input' : first);
  };

  const save = async () => {
    setAttempted(true);
    setFailure(undefined);
    const found = validateDraft(draft);
    if (Object.keys(found).length) {
      failFields(found);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const saved = await api.save(saveInput(draft, widget.revision));
      setLoaded({ phase: 'ready', settings: saved });
      setDraft(draftFrom(saved.widget));
      setAttempted(false);
      toastQueue.add({ title: t('saved'), tone: 'success' }, { timeout: 4000 });
    } catch (error) {
      if (!(error instanceof WebchatApiError)) {
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
      } else if (error.status === 400 && error.code === 'VALIDATION_FAILED') {
        const mapped = serverFieldError(error, draft);
        failFields({ [mapped?.field ?? 'queue']: mapped?.messageKey ?? 'errors.rejected' });
      } else {
        setFailure('network');
      }
    } finally {
      setPending(false);
    }
  };

  const copy = () => {
    if (!snippet) return;
    void navigator.clipboard
      ?.writeText(snippet)
      .then(() => {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      })
      .catch(() => undefined);
  };

  const error = (key: FieldKey) => (errors[key] ? t(errors[key]!) : undefined);

  return (
    <main className="wc" aria-labelledby={headingId}>
      <header className="wc__header">
        <h1 id={headingId} className="wc__title">
          {t('title')}
          <StatusChip status={statusTone}>{t(`status.${statusKey}`)}</StatusChip>
        </h1>
        <p className="wc__lead">{t('description')}</p>
      </header>

      {!canEdit ? (
        <p className="wc__banner" role="status">
          {t('readOnly')}
        </p>
      ) : null}
      {first && canEdit ? (
        <p className="wc__banner" role="status">
          {t('firstTime', { capacity: DEFAULT_CAPACITY, minutes: DEFAULT_IDLE_MINUTES })}
        </p>
      ) : null}
      {failure ? (
        <div className="wc__banner wc__banner--critical" role="alert">
          <p>
            {failure === 'network'
              ? t('saveFailed')
              : failure === 'conflict'
                ? t('conflict')
                : t('readOnly')}
          </p>
          {failure === 'network' ? (
            <Button size="sm" isDisabled={pending} onPress={() => void save()}>
              {t('retrySave')}
            </Button>
          ) : null}
          {failure === 'conflict' ? (
            <Button
              size="sm"
              onPress={() => {
                setDraft(draftFrom(widget));
                setErrors({});
                setFailure(undefined);
              }}
            >
              {t('conflictUseLatest')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="wc__grid">
        <div className="wc__main">
          <section className="wc__card" aria-labelledby={`${headingId}-routing`}>
            <h2 id={`${headingId}-routing`}>{t('routing.title')}</h2>
            <p className="wc__sub">{t('routing.sub')}</p>
            <div className="wc__stack">
              <div id="wc-field-queue">
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
              <div className="wc__pair">
                <div id="wc-field-capacity">
                  <TextField
                    type="number"
                    inputMode="numeric"
                    label={t('routing.capacity')}
                    value={draft.capacity}
                    onChange={(value) => update({ capacity: value }, ['capacity'])}
                    isDisabled={disabled}
                    isInvalid={!!errors.capacity}
                    description={t('routing.capacityHint')}
                    errorMessage={error('capacity')}
                  />
                </div>
                <div id="wc-field-idle">
                  <TextField
                    type="number"
                    inputMode="numeric"
                    label={t('routing.idle')}
                    value={draft.idleMinutes}
                    onChange={(value) => update({ idleMinutes: value }, ['idle'])}
                    isDisabled={disabled}
                    isInvalid={!!errors.idle}
                    description={t('routing.idleHint')}
                    errorMessage={error('idle')}
                  />
                </div>
              </div>
            </div>
          </section>

          <section
            className="wc__card"
            aria-labelledby={`${headingId}-origins`}
            id="wc-field-origins"
          >
            <h2 id={`${headingId}-origins`}>{t('origins.title')}</h2>
            <p className="wc__sub">{t('origins.sub', { limit: MAX_ORIGINS })}</p>
            {draft.origins.length === 0 ? (
              <p className="wc__empty">{t('origins.empty')}</p>
            ) : (
              <ul className="wc__origins" aria-label={t('origins.list')}>
                {draft.origins.map((origin) => (
                  <li key={origin} className="wc__origin">
                    <code className="wc__origin-text" title={origin}>
                      {origin}
                    </code>
                    {canEdit ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="wc__origin-remove"
                        isDisabled={pending}
                        aria-label={t('origins.remove', { origin })}
                        onPress={() => removeOrigin(origin)}
                      >
                        {t('origins.removeShort')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {errors.origins ? (
              <p className="wc__error" role="alert">
                {error('origins')}
              </p>
            ) : null}
            {canEdit ? (
              draft.origins.length >= MAX_ORIGINS ? (
                <p className="wc__sub" role="status">
                  {t('origins.limit', { limit: MAX_ORIGINS })}
                </p>
              ) : (
                <form
                  className="wc__add"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addOrigin();
                  }}
                >
                  <div id="wc-field-origin-input" className="wc__add-field">
                    <TextField
                      label={t('origins.newLabel')}
                      placeholder={t('origins.placeholder')}
                      value={newOrigin}
                      onChange={(value) => {
                        setNewOrigin(value);
                        setOriginError(undefined);
                      }}
                      isDisabled={pending}
                      isInvalid={!!originError}
                      errorMessage={
                        originError ? t(originError, { limit: MAX_ORIGINS }) : undefined
                      }
                      inputMode="url"
                      autoComplete="off"
                    />
                  </div>
                  <Button type="submit" isDisabled={pending || !newOrigin.trim()}>
                    {t('origins.add')}
                  </Button>
                </form>
              )
            ) : null}
          </section>

          <section className="wc__card" aria-labelledby={`${headingId}-welcome`}>
            <h2 id={`${headingId}-welcome`}>{t('welcome.title')}</h2>
            <p className="wc__sub">{t('welcome.sub')}</p>
            <div className="wc__pair">
              {(['greetingTh', 'greetingEn'] as const).map((key) => (
                <div key={key} id={`wc-field-${key}`}>
                  <TextField
                    multiline
                    label={t(key === 'greetingTh' ? 'welcome.th' : 'welcome.en')}
                    value={draft[key]}
                    onChange={(value) => update({ [key]: value }, [key])}
                    isDisabled={disabled}
                    isInvalid={!!errors[key]}
                    description={`${draft[key] ? '' : `${t('welcome.emptyHint')} · `}${t('welcome.count', { count: draft[key].length, limit: MAX_GREETING })}`}
                    errorMessage={
                      errors[key] ? t(errors[key]!, { limit: MAX_GREETING }) : undefined
                    }
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="wc__card" aria-labelledby={`${headingId}-code`}>
            <h2 id={`${headingId}-code`}>{t('snippet.title')}</h2>
            <p className="wc__sub">{t('snippet.sub')}</p>
            {snippet ? (
              <pre className="wc__code" aria-label={t('snippet.label')} tabIndex={0}>
                <code>{snippet}</code>
              </pre>
            ) : (
              <p className="wc__empty">{t('snippet.afterSave')}</p>
            )}
            <div className="wc__actions">
              <Button size="sm" isDisabled={!snippet} onPress={copy}>
                {copied ? t('snippet.copied') : t('snippet.copy')}
              </Button>
              <span role="status" className="wc__sr">
                {copied ? t('snippet.copied') : ''}
              </span>
              {preview ? (
                <a className="wc__link" href={preview} target="_blank" rel="noopener noreferrer">
                  {t('preview.open')}
                </a>
              ) : null}
            </div>
            {preview ? <p className="wc__sub">{t('preview.hint')}</p> : null}
          </section>
        </div>

        <aside className="wc__side">
          <section className="wc__card" aria-labelledby={`${headingId}-state`}>
            <h2 id={`${headingId}-state`}>{t('state.title')}</h2>
            <Switch
              isSelected={draft.enabled}
              onChange={(value) => update({ enabled: value }, ['queue', 'origins'])}
              isDisabled={disabled}
            >
              {t('state.toggle')}
            </Switch>
            <p className="wc__sub">{t(widget.enabled ? 'state.onHint' : 'state.offHint')}</p>
            <h3 className="wc__subhead">{t('state.required')}</h3>
            <ul className="wc__checklist">
              {(
                [
                  ['queue', requirements.queue, 'state.needQueue'],
                  ['origins', requirements.origin, 'state.needOrigin'],
                ] as const
              ).map(([field, met, label]) => (
                <li key={field} className={met ? 'wc__check wc__check--met' : 'wc__check'}>
                  <span aria-hidden="true" className="wc__check-mark">
                    {met ? '✓' : '!'}
                  </span>
                  <span>{t(label)}</span>
                  {!met && canEdit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => focusField(field === 'origins' ? 'origin-input' : 'queue')}
                    >
                      {t('state.goToField')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {attempted && draft.enabled && missing > 0 ? (
              <p className="wc__error" role="alert">
                {t('state.cannotEnable', { count: missing })}
              </p>
            ) : null}
          </section>

          {canEdit ? (
            <div className="wc__buttons">
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
        </aside>
      </div>
    </main>
  );
}
