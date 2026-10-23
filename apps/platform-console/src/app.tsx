/**
 * Platform Console — Guided onboarding (A1.7 #412, baseline A ของ #391)
 *
 * list → create → review → provisioning progress → failure/recovery → handoff + Action history
 *
 * - ทุกสถานะมาจาก Platform API; UI ไม่สรุปว่าสำเร็จก่อน `SUCCEEDED` (tenant ACTIVE)
 * - auditor เห็นแบบ read-only (capability จาก `/api/v1/session` ที่ server คำนวณจาก token)
 * - ไม่มี token/PII ใน URL หรือ storage: route มีแค่ requestId; คำค้นหาอยู่ใน state
 * - a11y: โฟกัสหัวข้อเมื่อเปลี่ยนหน้า, error summary ที่ลิงก์ไปช่องที่ผิด, label ทุกช่อง, live region
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Badge,
  Button,
  Cell,
  Checkbox,
  Column,
  Row,
  SearchField,
  Select,
  Table,
  TableBody,
  TableHeader,
  TextField as UiTextField,
} from '@d-contact/ui-react';
import type { MessageKey } from './i18n/messages.js';
import { usePlatformText } from './use-platform-text.js';
import { PlatformApiError, type PlatformApi } from './api.js';
import { PlatformAuthScreen } from './auth-screen.js';
import { PlatformHeader } from './platform-header.js';
import {
  EMPTY_DRAFT,
  FIELD_LABELS,
  LOCALES,
  RECOVERY_OPTIONS,
  STATUS_LABELS,
  TIMEZONES,
  actionLabel,
  actorLabelKey,
  blockedReasonKey,
  errorMessageKey,
  deliveryMessageKey,
  outcomeMessageKey,
  statusPresentation,
  stepPresentation,
  canMutate,
  readOnlyCopy,
  currentStep,
  draftToRequestBody,
  fieldErrorsToDraft,
  isHandoffReady,
  newIdempotencyKey,
  parseRoute,
  routePath,
  shouldPoll,
  validateDraft,
  type ActionHistoryItem,
  type CatalogView,
  type CommandView,
  type ErrorEnvelope,
  type RecoveryOption,
  type RequestStatus,
  type RequestView,
  type Route,
  type SessionView,
  type TenantDraft,
  type TenantSummary,
  type Tone,
} from './model.js';

type Navigate = (route: Route) => void;

/** นับการเปลี่ยนหน้าภายใน app — หน้าแรกไม่ย้ายโฟกัส (ให้ Tab แรกเจอ skip link) */
const NavigationContext = createContext(0);

function asEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof PlatformApiError) return error.envelope;
  return { status: 0, code: 'NETWORK', title: 'network', correlationId: null, retryable: true };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Shell ───────────────────────────────────────────────────────────────────

