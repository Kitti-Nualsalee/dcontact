/**
 * U1.4 (#432): แผง UAT run บน Journey Console จริง (Phase Contract #374, evidence #379)
 *
 * - แสดงเมื่อ API รายงาน profile `uat` เท่านั้น — API อื่นไม่มี route profile (404) จึงไม่มี UI ของ UAT เลย
 * - อยู่ในเนื้อหาของหน้า (ไม่ใช่ shell) จึงทำงานเหมือนกันทั้งเปิดและปิด flag `ui.shell.v2`
 * - ข้อมูล run/ผลทุกอย่างมาจาก server: หลังบันทึกผลหรือ `เริ่มรอบใหม่` โหลด run ใหม่เสมอ ไม่อนุมานสถานะเอง
 * - mutation ใช้ `Idempotency-Key` เดียวตลอด intent: เน็ตหลุดแล้วกดซ้ำใช้ key เดิม; server ตอบ error = key ใหม่
 * - session หมด (401) แสดงทางเข้าสู่ระบบใหม่ ไม่ปล่อยหน้าตัน
 * - จอต่ำกว่า 960px อ่านอย่างเดียวตามกติกาเดิมของหน้า: ไม่มีปุ่มบันทึกผล/เริ่มรอบใหม่
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
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Badge, Button } from '@d-contact/ui-react';
import { appI18n } from '../i18n/index.js';
import { JourneyAuthoringApiError } from './api.js';
import { errorMessage, journeyText } from './model.js';
import { Dialog } from './publish.js';
import { serverTime } from './server-time.js';
import {
  UAT_OUTCOMES,
  UAT_SEVERITIES,
  type UatApi,
  type UatOutcome,
  type UatRunView,
  type UatSeverity,
} from './uat-api.js';

// ── Context ─────────────────────────────────────────────────────────────────

export interface UatFailure {
  status?: number;
  code?: string;
  safeParams?: Record<string, unknown>;
}

export interface UatContextValue {
  api: UatApi;
  /** `undefined` = กำลังโหลด, `null` = ยังไม่มี run ที่ ACTIVE */
  run: UatRunView | null | undefined;
  loadError: UatFailure | null;
  sessionExpired: boolean;
  reload(): Promise<void>;
  /** แปลง error เป็นรูปที่แสดงได้ และจำว่า session หมดเมื่อได้ 401 */
  failure(error: unknown): UatFailure;
}

const UatContext = createContext<UatContextValue | null>(null);

/** `null` = ไม่ใช่ UAT (หรือยังไม่รู้ profile) — ใช้ path เดิมของ J5 ทั้งหมด */
export function useUat(): UatContextValue | null {
  return useContext(UatContext);
}

export function UatProvider({ api, children }: { api?: UatApi; children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [run, setRun] = useState<UatRunView | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<UatFailure | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const failure = useCallback((error: unknown): UatFailure => {
    if (!(error instanceof JourneyAuthoringApiError)) return {};
    if (error.status === 401) setSessionExpired(true);
    return { status: error.status, code: error.code, safeParams: error.safeParams };
  }, []);

  const reload = useCallback(async () => {
    if (!api) return;
    try {
      setRun(await api.current());
      setLoadError(null);
    } catch (error) {
      setLoadError(failure(error));
    }
  }, [api, failure]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .runtimeProfile()
      .then((profile) => {
        if (cancelled || profile?.profile !== 'uat') return;
        setActive(true);
        void reload();
      })
      // อ่าน profile ไม่ได้ = ไม่รู้ว่าเป็น UAT จึงไม่แสดงอะไรที่อ้างว่าเป็น UAT
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, reload]);

  const value = useMemo<UatContextValue | null>(
    () => (api && active ? { api, run, loadError, sessionExpired, reload, failure } : null),
    [api, active, run, loadError, sessionExpired, reload, failure],
  );
  return <UatContext.Provider value={value}>{children}</UatContext.Provider>;
}

// ── ข้อความ ─────────────────────────────────────────────────────────────────

