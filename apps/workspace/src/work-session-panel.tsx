/**
 * E1.12 (#486): the "move here" screen of the work-session lease (E1.3 #459)
 *
 * - shows the current lease holder (surface + start time) and the reason this place stopped taking work
 * - moving must always be confirmed in a dialog first; the button is disabled while the holder has pending work (call/wrap-up) or a request is in flight
 * - a rejected takeover shows only the reason — nothing at the old place is cut (call and WS stay intact)
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
 * overlay when this place does not hold the lease (and has no call in hand) — view only
 * while checking/requesting the lease no overlay is drawn (the take-work button is already disabled) — so a tenant with the flag off sees nothing flicker
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
