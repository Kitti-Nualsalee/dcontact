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
import { PlatformApiError, type PlatformApi } from './api.js';
import {
  ACTOR_LABELS,
  BLOCKED_REASONS,
  EMPTY_DRAFT,
  FIELD_LABELS,
  LOCALES,
  RECOVERY_OPTIONS,
  STATUS_LABELS,
  STEP_LABELS,
  TIMEZONES,
  actionLabel,
  canMutate,
  currentStep,
  describeHistory,
  draftToRequestBody,
  errorMessage,
  fieldErrorsToDraft,
  formatTime,
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
      <Centered title="เปิด Platform Console ไม่ได้">
        <p>{errorMessage(sessionError)}</p>
        {sessionError.code === 'UNAUTHENTICATED' && onSessionExpired ? (
          <button className="button primary" onClick={onSessionExpired}>
            เข้าสู่ระบบใหม่
          </button>
        ) : null}
      </Centered>
    );
  }
  if (!session) return <Centered title="กำลังตรวจสอบ session" busy />;

  const mutate = canMutate(session);
  return (
    <NavigationContext.Provider value={navigations}>
      <div className="shell">
        <a className="skip-link" href="#main">
          ข้ามไปเนื้อหาหลัก
        </a>
        <header className="topbar">
          <div className="brand">
            <span className="eyebrow">INTERNAL · PLATFORM OPERATIONS</span>
            <strong>D-Contact Platform Console</strong>
          </div>
          <nav aria-label="เมนูหลัก" className="topnav">
            <button
              className={`nav-link${route.name === 'list' ? ' active' : ''}`}
              aria-current={route.name === 'list' ? 'page' : undefined}
              onClick={() => navigate({ name: 'list' })}
            >
              Tenants
            </button>
            {mutate ? (
              <button
                className={`nav-link${route.name === 'new' ? ' active' : ''}`}
                aria-current={route.name === 'new' ? 'page' : undefined}
                onClick={() => navigate({ name: 'new' })}
              >
                สร้าง tenant
              </button>
            ) : null}
          </nav>
          <div className="identity">
            <span className="chip neutral">
              {mutate ? 'Platform Operator' : 'Platform Auditor (อ่านอย่างเดียว)'}
            </span>
            {onSignOut ? (
              <button className="button subtle" onClick={onSignOut}>
                ออกจากระบบ
              </button>
            ) : null}
          </div>
        </header>
        <main id="main" className="main" tabIndex={-1}>
          {route.name === 'list' ? (
            <TenantList api={api} navigate={navigate} canCreate={mutate} />
          ) : route.name === 'new' ? (
            mutate ? (
              <CreateWizard api={api} navigate={navigate} />
            ) : (
              <PageHeading title="สร้าง tenant" subtitle="บัญชีนี้เป็นแบบอ่านอย่างเดียว">
                <p role="alert" className="callout warning">
                  Platform Auditor สร้าง tenant ไม่ได้
                </p>
              </PageHeading>
            )
          ) : (
            <RequestDetail
              key={route.requestId}
              api={api}
              requestId={route.requestId}
              canMutate={mutate}
              navigate={navigate}
              pollMs={pollMs}
            />
          )}
        </main>
      </div>
    </NavigationContext.Provider>
  );
}

