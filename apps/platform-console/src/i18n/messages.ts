import type common from './locales/th/common.json';

type Keys<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Keys<T[K]>}`;
}[keyof T & string];

/** the model keeps only keys; the real text is always translated again at render time */
export type MessageKey = Keys<typeof common>;
