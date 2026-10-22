import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      aria-label={t('language.switch')}
      onPress={() => void setLocale(locale === 'th' ? 'en' : 'th')}
    >
      {t('language.next')}
    </Button>
  );
}
