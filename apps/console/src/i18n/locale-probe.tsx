import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { SUPPORTED_LOCALES } from '@d-contact/i18n';

/**
 * D1.11 (#450): a test page for the e2e harness only (`?view=i18n` in mode `e2e`) — proves that switching language
 * does not reload and the formatters follow the language; the real language switcher is in the shell top bar (D1.13)
 */
const SAMPLE_INSTANT = '2026-09-12T09:40:00Z';

export function LocaleProbe() {
  const { t } = useTranslation();
  const { locale, timeZone, formatters, setLocale } = useLocale();
  return (
    <main className="empty">
      <h1>{t('app.name')}</h1>
      <p data-testid="language-label">{t('language.label')}</p>
      <div role="group" aria-label={t('language.label')}>
        {SUPPORTED_LOCALES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={locale === option}
            onClick={() => void setLocale(option)}
          >
            {t(`language.${option}`)}
          </button>
        ))}
      </div>
      <p data-testid="sample-date">{formatters.dateTime(SAMPLE_INSTANT)}</p>
      <p data-testid="time-zone">{timeZone}</p>
    </main>
  );
}
