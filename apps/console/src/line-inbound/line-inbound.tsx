/**
 * #566 (R2): หน้า "LINE inbound (pilot)" — read-only, tenant pilot, role admin (server ตัดสิน)
 *
 * แสดงเวลา ชนิด ข้อความ fingerprint ผู้ส่ง และสถานะ; ไม่มีการตอบกลับ และไม่มี LINE ID ดิบ
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { LineInboundApiError, type LineInboundApi, type LineInboundItem } from './api.js';

type Status = 'loading' | 'ready' | 'unavailable' | 'forbidden' | 'expired' | 'error';

export function LineInbound({ api }: { api: LineInboundApi }) {
  const { t } = useTranslation('integrations');
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<LineInboundItem[]>([]);
  const [quarantined, setQuarantined] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  }, [load]);

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
                <td>{item.text ?? t('lineInbound.noText')}</td>
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
