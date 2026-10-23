import type common from './locales/th/common.json';

type Keys<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Keys<T[K]>}`;
}[keyof T & string];

/** model เก็บเพียง key; ข้อความจริงแปลใหม่ตอน render เสมอ */
export type MessageKey = Keys<typeof common>;
