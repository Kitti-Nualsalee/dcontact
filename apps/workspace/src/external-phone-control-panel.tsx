import { useEffect, useReducer } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { reduceExternalPhone } from './external-phone-control.js';

export function ExternalPhoneControlPanel({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation('dphone');
  const [phase, dispatch] = useReducer(reduceExternalPhone, 'DISCONNECTED');
  useEffect(() => {
    if (!enabled) dispatch('disconnect');
  }, [enabled]);

  return (
    <article className="aw-panel" aria-label={t('external.title')}>
      <div className="aw-panel-heading">
        <h2>{t('external.title')}</h2>
        <span className="aw-chip aw-chip-warning">{t('external.badge')}</span>
      </div>
      <p className="aw-copy">{t('external.description')}</p>
      <p role="status" aria-live="polite">
        {t(`external.phase.${phase}`)}
      </p>
      {!enabled ? <p className="aw-note">{t('external.paused')}</p> : null}
      <div className="aw-actions">
        <Button
          isDisabled={!enabled || phase !== 'DISCONNECTED'}
          onPress={() => dispatch('connect')}
        >
          {t('external.connect')}
        </Button>
        <Button
          isDisabled={!enabled || !['IDLE', 'ENDED'].includes(phase)}
          onPress={() => dispatch('incoming')}
        >
          {t('external.incoming')}
        </Button>
        <Button
          variant="primary"
          isDisabled={!enabled || phase !== 'RINGING'}
          onPress={() => dispatch('accept')}
        >
          {t('external.accept')}
        </Button>
        <Button
          isDisabled={!enabled || !['RINGING', 'ACTIVE'].includes(phase)}
          onPress={() => dispatch('hangup')}
        >
          {t('external.hangup')}
        </Button>
      </div>
    </article>
  );
}
