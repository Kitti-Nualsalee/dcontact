import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import type {
  Cg5Alert,
  Cg5ConsoleApi,
  Cg5EvidenceLevel,
  Cg5ExportJob,
  Cg5PolicyImpactBucket,
} from './cg5-console-api.js';
import { intlLocale, type GovernanceViewer, type Translate } from './governance-model.js';

type Load<T> = { data?: T; error?: string; loading: boolean };
const empty = <T,>(): Load<T> => ({ loading: true });
const metricKeys: Record<string, string> = {
  'cg.decision': 'cg5.metric.decision',
  'cg.restriction': 'cg5.metric.restriction',
  'cg.exception': 'cg5.metric.exception',
  'cg.audit': 'cg5.metric.audit',
};
function message(error: unknown, t: Translate) {
  return error instanceof Error ? error.message : t('cg5.loadFailed');
}
function lagged(asOf: string | null | undefined) {
  return !asOf || Date.now() - new Date(asOf).getTime() > 15 * 60 * 1000;
}
function exportState(state: string, t: Translate) {
  if (state === 'REVOKED') return t('cg5.exportState.revoked');
  if (state === 'EXPIRED') return t('cg5.exportState.expired');
  return state;
}
function statusSymbol(state: string, t: Translate) {
  return state === 'OPEN'
    ? t('cg5.alertStatus.open')
    : state === 'ACKED'
      ? t('cg5.alertStatus.acked')
      : state === 'SUPPRESSED'
        ? t('cg5.alertStatus.suppressed')
        : t('cg5.alertStatus.closed');
}

