/**
 * D1.11 (#450): formatter กลางของวันที่ เวลา และตัวเลข — ห้ามจัดรูปแบบใน message catalog
 *
 * - `th` → ปฏิทินพุทธ (พ.ศ.) เดือนย่อไทย เลขอารบิก: `12 ก.ย. 2569 16:40`
 * - `en` → en-GB ปี ค.ศ.: `12 Sep 2026 16:40`
 * - 24 ชั่วโมงทั้งสองภาษา และแสดงตาม timezone ที่ส่งเข้ามาเสมอ (ไม่ใช้เวลาเครื่อง)
 * - relative time ("5 นาทีที่ผ่านมา") ใช้เฉพาะเหตุการณ์ที่ห่างจากตอนนี้ไม่เกิน 24 ชั่วโมง
 *
 * วันที่ประกอบจาก `formatToParts` แทนการใช้ string ของ `Intl` ตรง ๆ เพราะรูปแบบของ ICU เปลี่ยนตาม
 * เวอร์ชันของ browser/Node (เช่น en-GB ใส่ `,` หลังปี และ ICU รุ่นใหม่ย่อ September เป็น `Sept`)
 * ถ้าไม่ยึดรูปเอง หน้าจอสองเครื่องจะแสดงวันที่เดียวกันไม่เหมือนกัน
 */
import type { SupportedLocale } from './locale.js';

const INTL_LOCALE: Record<SupportedLocale, string> = {
  th: 'th-TH-u-ca-buddhist-nu-latn',
  en: 'en-GB',
};

const RELATIVE_LIMIT_MS = 24 * 60 * 60 * 1000;

export type DateInput = Date | string | number;

export interface FormatterOptions {
  locale: SupportedLocale;
  timeZone: string;
  /** แทนนาฬิกาใน test */
  now?: () => Date;
}

export interface Formatters {
  readonly locale: SupportedLocale;
  readonly timeZone: string;
  /** `12 ก.ย. 2569 16:40` / `12 Sep 2026 16:40` */
  dateTime(value: DateInput): string;
  /** `12 ก.ย. 2569` / `12 Sep 2026` */
  date(value: DateInput): string;
  /** `16:40` */
  time(value: DateInput): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** ภายใน 24 ชั่วโมง → `5 นาทีที่ผ่านมา`; เกินกว่านั้น → เหมือน `dateTime` */
  relative(value: DateInput): string;
}

function toDate(value: DateInput): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`invalid date: ${String(value)}`);
  return date;
}

export function createFormatters(options: FormatterOptions): Formatters {
  const { locale, timeZone } = options;
  const now = options.now ?? (() => new Date());
  const intlLocale = INTL_LOCALE[locale];
  const dateParts = new Intl.DateTimeFormat(intlLocale, {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const relativeFormat = new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto' });

  const parts = (value: DateInput) => {
    const byType = new Map(dateParts.formatToParts(toDate(value)).map((p) => [p.type, p.value]));
    const month = byType.get('month') ?? '';
    return {
      day: byType.get('day') ?? '',
      month: locale === 'en' && month === 'Sept' ? 'Sep' : month,
      year: byType.get('year') ?? '',
      time: `${byType.get('hour')}:${byType.get('minute')}`,
    };
  };

  const date = (value: DateInput) => {
    const p = parts(value);
    return `${p.day} ${p.month} ${p.year}`;
  };
  const time = (value: DateInput) => parts(value).time;
  const dateTime = (value: DateInput) => {
    const p = parts(value);
    return `${p.day} ${p.month} ${p.year} ${p.time}`;
  };

  return {
    locale,
    timeZone,
    dateTime,
    date,
    time,
    number: (value, numberOptions) =>
      new Intl.NumberFormat(intlLocale, numberOptions).format(value),
    relative(value) {
      const diffMs = toDate(value).getTime() - now().getTime();
      const distance = Math.abs(diffMs);
      if (distance > RELATIVE_LIMIT_MS) return dateTime(value);
      if (distance < 60_000) return relativeFormat.format(Math.round(diffMs / 1000), 'second');
      if (distance < 3_600_000) return relativeFormat.format(Math.round(diffMs / 60_000), 'minute');
      return relativeFormat.format(Math.round(diffMs / 3_600_000), 'hour');
    },
  };
}
