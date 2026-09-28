/**
 * E1.12 (#486): หน้าจอ "ย้ายมาที่นี่" ของ work-session lease (E1.3 #459)
 *
 * - แสดงผู้ถือ lease ปัจจุบัน (surface + เวลาเริ่ม) และเหตุที่ที่นี่หยุดรับงาน
 * - ย้ายต้องยืนยันใน dialog ก่อนเสมอ; ปุ่มปิดระหว่างผู้ถือมีงานค้าง (สาย/wrap-up) หรือคำขอกำลังส่ง
 * - takeover ที่ถูกปฏิเสธแสดงเหตุผลเท่านั้น — ไม่มีอะไรของที่เดิมถูกตัด (สายและ WS อยู่ครบ)
 */
import { useState } from 'react';
import { useFormatters, useTranslation } from '@d-contact/i18n/react';
import { Button, Dialog } from '@d-contact/ui-react';
import type { WorkSessionHolder, WorkSessionState } from './work-session.js';

export interface WorkSessionPanelProps {
  state: WorkSessionState;
  onAcquire(): void;
  onTakeover(): void;
  onRefresh(): void;
}

function HolderFacts({ holder }: { holder: WorkSessionHolder }) {
  const { t } = useTranslation('workspace');
  const format = useFormatters();
  let startedAt: string;
  try {
    startedAt = format.dateTime(holder.acquiredAt);
  } catch {
    startedAt = t('lease.unknownTime');
  }
  return (
    <dl className="aw-facts" aria-label={t('lease.holderLabel')}>
      <div>
        <dt>{t('lease.holderSurface')}</dt>
        <dd>
          {holder.surface === 'embedded'
            ? t('lease.surface.embedded', { origin: holder.hostOrigin ?? '' })
            : t(`lease.surface.${holder.surface}`)}
        </dd>
      </div>
      <div>
        <dt>{t('lease.holderSince')}</dt>
        <dd>{startedAt}</dd>
      </div>
    </dl>
  );
}

/**
 * overlay เมื่อที่นี่ไม่ได้ถือ lease (และไม่มีสายในมือ) — ดูได้อย่างเดียว
 * ระหว่างตรวจ/ขอ lease ไม่วาด overlay (ปุ่มรับงานปิดอยู่แล้ว) — tenant ที่ปิด flag จึงไม่เห็นอะไรกระพริบ
 */
export function WorkSessionPanel({
  state,
  onAcquire,
  onTakeover,
  onRefresh,
}: WorkSessionPanelProps) {
  const { t } = useTranslation('workspace');
  const [confirming, setConfirming] = useState(false);

  if (state.phase === 'error') {
    return (
      <div className="aw-passive-overlay">
        <section className="aw-passive-card" aria-labelledby="lease-title">
          <p className="aw-eyebrow">{t('lease.eyebrow')}</p>
          <h2 id="lease-title">{t('lease.errorTitle')}</h2>
          {state.loss ? <p role="alert">{t(`lease.loss.${state.loss}`)}</p> : null}
          <p role="status">{t('lease.errorBody')}</p>
          <Button onPress={onRefresh}>{t('lease.refresh')}</Button>
        </section>
      </div>
    );
  }

  if (state.phase !== 'standby' && state.phase !== 'takingOver') return null;

  const holder = state.holder;
  const pending = state.phase === 'takingOver';
  const busy = Boolean(holder?.busy);
  const rejection = state.phase === 'standby' ? state.rejection : undefined;

  return (
    <div className="aw-passive-overlay">
      <section className="aw-passive-card" aria-labelledby="lease-title">
        <p className="aw-eyebrow">{t('lease.eyebrow')}</p>
        <h2 id="lease-title">{holder ? t('lease.heldTitle') : t('lease.freeTitle')}</h2>
        {state.loss ? (
          <p role="alert" className="aw-error">
            {t(`lease.loss.${state.loss}`)}
          </p>
        ) : null}
        <p>{holder ? t('lease.heldBody') : t('lease.freeBody')}</p>
        {holder ? <HolderFacts holder={holder} /> : null}
        {busy ? (
          <p className="aw-note" role="status">
            {t('lease.busy')}
          </p>
        ) : null}
        {rejection ? (
          <p className="aw-error" role="alert">
            {t(`lease.rejected.${rejection}`)}
          </p>
        ) : null}
        <div className="aw-actions">
          {holder ? (
            <Button
              variant="primary"
              isDisabled={busy || pending}
              onPress={() => setConfirming(true)}
            >
              {pending ? t('lease.moving') : t('lease.move')}
            </Button>
          ) : (
            <Button variant="primary" onPress={onAcquire}>
              {t('lease.start')}
            </Button>
          )}
          <Button variant="ghost" isDisabled={pending} onPress={onRefresh}>
            {t('lease.refresh')}
          </Button>
        </div>
      </section>

      <Dialog
        role="alertdialog"
        title={t('lease.confirmTitle')}
        isOpen={confirming && Boolean(holder)}
        onOpenChange={setConfirming}
        footer={(close) => (
          <>
            <Button variant="ghost" onPress={close}>
              {t('lease.cancel')}
            </Button>
            <Button
              variant="primary"
              isDisabled={busy || pending}
              onPress={() => {
                close();
                onTakeover();
              }}
            >
              {t('lease.confirm')}
            </Button>
          </>
        )}
      >
        <p>{t('lease.confirmBody')}</p>
        {holder ? <HolderFacts holder={holder} /> : null}
      </Dialog>
    </div>
  );
}
