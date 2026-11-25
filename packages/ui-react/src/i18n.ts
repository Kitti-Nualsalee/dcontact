/**
 * D1.10 (#449): the component's own messages (close button, placeholder) live in the `ui` namespace
 * apps merge `uiResources` into their own resources (D1.11) — components read through the app's i18n instance
 *
 * does not declare `CustomTypeOptions` here because the app owns that declaration (declaring it twice would clash)
 * so the key type is pinned with `UiKey`, computed from the Thai catalog instead
 */
import { useTranslation } from 'react-i18next';
import uiEn from './locales/en/ui.json' with { type: 'json' };
import uiTh from './locales/th/ui.json' with { type: 'json' };

export const UI_NAMESPACE = 'ui';

export const uiResources = { th: { ui: uiTh }, en: { ui: uiEn } } as const;

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type UiKey = Leaves<typeof uiTh>;

export type UiText = (key: UiKey, values?: Record<string, string | number>) => string;

export function useUiText(): UiText {
  const { i18n } = useTranslation();
  // namespace is fixed — the language follows the app's i18n without remounting
  const t = i18n.getFixedT(null, UI_NAMESPACE) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  return (key, values) => t(key, values);
}
