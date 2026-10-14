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
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { useInShell, useShellPageNav } from '@d-contact/ui-react';
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
  intlLocale,
  type GovernanceViewer,
  type RecoveryState,
  type Translate,
} from './governance-model.js';
import { useShellTokens } from './shell/tokens.js';
import './governance.css';
import { Cg5Dashboard } from './cg5-dashboard.js';
import type { Cg5ConsoleApi } from './cg5-console-api.js';

const VIEWER_KEY: Readonly<Record<GovernanceViewer, string>> = {
  SUPERVISOR: 'viewer.supervisor',
  TENANT_ADMIN: 'viewer.tenantAdmin',
  COMPLIANCE: 'viewer.compliance',
};

/** ตัวแปลของ namespace `governance` และภาษาปัจจุบัน (ใช้จัดรูปแบบวันที่) */
function useGovernanceText(): { t: Translate; locale: string } {
  const { t } = useTranslation('governance');
  const { locale } = useLocale();
  return { t: t as unknown as Translate, locale };
}

/** prefix ของ opaque id ตามด้วย … (ส่วนที่ตัด) — digest ใช้ …suffix แยกกันใน digestLabel */
const shortId = (value: string) => `${value.slice(0, 8)}…`;

/**
 * สถานะตำแหน่งของ Governance (URL เป็นความจริง) — ถือไว้เหนือ shell เพื่อให้เมนูย่อยของ shell
 * ไฮไลต์หน้าตรงกับเนื้อหาและเปลี่ยนหน้าได้โดยไม่โหลดใหม่ (#658)
 */
