import i18next from 'i18next';
import previewEn from '../preview/locales/en/preview.json' with { type: 'json' };
import previewTh from '../preview/locales/th/preview.json' with { type: 'json' };

const i18n = i18next.createInstance();
void i18n.init({
  resources: { th: { preview: previewTh }, en: { preview: previewEn } },
  lng: 'th',
  fallbackLng: 'th',
  defaultNS: 'preview',
  interpolation: { escapeValue: false },
  initAsync: false,
});

/**
 * Expected text of the preview page itself (namespace `preview`, `preview/locales`), as opposed to the
 * component text in the `ui` namespace read by `./catalog`:
 *
 *   page.getByRole('button', { name: pth('dialog.open') })
 */
export const pth = i18n.getFixedT('th', 'preview');
export const pen = i18n.getFixedT('en', 'preview');

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches any of the given texts literally, e.g. the same label in both languages */
export function anyOf(...texts: string[]) {
  return new RegExp(texts.map(escapeRegExp).join('|'));
}
