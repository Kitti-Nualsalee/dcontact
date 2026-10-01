/**
 * #566 (R2): หน้า "LINE inbound (pilot)" — read-only, tenant pilot, role admin (server ตัดสิน)
 *
 * แสดงเวลา ชนิด ข้อความ fingerprint ผู้ส่ง และสถานะ; ไม่มี LINE ID ดิบ
 * #567: เมื่อ team trial เปิด (route `/trial` ตอบได้) แสดงช่องตอบกลับต่อรายการและปุ่ม kill
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { useShellTokens } from '../shell/tokens.js';
import './line-inbound.css';
import {
  LineInboundApiError,
  type LineInboundApi,
  type LineInboundItem,
  type LineTrialStatus,
} from './api.js';

const TEXT_MAX = 500;

function newKey(): string {
  return `reply-${crypto.randomUUID()}`;
}

/**
 * #567 (T1/T2): ตอบกลับหนึ่งรายการ — text ≤500 ตัวอักษร; key เดิมตลอด intent เดียว (retry หลัง error ไม่ส่งซ้ำ)
 * key ใหม่หลังส่งสำเร็จเท่านั้น
 */
function ReplyForm({
  api,
  item,
  onSent,
}: {
  api: LineInboundApi;
  item: LineInboundItem;
  onSent: () => void;
}) {
  const { t } = useTranslation('integrations');
  const [text, setText] = useState('');
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const length = [...text.trim()].length;
  const submit = async () => {
    setBusy(true);
    try {
      const outcome = await api.reply(item.id, text, key);
      if (outcome.status === 'FAILED') {
        setResult(
          t(`lineInbound.reply.errors.${outcome.code}`, {
            defaultValue: t('lineInbound.reply.errors.UNKNOWN'),
          }),
        );
      } else {
        setResult(t(`lineInbound.reply.${outcome.status === 'SENT' ? 'sent' : 'pending'}`));
        setText('');
        setKey(newKey());
        onSent();
      }
    } catch {
      setResult(t('lineInbound.reply.errors.UNKNOWN'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="line-inbound-reply"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        <span>{t('lineInbound.reply.label')}</span>
        <textarea
          value={text}
          rows={2}
          onChange={(event) => {
            setText(event.target.value);
            setResult(null);
          }}
        />
      </label>
      <span className="line-inbound-count">
        {t('lineInbound.reply.count', { count: length, max: TEXT_MAX })}
      </span>
      <button type="submit" disabled={busy || length < 1 || length > TEXT_MAX}>
        {t('lineInbound.reply.send')}
      </button>
      {result ? <span role="status">{result}</span> : null}
    </form>
  );
}

/** #567 (T5): สถานะ trial + ปุ่ม kill — ยก kill ทำในหน้านี้ไม่ได้ */
function TrialPanel({
  api,
  trial,
  onChanged,
}: {
  api: LineInboundApi;
  trial: LineTrialStatus;
  onChanged: () => void;
}) {
  const { t } = useTranslation('integrations');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section className="line-inbound-trial" aria-label={t('lineInbound.trial.title')}>
      <h2>{t('lineInbound.trial.title')}</h2>
      {trial.killed ? (
        <p role="alert">{t('lineInbound.trial.killed')}</p>
      ) : trial.active ? (
        <p>
          {t('lineInbound.trial.active', {
            expiresAt: trial.expiresAt ? new Date(trial.expiresAt).toLocaleString() : '—',
            used: trial.last24h,
            perDay: trial.per24h ?? '—',
            perRecipient: trial.perRecipientPer24h ?? '—',
          })}
        </p>
      ) : (
        <p>{t('lineInbound.trial.inactive')}</p>
      )}
      {trial.killed ? null : confirming ? (
        <span>
          {t('lineInbound.trial.confirmKill')}{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api
                .kill()
                .catch(() => undefined)
                .finally(() => {
                  setBusy(false);
                  setConfirming(false);
                  onChanged();
                });
            }}
          >
            {t('lineInbound.trial.killNow')}
          </button>{' '}
          <button type="button" onClick={() => setConfirming(false)}>
            {t('lineInbound.trial.cancel')}
          </button>
        </span>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>
          {t('lineInbound.trial.kill')}
        </button>
      )}
    </section>
  );
}

type Status = 'loading' | 'ready' | 'unavailable' | 'forbidden' | 'expired' | 'error';

export function LineInbound({ api }: { api: LineInboundApi }) {
  const { t } = useTranslation('integrations');
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<LineInboundItem[]>([]);
  const [quarantined, setQuarantined] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trial, setTrial] = useState<LineTrialStatus | null>(null);

  const loadTrial = useCallback(() => {
    void api
      .trialStatus()
      .then(setTrial)
      .catch(() => setTrial(null));
  }, [api]);

  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      try {
        const page = await api.list(before ? { before } : {});
        setItems((current) => (before ? [...current, ...page.items] : page.items));
        setQuarantined(page.quarantined);
        setCursor(page.nextCursor);
        setStatus('ready');
      } catch (error) {
        const code = error instanceof LineInboundApiError ? error.status : 0;
        setStatus(
          code === 404
            ? 'unavailable'
            : code === 403
              ? 'forbidden'
              : code === 401
                ? 'expired'
                : 'error',
        );
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
    loadTrial();
  }, [load, loadTrial]);

  const canReply = Boolean(trial?.active && !trial.killed);
  // token ของ D1 โหลดแบบ dynamic (เหมือนหน้า dphone embedding) — render หลังพร้อมเพื่อไม่ให้เห็นหน้าไม่มีสี
  const tokensReady = useShellTokens();
  if (!tokensReady) return null;

  if (status !== 'ready') {
    return (
      <main className="line-inbound">
        <h1>{t('lineInbound.title')}</h1>
        <p role="status">{t(`lineInbound.status.${status}`)}</p>
        {status === 'error' ? (
          <button type="button" onClick={() => void load()} disabled={busy}>
            {t('lineInbound.refresh')}
          </button>
        ) : null}
      </main>
    );
  }
  return (
    <main className="line-inbound">
      <p className="eyebrow">{t('lineInbound.eyebrow')}</p>
      <h1>{t('lineInbound.title')}</h1>
      <p>{t('lineInbound.description')}</p>
      {trial ? <TrialPanel api={api} trial={trial} onChanged={loadTrial} /> : null}
      <div className="line-inbound-actions">
        <button type="button" onClick={() => void load()} disabled={busy}>
          {t('lineInbound.refresh')}
        </button>
        {quarantined > 0 ? (
          <span role="note">{t('lineInbound.quarantined', { count: quarantined })}</span>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p role="status">{t('lineInbound.empty')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{t('lineInbound.columns.receivedAt')}</th>
              <th scope="col">{t('lineInbound.columns.type')}</th>
              <th scope="col">{t('lineInbound.columns.text')}</th>
              <th scope="col">{t('lineInbound.columns.sender')}</th>
              <th scope="col">{t('lineInbound.columns.state')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <time dateTime={item.receivedAt}>
                    {new Date(item.receivedAt).toLocaleString()}
                  </time>
                </td>
                <td>{item.messageType ?? item.eventType}</td>
                <td>
                  {item.text ?? t('lineInbound.noText')}
                  {canReply && item.eventType === 'message' ? (
                    <ReplyForm api={api} item={item} onSent={loadTrial} />
                  ) : null}
                </td>
                <td>
                  <code>{item.senderFingerprint ?? '—'}</code>
                </td>
                <td>{item.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor ? (
        <button type="button" onClick={() => void load(cursor)} disabled={busy}>
          {t('lineInbound.loadMore')}
        </button>
      ) : null}
    </main>
  );
}

/**
 * ลิงก์ไปหน้า inbound — แสดงเฉพาะเมื่อ route ตอบได้และบัญชีนี้มีสิทธิ์ (ไม่มี overlay = 404 = ไม่แสดงอะไร)
 * probe ล้มด้วยเหตุอื่นก็ไม่แสดง: ไม่อ้างว่ามี LINE pilot ถ้ายืนยันไม่ได้
 */
export function LineInboundLink({ api, href }: { api: LineInboundApi; href: string }) {
  const { t } = useTranslation('integrations');
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api
      .availability()
      .then((availability) => {
        if (!cancelled) setVisible(availability === 'AVAILABLE');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);
  if (!visible) return null;
  return (
    <p className="line-inbound-link">
      <a href={href}>{t('lineInbound.openLink')}</a>
    </p>
  );
}
