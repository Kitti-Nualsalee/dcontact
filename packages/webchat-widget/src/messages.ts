import en from './locales/en/widget.json';
import th from './locales/th/widget.json';

export type WidgetLocale = 'th' | 'en';

const catalogs: Record<WidgetLocale, unknown> = { th, en };

/** Thai unless the browser asks for English first; the widget has only these two languages. */
export function pickLocale(languages: readonly string[]): WidgetLocale {
  const first = languages.find((language) => /^(th|en)\b/i.test(language));
  return first?.toLowerCase().startsWith('en') ? 'en' : 'th';
}

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export function translator(locale: WidgetLocale): Translate {
  return (key, values = {}) => {
    let node: unknown = catalogs[locale];
    for (const part of key.split('.'))
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    if (typeof node !== 'string') return key;
    return node.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ''));
  };
}
