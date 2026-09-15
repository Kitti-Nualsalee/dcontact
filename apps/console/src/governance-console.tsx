/**
 * CG4.9 (#192): Hybrid Governance Console ตาม #180
 *
 * - Exceptions = A approval workspace: คิวตาม risk/expiry → exception + binding → action rail
 * - Policies = B change studio: Draft → Tests → Approvals → Activation พร้อม head และ release packet
 * - Audit = C evidence-first timeline + safety case และใช้เป็น evidence drawer จาก A/B
 *
 * ทุกข้อมูลมาจาก D-Contact API เท่านั้น ไม่มี state ใดเป็น truth ฝั่ง Console: หลังทุก command
 * หรือ error จะโหลด canonical state ใหม่ และปุ่ม command ถูกปิดเมื่อ state ไม่แน่ชัด (fail closed)
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  ApprovalRecord,
  EffectiveScope,
  ExceptionRevision,
  ExceptionSeries,
  GovernanceApi,
  KillSwitch,
  PolicyTestArtifact,
  PolicyVersion,
  Quorum,
} from './governance-api.js';
import {
  DECISION_VOCABULARY,
  canDecide,
  canRequestChanges,
  digestLabel,
  effectiveWindowLabel,
  governanceHref,
  isRedacted,
  parseGovernanceLocation,
  recoveryFor,
  referenceLabel,
  riskLabel,
  sortExceptionQueue,
  stateLabel,
  type GovernanceLocation,
  type GovernanceSection,
  type GovernanceViewer,
  type RecoveryState,
} from './governance-model.js';
import './governance.css';

const VIEWER_LABEL: Readonly<Record<GovernanceViewer, string>> = {
  SUPERVISOR: 'Supervisor · summary',
  TENANT_ADMIN: 'Tenant Admin · summary',
  COMPLIANCE: 'Compliance · evidence',
};

/** prefix ของ opaque id ตามด้วย … (ส่วนที่ตัด) — digest ใช้ …suffix แยกกันใน digestLabel */
const shortId = (value: string) => `${value.slice(0, 8)}…`;

export function GovernanceConsole({
  api,
  viewer,
  initialLocation,
}: {
  api: GovernanceApi;
  viewer: GovernanceViewer;
  initialLocation: GovernanceLocation;
}) {
  const [location, setLocation] = useState(initialLocation);
  const mainRef = useRef<HTMLElement>(null);

  const go = useCallback((next: GovernanceLocation) => {
    window.history.pushState({}, '', governanceHref(next));
    setLocation(next);
    // ย้าย focus ไปเนื้อหาใหม่ให้ screen reader รู้ว่าหน้าเปลี่ยน
    requestAnimationFrame(() => mainRef.current?.focus());
  }, []);

  useEffect(() => {
    const onPop = () => setLocation(parseGovernanceLocation(new URL(window.location.href)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const section = location.section;
  const nav: Array<{ key: GovernanceSection; label: string; current: boolean }> = [
    { key: 'overview', label: 'ภาพรวม', current: section === 'overview' },
    {
      key: location.policyId ? 'policies' : 'exceptions',
      label: 'Policies & Exceptions',
      current: section === 'exceptions' || section === 'policies',
    },
    { key: 'audit', label: 'Audit', current: section === 'audit' },
  ];

  return (
    <div className="gov-shell">
      <a className="gov-skip" href="#gov-main">
        ข้ามไปเนื้อหาหลัก
      </a>
      <header className="gov-header">
        <strong>D-CONTACT</strong>
        <span>Contact Governance</span>
        <span className="gov-viewer">มุมมอง: {VIEWER_LABEL[viewer]}</span>
      </header>
      <nav aria-label="Contact Governance" className="gov-nav">
        {nav.map((item) => (
          <button
            key={item.label}
            type="button"
            aria-current={item.current ? 'page' : undefined}
            onClick={() => go({ ...location, section: item.key })}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <main id="gov-main" ref={mainRef} tabIndex={-1} className="gov-main">
        <p className="gov-boundary" role="note">
          {DECISION_VOCABULARY.developmentComplete}
        </p>
        {section === 'exceptions' || section === 'policies' ? (
          <nav aria-label="Policies & Exceptions" className="gov-subnav">
            <button
              type="button"
              aria-current={section === 'exceptions' ? 'page' : undefined}
              onClick={() => go({ ...location, section: 'exceptions' })}
            >
              Exceptions
            </button>
            <button
              type="button"
              aria-current={section === 'policies' ? 'page' : undefined}
              onClick={() => go({ ...location, section: 'policies' })}
            >
              Policies
            </button>
          </nav>
        ) : null}
        {section === 'overview' ? <Overview api={api} go={go} location={location} /> : null}
        {section === 'exceptions' ? (
          <ExceptionWorkspace api={api} viewer={viewer} location={location} go={go} />
        ) : null}
        {section === 'policies' ? (
          <PolicyStudio api={api} viewer={viewer} location={location} go={go} />
        ) : null}
        {section === 'audit' ? <AuditView api={api} location={location} go={go} /> : null}
      </main>
    </div>
  );
}

// ── shared building blocks ─────────────────────────────────────────────────────

function useCanonical<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T>();
  const [failure, setFailure] = useState<RecoveryState>();
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadRef.current());
      setFailure(undefined);
    } catch (error) {
      // state ที่อ่านไม่ได้ต้องไม่ถูกแทนด้วย snapshot เก่า: ล้างข้อมูลแล้วแสดง recovery
      setData(undefined);
      setFailure(recoveryFor(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, failure, loading, reload };
}

/**
 * Idempotency-Key ผูกกับ intent (รายการ + revision + การตัดสิน) ถ้าผลไม่แน่ชัดจะเก็บ key ไว้
 * เพื่อให้การส่งซ้ำเป็นคำสั่งเดิม ห้ามสร้าง key ใหม่เพื่อหลบผลเดิม
 */
function useCommand(onSettled: () => Promise<void>) {
  const keys = useRef(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryState & { intent: string }>();

  const run = useCallback(
    async <R,>(intent: string, execute: (idempotencyKey: string) => Promise<R>) => {
      const key = keys.current.get(intent) ?? crypto.randomUUID();
      keys.current.set(intent, key);
      setPending(true);
      try {
        const result = await execute(key);
        keys.current.delete(intent);
        setRecovery(undefined);
        return result;
      } catch (error) {
        const state = recoveryFor(error);
        if (state.recovery !== 'SAME_KEY') keys.current.delete(intent);
        setRecovery({ ...state, intent });
        return undefined;
      } finally {
        setPending(false);
        await onSettled();
      }
    },
    [onSettled],
  );

  return { run, pending, recovery, clearRecovery: () => setRecovery(undefined) };
}

function RecoveryBanner({
  state,
  onReload,
  onRetry,
}: {
  state: RecoveryState;
  onReload: () => void;
  onRetry?: () => void;
}) {
  const title = {
    STALE_APPROVAL: 'สิทธิ์อนุมัติ stale',
    VERSION_CONFLICT: 'Version conflict',
    HEAD_CONFLICT: 'Policy head conflict',
    OUTCOME_UNKNOWN: 'ผลของคำสั่งยังไม่แน่ชัด · hold ไว้ก่อน',
    FORBIDDEN: 'ไม่มีสิทธิ์',
    LIFECYCLE_BLOCKED: 'ขั้นตอนนี้ยังทำไม่ได้',
    NOT_FOUND: 'ไม่พบรายการ',
    INVALID: 'คำขอไม่ถูกต้อง',
  }[state.kind];
  return (
    <div className={`gov-recovery gov-recovery-${state.kind.toLowerCase()}`} role="alert">
      <strong>⚠ {title}</strong>
      <p>{state.message}</p>
      {state.code ? <code>{state.code}</code> : null}
      <div className="gov-recovery-actions">
        {state.recovery !== 'NONE' ? (
          <button type="button" className="gov-secondary" onClick={onReload}>
            โหลด canonical state ล่าสุด
          </button>
        ) : null}
        {state.recovery === 'SAME_KEY' && onRetry ? (
          <button type="button" className="gov-secondary" onClick={onRetry}>
            ส่งซ้ำด้วยคำสั่งเดิม
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LiveStatus({ message }: { message?: string }) {
  return (
    <p className="gov-live" role="status" aria-live="polite">
      {message ?? ''}
    </p>
  );
}

function Guardrails() {
  return (
    <div className="gov-guardrail" role="note">
      <strong>🔒 Guardrails ที่ override ไม่ได้</strong>
      <span>
        DNC · purpose objection · consent/lawful basis · explicit preference BLOCK/DEFER · kill
        switch · rule ที่ overridable=false — ไม่มีคำสั่งใดในหน้านี้ข้ามได้
      </span>
    </div>
  );
}

interface DialogField {
  name: string;
  label: string;
  hint: string;
  initial?: string;
  type?: 'text' | 'datetime-local';
}

/** dialog ยืนยันแบบ modal: focus เข้า field แรก, Tab วนในกล่อง, Esc ปิดและคืน focus */
function ConfirmDialog({
  title,
  body,
  fields,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  fields: DialogField[];
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: (values: Record<string, string>) => void;
}) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.name, field.initial ?? ''])),
  );
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    boxRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => {
      // ปุ่มที่เปิด dialog ถูก disable ระหว่างรอ server ยืนยัน จึงคืน focus เมื่อกลับมาใช้ได้
      // ไม่งั้น focus หลุดไปที่ body และผู้ใช้ keyboard ต้องเริ่มไล่ใหม่จากต้นหน้า
      const target = returnFocus.current as HTMLButtonElement | null;
      let attempts = 0;
      const restore = () => {
        if (!target?.isConnected) return;
        if (!target.disabled) {
          target.focus();
          return;
        }
        if (attempts++ < 100) window.setTimeout(restore, 50);
      };
      restore();
    };
  }, []);

  const missing = fields.some((field) => values[field.name]?.trim().length === 0);

  return (
    <div className="gov-modal" role="presentation">
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="gov-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Tab') {
            const focusable = [
              ...(boxRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ??
                []),
            ];
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="gov-dialog-body">{body}</div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!missing) onConfirm(values);
          }}
        >
          {fields.map((field) => (
            <label key={field.name}>
              {field.label}
              <input
                type={field.type ?? 'text'}
                value={values[field.name] ?? ''}
                required
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.name]: event.target.value }))
                }
              />
              <small>{field.hint}</small>
            </label>
          ))}
          <div className="gov-dialog-actions">
            <button type="button" className="gov-secondary" onClick={onCancel}>
              ยกเลิก
            </button>
            <button
              type="submit"
              className={danger ? 'gov-danger' : 'gov-primary'}
              disabled={missing}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const EVIDENCE_FIELD: DialogField = {
  name: 'evidenceRef',
  label: 'Evidence reference',
  hint: 'ใส่เฉพาะ opaque reference เช่น เลข ticket ภายใน — ห้ามใส่ชื่อ เบอร์ หรืออีเมลลูกค้า',
};