/** code ที่ server ไม่ส่ง `nextSafeAction` มา — ทางไปต่อที่ปลอดภัยของแต่ละ code */
const DEFAULT_NEXT_ACTION: Readonly<Record<string, string>> = {
  REVISION_CONFLICT: 'RELOAD_RUN',
  UAT_RUN_CLOSED: 'RELOAD_RUN',
  UAT_RUN_NOT_FOUND: 'RELOAD_RUN',
  IDEMPOTENCY_CONFLICT: 'SUBMIT_AGAIN',
  UAT_CAPABILITY_REQUIRED: 'ASK_MAKER',
  FIXTURE_PACK_NOT_FOUND: 'CHECK_PACK',
  FIXTURE_PACK_DIGEST_MISMATCH: 'ASK_OPERATOR',
  FIXTURE_MANIFEST_INVALID: 'ASK_OPERATOR',
  FIXTURE_PREFLIGHT_FAILED: 'ASK_OPERATOR',
  VALIDATION_FAILED: 'FIX_FIELD',
  REQUEST_MALFORMED: 'FIX_FIELD',
};

/** งานค้างของ run เดิมที่ต้องจัดการใน Journey ของรอบนั้นก่อน */
const JOURNEY_ACTIONS = new Set([
  'DECIDE_REVIEW',
  'PUBLISH_OR_EDIT_DRAFT',
  'RESOLVE_PENDING_COMMAND',
]);

export function uatErrorMessage(failure: UatFailure): string {
  if (failure.status === 401) return journeyText('uat.sessionExpiredBody');
  if (!failure.code) return journeyText('uat.error.network');
  const field = failure.safeParams?.field;
  return appI18n.exists(`journeys:uat.error.${failure.code}`)
    ? journeyText(`uat.error.${failure.code}`, { field: typeof field === 'string' ? field : '' })
    : errorMessage(failure.code);
}

export function uatNextAction(failure: UatFailure): string | null {
  if (failure.status === 401) return null;
  const fromServer = failure.safeParams?.nextSafeAction;
  const action =
    typeof fromServer === 'string'
      ? fromServer
      : failure.code
        ? DEFAULT_NEXT_ACTION[failure.code]
        : 'RETRY_SAME';
  return action && appI18n.exists(`journeys:uat.nextAction.${action}`) ? action : null;
}

function short(value: string, length: number): string {
  return value.slice(0, length);
}

// ── ส่วนประกอบย่อย ───────────────────────────────────────────────────────────

function FailureNotice({
  failure,
  journeyId,
  onOpenJourney,
}: {
  failure: UatFailure;
  journeyId: string | null | undefined;
  onOpenJourney: (journeyId: string) => void;
}) {
  const { t } = useTranslation('journeys');
  const action = uatNextAction(failure);
  return (
    <div className="j5-recovery" role="alert">
      <p>{uatErrorMessage(failure)}</p>
      {action ? (
        <p>
          <strong>{t('uat.nextActionLabel')}</strong> {journeyText(`uat.nextAction.${action}`)}
        </p>
      ) : null}
      {action && JOURNEY_ACTIONS.has(action) && journeyId ? (
        <div className="j5-button-row">
          <Button onPress={() => onOpenJourney(journeyId)}>{t('uat.openRunJourney')}</Button>
        </div>
      ) : null}
    </div>
  );
}

function SessionExpired({ onSignInAgain }: { onSignInAgain?: () => void }) {
  const { t } = useTranslation('journeys');
  return (
    <div className="j5-recovery" role="alert">
      <p>
        <strong>{t('uat.sessionExpiredTitle')}</strong>
      </p>
      <p>{t('uat.sessionExpiredBody')}</p>
      <div className="j5-button-row">
        <Button
          variant="primary"
          onPress={() => (onSignInAgain ? onSignInAgain() : window.location.reload())}
        >
          {t('uat.signInAgain')}
        </Button>
      </div>
    </div>
  );
}