export function useGovernanceLocation(initialLocation: GovernanceLocation) {
  const [location, setLocation] = useState(initialLocation);

  const go = useCallback((next: GovernanceLocation) => {
    window.history.pushState({}, '', governanceHref(next));
    setLocation(next);
    // ย้าย focus ไปเนื้อหาใหม่ให้ screen reader รู้ว่าหน้าเปลี่ยน
    requestAnimationFrame(() => document.getElementById('gov-main')?.focus());
  }, []);

  useEffect(() => {
    const onPop = () => setLocation(parseGovernanceLocation(new URL(window.location.href)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return [location, go] as const;
}

export function GovernanceConsole({
  api,
  viewer,
  location,
  go,
  cg5Api,
}: {
  api: GovernanceApi;
  cg5Api: Cg5ConsoleApi;
  viewer: GovernanceViewer;
  location: GovernanceLocation;
  go: (location: GovernanceLocation) => void;
}) {
  // #654: อยู่ใน ConsoleShell แล้ว shell วาด skip link, แถบบนและ <main> ให้ — หน้านี้ไม่วาดซ้ำ (landmark ซ้อน)
  const inShell = useInShell();
  // #658: เมนูย่อยของ shell มีหน้าย่อยครบแล้ว → ไม่วาดแท็บซ้ำ; ไม่มี (flag ปิด/API รุ่นเก่า) → แท็บเดิม
  const pagesInShell = useShellPageNav();
  const { t } = useGovernanceText();
  // governance.css อ้าง token ทั้งสองสถานะของ flag (เหมือน Journeys) — token มาก่อนเนื้อหา ไม่ให้เห็นหน้าที่ยังไม่มีสี
  const tokensReady = useShellTokens();
  if (!tokensReady) return null;

  const section = location.section;
  const nav: Array<{ key: GovernanceSection; label: string; current: boolean }> = [
    { key: 'overview', label: t('nav.overview'), current: section === 'overview' },
    {
      key: location.policyId ? 'policies' : 'exceptions',
      label: t('nav.policiesExceptions'),
      current: section === 'exceptions' || section === 'policies',
    },
    { key: 'audit', label: t('nav.audit'), current: section === 'audit' },
  ];

  const Main = inShell ? 'div' : 'main';
  return (
    <div className={inShell ? 'gov-shell gov-shell--embedded' : 'gov-shell'}>
      {inShell ? (
        <p className="gov-viewer gov-viewer--embedded">
          {t('viewer.label', { viewer: t(VIEWER_KEY[viewer]) })}
        </p>
      ) : (
        <>
          <a className="gov-skip" href="#gov-main">
            {t('chrome.skip')}
          </a>
          <header className="gov-header">
            <strong>{t('chrome.brand')}</strong>
            <span>{t('chrome.title')}</span>
            <span className="gov-viewer">
              {t('viewer.label', { viewer: t(VIEWER_KEY[viewer]) })}
            </span>
          </header>
        </>
      )}
      {pagesInShell ? null : (
        <nav aria-label={t('nav.label')} className="gov-nav">
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
      )}
      <Main id="gov-main" tabIndex={-1} className="gov-main">
        <p className="gov-boundary" role="note">
          {t('vocabulary.developmentComplete')}
        </p>
        {!pagesInShell && (section === 'exceptions' || section === 'policies') ? (
          <nav aria-label={t('nav.subLabel')} className="gov-subnav">
            <button
              type="button"
              aria-current={section === 'exceptions' ? 'page' : undefined}
              onClick={() => go({ ...location, section: 'exceptions' })}
            >
              {t('nav.exceptions')}
            </button>
            <button
              type="button"
              aria-current={section === 'policies' ? 'page' : undefined}
              onClick={() => go({ ...location, section: 'policies' })}
            >
              {t('nav.policies')}
            </button>
          </nav>
        ) : null}
        {section === 'overview' ? (
          <Overview api={api} cg5Api={cg5Api} viewer={viewer} go={go} location={location} />
        ) : null}
        {section === 'exceptions' ? (
          <ExceptionWorkspace api={api} viewer={viewer} location={location} go={go} />
        ) : null}
        {section === 'policies' ? (
          <PolicyStudio api={api} viewer={viewer} location={location} go={go} />
        ) : null}
        {section === 'audit' ? <AuditView api={api} location={location} go={go} /> : null}
      </Main>
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
  const { t } = useGovernanceText();
  const tRef = useRef(t);
  tRef.current = t;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadRef.current());
      setFailure(undefined);
    } catch (error) {
      // state ที่อ่านไม่ได้ต้องไม่ถูกแทนด้วย snapshot เก่า: ล้างข้อมูลแล้วแสดง recovery
      setData(undefined);
      setFailure(recoveryFor(error, tRef.current));
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
  const { t } = useGovernanceText();
  const tRef = useRef(t);
  tRef.current = t;
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
        const state = recoveryFor(error, tRef.current);
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
  const { t } = useGovernanceText();
  const title = t(`recovery.title.${state.kind}`);
  return (
    <div className={`gov-recovery gov-recovery-${state.kind.toLowerCase()}`} role="alert">
      <strong>⚠ {title}</strong>
      <p>{state.message}</p>
      {state.code ? <code>{state.code}</code> : null}
      <div className="gov-recovery-actions">
        {state.recovery !== 'NONE' ? (
          <button type="button" className="gov-secondary" onClick={onReload}>
            {t('recovery.reload')}
          </button>
        ) : null}
        {state.recovery === 'SAME_KEY' && onRetry ? (
          <button type="button" className="gov-secondary" onClick={onRetry}>
            {t('recovery.retry')}
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
  const { t } = useGovernanceText();
  return (
    <div className="gov-guardrail" role="note">
      <strong>{t('guardrails.title')}</strong>
      <span>{t('guardrails.body')}</span>
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
  const { t } = useGovernanceText();
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
              {t('common.cancel')}
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

const evidenceField = (t: Translate): DialogField => ({
  name: 'evidenceRef',
  label: t('fields.evidence.label'),
  hint: t('fields.evidence.hint'),
});

const reasonField = (t: Translate): DialogField => ({
  name: 'reasonCode',
  label: t('fields.reason.label'),
  hint: t('fields.reason.hint'),
});

function OpenById({ go }: { go: (location: GovernanceLocation) => void }) {
  const [kind, setKind] = useState<'contactId' | 'seriesId' | 'policyId'>('contactId');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const inputId = useId();
  const { t } = useGovernanceText();
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
          setError(t('openById.error'));
          return;
        }
        setError(undefined);
        go(parsed);
      }}
    >
      <fieldset>
        <legend>{t('openById.legend')}</legend>
        <select
          aria-label={t('openById.typeLabel')}
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="contactId">{t('openById.kindContact')}</option>
          <option value="seriesId">{t('openById.kindSeries')}</option>
          <option value="policyId">{t('openById.kindPolicy')}</option>
        </select>
        <label htmlFor={inputId} className="gov-visually-hidden">
          {t('openById.idLabel')}
        </label>
        <input
          id={inputId}
          value={value}
          placeholder="00000000-0000-0000-0000-000000000000"
          aria-invalid={error ? true : undefined}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="gov-primary">
          {t('common.open')}
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
  cg5Api,
  viewer,
  go,
  location,
}: {
  api: GovernanceApi;
  cg5Api: Cg5ConsoleApi;
  viewer: GovernanceViewer;
  go: (location: GovernanceLocation) => void;
  location: GovernanceLocation;
}) {
  const { t } = useGovernanceText();
  const kills = useCanonical(() => api.killSwitches({ state: 'ACTIVE' }), [api]);
  return (
    <section aria-labelledby="gov-overview-title">
      <p className="gov-eyebrow">{t('overview.eyebrow')}</p>
      <h1 id="gov-overview-title">{t('overview.title')}</h1>
      <Cg5Dashboard api={cg5Api} viewer={viewer} />
      <OpenById go={go} />
      <section className="gov-panel" aria-labelledby="gov-kills-title">
        <h2 id="gov-kills-title">{t('overview.kills.title')}</h2>
        {kills.failure ? (
          <RecoveryBanner state={kills.failure} onReload={() => void kills.reload()} />
        ) : kills.loading ? (
          <p>{t('common.loadingState')}</p>
        ) : (kills.data ?? []).length === 0 ? (
          <p>{t('overview.kills.empty')}</p>
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
          {t('overview.backToQueue', { id: shortId(location.contactId) })}
        </button>
      ) : null}
    </section>
  );
}

function KillSwitchRow({ kill }: { kill: KillSwitch }) {
  const { t } = useGovernanceText();
  return (
    <li>
      <strong>⛔ {stateLabel(kill.state)}</strong>
      <code>{kill.scopeKey}</code>
      <span>
        {t('overview.kill.detail', {
          reason: kill.reasonCode,
          at: new Date(kill.activatedAt).toISOString(),
          by: referenceLabel(kill.activatedByRef, t),
        })}
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
  const { t, locale } = useGovernanceText();
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
        <p className="gov-eyebrow">{t('exceptions.eyebrow')}</p>
        <h1 id="gov-exc-empty">{t('exceptions.title')}</h1>
        <p>{t('exceptions.empty')}</p>
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
    const counts = { current: result.quorum.current, required: result.quorum.required };
    setMessage(
      decision === 'APPROVE'
        ? result.workflowState === 'APPROVED'
          ? t('exceptions.message.quorumMet', counts)
          : t('exceptions.message.recorded', counts)
        : t('exceptions.message.rejected'),
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
          ? t('exceptions.message.revoked', { state: result.workflowState })
          : t('exceptions.message.cancelled', { state: result.workflowState }),
      );
    }
  };

  const approvedCount = approvals.filter((approval) => approval.decision === 'APPROVE').length;

  return (
    <section aria-labelledby="gov-exc-title">
      <div className="gov-title-row">
        <div>
          <p className="gov-eyebrow">{t('exceptions.eyebrow')}</p>
          <h1 id="gov-exc-title">
            {location.contactId
              ? t('exceptions.queueTitle', { id: shortId(location.contactId) })
              : t('exceptions.single')}
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
          <aside className="gov-queue" aria-label={t('exceptions.queue.label')}>
            <h2>{t('exceptions.queue.heading', { n: queue.data?.length ?? 0 })}</h2>
            {queue.failure ? (
              <RecoveryBanner state={queue.failure} onReload={() => void queue.reload()} />
            ) : queue.loading ? (
              <p>{t('common.loading')}</p>
            ) : (queue.data ?? []).length === 0 ? (
              <p>{t('exceptions.queue.empty')}</p>
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
                      <small>
                        {t('exceptions.queue.expires', {
                          at: new Date(item.expiresAt).toISOString(),
                        })}
                      </small>
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
            <p>{detail.loading ? t('common.loadingState') : t('exceptions.case.select')}</p>
          ) : (
            <>
              <div className="gov-section-head">
                <div>
                  <p className="gov-eyebrow">
                    {t('exceptions.case.eyebrow', {
                      id: shortId(series.seriesId),
                      revision: series.revision,
                    })}
                  </p>
                  <h2 id="gov-case-title">{series.reasonCode}</h2>
                </div>
                <span className={`gov-risk gov-risk-${series.riskTier.toLowerCase()}`}>
                  {riskLabel(series.riskTier)}
                </span>
              </div>
              <p className="gov-states">
                <span>
                  {t('exceptions.case.workflow', { state: stateLabel(series.workflowState) })}
                </span>
                <span>
                  {t('exceptions.case.effective', { state: stateLabel(series.effectiveState) })}
                </span>
              </p>
              <Guardrails />
              <dl className="gov-facts">
                <div>
                  <dt>{t('exceptions.facts.scope')}</dt>
                  <dd>
                    {t('exceptions.facts.scopeValue', {
                      scope:
                        series.scopeKind === 'CONTACT_WIDE'
                          ? t('exceptions.facts.contactWide')
                          : t('exceptions.facts.identity', {
                              id: shortId(series.identityId ?? ''),
                            }),
                      channel: series.channel,
                      purpose: series.purpose,
                      sourceType: series.sourceType,
                      sourceId: series.sourceId,
                    })}
                  </dd>
                </div>
                <div>
                  <dt>{t('exceptions.facts.rules')}</dt>
                  <dd>{series.allowedRuleCodes.join(', ')}</dd>
                </div>
                <div>
                  <dt>{t('exceptions.facts.policyBinding')}</dt>
                  <dd>
                    {t('exceptions.facts.policyBindingValue', {
                      policy: shortId(series.policyId),
                      version: series.policyVersion,
                      digest: digestLabel(series.policyContentDigest),
                      registry: series.registryVersion,
                    })}
                  </dd>
                </div>
                <div>
                  <dt>{t('exceptions.facts.window')}</dt>
                  <dd>{effectiveWindowLabel(series.startsAt, series.expiresAt, t, locale)}</dd>
                </div>
                <div>
                  <dt>{t('exceptions.facts.content')}</dt>
                  <dd>
                    {t('exceptions.facts.contentValue', {
                      digest: digestLabel(series.contentDigest),
                      version: series.aggregateVersion,
                    })}
                  </dd>
                </div>
              </dl>
              <h3>{t('exceptions.evidence.title')}</h3>
              <div className="gov-evidence">
                <span>
                  {t('exceptions.evidence.evidence', {
                    ref: referenceLabel(series.evidenceRef, t),
                  })}
                </span>
                {series.ticketRef ? (
                  <span>
                    {t('exceptions.evidence.ticket', { ref: referenceLabel(series.ticketRef, t) })}
                  </span>
                ) : null}
                <span>
                  {t('exceptions.evidence.maker', { ref: referenceLabel(series.actorRef, t) })}
                </span>
                {isRedacted(series.evidenceRef) ? (
                  <small>{t('exceptions.evidence.redacted')}</small>
                ) : null}
                <button type="button" className="gov-secondary" onClick={() => setDrawer(true)}>
                  {t('common.openEvidence')}
                </button>
              </div>
            </>
          )}
        </article>

        {series ? (
          <aside className="gov-panel gov-rail" aria-label={t('exceptions.checker.title')}>
            <h2>{t('exceptions.checker.title')}</h2>
            <p className="gov-quorum">
              {t('exceptions.checker.recorded')} <b>{approvedCount}</b>
              {quorum ? (
                <>
                  {' '}
                  {t('exceptions.checker.latestQuorum')}{' '}
                  <b>
                    {quorum.current}/{quorum.required}
                  </b>{' '}
                  ({quorum.status})
                </>
              ) : (
                <small> {t('exceptions.checker.serverChecks')}</small>
              )}
            </p>
            <ApprovalList approvals={approvals} />
            <p className="gov-help">{t('vocabulary.approve')}</p>
            {canDecide(viewer) && series.workflowState === 'PENDING' ? (
              <>
                <button
                  type="button"
                  className="gov-primary"
                  disabled={blocked}
                  onClick={() => setDialog('APPROVE')}
                >
                  {t('exceptions.checker.approve')}
                </button>
                <button
                  type="button"
                  className="gov-danger"
                  disabled={blocked}
                  onClick={() => setDialog('REJECT')}
                >
                  {t('exceptions.checker.reject')}
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
                {t('exceptions.checker.revoke')}
              </button>
            ) : null}
            {canRequestChanges(viewer) && series.workflowState === 'PENDING' ? (
              <button
                type="button"
                className="gov-secondary"
                disabled={blocked}
                onClick={() => setDialog('CANCEL')}
              >
                {t('exceptions.checker.cancelRequest')}
              </button>
            ) : null}
            {!canDecide(viewer) ? (
              <p className="gov-help">{t('exceptions.checker.readOnly')}</p>
            ) : null}
            {command.pending ? <p aria-live="polite">{t('common.waitingServer')}</p> : null}
          </aside>
        ) : null}
      </div>

      {series && (dialog === 'APPROVE' || dialog === 'REJECT') ? (
        <ConfirmDialog
          title={
            dialog === 'APPROVE'
              ? t('exceptions.dialog.approveTitle')
              : t('exceptions.dialog.rejectTitle')
          }
          body={
            <>
              <p>
                {t('exceptions.dialog.decisionBody', {
                  revision: series.revision,
                  digest: digestLabel(series.contentDigest),
                  version: series.aggregateVersion,
                })}
              </p>
              <p>{t('vocabulary.approve')}</p>
            </>
          }
          fields={[evidenceField(t)]}
          confirmLabel={
            dialog === 'APPROVE'
              ? t('exceptions.dialog.approveTitle')
              : t('exceptions.dialog.rejectTitle')
          }
          danger={dialog === 'REJECT'}
          onCancel={() => setDialog(undefined)}
          onConfirm={(values) => void decide(dialog, values)}
        />
      ) : null}
      {series && (dialog === 'REVOKE' || dialog === 'CANCEL') ? (
        <ConfirmDialog
          title={
            dialog === 'REVOKE'
              ? t('exceptions.dialog.revokeTitle')
              : t('exceptions.dialog.cancelTitle')
          }
          body={
            <p>
              {dialog === 'REVOKE'
                ? t('exceptions.dialog.revokeBody')
                : t('exceptions.dialog.cancelBody')}
            </p>
          }
          fields={[reasonField(t), evidenceField(t)]}
          confirmLabel={
            dialog === 'REVOKE'
              ? t('exceptions.dialog.revokeConfirm')
              : t('exceptions.dialog.cancelConfirm')
          }
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
  const { t } = useGovernanceText();
  if (approvals.length === 0) return <p>{t('approvals.empty')}</p>;
  return (
    <ol className="gov-approvals">
      {approvals.map((approval, index) => (
        <li key={`${approval.decidedAt}-${index}`}>
          <b>{approval.decision === 'APPROVE' ? t('approvals.approve') : t('approvals.reject')}</b>
          <span>
            {referenceLabel(approval.approverRef, t)} · {approval.capability}
            {approval.directCompliance ? t('approvals.directCompliance') : ''}
          </span>
          <small>
            {t('approvals.epoch', {
              epoch: approval.authorizationEpoch,
              at: new Date(approval.decidedAt).toISOString(),
            })}
          </small>
        </li>
      ))}
    </ol>
  );
}

function EvidenceDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { t } = useGovernanceText();
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
          <h2 id={titleId}>{t('drawer.title')}</h2>
          <button ref={closeRef} type="button" className="gov-secondary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

// ── B · Policy change studio ─────────────────────────────────────────────────

const STEPS = [
  { key: 'draft', states: ['DRAFT'] },
  { key: 'tests', states: [] as string[] },
  { key: 'approvals', states: ['IN_REVIEW', 'APPROVED'] },
  { key: 'activation', states: ['SCHEDULED', 'ACTIVE', 'SUPERSEDED'] },
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
  const { t } = useGovernanceText();
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
        <p className="gov-eyebrow">{t('policies.eyebrow')}</p>
        <h1 id="gov-pol-empty">{t('policies.title')}</h1>
        <p>{t('policies.empty')}</p>
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
          ? t('policies.message.approved', {
              current: result.quorum.current,
              required: result.quorum.required,
              state: result.lifecycleState,
            })
          : t('policies.message.rejected'),
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
        t('policies.message.published', {
          state: result.lifecycleState,
          activate: result.activateAt
            ? t('policies.message.activate', { at: result.activateAt })
            : '',
        }),
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
      setMessage(t('policies.message.rollback', { version: result.version }));
      go({ section: 'policies', policyId: result.policyId, versionId: result.policyVersionId });
    }
  };

  return (
    <section aria-labelledby="gov-pol-title">
      <div className="gov-title-row">
        <div>
          <p className="gov-eyebrow">{t('policies.eyebrow')}</p>
          <h1 id="gov-pol-title">
            {version
              ? t('policies.headingVersion', {
                  id: shortId(location.policyId),
                  version: version.version,
                })
              : t('policies.heading', { id: shortId(location.policyId) })}
          </h1>
        </div>
        {version ? <span className="gov-state">{stateLabel(version.lifecycleState)}</span> : null}
      </div>
      <ol className="gov-stepper" aria-label={t('policies.steps.label')}>
        {STEPS.map((step, index) => (
          <li
            key={step.key}
            aria-current={index === currentStep ? 'step' : undefined}
            className={index < currentStep ? 'is-done' : index === currentStep ? 'is-current' : ''}
          >
            {index < currentStep ? '✓' : index + 1} {t(`policies.steps.${step.key}`)}
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
          <strong>{t('policies.headMismatch.title')}</strong>
          <p>
            {t('policies.headMismatch.body', {
              base: artifact.baseHeadVersion,
              baseDigest: digestLabel(artifact.baseHeadDigest),
              current: head?.headVersion ?? 0,
              currentDigest: digestLabel(head?.headDigest),
            })}
          </p>
        </div>
      ) : null}
      {version ? (
        <div className="gov-studio-grid">
          <article className="gov-panel" aria-labelledby="gov-diff-title">
            <div className="gov-section-head">
              <h2 id="gov-diff-title">{t('policies.diff.title')}</h2>
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
                <span className="gov-diff">{t('policies.diff.noTests')}</span>
              )}
            </div>
            <dl className="gov-facts">
              <div>
                <dt>{t('common.scope')}</dt>
                <dd>
                  <code>{version.scopeKey}</code>
                </dd>
              </div>
              <div>
                <dt>{t('policies.facts.contentDigest')}</dt>
                <dd>
                  {t('policies.facts.contentValue', {
                    digest: digestLabel(version.contentDigest),
                    revision: version.draftRevision,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t('policies.facts.activeHead')}</dt>
                <dd>
                  {head
                    ? t('policies.facts.headValue', {
                        head: head.headVersion,
                        policy: head.activePolicyVersion,
                        digest: digestLabel(head.headDigest),
                      })
                    : t('policies.facts.noHead')}
                  {head?.nextActivationAt
                    ? t('policies.facts.nextActivation', { at: head.nextActivationAt })
                    : ''}
                </dd>
              </div>
              <div>
                <dt>{t('policies.facts.evaluator')}</dt>
                <dd>
                  {t('policies.facts.evaluatorValue', {
                    evaluator: version.evaluatorVersion,
                    registry: version.registryVersion,
                    schema: version.schemaVersion,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t('policies.facts.effective')}</dt>
                <dd>
                  {version.activateAt
                    ? t('policies.facts.effectiveActivate', { at: version.activateAt })
                    : t('policies.facts.effectiveFrom', { at: version.effectiveFrom })}
                </dd>
              </div>
            </dl>
            <Guardrails />
            {killActive ? (
              <div className="gov-recovery gov-recovery-lifecycle_blocked" role="note">
                <strong>{t('policies.kill.title')}</strong>
                <p>{t('policies.kill.body')}</p>
              </div>
            ) : null}
            <h3>{t('policies.history.title')}</h3>
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
                    {t('policies.history.item', {
                      version: item.version,
                      state: stateLabel(item.lifecycleState),
                    })}
                    {item.rollbackOfVersionId ? t('policies.history.rollback') : ''}
                  </button>
                </li>
              ))}
            </ul>
          </article>

          <aside className="gov-panel gov-rail" aria-labelledby="gov-release-title">
            <h2 id="gov-release-title">{t('policies.release.title')}</h2>
            {artifact ? (
              <div className="gov-tests" aria-label={t('policies.release.testsLabel')}>
                <b>
                  {artifact.outcome === 'PASSED' || artifact.failed === 0 ? '✓' : '✕'}{' '}
                  {artifact.outcome}
                </b>
                <span>
                  {t('policies.release.passedFailed', {
                    passed: artifact.passed,
                    failed: artifact.failed,
                  })}
                </span>
                <span>
                  {t('policies.release.artifact', {
                    digest: digestLabel(artifact.artifactDigest),
                    suite: artifact.suiteVersion,
                  })}
                </span>
              </div>
            ) : (
              <p>{t('policies.release.noArtifact')}</p>
            )}
            <p className="gov-quorum">
              {t('policies.release.approvalDigest', {
                digest: digestLabel(version.approvalDigest),
              })}
            </p>
            <ApprovalList approvals={data?.approvals ?? []} />
            <p className="gov-help">{t('vocabulary.activate')}</p>
            {canDecide(viewer) && version.lifecycleState === 'IN_REVIEW' && artifact ? (
              <>
                <button
                  type="button"
                  className="gov-primary"
                  disabled={blocked || !head}
                  onClick={() => setDialog('APPROVE')}
                >
                  {t('policies.release.recordApproval')}
                </button>
                <button
                  type="button"
                  className="gov-danger"
                  disabled={blocked || !head}
                  onClick={() => setDialog('REJECT')}
                >
                  {t('policies.release.rejectVersion')}
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
                {t('policies.release.publish')}
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
                {t('policies.release.rollback')}
              </button>
            ) : null}
            <button type="button" className="gov-link" onClick={() => setDrawer(true)}>
              {t('common.openEvidence')}
            </button>
            {command.pending ? <p aria-live="polite">{t('common.waitingServer')}</p> : null}
          </aside>
        </div>
      ) : detail.loading || versions.loading ? (
        <p>{t('common.loadingState')}</p>
      ) : versions.failure ? (
        <RecoveryBanner state={versions.failure} onReload={() => void versions.reload()} />
      ) : null}

      {version && artifact && head && (dialog === 'APPROVE' || dialog === 'REJECT') ? (
        <ConfirmDialog
          title={
            dialog === 'APPROVE'
              ? t('policies.dialog.approveTitle')
              : t('policies.dialog.rejectTitle')
          }
          body={
            <p>
              {t('policies.dialog.decisionBody', {
                content: digestLabel(version.contentDigest),
                artifact: digestLabel(artifact.artifactDigest),
                head: head.headVersion,
                vocabulary: t('vocabulary.approve'),
              })}
            </p>
          }
          fields={[
            {
              name: 'activateAt',
              label: t('policies.dialog.activateAtLabel'),
              hint: t('policies.dialog.activateAtHint'),
              type: 'datetime-local',
              initial: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16),
            },
            evidenceField(t),
          ]}
          confirmLabel={
            dialog === 'APPROVE'
              ? t('policies.dialog.approveConfirm')
              : t('policies.dialog.rejectConfirm')
          }
          danger={dialog === 'REJECT'}
          onCancel={() => setDialog(undefined)}
          onConfirm={(values) => void decide(dialog, values)}
        />
      ) : null}
      {version && artifact && head && dialog === 'PUBLISH' ? (
        <ConfirmDialog
          title={t('policies.dialog.publishTitle')}
          body={
            <>
              <p>
                {t('policies.dialog.publishBody', {
                  head: head.headVersion,
                  digest: digestLabel(version.approvalDigest),
                })}
              </p>
              <p>{t('vocabulary.developmentComplete')}</p>
            </>
          }
          fields={[evidenceField(t)]}
          confirmLabel={t('policies.dialog.publishConfirm')}
          onCancel={() => setDialog(undefined)}
          onConfirm={(values) => void publish(values)}
        />
      ) : null}
      {version && dialog === 'ROLLBACK' ? (
        <ConfirmDialog
          title={t('policies.dialog.rollbackTitle')}
          body={<p>{t('policies.dialog.rollbackBody', { version: version.version })}</p>}
          fields={[reasonField(t), evidenceField(t)]}
          confirmLabel={t('policies.dialog.rollbackConfirm')}
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
  const { t, locale } = useGovernanceText();
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
  if (!state.data) return <p>{t('common.loadingTimeline')}</p>;
  const { series, revisions, approvals } = state.data;
  return (
    <div className="gov-evidence-grid">
      <section aria-labelledby="gov-tl-exc">
        <h3 id="gov-tl-exc">{t('audit.timeline')}</h3>
        <Timeline entries={exceptionEntries(revisions, approvals, t)} />
      </section>
      <SafetyCase
        rows={[
          [t('audit.safety.restrictions'), t('audit.safety.restrictionsValue')],
          [t('audit.safety.riskTier'), riskLabel(series.riskTier)],
          [
            t('audit.safety.workflowEffective'),
            `${stateLabel(series.workflowState)} · ${stateLabel(series.effectiveState)}`,
          ],
          [
            t('audit.safety.expiry'),
            effectiveWindowLabel(series.startsAt, series.expiresAt, t, locale),
          ],
          [t('audit.safety.evidence'), referenceLabel(series.evidenceRef, t)],
        ]}
      />
      <button type="button" className="gov-secondary" onClick={() => void state.reload()}>
        {t('common.reloadState')}
      </button>
    </div>
  );
}

function exceptionEntries(
  revisions: ExceptionRevision[],
  approvals: ApprovalRecord[],
  t: Translate,
): TimelineEntry[] {
  return [
    ...revisions.map((revision) => ({
      at: revision.createdAt,
      title: t(revision.renewsSeriesId ? 'audit.entry.revisionRenewal' : 'audit.entry.revision', {
        n: revision.revision,
      }),
      detail: t('audit.entry.revisionDetail', {
        risk: riskLabel(revision.riskTier),
        digest: digestLabel(revision.contentDigest),
        maker: referenceLabel(revision.actorRef, t),
      }),
    })),
    ...approvals.map((approval) => ({
      at: approval.decidedAt,
      title:
        approval.decision === 'APPROVE'
          ? t('audit.entry.checkerApprove')
          : t('audit.entry.checkerReject'),
      detail: t('audit.entry.approvalDetail', {
        ref: referenceLabel(approval.approverRef, t),
        capability: approval.capability,
        epoch: approval.authorizationEpoch,
      }),
    })),
  ];
}

function PolicyTimeline({ api, policyId }: { api: GovernanceApi; policyId: string }) {
  const { t } = useGovernanceText();
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
  if (!state.data) return <p>{t('common.loadingTimeline')}</p>;
  const { versions, approvals, tests, head, kills } = state.data;
  return (
    <div className="gov-evidence-grid">
      <section aria-labelledby="gov-tl-pol">
        <h3 id="gov-tl-pol">{t('audit.timeline')}</h3>
        <Timeline entries={policyEntries(versions, approvals, tests, kills, t)} />
      </section>
      <SafetyCase
        rows={[
          [
            t('audit.safety.activeHead'),
            head
              ? `v${head.headVersion} · ${digestLabel(head.headDigest)}`
              : t('audit.safety.noneYet'),
          ],
          [
            t('audit.safety.killSwitch'),
            kills.some((kill) => kill.state === 'ACTIVE')
              ? t('audit.safety.killActive')
              : t('audit.safety.killNone'),
          ],
          [
            t('audit.safety.latestTests'),
            tests.at(-1)
              ? `${tests.at(-1)!.outcome} · ${digestLabel(tests.at(-1)!.artifactDigest)}`
              : t('audit.safety.noneYet'),
          ],
          [t('audit.safety.rollback'), t('audit.safety.rollbackValue')],
        ]}
      />
      <button type="button" className="gov-secondary" onClick={() => void state.reload()}>
        {t('common.reloadState')}
      </button>
    </div>
  );
}

function policyEntries(
  versions: PolicyVersion[],
  approvals: ApprovalRecord[],
  tests: PolicyTestArtifact[],
  kills: KillSwitch[],
  t: Translate,
): TimelineEntry[] {
  return [
    ...versions.map((version) => ({
      at: version.createdAt,
      title: t('audit.entry.version', {
        n: version.version,
        state: stateLabel(version.lifecycleState),
      }),
      detail: t('audit.entry.versionDetail', {
        digest: digestLabel(version.contentDigest),
        maker: referenceLabel(version.makerActorRef, t),
        rollback: version.rollbackOfVersionId ? t('policies.history.rollback') : '',
      }),
    })),
    ...tests.map((artifact) => ({
      at: artifact.createdAt,
      title: t('audit.entry.testArtifact', { outcome: artifact.outcome }),
      detail: t('audit.entry.testDetail', {
        passed: artifact.passed,
        failed: artifact.failed,
        base: artifact.baseHeadVersion,
        digest: digestLabel(artifact.artifactDigest),
      }),
    })),
    ...approvals.map((approval) => ({
      at: approval.decidedAt,
      title:
        approval.decision === 'APPROVE'
          ? t('audit.entry.checkerApprove')
          : t('audit.entry.checkerReject'),
      detail: t('audit.entry.approvalDetailShort', {
        ref: referenceLabel(approval.approverRef, t),
        capability: approval.capability,
      }),
    })),
    ...kills.map((kill) => ({
      at: kill.activatedAt,
      title: t('audit.entry.kill', { state: kill.state }),
      detail: t('audit.entry.killDetail', {
        reason: kill.reasonCode,
        ref: referenceLabel(kill.activatedByRef, t),
      }),
    })),
  ];
}

function SafetyCase({ rows }: { rows: Array<[string, string]> }) {
  const { t } = useGovernanceText();
  return (
    <section className="gov-panel gov-safety" aria-label={t('audit.safety.title')}>
      <h3>{t('audit.safety.title')}</h3>
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
  const { t } = useGovernanceText();
  return (
    <section aria-labelledby="gov-audit-title">
      <p className="gov-eyebrow">{t('audit.eyebrow')}</p>
      <h1 id="gov-audit-title">
        {location.seriesId
          ? t('audit.traceException', { id: shortId(location.seriesId) })
          : location.policyId
            ? t('audit.tracePolicy', { id: shortId(location.policyId) })
            : t('audit.title')}
      </h1>
      {location.seriesId ? (
        <>
          <ExceptionTimeline api={api} seriesId={location.seriesId} />
          <button
            type="button"
            className="gov-link"
            onClick={() => go({ ...location, section: 'exceptions' })}
          >
            {t('audit.toWorkspace')}
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
            {t('audit.toStudio')}
          </button>
        </>
      ) : (
        <>
          <p>{t('audit.empty')}</p>
          <OpenById go={(next) => go({ ...next, section: 'audit' })} />
        </>
      )}
    </section>
  );
}

export type { EffectiveScope };