export function PlatformConsoleApp({
  api,
  pollMs = 2_000,
  onSignOut,
  onSessionExpired,
}: {
  api: PlatformApi;
  pollMs?: number;
  onSignOut?: () => void;
  onSessionExpired?: () => void;
}) {
  const { t } = usePlatformText();

  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [navigations, setNavigations] = useState(0);
  const [session, setSession] = useState<SessionView | null>(null);
  const [sessionError, setSessionError] = useState<ErrorEnvelope | null>(null);

  useEffect(() => {
    let active = true;
    api
      .session()
      .then((value) => active && setSession(value))
      .catch((error: unknown) => active && setSessionError(asEnvelope(error)));
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    const onPop = () => {
      setRoute(parseRoute(window.location.pathname));
      setNavigations((count) => count + 1);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback<Navigate>((next) => {
    window.history.pushState(null, '', routePath(next));
    setRoute(next);
    setNavigations((count) => count + 1);
  }, []);

  if (sessionError) {
    return (
      <PlatformAuthScreen
        state="session-error"
        errorCode={sessionError.code}
        onSignIn={sessionError.code === 'UNAUTHENTICATED' ? onSessionExpired : undefined}
      />
    );
  }
  if (!session) return <PlatformAuthScreen state="session-loading" />;

  const mutate = canMutate(session);
  const readOnly = readOnlyCopy(session);
  return (
    <NavigationContext.Provider value={navigations}>
      <div className="shell">
        <PlatformHeader session={session} route={route} navigate={navigate} onSignOut={onSignOut} />
        <main id="main" className="main" tabIndex={-1}>
          {!mutate && readOnly.banner ? (
            <p role="status" className="callout warning">
              {t(readOnly.banner)}
            </p>
          ) : null}
          {route.name === 'list' ? (
            <TenantList api={api} navigate={navigate} canCreate={mutate} />
          ) : route.name === 'new' ? (
            mutate ? (
              <CreateWizard api={api} navigate={navigate} />
            ) : (
              <PageHeading title={t('navigation.create')} subtitle={t('readOnly.subtitle')}>
                <p role="alert" className="callout warning">
                  {t(readOnly.create)}
                </p>
              </PageHeading>
            )
          ) : (
            <RequestDetail
              key={route.requestId}
              api={api}
              requestId={route.requestId}
              canMutate={mutate}
              readOnlyNotice={t(readOnly.decision)}
              navigate={navigate}
              pollMs={pollMs}
            />
          )}
        </main>
      </div>
    </NavigationContext.Provider>
  );
}

/** หัวข้อหน้า — รับโฟกัสทุกครั้งที่เปิดหน้า เพื่อให้ screen reader รู้ว่าเปลี่ยนหน้าแล้ว */
function PageHeading({
  title,
  subtitle,
  actions,
  children,
  focusKey,
}: {
  title: string;
  subtitle?: string;
  focusKey?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const navigations = useContext(NavigationContext);
  const previousFocusKey = useRef(focusKey);
  useEffect(() => {
    if (navigations > 0 || previousFocusKey.current !== focusKey) heading.current?.focus();
    previousFocusKey.current = focusKey;
  }, [focusKey, navigations]);
  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {title}
          </h1>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge tone={tone === 'danger' ? 'critical' : tone === 'warning' ? 'attention' : tone}>
      {children}
    </Badge>
  );
}

function StatusChip({ status }: { status: RequestStatus }) {
  const { t } = usePlatformText();

  const presentation = statusPresentation(status);
  return (
    <Chip tone={presentation.tone}>
      {t(presentation.label)}{' '}
      {Object.hasOwn(STATUS_LABELS, status) ? <span className="code">({status})</span> : null}
    </Chip>
  );
}

function ErrorAlert({ error, onRetry }: { error: ErrorEnvelope; onRetry?: () => void }) {
  const { t, errorMessage } = usePlatformText();

  return (
    <div role="alert" className="callout danger">
      <strong>{errorMessage(error)}</strong>
      {error.correlationId ? (
        <span className="muted small">
          {' '}
          · {t('common.reference')} {error.correlationId}
        </span>
      ) : null}
      {onRetry && error.retryable ? (
        <div className="actions">
          <Button onPress={onRetry}>{t('common.retry')}</Button>
        </div>
      ) : null}
    </div>
  );
}

// ── Tenant list / search ────────────────────────────────────────────────────

function TenantList({
  api,
  navigate,
  canCreate,
}: {
  api: PlatformApi;
  navigate: Navigate;
  canCreate: boolean;
}) {
  const { t, formatTime } = usePlatformText();

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [submitted, setSubmitted] = useState<{ query: string; status: string }>({
    query: '',
    status: '',
  });
  const [items, setItems] = useState<TenantSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'more'>('loading');
  const [error, setError] = useState<ErrorEnvelope | null>(null);

  const load = useCallback(
    async (filters: { query: string; status: string }, after?: string) => {
      setState(after ? 'more' : 'loading');
      setError(null);
      try {
        const page = await api.searchTenants({
          ...(filters.query ? { query: filters.query } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          ...(after ? { cursor: after } : {}),
        });
        setItems((current) => (after ? [...current, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setState('ready');
      } catch (caught) {
        setError(asEnvelope(caught));
        setState('error');
      }
    },
    [api],
  );

  useEffect(() => {
    void load(submitted);
  }, [load, submitted]);

  return (
    <PageHeading
      title={t('navigation.tenants')}
      subtitle={t('list.subtitle')}
      actions={
        canCreate ? (
          <Button variant="primary" onPress={() => navigate({ name: 'new' })}>
            {t('navigation.create')}
          </Button>
        ) : undefined
      }
    >
      <form
        className="card search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted({ query: query.trim(), status });
        }}
      >
        <SearchField
          className="grow"
          label={t('list.searchLabel')}
          value={query}
          maxLength={254}
          autoComplete="off"
          onChange={setQuery}
        />
        <Select
          label={t('list.statusLabel')}
          selectedKey={status || 'all'}
          onSelectionChange={(key) => setStatus(key === 'all' ? '' : String(key ?? ''))}
          options={[
            { id: 'all', label: t('list.all') },
            ...Object.keys(STATUS_LABELS).map((value) => ({
              id: value,
              label: `${t(statusPresentation(value).label)} (${value})`,
            })),
          ]}
        />
        <div className="actions end">
          <Button variant="primary" type="submit">
            {t('list.search')}
          </Button>
          <Button
            type="button"
            onPress={() => {
              setQuery('');
              setStatus('');
              setSubmitted({ query: '', status: '' });
            }}
          >
            {t('common.clear')}
          </Button>
        </div>
      </form>

      <div className="card" aria-busy={state === 'loading' ? 'true' : 'false'}>
        <p className="sr-only" role="status" aria-live="polite">
          {state === 'loading'
            ? t('list.loading')
            : state === 'ready'
              ? t('list.count', { count: items.length })
              : ''}
        </p>
        {state === 'loading' ? (
          <p className="muted pad">{t('common.loading')}</p>
        ) : state === 'error' && error ? (
          <div className="pad">
            <ErrorAlert error={error} onRetry={() => void load(submitted)} />
          </div>
        ) : items.length === 0 ? (
          <div className="pad empty-state">
            <h2>{t('list.empty')}</h2>
            <p className="muted">{t('list.emptyHint')}</p>
          </div>
        ) : (
          <Table aria-label={t('list.table')}>
            <TableHeader>
              <Column id="tenant" isRowHeader>
                {t('list.tenant')}
              </Column>
              <Column id="identity">{t('list.identity')}</Column>
              <Column id="lifecycle">{t('list.lifecycle')}</Column>
              <Column id="provisioning">{t('labels.provisioning')}</Column>
              <Column id="updated">{t('list.updated')}</Column>
              <Column id="actions">{t('list.actions')}</Column>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <Row key={item.tenantId} id={item.tenantId} textValue={item.name}>
                  <Cell>{item.name}</Cell>
                  <Cell>
                    <span className="code">{item.slug}</span>
                    <br />
                    <span className="muted small">{item.primaryDomain ?? '—'}</span>
                  </Cell>
                  <Cell>
                    <Chip tone={item.lifecycleStatus === 'ACTIVE' ? 'success' : 'info'}>
                      {t(
                        item.lifecycleStatus === 'ACTIVE'
                          ? 'lifecycle.ACTIVE'
                          : item.lifecycleStatus === 'PROVISIONING'
                            ? 'lifecycle.PROVISIONING'
                            : 'statuses.unknown',
                      )}
                      {['ACTIVE', 'PROVISIONING'].includes(item.lifecycleStatus) ? (
                        <span className="code"> ({item.lifecycleStatus})</span>
                      ) : null}
                    </Chip>
                  </Cell>
                  <Cell>
                    {item.request ? (
                      <StatusChip status={item.request.status} />
                    ) : (
                      <Chip tone="neutral">{t('list.legacy')}</Chip>
                    )}
                  </Cell>
                  <Cell>{formatTime(item.request?.updatedAt ?? item.createdAt)}</Cell>
                  <Cell>
                    {item.request ? (
                      <Button
                        variant="ghost"
                        onPress={() =>
                          navigate({ name: 'request', requestId: item.request!.requestId })
                        }
                        aria-label={t('list.openDetails', { name: item.name })}
                      >
                        {t('list.open')}
                      </Button>
                    ) : (
                      <span className="muted small">{t('list.noHistory')}</span>
                    )}
                  </Cell>
                </Row>
              ))}
            </TableBody>
          </Table>
        )}
        {cursor && state !== 'loading' ? (
          <div className="pad">
            <Button isDisabled={state === 'more'} onPress={() => void load(submitted, cursor)}>
              {state === 'more' ? t('common.loading') : t('common.more')}
            </Button>
          </div>
        ) : null}
      </div>
    </PageHeading>
  );
}

// ── Create wizard ───────────────────────────────────────────────────────────

const WIZARD_STEPS = [
  'wizard.stepData',
  'wizard.stepReview',
  'labels.provisioning',
  'wizard.stepHandoff',
] as const;

function Stepper({ active }: { active: number }) {
  const { t } = usePlatformText();

  return (
    <ol className="stepper" aria-label={t('wizard.stepsLabel')}>
      {WIZARD_STEPS.map((label, index) => (
        <li
          key={label}
          className={index === active ? 'on' : index < active ? 'done' : ''}
          aria-current={index === active ? 'step' : undefined}
        >
          <span aria-hidden="true">{index < active ? '✓' : index + 1}</span> {t(label)}
        </li>
      ))}
    </ol>
  );
}

type DraftErrors = Partial<Record<keyof TenantDraft, MessageKey>>;

function ErrorSummary({ errors }: { errors: DraftErrors }) {
  const { t } = usePlatformText();

  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, [errors]);
  const entries = Object.entries(errors) as [keyof TenantDraft, MessageKey][];
  if (entries.length === 0) return null;
  return (
    <div
      ref={box}
      className="callout danger"
      role="alert"
      tabIndex={-1}
      aria-labelledby="error-summary-title"
    >
      <h2 id="error-summary-title">{t('validation.summary', { count: entries.length })}</h2>
      <ul>
        {entries.map(([field, message]) => (
          <li key={field}>
            <a
              href={`#field-${field}`}
              onClick={(event) => {
                event.preventDefault();
                focusDraftField(field);
              }}
            >
              {t(FIELD_LABELS[field])}: {t(message)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function focusDraftField(field: keyof TenantDraft) {
  const control = document.querySelector<HTMLElement>(
    `[data-field="${field}"] input:not([type="hidden"]), [data-field="${field}"] button, [data-field="${field}"] textarea`,
  );
  (control ?? document.getElementById(`field-${field}`))?.focus();
}

function TextField({
  field,
  draft,
  errors,
  onChange,
  type = 'text',
  hint,
  autoComplete = 'off',
}: {
  field: keyof TenantDraft;
  draft: TenantDraft;
  errors: DraftErrors;
  onChange: (field: keyof TenantDraft, value: string) => void;
  type?: import('react').HTMLInputTypeAttribute;
  hint?: string;
  autoComplete?: string;
}) {
  const { t } = usePlatformText();
  return (
    <div data-field={field}>
      <UiTextField
        id={`field-${field}`}
        label={t(FIELD_LABELS[field])}
        description={hint}
        value={draft[field]}
        onChange={(value) => onChange(field, value)}
        type={type}
        autoComplete={autoComplete}
        validationBehavior="aria"
        isInvalid={!!errors[field]}
        errorMessage={errors[field] ? t(errors[field]) : undefined}
      />
    </div>
  );
}

function CreateWizard({ api, navigate }: { api: PlatformApi; navigate: Navigate }) {
  const { t, errorMessage } = usePlatformText();

  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [catalogError, setCatalogError] = useState<ErrorEnvelope | null>(null);
  const [draft, setDraft] = useState<TenantDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [phase, setPhase] = useState<'form' | 'review'>('form');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ErrorEnvelope | null>(null);
  // key ต่อ "ชุดข้อมูลที่ review แล้ว" — กดส่งซ้ำหลัง network error ใช้ key เดิม จึงไม่สร้างซ้ำ
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    api
      .catalog()
      .then((value) => {
        setCatalog(value);
        // template ล่าสุดที่ ACTIVE — server pin อีกครั้งตอนรับคำขอ
        setDraft((current) => ({
          ...current,
          bootstrapTemplateVersion: value.templates[0]?.version ?? '',
        }));
      })
      .catch((error: unknown) => setCatalogError(asEnvelope(error)));
  }, [api]);

  const update = (field: keyof TenantDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    idempotencyKey.current = null;
  };

  const review = () => {
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    idempotencyKey.current ??= newIdempotencyKey('create');
    setConfirmed(false);
    setSubmitError(null);
    setPhase('review');
  };

  const submit = async () => {
    if (!confirmed || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.createRequest(draftToRequestBody(draft), idempotencyKey.current!);
      navigate({ name: 'request', requestId: result.request.requestId });
    } catch (caught) {
      const envelope = asEnvelope(caught);
      const fields = fieldErrorsToDraft(envelope.fieldErrors);
      const conflictField: Record<string, keyof TenantDraft> = {
        TENANT_SLUG_CONFLICT: 'slug',
        TENANT_DOMAIN_CONFLICT: 'primaryDomain',
        FIRST_ADMIN_EMAIL_CONFLICT: 'firstAdminEmail',
        PLAN_UNAVAILABLE: 'planCode',
        BOOTSTRAP_TEMPLATE_UNAVAILABLE: 'bootstrapTemplateVersion',
      };
      const conflict = Object.hasOwn(conflictField, envelope.code)
        ? conflictField[envelope.code]
        : undefined;
      if (Object.keys(fields).length > 0 || conflict) {
        // กลับไปแก้ในฟอร์ม: ข้อมูลเปลี่ยน = key ใหม่
        setErrors({ ...fields, ...(conflict ? { [conflict]: errorMessageKey(envelope) } : {}) });
        idempotencyKey.current = null;
        setPhase('form');
      } else {
        setSubmitError(envelope);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (catalogError) {
    return (
      <PageHeading title={t('navigation.create')}>
        <ErrorAlert error={catalogError} />
      </PageHeading>
    );
  }
  if (!catalog) {
    return (
      <PageHeading title={t('navigation.create')}>
        <p className="muted" aria-busy="true">
          {t('wizard.catalogLoading')}
        </p>
      </PageHeading>
    );
  }

  const template = catalog.templates.find(
    (entry) => entry.version === draft.bootstrapTemplateVersion,
  );
  return (
    <PageHeading
      title={phase === 'form' ? t('wizard.titleData') : t('wizard.titleReview')}
      focusKey={phase}
      subtitle={t('wizard.subtitle')}
    >
      <Stepper active={phase === 'form' ? 0 : 1} />
      <div className="layout">
        {phase === 'form' ? (
          <form
            className="card form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              review();
            }}
          >
            <ErrorSummary errors={errors} />
            <fieldset>
              <legend>{t('wizard.organization')}</legend>
              <TextField
                field="displayName"
                draft={draft}
                errors={errors}
                onChange={update}
                autoComplete="organization"
              />
              <TextField
                field="slug"
                draft={draft}
                errors={errors}
                onChange={update}
                hint={t('wizard.slugHint')}
              />
              <TextField
                field="primaryDomain"
                draft={draft}
                errors={errors}
                onChange={update}
                hint={t('wizard.domainHint')}
              />
            </fieldset>
            <fieldset>
              <legend>{t('wizard.defaults')}</legend>
              <div data-field="planCode">
                <Select
                  id="field-planCode"
                  label={t(FIELD_LABELS.planCode)}
                  selectedKey={draft.planCode || null}
                  placeholder={t('validation.planCode')}
                  onSelectionChange={(key) => update('planCode', String(key ?? ''))}
                  validationBehavior="aria"
                  isInvalid={!!errors.planCode}
                  errorMessage={errors.planCode ? t(errors.planCode) : undefined}
                  options={catalog.plans.map((plan) => ({
                    id: plan.code,
                    label: `${plan.code} (v${plan.version})`,
                  }))}
                />
              </div>
              <div data-field="locale">
                <Select
                  id="field-locale"
                  label={t(FIELD_LABELS.locale)}
                  selectedKey={draft.locale}
                  onSelectionChange={(key) => update('locale', String(key ?? ''))}
                  validationBehavior="aria"
                  isInvalid={!!errors.locale}
                  errorMessage={errors.locale ? t(errors.locale) : undefined}
                  options={LOCALES.map((locale) => ({ id: locale.value, label: t(locale.label) }))}
                />
              </div>
              <div data-field="timezone">
                <Select
                  id="field-timezone"
                  label={t(FIELD_LABELS.timezone)}
                  selectedKey={draft.timezone}
                  onSelectionChange={(key) => update('timezone', String(key ?? ''))}
                  validationBehavior="aria"
                  isInvalid={!!errors.timezone}
                  errorMessage={errors.timezone ? t(errors.timezone) : undefined}
                  options={TIMEZONES.map((timezone) => ({ id: timezone, label: timezone }))}
                />
              </div>
              <div className="field">
                <span className="label" id="template-label">
                  {t(FIELD_LABELS.bootstrapTemplateVersion)}
                </span>
                <p
                  id="field-bootstrapTemplateVersion"
                  tabIndex={-1}
                  aria-labelledby="template-label"
                  className="code"
                >
                  {template
                    ? `${template.version} · ${template.contentDigest.slice(0, 12)}…`
                    : t('wizard.templateMissing')}
                </p>
                {errors.bootstrapTemplateVersion ? (
                  <p className="field-error">{t(errors.bootstrapTemplateVersion)}</p>
                ) : null}
              </div>
            </fieldset>
            <fieldset>
              <legend>{t('actors.FIRST_ADMIN')}</legend>
              <TextField
                field="firstAdminDisplayName"
                draft={draft}
                errors={errors}
                onChange={update}
                autoComplete="name"
              />
              <TextField
                field="firstAdminEmail"
                draft={draft}
                errors={errors}
                onChange={update}
                type="email"
                autoComplete="email"
                hint={t('wizard.emailHint')}
              />
            </fieldset>
            <div className="actions end">
              <Button type="button" onPress={() => navigate({ name: 'list' })}>
                {t('actions.CANCEL')}
              </Button>
              <Button type="submit" variant="primary">
                {t('wizard.review')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="card form">
            <dl className="summary">
              {(
                [
                  'displayName',
                  'slug',
                  'primaryDomain',
                  'planCode',
                  'locale',
                  'timezone',
                  'bootstrapTemplateVersion',
                  'firstAdminDisplayName',
                  'firstAdminEmail',
                ] as (keyof TenantDraft)[]
              ).map((field) => (
                <div key={field}>
                  <dt>{t(FIELD_LABELS[field])}</dt>
                  <dd
                    className={
                      ['slug', 'primaryDomain', 'bootstrapTemplateVersion'].includes(field)
                        ? 'code'
                        : undefined
                    }
                  >
                    {field === 'slug' ? draft.slug.trim().toLowerCase() : draft[field]}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="callout warning">
              <strong>{t('wizard.immutableTitle')}</strong>
              <p>{t('wizard.immutableBody')}</p>
            </div>
            {submitError ? <ErrorAlert error={submitError} onRetry={() => void submit()} /> : null}
            <Checkbox className="confirmation" isSelected={confirmed} onChange={setConfirmed}>
              {t('wizard.confirm')}
            </Checkbox>
            <div className="actions end">
              <Button onPress={() => setPhase('form')} isDisabled={submitting}>
                {t('wizard.edit')}
              </Button>
              <Button
                variant="primary"
                onPress={() => void submit()}
                isDisabled={!confirmed || submitting}
              >
                {submitting ? t('common.sending') : t('wizard.submit')}
              </Button>
            </div>
          </div>
        )}
        <aside className="side" aria-label={t('wizard.aside')}>
          <div className="card pad">
            <h2 className="h3">{t('wizard.boundary')}</h2>
            <p className="muted small">{t('wizard.boundaryBody')}</p>
          </div>
          <div className="callout info">
            <strong>{t('wizard.safeTitle')}</strong>
            <p className="small">{t('wizard.safeBody')}</p>
          </div>
        </aside>
      </div>
    </PageHeading>
  );
}

// ── Request detail ──────────────────────────────────────────────────────────

function RequestDetail({
  api,
  requestId,
  canMutate,
  readOnlyNotice,
  navigate,
  pollMs,
}: {
  api: PlatformApi;
  requestId: string;
  canMutate: boolean;
  readOnlyNotice: string;
  navigate: Navigate;
  pollMs: number;
}) {
  const { t, formatTime } = usePlatformText();

  const [view, setView] = useState<RequestView | null>(null);
  const [error, setError] = useState<ErrorEnvelope | null>(null);
  const [recovery, setRecovery] = useState<RecoveryOption | 'RESEND' | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const recoveryTrigger = useRef<HTMLElement | null>(null);
  const closeRecovery = () => {
    const wasResend = recovery === 'RESEND';
    setRecovery(null);
    requestAnimationFrame(() => {
      const target = recoveryTrigger.current?.isConnected
        ? recoveryTrigger.current
        : wasResend
          ? document.getElementById('resend-invitation')
          : null;
      (target ?? document.querySelector<HTMLElement>('#main h1'))?.focus();
    });
  };

  const refresh = useCallback(async () => {
    try {
      const next = await api.getRequest(requestId);
      setView(next);
      setError(null);
      return next;
    } catch (caught) {
      setError(asEnvelope(caught));
      return null;
    }
  }, [api, requestId]);

  useEffect(() => {
    void refresh().then(() => setHistoryVersion((value) => value + 1));
  }, [refresh]);

  // poll ตามสถานะล่าสุดเสมอ: หลัง recovery ที่พากลับ RUNNING จะเริ่ม poll ใหม่เอง
  // ACTION_REQUIRED/สิ้นสุดแล้วหยุด (worker ไม่เดินเอง)
  useEffect(() => {
    if (!view || !shouldPoll(view.status)) return;
    const timer = setTimeout(() => {
      void refresh().then(() => setHistoryVersion((value) => value + 1));
    }, pollMs);
    return () => clearTimeout(timer);
  }, [view, refresh, pollMs]);

  if (error && !view) {
    return (
      <PageHeading
        title={error.code === 'NOT_FOUND' ? t('request.notFound') : t('request.unavailable')}
        actions={<Button onPress={() => navigate({ name: 'list' })}>{t('request.back')}</Button>}
      >
        <ErrorAlert error={error} onRetry={() => void refresh()} />
      </PageHeading>
    );
  }
  if (!view) {
    return (
      <PageHeading title={t('request.loading')}>
        <p className="muted" aria-busy="true">
          {t('common.loading')}
        </p>
      </PageHeading>
    );
  }

  const step = currentStep(view);
  const ready = isHandoffReady(view);
  const activeStage = ready ? 3 : 2;
  return (
    <PageHeading
      title={view.displayName}
      subtitle={t('request.subtitle', { id: view.requestId })}
      actions={<Button onPress={() => navigate({ name: 'list' })}>{t('request.back')}</Button>}
    >
      <Stepper active={activeStage} />
      <p className="sr-only" role="status" aria-live="polite">
        {t('progress.status', { state: t(statusPresentation(view.status).label) })}
      </p>
      <div className="layout">
        <div className="stack">
          <section className="card" aria-labelledby="progress-title">
            <div className="card-head">
              <h2 id="progress-title">
                {ready
                  ? t('request.ready')
                  : view.status === 'ACTION_REQUIRED'
                    ? t('statuses.ACTION_REQUIRED')
                    : t('labels.provisioning')}
              </h2>
              <StatusChip status={view.status} />
            </div>
            <div className="pad">
              {view.status === 'PENDING' ? (
                <p className="callout info">{t('request.pending')}</p>
              ) : null}
              {view.status === 'ACTION_REQUIRED' ? (
                <div className="callout danger" role="alert">
                  <strong>
                    {t('progress.stopped', {
                      step: step ? t(stepPresentation(step.stepKey).title) : '—',
                    })}
                  </strong>
                  <p className="small">
                    {t('request.reason')}{' '}
                    <span className="code">{view.failureCode ?? step?.errorCode ?? '—'}</span> ·{' '}
                    {t('request.revision')} {view.revision}
                  </p>
                </div>
              ) : null}
              {ready ? (
                <div className="callout success">
                  <strong>{t('request.active')}</strong>
                  <p className="small">{t('request.activeBody')}</p>
                </div>
              ) : null}
              <ol className="progress">
                {view.steps.map((entry) => (
                  <li
                    key={entry.stepKey}
                    className={`progress-item ${String(entry.state ?? 'unknown').toLowerCase()}`}
                  >
                    <span className="progress-icon" aria-hidden="true">
                      {entry.state === 'SUCCEEDED'
                        ? '✓'
                        : entry.state === 'ACTION_REQUIRED'
                          ? '!'
                          : entry.state === 'RUNNING'
                            ? '…'
                            : '○'}
                    </span>
                    <div>
                      <strong>{t(stepPresentation(entry.stepKey).title)}</strong>
                      <span className="sr-only">
                        {t('progress.status', { state: t(statusPresentation(entry.state).label) })}
                      </span>
                      <p className="muted small">
                        {entry.state === 'SUCCEEDED'
                          ? t('progress.completed', { time: formatTime(entry.finishedAt) })
                          : entry.state === 'ACTION_REQUIRED'
                            ? t('progress.waiting', { code: entry.errorCode ?? '' })
                            : entry.state === 'RUNNING'
                              ? t('progress.running', { count: entry.attempt })
                              : entry.nextAttemptAt
                                ? t('progress.retry', { time: formatTime(entry.nextAttemptAt) })
                                : t(stepPresentation(entry.stepKey).detail)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          {view.status === 'ACTION_REQUIRED' ? (
            <section className="card" aria-labelledby="recovery-title">
              <div className="card-head">
                <h2 id="recovery-title">{t('recovery.title')}</h2>
              </div>
              <div className="pad">
                {canMutate ? (
                  <>
                    <p className="muted small">{t('recovery.guidance')}</p>
                    <div className="recovery-options">
                      {RECOVERY_OPTIONS.map((option) => (
                        <Button
                          key={option.action}
                          variant={
                            option.recommended
                              ? 'primary'
                              : option.destructive
                                ? 'danger'
                                : 'secondary'
                          }
                          onPress={(event) => {
                            recoveryTrigger.current = event.target as HTMLElement;
                            setRecovery(option);
                          }}
                          aria-describedby={`recovery-${option.path}`}
                        >
                          {t(option.title)}
                          {option.recommended ? t('recovery.recommended') : ''}
                        </Button>
                      ))}
                    </div>
                    <ul className="small muted">
                      {RECOVERY_OPTIONS.map((option) => (
                        <li key={option.action} id={`recovery-${option.path}`}>
                          <strong>{t(option.title)}:</strong> {t(option.detail)}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="callout info">{readOnlyNotice}</p>
                )}
              </div>
            </section>
          ) : null}

          {recovery ? (
            recovery === 'RESEND' ? (
              <ResendPanel
                api={api}
                view={view}
                onClose={closeRecovery}
                onDone={async () => {
                  await refresh();
                  setHistoryVersion((value) => value + 1);
                }}
              />
            ) : (
              <RecoveryPanel
                api={api}
                view={view}
                option={recovery}
                pollMs={Math.min(pollMs, 1_000)}
                refresh={refresh}
                onClose={closeRecovery}
                onDone={() => setHistoryVersion((value) => value + 1)}
              />
            )
          ) : null}

          <ActionHistory api={api} tenantId={view.tenantId} version={historyVersion} />
        </div>

        <aside className="side" aria-label={t('request.aside')}>
          <section className="card pad" aria-labelledby="pinned-title">
            <h2 id="pinned-title" className="h3">
              {t('request.pinned')}
            </h2>
            <dl className="summary compact">
              <div>
                <dt>{t('fields.slug')}</dt>
                <dd className="code">{view.slug}</dd>
              </div>
              <div>
                <dt>{t('fields.primaryDomain')}</dt>
                <dd className="code">{view.primaryDomain}</dd>
              </div>
              <div>
                <dt>{t('fields.planCode')}</dt>
                <dd>{`${view.plan.code} v${view.plan.version}`}</dd>
              </div>
              <div>
                <dt>{t('fields.bootstrapTemplateVersion')}</dt>
                <dd className="code">{view.bootstrapTemplateVersion}</dd>
              </div>
              <div>
                <dt>{t('request.localeTimezone')}</dt>
                <dd>
                  {view.locale} · {view.timezone}
                </dd>
              </div>
              <div>
                <dt>{t('actions.REQUEST_ACCEPTED')}</dt>
                <dd>{formatTime(view.acceptedAt)}</dd>
              </div>
            </dl>
          </section>
          <section className="card pad" aria-labelledby="handoff-title">
            <h2 id="handoff-title" className="h3">
              {t('invitation.title')}
            </h2>
            <p>
              {view.firstAdmin.displayName}
              <br />
              <span className="muted small">{view.firstAdmin.emailMasked}</span>
            </p>
            {view.invitation ? (
              <p className="small">
                {t('invitation.generation', { count: view.invitation.generation })}{' '}
                <strong>{t(deliveryMessageKey(view.invitation.delivery))}</strong>
                <br />
                {t('invitation.expires', { time: formatTime(view.invitation.expiresAt) })}
                {view.invitation.expired ? t('invitation.expired') : ''}
                <br />
                <span className="muted">{t('invitation.deliveryHint')}</span>
              </p>
            ) : (
              <p className="muted small">{t('invitation.notSent')}</p>
            )}
            {canMutate && view.invitation && !recovery ? (
              <Button
                id="resend-invitation"
                onPress={(event) => {
                  recoveryTrigger.current = event.target as HTMLElement;
                  setRecovery('RESEND');
                }}
              >
                {t('invitation.resend')}
              </Button>
            ) : null}
          </section>
        </aside>
      </div>
    </PageHeading>
  );
}

// ── Recovery (preview → confirm → execute) ──────────────────────────────────

const REASONS = [
  { value: 'OPERATOR_VERIFIED', label: 'reasons.OPERATOR_VERIFIED' },
  { value: 'DEPENDENCY_RECOVERED', label: 'reasons.DEPENDENCY_RECOVERED' },
  { value: 'CUSTOMER_REQUEST', label: 'reasons.CUSTOMER_REQUEST' },
  { value: 'INVALID_REQUEST', label: 'reasons.INVALID_REQUEST' },
] as const;

function RecoveryPanel({
  api,
  view,
  option,
  pollMs,
  refresh,
  onClose,
  onDone,
}: {
  api: PlatformApi;
  view: RequestView;
  option: RecoveryOption;
  pollMs: number;
  refresh: () => Promise<RequestView | null>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, errorMessage } = usePlatformText();

  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [phase, setPhase] = useState<'previewing' | 'confirm' | 'executing' | 'done'>('previewing');
  const [preview, setPreview] = useState<CommandView | null>(null);
  const [command, setCommand] = useState<CommandView | null>(null);
  const [error, setError] = useState<ErrorEnvelope | null>(null);
  const [reasonCode, setReasonCode] = useState<string>(REASONS[0].value);
  const [comment, setComment] = useState('');
  const [acknowledged, setAcknowledged] = useState(!option.destructive);
  const [commentError, setCommentError] = useState<MessageKey | null>(null);
  const key = useRef(newIdempotencyKey(option.path));
  const revision = useRef(view.revision);

  useEffect(() => {
    heading.current?.focus();
  }, [phase]);

  const runPreview = useCallback(async () => {
    setPhase('previewing');
    setError(null);
    try {
      const fresh = await refresh();
      if (fresh) revision.current = fresh.revision;
      let current = await api.requestPreview(view.requestId, option.path);
      // worker ถาม dependency จริงแล้วเขียนผลกลับ — poll จนจบ
      for (
        let round = 0;
        round < 60 && (current.state === 'QUEUED' || current.state === 'RUNNING');
        round += 1
      ) {
        await sleep(pollMs);
        current = await api.getPreview(view.requestId, current.commandId);
      }
      setPreview(current);
      key.current = newIdempotencyKey(option.path);
      setPhase('confirm');
    } catch (caught) {
      setError(asEnvelope(caught));
      setPhase('confirm');
    }
  }, [api, option.path, pollMs, refresh, view.requestId]);

  useEffect(() => {
    void runPreview();
  }, [runPreview]);

  const execute = async () => {
    if (!comment.trim()) {
      setCommentError('validation.comment');
      document.getElementById(`${titleId}-comment`)?.focus();
      return;
    }
    setCommentError(null);
    setError(null);
    setPhase('executing');
    try {
      const accepted = await api.submitAction(
        view.requestId,
        option.path,
        {
          expectedRevision: revision.current,
          previewDigest: preview?.result?.previewDigest,
          reasonCode,
          comment: comment.trim(),
        },
        key.current,
      );
      let current = accepted.command;
      for (
        let round = 0;
        round < 60 && (current.state === 'QUEUED' || current.state === 'RUNNING');
        round += 1
      ) {
        await sleep(pollMs);
        current = await api.getCommand(view.requestId, current.commandId);
      }
      setCommand(current);
      setPhase('done');
      await refresh();
      onDone();
    } catch (caught) {
      setError(asEnvelope(caught));
      setPhase('confirm');
    }
  };

  const result = preview?.result as
    | {
        allowed?: boolean;
        blockedBy?: string | null;
        finding?: string | null;
        previewDigest?: string;
      }
    | null
    | undefined;
  const allowed = preview?.state === 'SUCCEEDED' && result?.allowed === true;

  return (
    <section
      className="card panel"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && phase !== 'executing') onClose();
      }}
    >
      <div className="card-head">
        <h2 id={titleId} ref={heading} tabIndex={-1}>
          {t(option.title)}:{' '}
          {phase === 'previewing'
            ? t('recovery.previewing')
            : phase === 'executing'
              ? t('recovery.executing')
              : phase === 'done'
                ? t('recovery.done')
                : t('recovery.confirming')}
        </h2>
        <Button variant="ghost" onPress={onClose} isDisabled={phase === 'executing'}>
          {t('common.close')}
        </Button>
      </div>
      <div className="pad" aria-live="polite">
        {phase === 'previewing' ? <p className="muted">{t('recovery.checking')}</p> : null}
        {error ? (
          <>
            <ErrorAlert error={error} />
            {['REVISION_CONFLICT', 'PREVIEW_STALE', 'COMMAND_IN_PROGRESS'].includes(error.code) ? (
              <Button onPress={() => void runPreview()}>{t('recovery.reloadPreview')}</Button>
            ) : null}
          </>
        ) : null}
        {phase === 'confirm' && preview && !error ? (
          allowed ? (
            <form
              className="form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void execute();
              }}
            >
              <dl className="summary compact">
                <div>
                  <dt>{t('recovery.finding')}</dt>
                  <dd className="code">{result?.finding ?? '—'}</dd>
                </div>
                <div>
                  <dt>{t('recovery.revision')}</dt>
                  <dd>{revision.current}</dd>
                </div>
                <div>
                  <dt>{t('recovery.digest')}</dt>
                  <dd className="code">{result?.previewDigest?.slice(0, 16)}…</dd>
                </div>
              </dl>
              <Select
                id={`${titleId}-reason`}
                label={t('request.reason')}
                selectedKey={reasonCode}
                onSelectionChange={(key) => setReasonCode(String(key ?? REASONS[0].value))}
                options={REASONS.map((reason) => ({ id: reason.value, label: t(reason.label) }))}
              />
              <UiTextField
                id={`${titleId}-comment`}
                multiline
                label={t('recovery.comment')}
                value={comment}
                maxLength={500}
                onChange={(value) => {
                  setComment(value);
                  setCommentError(null);
                }}
                validationBehavior="aria"
                isInvalid={!!commentError}
                errorMessage={commentError ? t(commentError) : undefined}
              />
              {option.destructive ? (
                <Checkbox
                  className="confirmation"
                  isSelected={acknowledged}
                  onChange={setAcknowledged}
                >
                  {t('recovery.acknowledge', { action: t(option.title) })}
                </Checkbox>
              ) : null}
              <div className="actions end">
                <Button type="button" onPress={onClose}>
                  {t('actions.CANCEL')}
                </Button>
                <Button
                  type="submit"
                  variant={option.destructive ? 'danger' : 'primary'}
                  isDisabled={!acknowledged}
                >
                  {t('recovery.confirm', { action: t(option.title) })}
                </Button>
              </div>
            </form>
          ) : (
            <div className="callout warning" role="alert">
              <strong>{t('recovery.blocked')}</strong>
              <p>
                {preview.state === 'REJECTED'
                  ? errorMessage({
                      code: preview.errorCode ?? 'INTERNAL',
                      title: preview.errorCode ?? '',
                    })
                  : t(blockedReasonKey(result?.blockedBy))}
              </p>
            </div>
          )
        ) : null}
        {phase === 'executing' ? <p className="muted">{t('recovery.accepted')}</p> : null}
        {phase === 'done' && command ? (
          command.state === 'SUCCEEDED' ? (
            <div className="callout success" role="status">
              <strong>{t('recovery.succeeded', { action: t(option.title) })}</strong>
              <p className="small">
                {t('recovery.requestState', {
                  state: t(
                    statusPresentation(
                      typeof command.result?.status === 'string'
                        ? command.result.status
                        : undefined,
                    ).label,
                  ),
                })}
              </p>
            </div>
          ) : (
            <div className="callout danger" role="alert">
              <strong>
                {t(command.state === 'REJECTED' ? 'recovery.rejected' : 'recovery.unconfirmed', {
                  action: t(option.title),
                })}
              </strong>
              <p className="small">
                {errorMessage({
                  code: command.errorCode ?? 'INTERNAL',
                  title: command.errorCode ?? '',
                })}
              </p>
              <Button onPress={() => void runPreview()}>{t('recovery.previewAgain')}</Button>
            </div>
          )
        ) : null}
      </div>
    </section>
  );
}

function ResendPanel({
  api,
  view,
  onClose,
  onDone,
}: {
  api: PlatformApi;
  view: RequestView;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t, errorMessage } = usePlatformText();

  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const key = useRef(newIdempotencyKey('resend'));
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'form' | 'sending' | 'queued'>('form');
  const [error, setError] = useState<{ envelope: ErrorEnvelope; retryAfter?: number } | null>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [state]);

  const submit = async () => {
    if (!comment.trim()) {
      setError({
        envelope: {
          status: 400,
          code: 'VALIDATION_FAILED',
          title: '',
          correlationId: null,
          retryable: false,
        },
      });
      return;
    }
    setState('sending');
    setError(null);
    try {
      await api.submitAction(
        view.requestId,
        'resend-invitation',
        { reasonCode: 'RECIPIENT_REQUESTED', comment: comment.trim() },
        key.current,
      );
      setState('queued');
      await onDone();
    } catch (caught) {
      setError({
        envelope: asEnvelope(caught),
        ...(caught instanceof PlatformApiError && caught.retryAfterSeconds
          ? { retryAfter: caught.retryAfterSeconds }
          : {}),
      });
      setState('form');
    }
  };

  return (
    <section
      className="card panel"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && state !== 'sending') onClose();
      }}
    >
      <div className="card-head">
        <h2 id={titleId} ref={heading} tabIndex={-1}>
          {t('invitation.resend')}
        </h2>
        <Button variant="ghost" onPress={onClose}>
          {t('common.close')}
        </Button>
      </div>
      <div className="pad">
        {error ? (
          <div role="alert" className="callout danger">
            <strong>{errorMessage(error.envelope)}</strong>
            {error.retryAfter ? (
              <p className="small">
                {t('invitation.retryAfter', { count: Math.ceil(error.retryAfter / 60) })}
              </p>
            ) : null}
          </div>
        ) : null}
        {state === 'queued' ? (
          <p role="status" className="callout success">
            {t('invitation.queued')}
          </p>
        ) : (
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p className="muted small">
              {t('invitation.limit', { count: view.invitation?.resendsInLastHour ?? 0 })}
            </p>
            <UiTextField
              id={`${titleId}-comment`}
              multiline
              label={t('invitation.comment')}
              maxLength={500}
              value={comment}
              onChange={setComment}
            />
            <div className="actions end">
              <Button type="button" onPress={onClose}>
                {t('actions.CANCEL')}
              </Button>
              <Button type="submit" variant="primary" isDisabled={state === 'sending'}>
                {state === 'sending' ? t('common.sending') : t('invitation.resend')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

// ── Action history timeline ─────────────────────────────────────────────────

function ActionHistory({
  api,
  tenantId,
  version,
}: {
  api: PlatformApi;
  tenantId: string;
  version: number;
}) {
  const { t, formatTime, describeHistory } = usePlatformText();

  const [items, setItems] = useState<ActionHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ErrorEnvelope | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      try {
        const page = await api.actionHistory(tenantId, after);
        setItems((current) => (after ? [...current, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(null);
      } catch (caught) {
        setError(asEnvelope(caught));
      } finally {
        setLoading(false);
      }
    },
    [api, tenantId],
  );

  useEffect(() => {
    void load();
  }, [load, version]);

  const ordered = useMemo(() => [...items].reverse(), [items]);
  return (
    <section className="card" aria-labelledby="history-title">
      <div className="card-head">
        <div>
          <h2 id="history-title">{t('history.title')}</h2>
          <p className="muted small">{t('history.subtitle')}</p>
        </div>
      </div>
      <div className="pad" aria-busy={loading ? 'true' : 'false'}>
        {error ? <ErrorAlert error={error} onRetry={() => void load()} /> : null}
        {!error && items.length === 0 && !loading ? (
          <p className="muted">{t('history.empty')}</p>
        ) : null}
        <ol className="timeline" aria-label={t('history.order')}>
          {ordered.map((item) => (
            <li
              key={item.id}
              className={`timeline-item ${item.outcome === 'REJECTED' ? 'rejected' : ''}`}
            >
              <div className="timeline-meta">
                <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time>
                <Chip tone={item.actor.kind === 'SYSTEM' ? 'neutral' : 'info'}>
                  {t(actorLabelKey(item.actor.kind))}
                </Chip>
              </div>
              <div>
                <strong>{t(actionLabel(item.action))}</strong>
                {item.outcome !== 'SUCCEEDED' ? (
                  <Chip tone={item.outcome === 'REJECTED' ? 'danger' : 'neutral'}>
                    {t(outcomeMessageKey(item.outcome))}
                  </Chip>
                ) : null}
                <p className="small">{describeHistory(item)}</p>
                {item.comment ? <p className="small quote">“{item.comment}”</p> : null}
                <p className="muted small">
                  {t('history.correlation')} <span className="code">{item.correlationId}</span> ·{' '}
                  {t('history.request')} <span className="code">{item.requestId.slice(0, 8)}</span>{' '}
                  · {t('history.audit')} <span className="code">{item.id.slice(0, 8)}</span>
                </p>
              </div>
            </li>
          ))}
        </ol>
        {cursor ? (
          <Button isDisabled={loading} onPress={() => void load(cursor)}>
            {loading ? t('common.loading') : t('history.more')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