const REASON_FIELD: DialogField = {
  name: 'reasonCode',
  label: 'Reason code',
  hint: 'รหัสเหตุผลแบบควบคุม เช่น COMPLIANCE_WITHDRAWN',
};

function OpenById({ go }: { go: (location: GovernanceLocation) => void }) {
  const [kind, setKind] = useState<'contactId' | 'seriesId' | 'policyId'>('contactId');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const inputId = useId();
  return (
    <form
      className="gov-open"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        const next: GovernanceLocation = {
          section: kind === 'policyId' ? 'policies' : 'exceptions',
          [kind]: trimmed,
        };
        const parsed = parseGovernanceLocation(
          new URL(`https://console.local/${governanceHref(next)}`),
        );
        if (!parsed[kind]) {
          setError('รับเฉพาะ opaque ID (UUID) — ห้ามค้นด้วยชื่อ เบอร์ หรืออีเมล');
          return;
        }
        setError(undefined);
        go(parsed);
      }}
    >
      <fieldset>
        <legend>เปิดรายการด้วย opaque ID</legend>
        <select
          aria-label="ประเภท ID"
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="contactId">Contact (คิว exception)</option>
          <option value="seriesId">Exception series</option>
          <option value="policyId">Policy series</option>
        </select>
        <label htmlFor={inputId} className="gov-visually-hidden">
          ID
        </label>
        <input
          id={inputId}
          value={value}
          placeholder="00000000-0000-0000-0000-000000000000"
          aria-invalid={error ? true : undefined}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="gov-primary">
          เปิด
        </button>
      </fieldset>
      {error ? (
        <p role="alert" className="gov-field-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────────

function Overview({
  api,
  go,
  location,
}: {
  api: GovernanceApi;
  go: (location: GovernanceLocation) => void;
  location: GovernanceLocation;
}) {
  const kills = useCanonical(() => api.killSwitches({ state: 'ACTIVE' }), [api]);
  return (
    <section aria-labelledby="gov-overview-title">
      <p className="gov-eyebrow">OVERVIEW</p>
      <h1 id="gov-overview-title">Contact Governance</h1>
      <OpenById go={go} />
      <section className="gov-panel" aria-labelledby="gov-kills-title">
        <h2 id="gov-kills-title">Kill switch ที่ใช้งานอยู่</h2>
        {kills.failure ? (
          <RecoveryBanner state={kills.failure} onReload={() => void kills.reload()} />
        ) : kills.loading ? (
          <p>กำลังโหลด canonical state…</p>
        ) : (kills.data ?? []).length === 0 ? (
          <p>ไม่มี kill switch ที่ใช้งานอยู่</p>
        ) : (
          <ul className="gov-list">
            {(kills.data ?? []).map((kill) => (
              <KillSwitchRow key={kill.killSwitchId} kill={kill} />
            ))}
          </ul>
        )}
      </section>
      {location.contactId ? (
        <button
          type="button"
          className="gov-link"
          onClick={() => go({ section: 'exceptions', contactId: location.contactId! })}
        >
          กลับไปคิว exception ของ contact {shortId(location.contactId)}
        </button>
      ) : null}
    </section>
  );
}

function KillSwitchRow({ kill }: { kill: KillSwitch }) {
  return (
    <li>
      <strong>⛔ {stateLabel(kill.state)}</strong>
      <code>{kill.scopeKey}</code>
      <span>
        {kill.reasonCode} · เปิดเมื่อ {new Date(kill.activatedAt).toISOString()} · โดย{' '}
        {referenceLabel(kill.activatedByRef)}
      </span>
    </li>
  );
}

// ── A · Exceptions approval workspace ────────────────────────────────────────

function ExceptionWorkspace({
  api,
  viewer,
  location,
  go,
}: {
  api: GovernanceApi;
  viewer: GovernanceViewer;
  location: GovernanceLocation;
  go: (location: GovernanceLocation) => void;
}) {
  const queue = useCanonical(
    async () =>
      location.contactId ? sortExceptionQueue(await api.contactExceptions(location.contactId)) : [],
    [api, location.contactId],
  );
  const selectedId = location.seriesId ?? queue.data?.[0]?.seriesId;
  const detail = useCanonical(async () => {
    if (!selectedId) return undefined;
    const [series, approvals] = await Promise.all([
      api.exception(selectedId),
      api.exceptionApprovals(selectedId),
    ]);
    return { series, approvals };
  }, [api, selectedId]);
  const [message, setMessage] = useState<string>();
  const [quorum, setQuorum] = useState<Quorum>();
  const [dialog, setDialog] = useState<'APPROVE' | 'REJECT' | 'REVOKE' | 'CANCEL'>();
  const [drawer, setDrawer] = useState(false);

  const reloadAll = useCallback(async () => {
    await Promise.all([queue.reload(), detail.reload()]);
  }, [queue.reload, detail.reload]);
  const command = useCommand(reloadAll);

  if (!location.contactId && !location.seriesId) {
    return (
      <section aria-labelledby="gov-exc-empty">
        <p className="gov-eyebrow">APPROVAL WORKSPACE</p>
        <h1 id="gov-exc-empty">Exceptions</h1>
        <p>เปิดคิวจาก Contact หรือ Exception series ด้วย opaque ID</p>
        <OpenById go={go} />
      </section>
    );
  }

  const series = detail.data?.series;
  const approvals = detail.data?.approvals ?? [];
  // state ที่ยังโหลดไม่ได้หรือผลคำสั่งไม่แน่ชัดต้องปิด action ทั้งหมด
  const blocked = command.pending || !!detail.failure || !!command.recovery || detail.loading;
  const intentFor = (action: string) =>
    `exception:${series?.seriesId}:${series?.revision}:${action}`;

  const decide = async (decision: 'APPROVE' | 'REJECT', values: Record<string, string>) => {
    if (!series) return;
    setDialog(undefined);
    const result = await command.run(intentFor(decision), (idempotencyKey) =>
      api.decideException({
        series,
        decision,
        evidenceRef: values.evidenceRef!,
        idempotencyKey,
      }),
    );
    if (!result) return;
    setQuorum(result.quorum);
    setMessage(
      decision === 'APPROVE'
        ? result.workflowState === 'APPROVED'
          ? `Quorum ครบ (${result.quorum.current}/${result.quorum.required}) — exception อยู่ในสถานะ APPROVED ซึ่งยังไม่ใช่ ALLOW: runtime จะตัดสินทุกครั้งที่ส่งจริง`
          : `บันทึก approval แล้ว (quorum ${result.quorum.current}/${result.quorum.required}) — ยังไม่ใช่ ALLOW และยังไม่ Activate`
        : 'ปฏิเสธ revision นี้แล้ว ประวัติยังเป็น append-only',
    );
  };

  const transition = async (action: 'revoke' | 'cancel', values: Record<string, string>) => {
    if (!series) return;
    setDialog(undefined);
    const result = await command.run(intentFor(action), (idempotencyKey) =>
      api.transitionException({
        series,
        action,
        reasonCode: values.reasonCode!,
        evidenceRef: values.evidenceRef!,
        idempotencyKey,
      }),
    );
    if (result) {
      setMessage(
        action === 'revoke'
          ? `Revoke แล้ว (${result.workflowState}) — งานที่ค้างจะถูก re-authorize และไม่มีการ resume อัตโนมัติ`
          : `ยกเลิกคำขอแล้ว (${result.workflowState})`,
      );
    }
  };

  const approvedCount = approvals.filter((approval) => approval.decision === 'APPROVE').length;

  return (
    <section aria-labelledby="gov-exc-title">
      <div className="gov-title-row">
        <div>
          <p className="gov-eyebrow">APPROVAL WORKSPACE</p>
          <h1 id="gov-exc-title">
            {location.contactId
              ? `คิว exception · contact ${shortId(location.contactId)}`
              : 'Exception'}
          </h1>
        </div>
      </div>
      <LiveStatus message={message} />
      {command.recovery ? (
        <RecoveryBanner
          state={command.recovery}
          onReload={() => {
            command.clearRecovery();
            void reloadAll();
          }}
          onRetry={() =>
            setDialog(command.recovery?.intent.split(':').at(-1)?.toUpperCase() as never)
          }
        />
      ) : null}
      <div className="gov-three-pane">
        {location.contactId ? (
          <aside className="gov-queue" aria-label="คิว exception">
            <h2>คิว ({queue.data?.length ?? 0})</h2>
            {queue.failure ? (
              <RecoveryBanner state={queue.failure} onReload={() => void queue.reload()} />
            ) : queue.loading ? (
              <p>กำลังโหลด…</p>
            ) : (queue.data ?? []).length === 0 ? (
              <p>ไม่มี exception สำหรับ contact นี้</p>
            ) : (
              <ul>
                {(queue.data ?? []).map((item) => (
                  <li key={item.seriesId}>
                    <button
                      type="button"
                      aria-current={item.seriesId === selectedId ? 'true' : undefined}
                      onClick={() =>
                        go({
                          section: 'exceptions',
                          contactId: location.contactId!,
                          seriesId: item.seriesId,
                        })
                      }
                    >
                      <span className={`gov-risk gov-risk-${item.riskTier.toLowerCase()}`}>
                        {riskLabel(item.riskTier)}
                      </span>
                      <b>{shortId(item.seriesId)}</b>
                      <small>
                        {stateLabel(item.workflowState)} · {item.allowedRuleCodes.join(', ')}
                      </small>
                      <small>หมดอายุ {new Date(item.expiresAt).toISOString()}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        ) : null}

        <article className="gov-panel gov-case" aria-labelledby="gov-case-title">
          {detail.failure ? (
            <RecoveryBanner state={detail.failure} onReload={() => void detail.reload()} />
          ) : !series ? (
            <p>{detail.loading ? 'กำลังโหลด canonical state…' : 'เลือกรายการจากคิว'}</p>
          ) : (
            <>
              <div className="gov-section-head">
                <div>
                  <p className="gov-eyebrow">
                    EXCEPTION {shortId(series.seriesId)} · REVISION {series.revision}
                  </p>
                  <h2 id="gov-case-title">{series.reasonCode}</h2>
                </div>
                <span className={`gov-risk gov-risk-${series.riskTier.toLowerCase()}`}>
                  {riskLabel(series.riskTier)}
                </span>
              </div>
              <p className="gov-states">
                <span>Workflow: {stateLabel(series.workflowState)}</span>
                <span>Effective: {stateLabel(series.effectiveState)}</span>
              </p>
              <Guardrails />
              <dl className="gov-facts">
                <div>
                  <dt>Scope</dt>
                  <dd>
                    {series.scopeKind === 'CONTACT_WIDE'
                      ? 'Contact-wide'
                      : `Identity ${shortId(series.identityId ?? '')}`}{' '}
                    · {series.channel} · {series.purpose} · {series.sourceType} {series.sourceId}
                  </dd>
                </div>
                <div>
                  <dt>Rule ที่ยกได้</dt>
                  <dd>{series.allowedRuleCodes.join(', ')}</dd>
                </div>
                <div>
                  <dt>Policy binding</dt>
                  <dd>
                    {shortId(series.policyId)} v{series.policyVersion} · digest{' '}
                    {digestLabel(series.policyContentDigest)} · {series.registryVersion}
                  </dd>
                </div>
                <div>
                  <dt>Effective window</dt>
                  <dd>{effectiveWindowLabel(series.startsAt, series.expiresAt)}</dd>
                </div>
                <div>
                  <dt>Content digest / version</dt>
                  <dd>
                    {digestLabel(series.contentDigest)} · contact version {series.aggregateVersion}
                  </dd>
                </div>
              </dl>
              <h3>หลักฐาน</h3>
              <div className="gov-evidence">
                <span>Evidence: {referenceLabel(series.evidenceRef)}</span>
                {series.ticketRef ? <span>Ticket: {referenceLabel(series.ticketRef)}</span> : null}
                <span>Maker: {referenceLabel(series.actorRef)}</span>
                {isRedacted(series.evidenceRef) ? (
                  <small>
                    รายละเอียดหลักฐานเปิดได้เฉพาะผู้มีสิทธิ์ Compliance และทุกการเปิดถูก audit
                  </small>
                ) : null}
                <button type="button" className="gov-secondary" onClick={() => setDrawer(true)}>
                  เปิด evidence timeline
                </button>
              </div>
            </>
          )}
        </article>

        {series ? (
          <aside className="gov-panel gov-rail" aria-label="Maker–Checker">
            <h2>Maker–Checker</h2>
            <p className="gov-quorum">
              Approvals ที่บันทึกแล้ว <b>{approvedCount}</b>
              {quorum ? (
                <>
                  {' '}
                  · quorum ล่าสุดจาก server{' '}
                  <b>
                    {quorum.current}/{quorum.required}
                  </b>{' '}
                  ({quorum.status})
                </>
              ) : (
                <small> · server ตรวจ quorum ตาม risk tier ทุกครั้งที่บันทึก</small>
              )}
            </p>
            <ApprovalList approvals={approvals} />
            <p className="gov-help">{DECISION_VOCABULARY.approve}</p>
            {canDecide(viewer) && series.workflowState === 'PENDING' ? (
              <>
                <button
                  type="button"
                  className="gov-primary"
                  disabled={blocked}
                  onClick={() => setDialog('APPROVE')}
                >
                  Approve เป็น checker
                </button>
                <button
                  type="button"
                  className="gov-danger"
                  disabled={blocked}
                  onClick={() => setDialog('REJECT')}
                >
                  Reject พร้อมหลักฐาน
                </button>
              </>
            ) : null}
            {canDecide(viewer) && series.workflowState === 'APPROVED' ? (
              <button
                type="button"
                className="gov-danger"
                disabled={blocked}
                onClick={() => setDialog('REVOKE')}
              >
                Revoke exception
              </button>
            ) : null}
            {canRequestChanges(viewer) && series.workflowState === 'PENDING' ? (
              <button
                type="button"
                className="gov-secondary"
                disabled={blocked}
                onClick={() => setDialog('CANCEL')}
              >
                ยกเลิกคำขอ (maker)
              </button>
            ) : null}
            {!canDecide(viewer) ? (
              <p className="gov-help">มุมมองนี้ดู summary ได้ แต่ approve/revoke ไม่ได้</p>
            ) : null}
            {command.pending ? <p aria-live="polite">กำลังรอ server ยืนยัน…</p> : null}
          </aside>
        ) : null}
      </div>

      {series && (dialog === 'APPROVE' || dialog === 'REJECT') ? (
        <ConfirmDialog
          title={dialog === 'APPROVE' ? 'ยืนยัน Approve' : 'ยืนยัน Reject'}
          body={
            <>
              <p>
                ผูกกับ revision {series.revision} · digest {digestLabel(series.contentDigest)} ·
                contact version {series.aggregateVersion} — ถ้ามีการเปลี่ยนระหว่างนี้ server
                จะปฏิเสธ
              </p>
              <p>{DECISION_VOCABULARY.approve}</p>
            </>
          }
          fields={[EVIDENCE_FIELD]}
          confirmLabel={dialog === 'APPROVE' ? 'ยืนยัน Approve' : 'ยืนยัน Reject'}
          danger={dialog === 'REJECT'}
          onCancel={() => setDialog(undefined)}
          onConfirm={(values) => void decide(dialog, values)}
        />
      ) : null}
      {series && (dialog === 'REVOKE' || dialog === 'CANCEL') ? (
        <ConfirmDialog
          title={dialog === 'REVOKE' ? 'ยืนยัน Revoke' : 'ยืนยันยกเลิกคำขอ'}
          body={
            <p>
              {dialog === 'REVOKE'
                ? 'Revoke มีผลทันทีที่ commit และงานที่ค้างจะถูก re-authorize — การอนุมัติใหม่ต้องเป็น series ใหม่'
                : 'ยกเลิกได้เฉพาะคำขอที่ยังรอตัดสิน และประวัติยังเก็บไว้ครบ'}
            </p>
          }
          fields={[REASON_FIELD, EVIDENCE_FIELD]}
          confirmLabel={dialog === 'REVOKE' ? 'ยืนยัน Revoke' : 'ยืนยันยกเลิก'}
          danger
          onCancel={() => setDialog(undefined)}
          onConfirm={(values) => void transition(dialog === 'REVOKE' ? 'revoke' : 'cancel', values)}
        />
      ) : null}
      {series && drawer ? (
        <EvidenceDrawer onClose={() => setDrawer(false)}>
          <ExceptionTimeline api={api} seriesId={series.seriesId} />
        </EvidenceDrawer>
      ) : null}
    </section>
  );
}

function ApprovalList({ approvals }: { approvals: ApprovalRecord[] }) {
  if (approvals.length === 0) return <p>ยังไม่มีการลงความเห็น</p>;
  return (
    <ol className="gov-approvals">
      {approvals.map((approval, index) => (
        <li key={`${approval.decidedAt}-${index}`}>
          <b>{approval.decision === 'APPROVE' ? '✓ APPROVE' : '✕ REJECT'}</b>
          <span>
            {referenceLabel(approval.approverRef)} · {approval.capability}
            {approval.directCompliance ? ' · direct Compliance' : ''}
          </span>
          <small>
            epoch {approval.authorizationEpoch} · {new Date(approval.decidedAt).toISOString()}
          </small>
        </li>
      ))}
    </ol>
  );
}

function EvidenceDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <div className="gov-modal" role="presentation">
      <aside
        className="gov-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="gov-section-head">
          <h2 id={titleId}>Evidence timeline</h2>
          <button ref={closeRef} type="button" className="gov-secondary" onClick={onClose}>
            ปิด
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

// ── B · Policy change studio ─────────────────────────────────────────────────

const STEPS = [
  { key: 'draft', label: 'Draft', states: ['DRAFT'] },
  { key: 'tests', label: 'Tests', states: [] as string[] },
  { key: 'approvals', label: 'Approvals', states: ['IN_REVIEW', 'APPROVED'] },
  { key: 'activation', label: 'Activation', states: ['SCHEDULED', 'ACTIVE', 'SUPERSEDED'] },
];

function PolicyStudio({
  api,
  viewer,
  location,
  go,
}: {
  api: GovernanceApi;
  viewer: GovernanceViewer;
  location: GovernanceLocation;
  go: (location: GovernanceLocation) => void;
}) {
  const versions = useCanonical(
    async () => (location.policyId ? api.policyVersions(location.policyId) : []),
    [api, location.policyId],
  );
  const selectedId = location.versionId ?? versions.data?.at(-1)?.policyVersionId;
  const detail = useCanonical(async () => {
    if (!selectedId) return undefined;
    const version = await api.policyVersion(selectedId);
    const [tests, approvals, head, kills] = await Promise.all([
      api.policyTests(selectedId),
      api.policyApprovals(selectedId),
      api.effectiveScope(version.scopeKey),
      api.killSwitches({ scopeKey: version.scopeKey, state: 'ACTIVE' }),
    ]);
    return { version, tests, approvals, head, kills };
  }, [api, selectedId]);
  const [message, setMessage] = useState<string>();
  const [dialog, setDialog] = useState<'APPROVE' | 'REJECT' | 'PUBLISH' | 'ROLLBACK'>();
  const [drawer, setDrawer] = useState(false);
  const reloadAll = useCallback(async () => {
    await Promise.all([versions.reload(), detail.reload()]);
  }, [versions.reload, detail.reload]);
  const command = useCommand(reloadAll);

  if (!location.policyId) {
    return (
      <section aria-labelledby="gov-pol-empty">
        <p className="gov-eyebrow">POLICY CHANGE STUDIO</p>
        <h1 id="gov-pol-empty">Policies</h1>
        <p>เปิด policy series ด้วย opaque ID</p>
        <OpenById go={go} />
      </section>
    );
  }

  const data = detail.data;
  const version = data?.version;
  const artifact = data?.tests.at(-1);
  const head = data?.head;
  // version ที่ทดสอบกับ head อื่นต้องทดสอบใหม่ก่อนตัดสิน: ห้ามให้ server เป็นด่านเดียวที่เห็นว่าไม่ตรง
  const headMismatch =
    !!version &&
    !!artifact &&
    (head
      ? artifact.baseHeadVersion !== head.headVersion || artifact.baseHeadDigest !== head.headDigest
      : artifact.baseHeadVersion !== 0);
  const killActive = (data?.kills.length ?? 0) > 0 || head?.killSwitchActive === true;
  const blocked =
    command.pending || !!detail.failure || !!command.recovery || detail.loading || headMismatch;
  const intentFor = (action: string) =>
    `policy:${version?.policyVersionId}:${version?.draftRevision}:${action}`;
  const currentStep = version
    ? STEPS.findIndex((step) => step.states.includes(version.lifecycleState)) === 0 && artifact
      ? 1
      : Math.max(
          0,
          STEPS.findIndex((step) => step.states.includes(version.lifecycleState)),
        )
    : 0;

  const decide = async (decision: 'APPROVE' | 'REJECT', values: Record<string, string>) => {
    if (!version || !artifact || !head) return;
    setDialog(undefined);
    const result = await command.run(intentFor(decision), (idempotencyKey) =>
      api.decidePolicy({
        version,
        decision,
        artifact,
        head,
        activateAt: new Date(values.activateAt!).toISOString(),
        evidenceRef: values.evidenceRef!,
        idempotencyKey,
      }),
    );
    if (result) {
      setMessage(
        decision === 'APPROVE'
          ? `บันทึก approval แล้ว (quorum ${result.quorum.current}/${result.quorum.required}, ${result.lifecycleState}) — Approve ไม่เท่ากับ Activate`
          : 'ปฏิเสธ version นี้แล้ว',
      );
    }
  };

  const publish = async (values: Record<string, string>) => {
    if (!version || !artifact || !head) return;
    setDialog(undefined);
    const result = await command.run(intentFor('PUBLISH'), (idempotencyKey) =>
      api.publishPolicy({
        version,
        artifact,
        head,
        evidenceRef: values.evidenceRef!,
        idempotencyKey,
      }),
    );
    if (result) {
      setMessage(
        `Commit การ publish แล้ว (${result.lifecycleState}${result.activateAt ? ` · activate ${result.activateAt}` : ''}) — ` +
          'downstream จะ re-authorize งานที่ค้างจาก event; Console ยังไม่มี query acknowledgement จึงไม่อ้างว่ากระจายผลครบแล้ว',
      );
    }
  };

  const rollback = async (values: Record<string, string>) => {
    if (!version) return;
    setDialog(undefined);
    const result = await command.run(intentFor('ROLLBACK'), (idempotencyKey) =>
      api.rollbackPolicy({
        source: version,
        reasonCode: values.reasonCode!,
        evidenceRef: values.evidenceRef!,
        idempotencyKey,
      }),
    );
    if (result) {
      setMessage(
        `สร้าง rollback candidate v${result.version} แล้ว — rollback เป็น version ใหม่ที่ต้องทดสอบและอนุมัติใหม่ ไม่สลับกลับ row เดิม`,
      );
      go({ section: 'policies', policyId: result.policyId, versionId: result.policyVersionId });
    }
  };

  return (
    <section aria-labelledby="gov-pol-title">
      <div className="gov-title-row">
        <div>
          <p className="gov-eyebrow">POLICY CHANGE STUDIO</p>
          <h1 id="gov-pol-title">
            Policy {shortId(location.policyId)}
            {version ? ` · v${version.version}` : ''}
          </h1>
        </div>
        {version ? <span className="gov-state">{stateLabel(version.lifecycleState)}</span> : null}
      </div>
      <ol className="gov-stepper" aria-label="ขั้นตอน policy">
        {STEPS.map((step, index) => (
          <li
            key={step.key}
            aria-current={index === currentStep ? 'step' : undefined}
            className={index < currentStep ? 'is-done' : index === currentStep ? 'is-current' : ''}
          >
            {index < currentStep ? '✓' : index + 1} {step.label}
          </li>
        ))}
      </ol>
      <LiveStatus message={message} />
      {command.recovery ? (
        <RecoveryBanner
          state={command.recovery}
          onReload={() => {
            command.clearRecovery();
            void reloadAll();
          }}
        />
      ) : null}
      {detail.failure ? (
        <RecoveryBanner state={detail.failure} onReload={() => void detail.reload()} />
      ) : null}
      {headMismatch && artifact ? (
        <div className="gov-recovery gov-recovery-head_conflict" role="alert">
          <strong>⚠ Policy head เปลี่ยนหลังทดสอบ</strong>
          <p>
            ผลทดสอบผูกกับ head v{artifact.baseHeadVersion} ({digestLabel(artifact.baseHeadDigest)})
            แต่ head ปัจจุบันเป็น v{head?.headVersion ?? 0} ({digestLabel(head?.headDigest)}) —
            ต้องทดสอบและอนุมัติใหม่ ระบบไม่เลือกผู้ชนะให้
          </p>
        </div>
      ) : null}
      {version ? (
        <div className="gov-studio-grid">
          <article className="gov-panel" aria-labelledby="gov-diff-title">
            <div className="gov-section-head">
              <h2 id="gov-diff-title">การเปลี่ยนแปลงเทียบ active head</h2>
              {version.diffClass ? (
                <span className={`gov-diff gov-diff-${version.diffClass.toLowerCase()}`}>
                  {version.diffClass === 'RELAXATION'
                    ? '▼'
                    : version.diffClass === 'TIGHTENING'
                      ? '▲'
                      : '='}{' '}
                  {version.diffClass}
                </span>
              ) : (
                <span className="gov-diff">ยังไม่มีผลทดสอบ</span>
              )}
            </div>
            <dl className="gov-facts">
              <div>
                <dt>Scope</dt>
                <dd>
                  <code>{version.scopeKey}</code>
                </dd>
              </div>
              <div>
                <dt>Content digest</dt>
                <dd>
                  {digestLabel(version.contentDigest)} · draft revision {version.draftRevision}
                </dd>
              </div>
              <div>
                <dt>Active head ปัจจุบัน</dt>
                <dd>
                  {head
                    ? `v${head.headVersion} · policy v${head.activePolicyVersion} · ${digestLabel(head.headDigest)}`
                    : 'ยังไม่มี active head'}
                  {head?.nextActivationAt ? ` · activation ถัดไป ${head.nextActivationAt}` : ''}
                </dd>
              </div>
              <div>
                <dt>Evaluator / registry</dt>
                <dd>
                  {version.evaluatorVersion} · {version.registryVersion} · schema{' '}
                  {version.schemaVersion}
                </dd>
              </div>
              <div>
                <dt>Effective</dt>
                <dd>
                  {version.activateAt
                    ? `activate ${version.activateAt}`
                    : `from ${version.effectiveFrom}`}
                </dd>
              </div>
            </dl>
            <Guardrails />
            {killActive ? (
              <div className="gov-recovery gov-recovery-lifecycle_blocked" role="note">
                <strong>⛔ Kill switch ใช้งานอยู่ใน scope นี้</strong>
                <p>
                  publish ที่ผ่อนลงถูกบล็อกจนกว่าจะเคลียร์ด้วย approval ของอีกคน และการเคลียร์ไม่
                  resume งานเดิม
                </p>
              </div>
            ) : null}
            <h3>ประวัติ version</h3>
            <ul className="gov-list">
              {(versions.data ?? []).map((item) => (
                <li key={item.policyVersionId}>
                  <button
                    type="button"
                    className="gov-link"
                    aria-current={
                      item.policyVersionId === version.policyVersionId ? 'true' : undefined
                    }
                    onClick={() =>
                      go({
                        section: 'policies',
                        policyId: item.policyId,
                        versionId: item.policyVersionId,
                      })
                    }
                  >
                    v{item.version} · {stateLabel(item.lifecycleState)}
                    {item.rollbackOfVersionId ? ' · rollback candidate' : ''}
                  </button>
                </li>
              ))}
            </ul>
          </article>

          <aside className="gov-panel gov-rail" aria-labelledby="gov-release-title">
            <h2 id="gov-release-title">Release packet</h2>
            {artifact ? (
              <div className="gov-tests" aria-label="ผลทดสอบ synthetic">
                <b>
                  {artifact.outcome === 'PASSED' || artifact.failed === 0 ? '✓' : '✕'}{' '}
                  {artifact.outcome}
                </b>
                <span>
                  ผ่าน {artifact.passed} · ล้มเหลว {artifact.failed}
                </span>
                <span>
                  artifact {digestLabel(artifact.artifactDigest)} · {artifact.suiteVersion}
                </span>
              </div>
            ) : (
              <p>ยังไม่มี test artifact — ต้องทดสอบก่อนอนุมัติ</p>
            )}
            <p className="gov-quorum">Approval digest {digestLabel(version.approvalDigest)}</p>
            <ApprovalList approvals={data?.approvals ?? []} />
            <p className="gov-help">{DECISION_VOCABULARY.activate}</p>
            {canDecide(viewer) && version.lifecycleState === 'IN_REVIEW' && artifact ? (
              <>
                <button
                  type="button"
                  className="gov-primary"
                  disabled={blocked || !head}
                  onClick={() => setDialog('APPROVE')}
                >
                  บันทึก approval
                </button>
                <button
                  type="button"
                  className="gov-danger"
                  disabled={blocked || !head}
                  onClick={() => setDialog('REJECT')}
                >
                  ปฏิเสธ version
                </button>
              </>
            ) : null}
            {canDecide(viewer) && version.lifecycleState === 'APPROVED' && artifact && head ? (
              <button
                type="button"
                className="gov-primary"
                disabled={blocked}
                onClick={() => setDialog('PUBLISH')}
              >
                Publish / ตั้งเวลา Activate
              </button>
            ) : null}
            {canDecide(viewer) &&
            (version.lifecycleState === 'ACTIVE' || version.lifecycleState === 'SUPERSEDED') ? (
              <button
                type="button"
                className="gov-secondary"
                disabled={command.pending || !!command.recovery}
                onClick={() => setDialog('ROLLBACK')}
              >
                สร้าง rollback candidate
              </button>
            ) : null}
            <button type="button" className="gov-link" onClick={() => setDrawer(true)}>
              เปิด evidence timeline
            </button>
            {command.pending ? <p aria-live="polite">กำลังรอ server ยืนยัน…</p> : null}
          </aside>
        </div>
      ) : detail.loading || versions.loading ? (
        <p>กำลังโหลด canonical state…</p>
      ) : versions.failure ? (
        <RecoveryBanner state={versions.failure} onReload={() => void versions.reload()} />
      ) : null}

      {version && artifact && head && (dialog === 'APPROVE' || dialog === 'REJECT') ? (
        <ConfirmDialog
          title={dialog === 'APPROVE' ? 'ยืนยัน approval ของ policy' : 'ยืนยันปฏิเสธ policy'}
          body={
            <p>
              ผูกกับ content {digestLabel(version.contentDigest)} · test artifact{' '}
              {digestLabel(artifact.artifactDigest)} · head v{head.headVersion} —{' '}
              {DECISION_VOCABULARY.approve}
            </p>
          }
          fields={[
            {
              name: 'activateAt',
              label: 'เวลาที่ต้องการให้ Activate (UTC)',
              hint: 'ใช้เมื่อ quorum ครบ — ยังต้อง publish ก่อนมีผล',
              type: 'datetime-local',
              initial: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16),
            },
            EVIDENCE_FIELD,
          ]}
          confirmLabel={dialog === 'APPROVE' ? 'ยืนยัน approval' : 'ยืนยันปฏิเสธ'}
          danger={dialog === 'REJECT'}
          onCancel={() => setDialog(undefined)}
          onConfirm={(values) => void decide(dialog, values)}
        />
      ) : null}
      {version && artifact && head && dialog === 'PUBLISH' ? (
        <ConfirmDialog
          title="ยืนยัน Publish"
          body={
            <>
              <p>
                เปลี่ยน policy head ของ scope จาก v{head.headVersion} ตาม approval{' '}
                {digestLabel(version.approvalDigest)}
              </p>
              <p>{DECISION_VOCABULARY.developmentComplete}</p>
            </>
          }
          fields={[EVIDENCE_FIELD]}
          confirmLabel="ยืนยัน Publish"
          onCancel={() => setDialog(undefined)}
          onConfirm={(values) => void publish(values)}
        />
      ) : null}
      {version && dialog === 'ROLLBACK' ? (
        <ConfirmDialog
          title="สร้าง rollback candidate"
          body={
            <p>
              สร้าง version ใหม่จากเนื้อหาของ v{version.version} ต้องทดสอบ อนุมัติ และ publish
              ใหม่ทั้งหมด
            </p>
          }
          fields={[REASON_FIELD, EVIDENCE_FIELD]}
          confirmLabel="สร้าง rollback candidate"
          onCancel={() => setDialog(undefined)}
          onConfirm={(values) => void rollback(values)}
        />
      ) : null}
      {version && drawer ? (
        <EvidenceDrawer onClose={() => setDrawer(false)}>
          <PolicyTimeline api={api} policyId={version.policyId} />
        </EvidenceDrawer>
      ) : null}
    </section>
  );
}

// ── C · Evidence-first audit ─────────────────────────────────────────────────

interface TimelineEntry {
  at: string;
  title: string;
  detail: string;
}

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="gov-timeline">
      {[...entries]
        .sort((left, right) => left.at.localeCompare(right.at))
        .map((entry, index) => (
          <li key={`${entry.at}-${index}`}>
            <time dateTime={entry.at}>{entry.at}</time>
            <b>{entry.title}</b>
            <span>{entry.detail}</span>
          </li>
        ))}
    </ol>
  );
}

function ExceptionTimeline({ api, seriesId }: { api: GovernanceApi; seriesId: string }) {
  const state = useCanonical(async () => {
    const [series, revisions, approvals] = await Promise.all([
      api.exception(seriesId),
      api.exceptionHistory(seriesId),
      api.exceptionApprovals(seriesId),
    ]);
    return { series, revisions, approvals };
  }, [api, seriesId]);
  if (state.failure)
    return <RecoveryBanner state={state.failure} onReload={() => void state.reload()} />;
  if (!state.data) return <p>กำลังโหลด canonical timeline…</p>;
  const { series, revisions, approvals } = state.data;
  return (
    <div className="gov-evidence-grid">
      <section aria-labelledby="gov-tl-exc">
        <h3 id="gov-tl-exc">Canonical timeline</h3>
        <Timeline entries={exceptionEntries(revisions, approvals)} />
      </section>
      <SafetyCase
        rows={[
          ['Hard restrictions / consent / preference', 'ไม่ถูก override โดย exception ใด ๆ'],
          ['Risk tier', riskLabel(series.riskTier)],
          [
            'Workflow / effective',
            `${stateLabel(series.workflowState)} · ${stateLabel(series.effectiveState)}`,
          ],
          ['Expiry', effectiveWindowLabel(series.startsAt, series.expiresAt)],
          ['Evidence', referenceLabel(series.evidenceRef)],
        ]}
      />
      <button type="button" className="gov-secondary" onClick={() => void state.reload()}>
        โหลด canonical state ใหม่
      </button>
    </div>
  );
}

function exceptionEntries(
  revisions: ExceptionRevision[],
  approvals: ApprovalRecord[],
): TimelineEntry[] {
  return [
    ...revisions.map((revision) => ({
      at: revision.createdAt,
      title: `Revision ${revision.revision} ${revision.renewsSeriesId ? '(renewal)' : ''}`.trim(),
      detail: `${riskLabel(revision.riskTier)} · digest ${digestLabel(revision.contentDigest)} · maker ${referenceLabel(revision.actorRef)}`,
    })),
    ...approvals.map((approval) => ({
      at: approval.decidedAt,
      title: approval.decision === 'APPROVE' ? '✓ Checker approve' : '✕ Checker reject',
      detail: `${referenceLabel(approval.approverRef)} · ${approval.capability} · epoch ${approval.authorizationEpoch}`,
    })),
  ];
}

function PolicyTimeline({ api, policyId }: { api: GovernanceApi; policyId: string }) {
  const state = useCanonical(async () => {
    const versions = await api.policyVersions(policyId);
    const latest = versions.at(-1);
    const [approvals, tests, head, kills] = latest
      ? await Promise.all([
          api.policyApprovals(latest.policyVersionId),
          api.policyTests(latest.policyVersionId),
          api.effectiveScope(latest.scopeKey),
          api.killSwitches({ scopeKey: latest.scopeKey }),
        ])
      : [[], [], undefined, []];
    return { versions, approvals, tests, head, kills };
  }, [api, policyId]);
  if (state.failure)
    return <RecoveryBanner state={state.failure} onReload={() => void state.reload()} />;
  if (!state.data) return <p>กำลังโหลด canonical timeline…</p>;
  const { versions, approvals, tests, head, kills } = state.data;
  return (
    <div className="gov-evidence-grid">
      <section aria-labelledby="gov-tl-pol">
        <h3 id="gov-tl-pol">Canonical timeline</h3>
        <Timeline entries={policyEntries(versions, approvals, tests, kills)} />
      </section>
      <SafetyCase
        rows={[
          [
            'Active head',
            head ? `v${head.headVersion} · ${digestLabel(head.headDigest)}` : 'ยังไม่มี',
          ],
          [
            'Kill switch',
            kills.some((kill) => kill.state === 'ACTIVE') ? '⛔ ACTIVE' : 'ไม่มีที่ใช้งานอยู่',
          ],
          [
            'Tests ล่าสุด',
            tests.at(-1)
              ? `${tests.at(-1)!.outcome} · ${digestLabel(tests.at(-1)!.artifactDigest)}`
              : 'ยังไม่มี',
          ],
          ['Rollback', 'สร้าง version ใหม่เสมอ ไม่แก้ published row'],
        ]}
      />
      <button type="button" className="gov-secondary" onClick={() => void state.reload()}>
        โหลด canonical state ใหม่
      </button>
    </div>
  );
}

function policyEntries(
  versions: PolicyVersion[],
  approvals: ApprovalRecord[],
  tests: PolicyTestArtifact[],
  kills: KillSwitch[],
): TimelineEntry[] {
  return [
    ...versions.map((version) => ({
      at: version.createdAt,
      title: `Version ${version.version} · ${stateLabel(version.lifecycleState)}`,
      detail: `digest ${digestLabel(version.contentDigest)} · maker ${referenceLabel(version.makerActorRef)}${version.rollbackOfVersionId ? ' · rollback candidate' : ''}`,
    })),
    ...tests.map((artifact) => ({
      at: artifact.createdAt,
      title: `Test artifact ${artifact.outcome}`,
      detail: `${artifact.passed} ผ่าน / ${artifact.failed} ล้มเหลว · base head v${artifact.baseHeadVersion} · ${digestLabel(artifact.artifactDigest)}`,
    })),
    ...approvals.map((approval) => ({
      at: approval.decidedAt,
      title: approval.decision === 'APPROVE' ? '✓ Checker approve' : '✕ Checker reject',
      detail: `${referenceLabel(approval.approverRef)} · ${approval.capability}`,
    })),
    ...kills.map((kill) => ({
      at: kill.activatedAt,
      title: `⛔ Kill switch ${kill.state}`,
      detail: `${kill.reasonCode} · ${referenceLabel(kill.activatedByRef)}`,
    })),
  ];
}

function SafetyCase({ rows }: { rows: Array<[string, string]> }) {
  return (
    <section className="gov-panel gov-safety" aria-label="Safety case">
      <h3>Safety case</h3>
      <dl>
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function AuditView({
  api,
  location,
  go,
}: {
  api: GovernanceApi;
  location: GovernanceLocation;
  go: (location: GovernanceLocation) => void;
}) {
  return (
    <section aria-labelledby="gov-audit-title">
      <p className="gov-eyebrow">EVIDENCE-FIRST TIMELINE</p>
      <h1 id="gov-audit-title">
        {location.seriesId
          ? `Trace · exception ${shortId(location.seriesId)}`
          : location.policyId
            ? `Trace · policy ${shortId(location.policyId)}`
            : 'Audit'}
      </h1>
      {location.seriesId ? (
        <>
          <ExceptionTimeline api={api} seriesId={location.seriesId} />
          <button
            type="button"
            className="gov-link"
            onClick={() => go({ ...location, section: 'exceptions' })}
          >
            ไปยัง approval workspace ของรายการนี้
          </button>
        </>
      ) : location.policyId ? (
        <>
          <PolicyTimeline api={api} policyId={location.policyId} />
          <button
            type="button"
            className="gov-link"
            onClick={() => go({ ...location, section: 'policies' })}
          >
            ไปยัง policy studio ของรายการนี้
          </button>
        </>
      ) : (
        <>
          <p>เปิด trace ของ exception หรือ policy ด้วย opaque ID</p>
          <OpenById go={(next) => go({ ...next, section: 'audit' })} />
        </>
      )}
    </section>
  );
}

export type { EffectiveScope };
