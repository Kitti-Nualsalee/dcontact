import { en, th } from './catalog';

type Options = Record<string, unknown>;

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** matches the catalog text of `key` in Thai, as a substring */
export const thRegExp = (key: string, options?: Options) =>
  new RegExp(escapeRegExp(th(key, options)));

/** regex source matching `key` in either language, for specs that run in both locales */
export const bothLocales = (key: string, options?: Options) =>
  `(?:${escapeRegExp(th(key, options))}|${escapeRegExp(en(key, options))})`;
