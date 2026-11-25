import type { Formatters } from '@d-contact/i18n';

/**
 * server time for display in tables — the central formatter throws RangeError when it cannot parse (deliberately so code sees the problem)
 * but one malformed row must not break the whole page, so the raw value is shown instead
 */
export function serverTime(formatters: Pick<Formatters, 'dateTime'>, iso: string): string {
  try {
    return formatters.dateTime(iso);
  } catch {
    return iso;
  }
}