const PACK_ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PACK_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function RecordStepForm({
  uat,
  run,
  onRecorded,
  onFailure,
}: {
  uat: UatContextValue;
  run: UatRunView;
  onRecorded: (stepId: string) => void;
  onFailure: (failure: UatFailure | null) => void;
}) {
  const { t } = useTranslation('journeys');
  const ids = { step: useId(), actual: useId(), severity: useId(), correlation: useId() };
  const outcomeName = useId();
  const [stepId, setStepId] = useState(run.steps[0]?.stepId ?? '');
  const [outcome, setOutcome] = useState<UatOutcome>('PASS');
  const [actual, setActual] = useState('');
  const [severity, setSeverity] = useState<UatSeverity | ''>('');
  const [correlationId, setCorrelationId] = useState('');
  const [busy, setBusy] = useState(false);
  const intent = useRef<{ body: string; key: string } | null>(null);
  const step = run.steps.find((entry) => entry.stepId === stepId);
  const correlationInvalid =
    correlationId.trim().length > 0 && !CORRELATION_ID.test(correlationId.trim());
  const complete =
    !!step &&
    actual.trim().length > 0 &&
    actual.length <= 2000 &&
    (outcome !== 'FAIL' || severity !== '') &&
    !correlationInvalid;

  const submit = async () => {
    if (!complete) return;
    const body = {
      stepId,
      outcome,
      actual,
      ...(outcome === 'FAIL' && severity ? { severity } : {}),
      ...(correlationId.trim() ? { correlationId: correlationId.trim() } : {}),
    };
    const serialized = JSON.stringify({ runId: run.runId, body });
    if (intent.current?.body !== serialized)
      intent.current = { body: serialized, key: `uat-step-${crypto.randomUUID()}` };
    setBusy(true);
    onFailure(null);
    try {
      await uat.api.recordStepResult(run.runId, body, intent.current.key);
      intent.current = null;
      setActual('');
      setSeverity('');
      setCorrelationId('');
      await uat.reload();
      onRecorded(stepId);
    } catch (error) {
      // server ตอบแล้ว = intent จบ; เน็ตหลุด = ยังไม่รู้ผล กดซ้ำด้วย key เดิม (server replay ได้)
      if (error instanceof JourneyAuthoringApiError) intent.current = null;
      onFailure(uat.failure(error));
      if (error instanceof JourneyAuthoringApiError && error.code === 'UAT_RUN_CLOSED')
        await uat.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      aria-labelledby={`${ids.step}-heading`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 id={`${ids.step}-heading`}>{t('uat.recordHeading')}</h3>
      <div className="j5-field">
        <label htmlFor={ids.step}>{t('uat.stepLabel')}</label>
        <select id={ids.step} value={stepId} onChange={(event) => setStepId(event.target.value)}>
          {run.steps.map((entry) => (
            <option key={entry.stepId} value={entry.stepId}>
              {entry.stepId} · {entry.title}
            </option>
          ))}
        </select>
      </div>
      {step ? (
        <dl className="j5-facts">
          <div>
            <dt>{t('uat.expected')}</dt>
            <dd>{step.expected}</dd>
          </div>
          <div>
            <dt>{t('uat.stateLabelHeading')}</dt>
            <dd>{t(`uat.stateLabel.${step.stateLabel}`)}</dd>
          </div>
        </dl>
      ) : null}
      <fieldset className="j5-fieldset">
        <legend>{t('uat.outcomeLabel')}</legend>
        {UAT_OUTCOMES.map((choice) => (
          <label key={choice} className="j5-radio">
            <input
              type="radio"
              name={outcomeName}
              value={choice}
              checked={outcome === choice}
              onChange={() => setOutcome(choice)}
            />
            {t(`uat.outcome.${choice}`)}
          </label>
        ))}
      </fieldset>
      {outcome === 'FAIL' ? (
        <div className="j5-field">
          <label htmlFor={ids.severity}>{t('uat.severityLabel')}</label>
          <select
            id={ids.severity}
            value={severity}
            required
            aria-required="true"
            onChange={(event) => setSeverity(event.target.value as UatSeverity | '')}
          >
            <option value="">{t('uat.severityChoose')}</option>
            {UAT_SEVERITIES.map((choice) => (
              <option key={choice} value={choice}>
                {t(`uat.severity.${choice}`)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="j5-field">
        <label htmlFor={ids.actual}>{t('uat.actualLabel')}</label>
        <textarea
          id={ids.actual}
          rows={3}
          value={actual}
          required
          aria-required="true"
          maxLength={2000}
          onChange={(event) => setActual(event.target.value)}
        />
        <small className="j5-help">{t('uat.actualHint')}</small>
      </div>
      <div className="j5-field">
        <label htmlFor={ids.correlation}>{t('uat.correlationLabel')}</label>
        <input
          id={ids.correlation}
          value={correlationId}
          aria-invalid={correlationInvalid}
          aria-describedby={`${ids.correlation}-hint`}
          onChange={(event) => setCorrelationId(event.target.value)}
        />
        <small id={`${ids.correlation}-hint`} className="j5-help">
          {t('uat.correlationHint')}
        </small>
      </div>
      <Button type="submit" variant="primary" isDisabled={!complete || busy}>
        {busy ? t('uat.recording') : t('uat.record')}
      </Button>
    </form>
  );
}

// ── แผงหลัก ─────────────────────────────────────────────────────────────────

export function UatRunPanel({
  readOnly,
  defaults = {},
  onOpenJourney,
  onSignInAgain,
}: {
  readOnly: boolean;
  /** pack เริ่มต้นตอนยังไม่มี run (ค่าจาก build) — ผู้ทดสอบแก้ได้ใน dialog ก่อนยืนยัน */
  defaults?: { environment?: string; packVersion?: string };
  onOpenJourney: (journeyId: string) => void;
  onSignInAgain?: () => void;
}) {
  const uat = useUat();
  const { t } = useTranslation('journeys');
  const { formatters } = useLocale();
  const headingId = useId();
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<UatFailure | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const startIntent = useRef<{ body: string; key: string } | null>(null);
  if (!uat) return null;
  const { run } = uat;

  const start = async (values: Record<string, string>) => {
    setConfirming(false);
    const body = {
      environment: values.environment!,
      packVersion: values.packVersion!,
      expectedRevision: run?.revision ?? 0,
    };
    const serialized = JSON.stringify(body);
    if (startIntent.current?.body !== serialized)
      startIntent.current = { body: serialized, key: `uat-start-${crypto.randomUUID()}` };
    setStarting(true);
    setFailure(null);
    try {
      const next = await uat.api.start(body, startIntent.current.key);
      startIntent.current = null;
      await uat.reload();
      setAnnouncement(t('uat.started', { sequence: next.sequence }));
      if (next.journeyId) onOpenJourney(next.journeyId);
    } catch (error) {
      if (error instanceof JourneyAuthoringApiError) startIntent.current = null;
      setFailure(uat.failure(error));
      // revision เปลี่ยน/run ปิดแล้ว: โหลดความจริงล่าสุดจาก server ให้ผู้ทดสอบตัดสินใจใหม่
      if (
        error instanceof JourneyAuthoringApiError &&
        ['REVISION_CONFLICT', 'UAT_RUN_CLOSED'].includes(error.code ?? '')
      )
        await uat.reload();
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="j5-panel j5-uat" aria-labelledby={headingId}>
      <div className="j5-title-row">
        <h2 id={headingId}>{t('uat.heading')}</h2>
        <Badge tone="attention">{t('uat.badge')}</Badge>
      </div>
      <p className="j5-boundary" role="note">
        {t('uat.boundary')}
      </p>
      <p className="j5-live" role="status" aria-live="polite">
        {announcement}
      </p>
      {uat.sessionExpired ? <SessionExpired onSignInAgain={onSignInAgain} /> : null}
      {!uat.sessionExpired && uat.loadError ? (
        <FailureNotice failure={uat.loadError} journeyId={null} onOpenJourney={onOpenJourney} />
      ) : null}
      {run === undefined && !uat.loadError && !uat.sessionExpired ? (
        <p role="status">{t('common.loading')}</p>
      ) : null}
      {run === null ? <p>{t('uat.noRun')}</p> : null}
      {run ? (
        <>
          <dl className="j5-facts" aria-label={t('uat.runLabel')}>
            <div>
              <dt>{t('uat.sequence')}</dt>
              <dd>{t('uat.sequenceValue', { sequence: run.sequence })}</dd>
            </div>
            <div>
              <dt>{t('uat.runId')}</dt>
              <dd>
                <code title={run.runId}>{short(run.runId, 8)}</code>
              </dd>
            </div>
            <div>
              <dt>{t('uat.lifecycle')}</dt>
              <dd>{run.lifecycle}</dd>
            </div>
            <div>
              <dt>{t('uat.revision')}</dt>
              <dd>{run.revision}</dd>
            </div>
            <div>
              <dt>{t('uat.pack')}</dt>
              <dd>
                {run.fixturePack.environment} · {run.fixturePack.packVersion} ·{' '}
                <code title={run.fixturePack.digest}>{short(run.fixturePack.digest, 12)}</code>
              </dd>
            </div>
            <div>
              <dt>{t('uat.buildSha')}</dt>
              <dd>
                <code title={run.fixturePack.buildSha}>{short(run.fixturePack.buildSha, 12)}</code>
              </dd>
            </div>
            <div>
              <dt>{t('uat.openedAt')}</dt>
              <dd>
                <time dateTime={run.openedAt}>{serverTime(formatters, run.openedAt)}</time>
              </dd>
            </div>
            <div>
              <dt>{t('uat.journey')}</dt>
              <dd>
                {run.journeyId ? (
                  <button
                    type="button"
                    className="j5-link"
                    onClick={() => onOpenJourney(run.journeyId!)}
                  >
                    {t('uat.openRunJourney')}
                  </button>
                ) : (
                  t('uat.journeyPending')
                )}
              </dd>
            </div>
          </dl>

          <h3>{t('uat.resultsHeading')}</h3>
          {run.stepResults.length === 0 ? (
            <p>{t('uat.noResults')}</p>
          ) : (
            <div className="j5-table-scroll">
              <table className="j5-table">
                <caption className="j5-sr">{t('uat.resultsCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('uat.col.step')}</th>
                    <th scope="col">{t('uat.col.outcome')}</th>
                    <th scope="col">{t('uat.col.severity')}</th>
                    <th scope="col">{t('uat.col.actual')}</th>
                    <th scope="col">{t('uat.col.stateLabel')}</th>
                    <th scope="col">{t('uat.col.recordedAt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {run.stepResults.map((result, index) => (
                    <tr key={`${result.stepId}-${result.recordedAt}-${index}`}>
                      <td>
                        <code>{result.stepId}</code>
                      </td>
                      <td>
                        <Badge
                          tone={
                            result.outcome === 'PASS'
                              ? 'success'
                              : result.outcome === 'FAIL'
                                ? 'critical'
                                : 'attention'
                          }
                        >
                          {t(`uat.outcome.${result.outcome}`)}
                        </Badge>
                      </td>
                      <td>{result.severity ?? t('common.none')}</td>
                      <td>{result.actual}</td>
                      <td>{t(`uat.stateLabel.${result.stateLabel}`)}</td>
                      <td>
                        <time dateTime={result.recordedAt}>
                          {serverTime(formatters, result.recordedAt)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {failure && !uat.sessionExpired ? (
        <FailureNotice failure={failure} journeyId={run?.journeyId} onOpenJourney={onOpenJourney} />
      ) : null}

      {readOnly ? (
        <p className="j5-help" role="note">
          {t('uat.readOnlyNote')}
        </p>
      ) : uat.sessionExpired || run === undefined ? null : (
        <>
          {run?.lifecycle === 'ACTIVE' ? (
            <RecordStepForm
              key={run.runId}
              uat={uat}
              run={run}
              onFailure={setFailure}
              onRecorded={(stepId) => setAnnouncement(t('uat.recorded', { stepId }))}
            />
          ) : null}
          <h3>{t('uat.newRunHeading')}</h3>
          <p className="j5-help">{t('uat.newRunHint')}</p>
          <Button isDisabled={starting} onPress={() => setConfirming(true)}>
            {starting ? t('uat.starting') : t('uat.startNewRun')}
          </Button>
        </>
      )}

      {confirming ? (
        <Dialog
          alert
          title={t('uat.confirmTitle')}
          body={
            <>
              <p>
                {run ? t('uat.confirmCloses', { sequence: run.sequence }) : t('uat.confirmFirst')}
              </p>
              <p>{t('uat.confirmKeeps')}</p>
              <p>{t('uat.confirmCreates')}</p>
            </>
          }
          fields={[
            {
              name: 'environment',
              label: t('uat.packEnvironment'),
              initial: run?.fixturePack.environment ?? defaults.environment ?? '',
              pattern: PACK_ENVIRONMENT,
            },
            {
              name: 'packVersion',
              label: t('uat.packVersion'),
              initial: run?.fixturePack.packVersion ?? defaults.packVersion ?? '',
              pattern: PACK_VERSION,
            },
          ]}
          confirmLabel={t('uat.startNewRun')}
          onCancel={() => setConfirming(false)}
          onConfirm={(values) => void start(values)}
        />
      ) : null}
    </section>
  );
}