export function Cg5Dashboard({ api, viewer }: { api: Cg5ConsoleApi; viewer: GovernanceViewer }) {
  const { t: translate } = useTranslation('governance');
  const t = translate as unknown as Translate;
  const { locale } = useLocale();
  const formatLocale = intlLocale(locale);
  const [metrics, setMetrics] =
    useState<Load<Awaited<ReturnType<Cg5ConsoleApi['metrics']>>>>(empty());
  const [impact, setImpact] =
    useState<Load<{ asOf: string | null; items: Cg5PolicyImpactBucket[] }>>(empty());
  const [alerts, setAlerts] = useState<Load<Awaited<ReturnType<Cg5ConsoleApi['alerts']>>>>(empty());
  const [exports, setExports] = useState<Load<Cg5ExportJob[]>>(empty());
  const [state, setState] = useState<'ALL' | 'OPEN' | 'ACKED' | 'SUPPRESSED'>('ALL');
  const [severity, setSeverity] = useState<'ALL' | 'WARNING' | 'CRITICAL'>('ALL');
  const [ackError, setAckError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string>();
  const [level, setLevel] = useState<Cg5EvidenceLevel>('SUMMARY');
  const [reason, setReason] = useState('');
  const [dataset, setDataset] = useState('DECISION_TRACE');
  const [from, setFrom] = useState('2026-09-01T00:00');
  const [to, setTo] = useState('2026-09-02T00:00');

  const reloadMetrics = async () => {
    setMetrics(empty());
    try {
      setMetrics({ loading: false, data: await api.metrics({ limit: 50 }) });
    } catch (error) {
      setMetrics({ loading: false, error: message(error, t) });
    }
  };
  const reloadImpact = async () => {
    if (viewer === 'SUPERVISOR') {
      setImpact({ loading: false, data: { asOf: null, items: [] } });
      return;
    }
    setImpact(empty());
    try {
      setImpact({ loading: false, data: await api.policyImpact() });
    } catch (error) {
      setImpact({ loading: false, error: message(error, t) });
    }
  };
  const reloadAlerts = async () => {
    setAlerts(empty());
    try {
      setAlerts({
        loading: false,
        data: await api.alerts({
          ...(state === 'ALL' ? {} : { states: [state] }),
          ...(severity === 'ALL' ? {} : { severities: [severity] }),
        }),
      });
    } catch (error) {
      setAlerts({ loading: false, error: message(error, t) });
    }
  };
  const reloadExports = async () => {
    if (viewer === 'SUPERVISOR') {
      setExports({ loading: false, data: [] });
      return;
    }
    setExports(empty());
    try {
      setExports({ loading: false, data: await api.exports() });
    } catch (error) {
      setExports({ loading: false, error: message(error, t) });
    }
  };
  useEffect(() => {
    void reloadMetrics();
    void reloadImpact();
    void reloadExports();
  }, [api, viewer]);
  useEffect(() => {
    void reloadAlerts();
  }, [api, state, severity]);
  const cards = useMemo(
    () =>
      Object.entries(metricKeys).map(([key, labelKey]) => ({
        label: t(labelKey),
        // ไม่มี projection (เช่น backfill ยังไม่จบ) ต้องบอกว่าไม่พร้อม ไม่ใช่แสดง 0 ที่ดูเหมือนตัวเลขจริง
        value:
          metrics.data?.items
            .filter((item) => item.metricKey === key)
            .reduce((sum, item) => sum + Number(item.value), 0) ?? null,
      })),
    [metrics.data, t],
  );
  const reasons = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const item of metrics.data?.items ?? []) {
      if (item.reasonCode)
        grouped.set(item.reasonCode, (grouped.get(item.reasonCode) ?? 0) + Number(item.value));
    }
    return [...grouped.entries()].sort((left, right) => right[1] - left[1]);
  }, [metrics.data]);
  const acknowledge = async (alert: Cg5Alert) => {
    setAckError(undefined);
    try {
      await api.acknowledgeAlert({ alertId: alert.id, version: alert.version });
      await reloadAlerts();
    } catch (error) {
      setAckError(t('cg5.ackConflict', { message: message(error, t) }));
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) return;
    setSubmitting(true);
    setExportMessage(undefined);
    try {
      await api.requestExport({
        datasets: [dataset],
        rangeFrom: new Date(from).toISOString(),
        rangeTo: new Date(to).toISOString(),
        evidenceLevel: level,
        reason: reason.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      setExportMessage(t('cg5.exportSent'));
      setReason('');
      await reloadExports();
    } catch (error) {
      setExportMessage(message(error, t));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="cg5-dashboard" aria-labelledby="cg5-title">
      <div className="cg5-title">
        <div>
          <p className="gov-eyebrow">{t('cg5.eyebrow')}</p>
          <h1 id="cg5-title">{t('cg5.title')}</h1>
        </div>
        <a className="gov-link" href="?view=governance&section=audit">
          {t('cg5.healthLink')}
        </a>
      </div>
      <section className="cg5-freshness" aria-label={t('cg5.freshness.title')}>
        <strong>{t('cg5.freshness.title')}</strong>
        <span>
          {t('cg5.freshness.decision', {
            value: metrics.data?.asOf
              ? new Date(metrics.data.asOf).toLocaleString(formatLocale)
              : t('cg5.freshness.notReady'),
          })}
        </span>
        <span>
          {t('cg5.freshness.alert', {
            value: alerts.data?.asOf
              ? new Date(alerts.data.asOf).toLocaleString(formatLocale)
              : t('cg5.freshness.notReady'),
          })}
        </span>
        {metrics.error ||
        alerts.error ||
        lagged(metrics.data?.asOf) ||
        lagged(alerts.data?.asOf) ? (
          <p role="alert">
            {t('cg5.freshness.lag', {
              detail: metrics.error ?? alerts.error ?? t('cg5.freshness.lagDetail'),
            })}
          </p>
        ) : null}
      </section>
      <div className="cg5-cards">
        {cards.map((card) => (
          <article className="gov-panel" key={card.label}>
            <p>{card.label}</p>
            <strong>
              {metrics.loading
                ? '…'
                : card.value === null
                  ? t('cg5.cardNotReady')
                  : card.value.toLocaleString(formatLocale)}
            </strong>
          </article>
        ))}
      </div>
      <section className="gov-panel">
        <h2>{t('cg5.reasons.title')}</h2>
        {metrics.loading ? (
          <p>{t('cg5.reasons.loading')}</p>
        ) : reasons.length === 0 ? (
          <p>{t('cg5.reasons.empty')}</p>
        ) : (
          <ul className="cg5-reasons">
            {reasons.map(([reasonCode, value]) => (
              <li key={reasonCode}>
                <strong>{reasonCode}</strong>{' '}
                <span>{t('cg5.reasons.count', { n: value.toLocaleString(formatLocale) })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {viewer === 'SUPERVISOR' ? null : (
        <section className="gov-panel">
          <h2>{t('cg5.impact.title')}</h2>
          {impact.loading ? (
            <p>{t('cg5.impact.loading')}</p>
          ) : impact.error ? (
            <p role="alert">{impact.error}</p>
          ) : impact.data?.items.length === 0 ? (
            <p>{t('cg5.impact.empty')}</p>
          ) : (
            <ul className="cg5-impact">
              {impact.data?.items.map((item) => (
                <li key={`${item.bucketStart}:${item.policyVersion}:${item.decision}`}>
                  <strong>{t('cg5.impact.policy', { version: item.policyVersion })}</strong> ·{' '}
                  {item.decision} · {item.value}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="gov-panel">
        <div className="cg5-title">
          <h2>{t('cg5.alerts.title')}</h2>
          <div className="cg5-filters">
            <label>
              {t('cg5.alerts.status')}
              <select
                value={state}
                onChange={(event) => setState(event.target.value as typeof state)}
              >
                <option value="ALL">{t('cg5.alerts.statusAll')}</option>
                <option value="OPEN">{t('cg5.alerts.statusOpen')}</option>
                <option value="ACKED">{t('cg5.alerts.statusAcked')}</option>
                <option value="SUPPRESSED">{t('cg5.alerts.statusSuppressed')}</option>
              </select>
            </label>
            <label>
              {t('cg5.alerts.severity')}
              <select
                value={severity}
                onChange={(event) => setSeverity(event.target.value as typeof severity)}
              >
                <option value="ALL">{t('cg5.alerts.severityAll')}</option>
                <option value="CRITICAL">{t('cg5.alerts.severityCritical')}</option>
                <option value="WARNING">{t('cg5.alerts.severityWarning')}</option>
              </select>
            </label>
          </div>
        </div>
        {ackError ? (
          <p role="alert">
            {ackError}{' '}
            <button className="gov-secondary" type="button" onClick={() => void reloadAlerts()}>
              {t('cg5.alerts.reload')}
            </button>
          </p>
        ) : null}
        {alerts.loading ? (
          <p>{t('cg5.alerts.loading')}</p>
        ) : alerts.error ? (
          <p role="alert">{alerts.error}</p>
        ) : alerts.data?.items.length === 0 ? (
          <p>{t('cg5.alerts.empty')}</p>
        ) : (
          <ul className="cg5-alerts">
            {alerts.data?.items.map((alert) => (
              <li key={alert.id} className={alert.state === 'SUPPRESSED' ? 'cg5-suppressed' : ''}>
                <strong>
                  {alert.severity === 'CRITICAL'
                    ? t('cg5.alerts.critical')
                    : t('cg5.alerts.warning')}{' '}
                  · {alert.ruleCode}
                </strong>
                <span>
                  {t('cg5.alerts.line', {
                    status: statusSymbol(alert.state, t),
                    value: alert.value,
                    threshold: alert.threshold,
                    hits: alert.consecutiveHits,
                    channel: alert.channel ?? t('cg5.alerts.allChannels'),
                    purpose: alert.purpose ?? t('cg5.alerts.allPurposes'),
                  })}
                </span>
                {alert.state === 'OPEN' ? (
                  <button
                    className="gov-secondary"
                    type="button"
                    onClick={() => void acknowledge(alert)}
                  >
                    {t('cg5.alerts.acknowledge')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {viewer === 'SUPERVISOR' ? (
        <section className="gov-panel">
          <h2>{t('cg5.export.title')}</h2>
          <p>{t('cg5.export.supervisorNote')}</p>
        </section>
      ) : (
        <section className="gov-panel">
          <h2>{t('cg5.export.title')}</h2>
          <form className="cg5-export" onSubmit={submit}>
            <label>
              {t('cg5.export.dataset')}
              <select value={dataset} onChange={(event) => setDataset(event.target.value)}>
                <option value="DECISION_TRACE">{t('cg5.export.decisionTrace')}</option>
                <option value="AUDIT_LOG">{t('cg5.export.auditLog')}</option>
                <option value="RESTRICTION_EVIDENCE">{t('cg5.export.restrictionEvidence')}</option>
                <option value="EXCEPTION_APPROVAL">{t('cg5.export.exceptionApproval')}</option>
              </select>
            </label>
            <label>
              {t('cg5.export.from')}
              <input
                type="datetime-local"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                required
              />
            </label>
            <label>
              {t('cg5.export.to')}
              <input
                type="datetime-local"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                required
              />
            </label>
            <label>
              {t('cg5.export.level')}
              <select
                value={level}
                onChange={(event) => setLevel(event.target.value as Cg5EvidenceLevel)}
              >
                <option value="SUMMARY">{t('cg5.export.levelSummary')}</option>
                <option value="EVIDENCE">{t('cg5.export.levelEvidence')}</option>
              </select>
            </label>
            <label>
              {t('cg5.export.reason')}
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
              />
            </label>
            {!reason.trim() ? <p role="status">{t('cg5.export.reasonRequired')}</p> : null}
            <p>
              {t('cg5.export.reasonAudited')}
              {level === 'EVIDENCE' ? t('cg5.export.evidenceNote') : ''}
            </p>
            <button className="gov-primary" disabled={submitting || !reason.trim()}>
              {submitting ? t('cg5.export.submitting') : t('cg5.export.submit')}
            </button>
          </form>
          {exportMessage ? <p role="status">{exportMessage}</p> : null}
          <ul className="cg5-exports">
            {exports.data?.map((job) => (
              <li key={job.exportId}>
                <strong>
                  {t('cg5.export.jobTitle', {
                    state: exportState(job.state, t),
                    level: job.evidenceLevel,
                  })}
                </strong>
                <span>
                  {t('cg5.export.jobDetail', {
                    datasets: job.datasets.join(', '),
                    digest: job.manifestDigest
                      ? t('cg5.export.digest', { tail: job.manifestDigest.slice(-8) })
                      : t('cg5.export.noDigest'),
                    file:
                      job.state === 'REVOKED'
                        ? t('cg5.export.fileRevoked')
                        : t('cg5.export.expires', { at: job.expiresAt ?? '—' }),
                    by: job.requestedByRef,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
