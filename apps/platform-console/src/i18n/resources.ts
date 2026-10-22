import { uiResources } from '@d-contact/ui-react/i18n';
import commonTh from './locales/th/common.json' with { type: 'json' };
import commonEn from './locales/en/common.json' with { type: 'json' };

export const DEFAULT_NAMESPACE = 'common';
export const resources = {
  th: { common: commonTh, ...uiResources.th },
  en: { common: commonEn, ...uiResources.en },
} as const;