function Centered({
  title,
  busy,
  children,
}: {
  title: string;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <main className="centered" aria-busy={busy ? 'true' : undefined}>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

/** หัวข้อหน้า — รับโฟกัสทุกครั้งที่เปิดหน้า เพื่อให้ screen reader รู้ว่าเปลี่ยนหน้าแล้ว */
function PageHeading({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const navigations = useContext(NavigationContext);
  useEffect(() => {
    if (navigations > 0) heading.current?.focus();
  }, [title, navigations]);
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
  return <span className={`chip ${tone}`}>{children}</span>;
}

function StatusChip({ status }: { status: RequestStatus }) {
  const presentation = STATUS_LABELS[status];
  return (
    <Chip tone={presentation.tone}>
      {presentation.label} <span className="code">({status})</span>
    </Chip>
  );
}

function ErrorAlert({ error, onRetry }: { error: ErrorEnvelope; onRetry?: () => void }) {
  return (
    <div role="alert" className="callout danger">
      <strong>{errorMessage(error)}</strong>
      {error.correlationId ? (
        <span className="muted small"> · อ้างอิง {error.correlationId}</span>
      ) : null}
      {onRetry && error.retryable ? (
        <div className="actions">
          <button className="button" onClick={onRetry}>
            ลองอีกครั้ง
          </button>
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
      title="Tenants"
      subtitle="ค้นหาด้วยชื่อองค์กร, slug, primary domain, request ID หรืออีเมล first admin"
      actions={
        canCreate ? (
          <button className="button primary" onClick={() => navigate({ name: 'new' })}>
            สร้าง tenant
          </button>
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
        <div className="field grow">
          <label htmlFor="tenant-search">ค้นหา tenant</label>
          <input
            id="tenant-search"
            type="search"
            value={query}
            maxLength={254}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="tenant-status">สถานะคำขอ</label>
          <select
            id="tenant-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">ทั้งหมด</option>
            {(Object.keys(STATUS_LABELS) as RequestStatus[]).map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value].label} ({value})
              </option>
            ))}
          </select>
        </div>
        <div className="actions end">
          <button className="button primary" type="submit">
            ค้นหา
          </button>
          <button
            className="button"
            type="button"
            onClick={() => {
              setQuery('');
              setStatus('');
              setSubmitted({ query: '', status: '' });
            }}
          >
            ล้าง
          </button>
        </div>
      </form>

      <div className="card" aria-busy={state === 'loading' ? 'true' : 'false'}>
        <p className="sr-only" role="status" aria-live="polite">
          {state === 'loading'
            ? 'กำลังโหลด tenant'
            : state === 'ready'
              ? `พบ ${items.length} รายการ`
              : ''}
        </p>
        {state === 'loading' ? (
          <p className="muted pad">กำลังโหลด…</p>
        ) : state === 'error' && error ? (
          <div className="pad">
            <ErrorAlert error={error} onRetry={() => void load(submitted)} />
          </div>
        ) : items.length === 0 ? (
          <div className="pad empty-state">
            <h2>ไม่พบ tenant</h2>
            <p className="muted">ลองคำค้นอื่น หรือล้างตัวกรอง</p>
          </div>
        ) : (
          <table className="table">
            <caption className="sr-only">รายการ tenant</caption>
            <thead>
              <tr>
                <th scope="col">Tenant</th>
                <th scope="col">Identity</th>
                <th scope="col">Lifecycle</th>
                <th scope="col">Provisioning</th>
                <th scope="col">อัปเดตล่าสุด</th>
                <th scope="col">
                  <span className="sr-only">การทำงาน</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.tenantId}>
                  <th scope="row">{item.name}</th>
                  <td>
                    <span className="code">{item.slug}</span>
                    <br />
                    <span className="muted small">{item.primaryDomain ?? '—'}</span>
                  </td>
                  <td>
                    <Chip tone={item.lifecycleStatus === 'ACTIVE' ? 'success' : 'info'}>
                      {item.lifecycleStatus}
                    </Chip>
                  </td>
                  <td>
                    {item.request ? (
                      <StatusChip status={item.request.status} />
                    ) : (
                      <Chip tone="neutral">legacy</Chip>
                    )}
                  </td>
                  <td>{formatTime(item.request?.updatedAt ?? item.createdAt)}</td>
                  <td>
                    {item.request ? (
                      <button
                        className="button link"
                        onClick={() =>
                          navigate({ name: 'request', requestId: item.request!.requestId })
                        }
                        aria-label={`เปิดรายละเอียด ${item.name}`}
                      >
                        เปิด →
                      </button>
                    ) : (
                      <span className="muted small">ไม่มี provisioning history</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor && state !== 'loading' ? (
          <div className="pad">
            <button
              className="button"
              disabled={state === 'more'}
              onClick={() => void load(submitted, cursor)}
            >
              {state === 'more' ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}
            </button>
          </div>
        ) : null}
      </div>
    </PageHeading>
  );
}

// ── Create wizard ───────────────────────────────────────────────────────────

const WIZARD_STEPS = ['ข้อมูลลูกค้า', 'ตรวจสอบ', 'Provisioning', 'ส่งมอบ'] as const;

function Stepper({ active }: { active: number }) {
  return (
    <ol className="stepper" aria-label="ขั้นตอนการสร้าง tenant">
      {WIZARD_STEPS.map((label, index) => (
        <li
          key={label}
          className={index === active ? 'on' : index < active ? 'done' : ''}
          aria-current={index === active ? 'step' : undefined}
        >
          <span aria-hidden="true">{index < active ? '✓' : index + 1}</span> {label}
        </li>
      ))}
    </ol>
  );
}

type DraftErrors = Partial<Record<keyof TenantDraft, string>>;

function ErrorSummary({ errors }: { errors: DraftErrors }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, [errors]);
  const entries = Object.entries(errors) as [keyof TenantDraft, string][];
  if (entries.length === 0) return null;
  return (
    <div
      ref={box}
      className="callout danger"
      role="alert"
      tabIndex={-1}
      aria-labelledby="error-summary-title"
    >
      <h2 id="error-summary-title">ข้อมูลบางช่องต้องแก้ไข ({entries.length})</h2>
      <ul>
        {entries.map(([field, message]) => (
          <li key={field}>
            <a
              href={`#field-${field}`}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(`field-${field}`)?.focus();
              }}
            >
              {FIELD_LABELS[field]}: {message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
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
  type?: string;
  hint?: string;
  autoComplete?: string;
}) {
  const hintId = `hint-${field}`;
  const errorId = `error-${field}`;
  return (
    <div className="field">
      <label htmlFor={`field-${field}`}>{FIELD_LABELS[field]}</label>
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      <input
        id={`field-${field}`}
        type={type}
        value={draft[field]}
        autoComplete={autoComplete}
        aria-invalid={errors[field] ? 'true' : undefined}
        aria-describedby={
          [hint ? hintId : '', errors[field] ? errorId : ''].filter(Boolean).join(' ') || undefined
        }
        onChange={(event) => onChange(field, event.target.value)}
      />
      {errors[field] ? (
        <p id={errorId} className="field-error">
          {errors[field]}
        </p>
      ) : null}
    </div>
  );
}

function CreateWizard({ api, navigate }: { api: PlatformApi; navigate: Navigate }) {
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
      const conflict = conflictField[envelope.code];
      if (Object.keys(fields).length > 0 || conflict) {
        // กลับไปแก้ในฟอร์ม: ข้อมูลเปลี่ยน = key ใหม่
        setErrors({ ...fields, ...(conflict ? { [conflict]: errorMessage(envelope) } : {}) });
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
      <PageHeading title="สร้าง tenant">
        <ErrorAlert error={catalogError} />
      </PageHeading>
    );
  }
  if (!catalog) {
    return (
      <PageHeading title="สร้าง tenant">
        <p className="muted" aria-busy="true">
          กำลังโหลด plan และ bootstrap template…
        </p>
      </PageHeading>
    );
  }

  const template = catalog.templates.find(
    (entry) => entry.version === draft.bootstrapTemplateVersion,
  );
  return (
    <PageHeading
      title={
        phase === 'form' ? 'สร้าง tenant: ข้อมูลลูกค้า' : 'สร้าง tenant: ตรวจสอบก่อน provision'
      }
      subtitle="Guided onboarding — tenant จะพร้อมใช้งานเมื่อทุกขั้นผ่านและสถานะเป็น ACTIVE เท่านั้น"
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
              <legend>องค์กรลูกค้า</legend>
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
                hint="แก้ไม่ได้หลังยืนยัน ใช้เป็น subdomain และ SIP domain"
              />
              <TextField
                field="primaryDomain"
                draft={draft}
                errors={errors}
                onChange={update}
                hint="เช่น example.co.th"
              />
            </fieldset>
            <fieldset>
              <legend>Plan และค่าตั้งต้น</legend>
              <div className="field">
                <label htmlFor="field-planCode">{FIELD_LABELS.planCode}</label>
                <select
                  id="field-planCode"
                  value={draft.planCode}
                  aria-invalid={errors.planCode ? 'true' : undefined}
                  aria-describedby={errors.planCode ? 'error-planCode' : undefined}
                  onChange={(event) => update('planCode', event.target.value)}
                >
                  <option value="">เลือก plan</option>
                  {catalog.plans.map((plan) => (
                    <option key={plan.code} value={plan.code}>
                      {plan.code} (v{plan.version})
                    </option>
                  ))}
                </select>
                {errors.planCode ? (
                  <p id="error-planCode" className="field-error">
                    {errors.planCode}
                  </p>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="field-locale">{FIELD_LABELS.locale}</label>
                <select
                  id="field-locale"
                  value={draft.locale}
                  onChange={(event) => update('locale', event.target.value)}
                >
                  {LOCALES.map((locale) => (
                    <option key={locale.value} value={locale.value}>
                      {locale.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="field-timezone">{FIELD_LABELS.timezone}</label>
                <select
                  id="field-timezone"
                  value={draft.timezone}
                  onChange={(event) => update('timezone', event.target.value)}
                >
                  {TIMEZONES.map((timezone) => (
                    <option key={timezone} value={timezone}>
                      {timezone}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span className="label" id="template-label">
                  {FIELD_LABELS.bootstrapTemplateVersion}
                </span>
                <p
                  id="field-bootstrapTemplateVersion"
                  tabIndex={-1}
                  aria-labelledby="template-label"
                  className="code"
                >
                  {template
                    ? `${template.version} · ${template.contentDigest.slice(0, 12)}…`
                    : 'ไม่มี template ที่ใช้งานได้'}
                </p>
                {errors.bootstrapTemplateVersion ? (
                  <p className="field-error">{errors.bootstrapTemplateVersion}</p>
                ) : null}
              </div>
            </fieldset>
            <fieldset>
              <legend>First admin</legend>
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
                hint="ต้องไม่ซ้ำทั้ง platform — ระบบส่งคำเชิญ (72 ชั่วโมง) ไปที่อีเมลนี้"
              />
            </fieldset>
            <div className="actions end">
              <button type="button" className="button" onClick={() => navigate({ name: 'list' })}>
                ยกเลิก
              </button>
              <button type="submit" className="button primary">
                ตรวจสอบข้อมูล →
              </button>
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
                  <dt>{FIELD_LABELS[field]}</dt>
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
              <strong>ค่าที่แก้ไม่ได้หลังส่งคำขอ</strong>
              <p>
                Tenant ID ถูกสร้างโดย server; slug, primary domain, plan และ template ถูก pin ตลอด
                onboarding ถ้าคำขอจบแบบยุติ ค่าเหล่านี้จะติด tombstone 30 วัน
              </p>
            </div>
            {submitError ? <ErrorAlert error={submitError} onRetry={() => void submit()} /> : null}
            <div className="field checkbox">
              <input
                id="confirm-provision"
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <label htmlFor="confirm-provision">
                ฉันตรวจสอบ identity, plan และ first admin แล้ว และเข้าใจว่าระบบจะเริ่ม durable
                provisioning
              </label>
            </div>
            <div className="actions end">
              <button className="button" onClick={() => setPhase('form')} disabled={submitting}>
                ← แก้ไข
              </button>
              <button
                className="button primary"
                onClick={() => void submit()}
                disabled={!confirmed || submitting}
              >
                {submitting ? 'กำลังส่ง…' : 'ยืนยันและเริ่ม provision'}
              </button>
            </div>
          </div>
        )}
        <aside className="side" aria-label="ข้อมูลประกอบ">
          <div className="card pad">
            <h2 className="h3">Completion boundary</h2>
            <p className="muted small">
              แสดงว่าพร้อมใช้งานเมื่อ Organization, bootstrap, first admin, คำเชิญ และ readiness
              ผ่านครบเท่านั้น
            </p>
          </div>
          <div className="callout info">
            <strong>ข้อมูลปลอดภัย</strong>
            <p className="small">
              ไม่มี temporary password หรือ secret ใน UI, URL และ Action history
            </p>
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
  navigate,
  pollMs,
}: {
  api: PlatformApi;
  requestId: string;
  canMutate: boolean;
  navigate: Navigate;
  pollMs: number;
}) {
  const [view, setView] = useState<RequestView | null>(null);
  const [error, setError] = useState<ErrorEnvelope | null>(null);
  const [recovery, setRecovery] = useState<RecoveryOption | 'RESEND' | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);

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
        title={error.code === 'NOT_FOUND' ? 'ไม่พบคำขอ' : 'เปิดคำขอไม่ได้'}
        actions={
          <button className="button" onClick={() => navigate({ name: 'list' })}>
            ← กลับรายการ
          </button>
        }
      >
        <ErrorAlert error={error} onRetry={() => void refresh()} />
      </PageHeading>
    );
  }
  if (!view) {
    return (
      <PageHeading title="กำลังโหลดคำขอ">
        <p className="muted" aria-busy="true">
          กำลังโหลด…
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
      subtitle={`Request ${view.requestId}`}
      actions={
        <button className="button" onClick={() => navigate({ name: 'list' })}>
          ← กลับรายการ
        </button>
      }
    >
      <Stepper active={activeStage} />
      <p className="sr-only" role="status" aria-live="polite">
        สถานะ {STATUS_LABELS[view.status].label}
      </p>
      <div className="layout">
        <div className="stack">
          <section className="card" aria-labelledby="progress-title">
            <div className="card-head">
              <h2 id="progress-title">
                {ready
                  ? 'พร้อมส่งมอบให้ลูกค้า'
                  : view.status === 'ACTION_REQUIRED'
                    ? 'ต้องการการตัดสินใจ'
                    : 'Provisioning'}
              </h2>
              <StatusChip status={view.status} />
            </div>
            <div className="pad">
              {view.status === 'PENDING' ? (
                <p className="callout info">
                  รับคำขอแล้ว — worker จะเริ่มอัตโนมัติ หน้านี้อัปเดตเอง
                </p>
              ) : null}
              {view.status === 'ACTION_REQUIRED' ? (
                <div className="callout danger" role="alert">
                  <strong>
                    หยุดอย่างปลอดภัยที่ขั้น {step ? STEP_LABELS[step.stepKey].title : '—'}
                  </strong>
                  <p className="small">
                    เหตุผล{' '}
                    <span className="code">{view.failureCode ?? step?.errorCode ?? '—'}</span> ·
                    revision {view.revision}
                  </p>
                </div>
              ) : null}
              {ready ? (
                <div className="callout success">
                  <strong>Tenant ACTIVE</strong>
                  <p className="small">ทุกขั้นผ่านครบและเปิดใช้งานใน transaction เดียวกัน</p>
                </div>
              ) : null}
              <ol className="progress">
                {view.steps.map((entry) => (
                  <li key={entry.stepKey} className={`progress-item ${entry.state.toLowerCase()}`}>
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
                      <strong>{STEP_LABELS[entry.stepKey].title}</strong>
                      <span className="sr-only"> สถานะ {entry.state}</span>
                      <p className="muted small">
                        {entry.state === 'SUCCEEDED'
                          ? `สำเร็จ · ${formatTime(entry.finishedAt)}`
                          : entry.state === 'ACTION_REQUIRED'
                            ? `หยุดรอ Operator · ${entry.errorCode ?? ''}`
                            : entry.state === 'RUNNING'
                              ? `กำลังทำ · attempt ${entry.attempt}`
                              : entry.nextAttemptAt
                                ? `นัดลองใหม่ ${formatTime(entry.nextAttemptAt)}`
                                : STEP_LABELS[entry.stepKey].detail}
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
                <h2 id="recovery-title">Recovery</h2>
              </div>
              <div className="pad">
                {canMutate ? (
                  <>
                    <p className="muted small">
                      แนะนำ: Reconcile ก่อน — ทุก action ต้อง preview แล้วยืนยันพร้อมเหตุผล
                    </p>
                    <div className="recovery-options">
                      {RECOVERY_OPTIONS.map((option) => (
                        <button
                          key={option.action}
                          className={`button ${option.recommended ? 'primary' : option.destructive ? 'danger' : ''}`}
                          onClick={() => setRecovery(option)}
                          aria-describedby={`recovery-${option.path}`}
                        >
                          {option.title}
                          {option.recommended ? ' (แนะนำ)' : ''}
                        </button>
                      ))}
                    </div>
                    <ul className="small muted">
                      {RECOVERY_OPTIONS.map((option) => (
                        <li key={option.action} id={`recovery-${option.path}`}>
                          <strong>{option.title}:</strong> {option.detail}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="callout info">
                    Platform Auditor ดูได้อย่างเดียว — ต้องให้ Platform Operator ตัดสินใจ
                  </p>
                )}
              </div>
            </section>
          ) : null}

          {recovery ? (
            recovery === 'RESEND' ? (
              <ResendPanel
                api={api}
                view={view}
                onClose={() => setRecovery(null)}
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
                onClose={() => setRecovery(null)}
                onDone={() => setHistoryVersion((value) => value + 1)}
              />
            )
          ) : null}

          <ActionHistory api={api} tenantId={view.tenantId} version={historyVersion} />
        </div>

        <aside className="side" aria-label="ข้อมูลที่ pin และการส่งมอบ">
          <section className="card pad" aria-labelledby="pinned-title">
            <h2 id="pinned-title" className="h3">
              ค่าที่ pin ไว้
            </h2>
            <dl className="summary compact">
              <div>
                <dt>Slug</dt>
                <dd className="code">{view.slug}</dd>
              </div>
              <div>
                <dt>Primary domain</dt>
                <dd className="code">{view.primaryDomain}</dd>
              </div>
              <div>
                <dt>Plan</dt>
                <dd>
                  {view.plan.code} v{view.plan.version}
                </dd>
              </div>
              <div>
                <dt>Bootstrap template</dt>
                <dd className="code">{view.bootstrapTemplateVersion}</dd>
              </div>
              <div>
                <dt>Locale / Timezone</dt>
                <dd>
                  {view.locale} · {view.timezone}
                </dd>
              </div>
              <div>
                <dt>รับคำขอ</dt>
                <dd>{formatTime(view.acceptedAt)}</dd>
              </div>
            </dl>
          </section>
          <section className="card pad" aria-labelledby="handoff-title">
            <h2 id="handoff-title" className="h3">
              First admin และคำเชิญ
            </h2>
            <p>
              {view.firstAdmin.displayName}
              <br />
              <span className="muted small">{view.firstAdmin.emailMasked}</span>
            </p>
            {view.invitation ? (
              <p className="small">
                คำเชิญรุ่นที่ {view.invitation.generation}:{' '}
                <strong>
                  {view.invitation.delivery === 'SENT'
                    ? 'ส่งถึงผู้ให้บริการอีเมลแล้ว'
                    : view.invitation.delivery}
                </strong>
                <br />
                หมดอายุ {formatTime(view.invitation.expiresAt)}
                {view.invitation.expired ? ' (หมดอายุแล้ว)' : ''}
                <br />
                <span className="muted">การส่งถึงไม่ได้แปลว่าผู้ใช้ activate แล้ว</span>
              </p>
            ) : (
              <p className="muted small">ยังไม่ได้ส่งคำเชิญ</p>
            )}
            {canMutate && view.invitation && !recovery ? (
              <button className="button" onClick={() => setRecovery('RESEND')}>
                ส่งคำเชิญอีกครั้ง
              </button>
            ) : null}
          </section>
        </aside>
      </div>
    </PageHeading>
  );
}

// ── Recovery (preview → confirm → execute) ──────────────────────────────────

const REASONS = [
  { value: 'OPERATOR_VERIFIED', label: 'Operator ตรวจสถานะจริงแล้ว' },
  { value: 'DEPENDENCY_RECOVERED', label: 'ระบบภายนอกกลับมาปกติแล้ว' },
  { value: 'CUSTOMER_REQUEST', label: 'ลูกค้าร้องขอ' },
  { value: 'INVALID_REQUEST', label: 'คำขอไม่ถูกต้อง ต้องยุติ' },
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
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [phase, setPhase] = useState<'previewing' | 'confirm' | 'executing' | 'done'>('previewing');
  const [preview, setPreview] = useState<CommandView | null>(null);
  const [command, setCommand] = useState<CommandView | null>(null);
  const [error, setError] = useState<ErrorEnvelope | null>(null);
  const [reasonCode, setReasonCode] = useState<string>(REASONS[0].value);
  const [comment, setComment] = useState('');
  const [acknowledged, setAcknowledged] = useState(!option.destructive);
  const [commentError, setCommentError] = useState<string | null>(null);
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
      setCommentError('ต้องระบุเหตุผลเพิ่มเติม');
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
          {option.title}:{' '}
          {phase === 'previewing'
            ? 'กำลัง preview'
            : phase === 'executing'
              ? 'กำลังดำเนินการ'
              : phase === 'done'
                ? 'ผลการดำเนินการ'
                : 'ยืนยัน'}
        </h2>
        <button className="button subtle" onClick={onClose} disabled={phase === 'executing'}>
          ปิด
        </button>
      </div>
      <div className="pad" aria-live="polite">
        {phase === 'previewing' ? (
          <p className="muted">ระบบกำลังตรวจสถานะจริงของ dependency…</p>
        ) : null}
        {error ? (
          <>
            <ErrorAlert error={error} />
            {['REVISION_CONFLICT', 'PREVIEW_STALE', 'COMMAND_IN_PROGRESS'].includes(error.code) ? (
              <button className="button" onClick={() => void runPreview()}>
                โหลดสถานะล่าสุดแล้ว preview ใหม่
              </button>
            ) : null}
          </>
        ) : null}
        {phase === 'confirm' && preview && !error ? (
          allowed ? (
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                void execute();
              }}
            >
              <dl className="summary compact">
                <div>
                  <dt>ผลการตรวจ</dt>
                  <dd className="code">{result?.finding ?? '—'}</dd>
                </div>
                <div>
                  <dt>Revision ที่ยืนยัน</dt>
                  <dd>{revision.current}</dd>
                </div>
                <div>
                  <dt>Preview digest</dt>
                  <dd className="code">{result?.previewDigest?.slice(0, 16)}…</dd>
                </div>
              </dl>
              <div className="field">
                <label htmlFor={`${titleId}-reason`}>เหตุผล</label>
                <select
                  id={`${titleId}-reason`}
                  value={reasonCode}
                  onChange={(event) => setReasonCode(event.target.value)}
                >
                  {REASONS.map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      {reason.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${titleId}-comment`}>รายละเอียด (บันทึกใน Action history)</label>
                <textarea
                  id={`${titleId}-comment`}
                  value={comment}
                  maxLength={500}
                  rows={3}
                  aria-invalid={commentError ? 'true' : undefined}
                  aria-describedby={commentError ? `${titleId}-comment-error` : undefined}
                  onChange={(event) => setComment(event.target.value)}
                />
                {commentError ? (
                  <p id={`${titleId}-comment-error`} className="field-error">
                    {commentError}
                  </p>
                ) : null}
              </div>
              {option.destructive ? (
                <div className="field checkbox">
                  <input
                    id={`${titleId}-ack`}
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  <label htmlFor={`${titleId}-ack`}>
                    ฉันเข้าใจผลกระทบของ {option.title} และตรวจสอบแล้ว
                  </label>
                </div>
              ) : null}
              <div className="actions end">
                <button type="button" className="button" onClick={onClose}>
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  className={`button ${option.destructive ? 'danger' : 'primary'}`}
                  disabled={!acknowledged}
                >
                  ยืนยัน {option.title}
                </button>
              </div>
            </form>
          ) : (
            <div className="callout warning" role="alert">
              <strong>ทำรายการนี้ไม่ได้ตอนนี้</strong>
              <p>
                {preview.state === 'REJECTED'
                  ? errorMessage({
                      code: preview.errorCode ?? 'INTERNAL',
                      title: preview.errorCode ?? '',
                    })
                  : (BLOCKED_REASONS[result?.blockedBy ?? ''] ?? result?.blockedBy)}
              </p>
            </div>
          )
        ) : null}
        {phase === 'executing' ? (
          <p className="muted">ส่งคำสั่งแล้ว (202) — รอ worker ดำเนินการ…</p>
        ) : null}
        {phase === 'done' && command ? (
          command.state === 'SUCCEEDED' ? (
            <div className="callout success" role="status">
              <strong>{option.title} สำเร็จ</strong>
              <p className="small">สถานะคำขอ: {String(command.result?.status ?? '—')}</p>
            </div>
          ) : (
            <div className="callout danger" role="alert">
              <strong>{option.title} ถูกปฏิเสธ</strong>
              <p className="small">
                {errorMessage({
                  code: command.errorCode ?? 'INTERNAL',
                  title: command.errorCode ?? '',
                })}
              </p>
              <button className="button" onClick={() => void runPreview()}>
                preview ใหม่
              </button>
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
    <section className="card panel" aria-labelledby={titleId}>
      <div className="card-head">
        <h2 id={titleId} ref={heading} tabIndex={-1}>
          ส่งคำเชิญอีกครั้ง
        </h2>
        <button className="button subtle" onClick={onClose}>
          ปิด
        </button>
      </div>
      <div className="pad">
        {error ? (
          <div role="alert" className="callout danger">
            <strong>{errorMessage(error.envelope)}</strong>
            {error.retryAfter ? (
              <p className="small">
                ลองได้อีกครั้งในประมาณ {Math.ceil(error.retryAfter / 60)} นาที
              </p>
            ) : null}
          </div>
        ) : null}
        {state === 'queued' ? (
          <p role="status" className="callout success">
            รับคำสั่งแล้ว — worker จะสร้างคำเชิญรุ่นใหม่และยกเลิกรุ่นเก่า
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
              ส่งซ้ำได้ไม่เกิน 3 ครั้งต่อชั่วโมง · ส่งไปแล้วในชั่วโมงนี้{' '}
              {view.invitation?.resendsInLastHour ?? 0} ครั้ง
            </p>
            <div className="field">
              <label htmlFor={`${titleId}-comment`}>เหตุผล (บันทึกใน Action history)</label>
              <textarea
                id={`${titleId}-comment`}
                rows={3}
                maxLength={500}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </div>
            <div className="actions end">
              <button type="button" className="button" onClick={onClose}>
                ยกเลิก
              </button>
              <button type="submit" className="button primary" disabled={state === 'sending'}>
                {state === 'sending' ? 'กำลังส่ง…' : 'ส่งคำเชิญอีกครั้ง'}
              </button>
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
          <h2 id="history-title">Action history</h2>
          <p className="muted small">
            Timeline แบบ append-only — ใครทำอะไร เมื่อไร และอ้างอิง context ใด
          </p>
        </div>
      </div>
      <div className="pad" aria-busy={loading ? 'true' : 'false'}>
        {error ? <ErrorAlert error={error} onRetry={() => void load()} /> : null}
        {!error && items.length === 0 && !loading ? (
          <p className="muted">ยังไม่มีเหตุการณ์</p>
        ) : null}
        <ol className="timeline" aria-label="เหตุการณ์ล่าสุดก่อน">
          {ordered.map((item) => (
            <li
              key={item.id}
              className={`timeline-item ${item.outcome === 'REJECTED' ? 'rejected' : ''}`}
            >
              <div className="timeline-meta">
                <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time>
                <Chip tone={item.actor.kind === 'SYSTEM' ? 'neutral' : 'info'}>
                  {ACTOR_LABELS[item.actor.kind] ?? item.actor.kind}
                </Chip>
              </div>
              <div>
                <strong>{actionLabel(item.action)}</strong>
                {item.outcome !== 'SUCCEEDED' ? (
                  <Chip tone={item.outcome === 'REJECTED' ? 'danger' : 'neutral'}>
                    {item.outcome}
                  </Chip>
                ) : null}
                <p className="small">{describeHistory(item)}</p>
                {item.comment ? <p className="small quote">“{item.comment}”</p> : null}
                <p className="muted small">
                  correlation <span className="code">{item.correlationId}</span> · request{' '}
                  <span className="code">{item.requestId.slice(0, 8)}</span> · audit{' '}
                  <span className="code">{item.id.slice(0, 8)}</span>
                </p>
              </div>
            </li>
          ))}
        </ol>
        {cursor ? (
          <button className="button" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? 'กำลังโหลด…' : 'โหลดเหตุการณ์ใหม่กว่านี้'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
