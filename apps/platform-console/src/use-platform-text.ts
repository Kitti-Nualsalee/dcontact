import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { errorMessageKey, type ActionHistoryItem } from './model.js';
import { describeHistory } from './presentation.js';

export function usePlatformText() {
  const { t } = useTranslation();
  const { formatters } = useLocale();
  return {
    t,
    formatTime: (iso: string | null | undefined) => (iso ? formatters.dateTime(iso) : '—'),
    errorMessage: (error: { code?: string | null; title?: unknown }) => t(errorMessageKey(error)),
    describeHistory: (item: ActionHistoryItem) => describeHistory(item, t),
  };
}
