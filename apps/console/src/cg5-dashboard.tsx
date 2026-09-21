import { useEffect, useMemo, useState } from 'react';
import type { Cg5Alert, Cg5ConsoleApi, Cg5EvidenceLevel, Cg5ExportJob } from './cg5-console-api.js';
import type { GovernanceViewer } from './governance-model.js';

type Load<T> = { data?: T; error?: string; loading: boolean };
const empty = <T,>(): Load<T> => ({ loading: true });
const metricLabels: Record<string, string> = {
  'cg.decision': 'การตัดสิน',
  'cg.restriction': 'ข้อจำกัด',
  'cg.exception': 'Exception',
  'cg.audit': 'Audit',
};
function message(error: unknown) {
  return error instanceof Error ? error.message : 'โหลดข้อมูลไม่สำเร็จ';
}
function statusSymbol(state: string) {
  return state === 'OPEN'
    ? '● เปิดอยู่'
    : state === 'ACKED'
      ? '✓ รับทราบแล้ว'
      : state === 'SUPPRESSED'
        ? '⊘ ระงับชั่วคราว'
        : '✓ ปิดแล้ว';
}

export function Cg5Dashboard({ api, viewer }: { api: Cg5ConsoleApi; viewer: GovernanceViewer }) {
  const [metrics, setMetrics] =
    useState<Load<Awaited<ReturnType<Cg5ConsoleApi['metrics']>>>>(empty());
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
      setMetrics({ loading: false, error: message(error) });
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
      setAlerts({ loading: false, error: message(error) });
    }
  };
  const reloadExports = async () => {
    setExports(empty());
    try {
      setExports({ loading: false, data: await api.exports() });
    } catch (error) {
      setExports({ loading: false, error: message(error) });
    }
  };
  useEffect(() => {
    void reloadMetrics();
    void reloadExports();
  }, [api]);
  useEffect(() => {
    void reloadAlerts();
  }, [api, state, severity]);
  const cards = useMemo(
    () =>
      Object.entries(metricLabels).map(([key, label]) => ({
        label,
        value:
          metrics.data?.items
            .filter((item) => item.metricKey === key)
            .reduce((sum, item) => sum + Number(item.value), 0) ?? 0,
      })),
    [metrics.data],
  );
  const acknowledge = async (alert: Cg5Alert) => {
    setAckError(undefined);
    try {
      await api.acknowledgeAlert({ alertId: alert.id, version: alert.version });
      await reloadAlerts();
    } catch (error) {
      setAckError(`${message(error)} — มีการเปลี่ยนข้อมูลแล้ว ให้โหลดรายการใหม่`);
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
      setExportMessage('ส่งคำขอ export แล้ว ระบบบันทึกเหตุผลลง audit');
      setReason('');
      await reloadExports();
    } catch (error) {
      setExportMessage(message(error));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="cg5-dashboard" aria-labelledby="cg5-title">
      <div className="cg5-title">
        <div>
          <p className="gov-eyebrow">CG5 OVERVIEW</p>
          <h1 id="cg5-title">Governance overview</h1>
        </div>
        <a className="gov-link" href="?view=governance&section=audit">
          เปิด Governance Health
        </a>
      </div>
      <section className="cg5-freshness" aria-label="ความสดของข้อมูล">
        <strong>ความสดของข้อมูล</strong>
        <span>
          Decision projection:{' '}
          {metrics.data?.asOf
            ? new Date(metrics.data.asOf).toLocaleString('th-TH')
            : 'ข้อมูลยังไม่พร้อม'}
        </span>
        <span>
          Alert state:{' '}
          {alerts.data?.asOf
            ? new Date(alerts.data.asOf).toLocaleString('th-TH')
            : 'ข้อมูลยังไม่พร้อม'}
        </span>
        {metrics.error || alerts.error ? (
          <p role="alert">⚠ ข้อมูลอาจล่าช้ากว่า SLO: {metrics.error ?? alerts.error}</p>
        ) : null}
      </section>
      <div className="cg5-cards">
        {cards.map((card) => (
          <article className="gov-panel" key={card.label}>
            <p>{card.label}</p>
            <strong>{metrics.loading ? '…' : card.value.toLocaleString('th-TH')}</strong>
          </article>
        ))}
      </div>
      <section className="gov-panel">
        <div className="cg5-title">
          <h2>Alert</h2>
          <div className="cg5-filters">
            <label>
              สถานะ
              <select
                value={state}
                onChange={(event) => setState(event.target.value as typeof state)}
              >
                <option value="ALL">ทั้งหมด</option>
                <option value="OPEN">เปิดอยู่</option>
                <option value="ACKED">รับทราบแล้ว</option>
                <option value="SUPPRESSED">ระงับชั่วคราว</option>
              </select>
            </label>
            <label>
              ความรุนแรง
              <select
                value={severity}
                onChange={(event) => setSeverity(event.target.value as typeof severity)}
              >
                <option value="ALL">ทุกระดับ</option>
                <option value="CRITICAL">CRITICAL</option>
                <option value="WARNING">WARNING</option>
              </select>
            </label>
          </div>
        </div>
        {ackError ? <p role="alert">{ackError}</p> : null}
        {alerts.loading ? (
          <p>กำลังโหลด alert…</p>
        ) : alerts.error ? (
          <p role="alert">{alerts.error}</p>
        ) : alerts.data?.items.length === 0 ? (
          <p>ไม่มีรายการที่ตรงกับตัวกรอง</p>
        ) : (
          <ul className="cg5-alerts">
            {alerts.data?.items.map((alert) => (
              <li key={alert.id} className={alert.state === 'SUPPRESSED' ? 'cg5-suppressed' : ''}>
                <strong>
                  {alert.severity === 'CRITICAL' ? '▲▲ CRITICAL' : '▲ WARNING'} · {alert.ruleCode}
                </strong>
                <span>
                  {statusSymbol(alert.state)} · ค่าปัจจุบัน {alert.value} / ฐาน {alert.threshold} ·
                  เข้าเงื่อนไข {alert.consecutiveHits} รอบ · {alert.channel ?? 'ทุก channel'} /{' '}
                  {alert.purpose ?? 'ทุก purpose'}
                </span>
                {alert.state === 'OPEN' ? (
                  <button
                    className="gov-secondary"
                    type="button"
                    onClick={() => void acknowledge(alert)}
                  >
                    รับทราบ
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {viewer === 'SUPERVISOR' ? (
        <section className="gov-panel">
          <h2>Compliance export</h2>
          <p>มุมมอง Supervisor เห็นเฉพาะสรุปของทีม และไม่มีสิทธิ์สั่ง export</p>
        </section>
      ) : (
        <section className="gov-panel">
          <h2>Compliance export</h2>
          <form className="cg5-export" onSubmit={submit}>
            <label>
              ชุดข้อมูล
              <select value={dataset} onChange={(event) => setDataset(event.target.value)}>
                <option value="DECISION_TRACE">Decision trace</option>
                <option value="AUDIT_LOG">Audit log</option>
                <option value="RESTRICTION_EVIDENCE">Restriction evidence</option>
                <option value="EXCEPTION_APPROVAL">Exception approval</option>
              </select>
            </label>
            <label>
              ตั้งแต่
              <input
                type="datetime-local"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                required
              />
            </label>
            <label>
              ถึง
              <input
                type="datetime-local"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                required
              />
            </label>
            <label>
              ระดับข้อมูล
              <select
                value={level}
                onChange={(event) => setLevel(event.target.value as Cg5EvidenceLevel)}
              >
                <option value="SUMMARY">SUMMARY</option>
                <option value="EVIDENCE">EVIDENCE</option>
              </select>
            </label>
            <label>
              เหตุผล
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
              />
            </label>
            {!reason.trim() ? <p role="status">ต้องระบุเหตุผลก่อนสั่ง export</p> : null}
            <p>
              เหตุผลนี้ถูกบันทึกลง audit
              {level === 'EVIDENCE'
                ? ' · EVIDENCE ต้องมีสิทธิ์เฉพาะและถูกนับในกฎเฝ้าระวังปริมาณ export'
                : ''}
            </p>
            <button className="gov-primary" disabled={submitting || !reason.trim()}>
              {submitting ? 'กำลังส่ง…' : 'สั่ง export'}
            </button>
          </form>
          {exportMessage ? <p role="status">{exportMessage}</p> : null}
          <ul className="cg5-exports">
            {exports.data?.map((job) => (
              <li key={job.exportId}>
                <strong>
                  {job.state} · {job.evidenceLevel}
                </strong>
                <span>
                  {job.datasets.join(', ')} ·{' '}
                  {job.manifestDigest
                    ? `digest …${job.manifestDigest.slice(-8)}`
                    : 'ยังไม่มี digest'}{' '}
                  · หมดอายุ {job.expiresAt ?? '—'} · ผู้สั่ง {job.requestedByRef}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
