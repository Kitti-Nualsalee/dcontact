/** #964 filter state of the "My work history" page — separated from the UI so it can be unit tested */
export const SUMMARY_PERIODS = ['today', '7d', '30d', 'all'] as const;
export type SummaryPeriod = (typeof SUMMARY_PERIODS)[number];
export const DEFAULT_PERIOD: SummaryPeriod = '7d';
/** value in the URL/API for work with no disposition */
export const NO_DISPOSITION = '__none__';

/** #1044: the channel of a closed work item; no filter = every channel */
export const HISTORY_CHANNELS = ['VOICE', 'WEBCHAT'] as const;
export type HistoryChannel = (typeof HISTORY_CHANNELS)[number];

export function channelFrom(value: string | null): HistoryChannel | undefined {
  return (HISTORY_CHANNELS as readonly string[]).includes(value ?? '')
    ? (value as HistoryChannel)
    : undefined;
}

export interface HistoryFilter {
  from: string | null;
  to: string | null;
  /** undefined = every channel */
  channel?: HistoryChannel;
  /** undefined = every disposition, null = no disposition */
  disposition?: string | null;
}

export function periodFrom(value: string | null): SummaryPeriod {
  return (SUMMARY_PERIODS as readonly string[]).includes(value ?? '')
    ? (value as SummaryPeriod)
    : DEFAULT_PERIOD;
}

export function dispositionFrom(value: string | null): string | null | undefined {
  if (value === null || value === '' || value.length > 256) return undefined;
  return value === NO_DISPOSITION ? null : value;
}

export function dispositionParam(value: string | null | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ?? NO_DISPOSITION;
}

export function listQuery(filter: HistoryFilter | undefined, cursor?: string): string {
  const query = new URLSearchParams({ limit: '20' });
  if (filter?.from) query.set('from', filter.from);
  if (filter?.to) query.set('to', filter.to);
  const disposition = dispositionParam(filter?.disposition);
  if (disposition !== undefined) query.set('disposition', disposition);
  if (filter?.channel) query.set('channel', filter.channel);
  if (cursor) query.set('cursor', cursor);
  return query.toString();
}

/** write the filters into the current URL while keeping other parameters (view, tenant) */
export function filterHref(
  href: string,
  period: SummaryPeriod,
  disposition: string | null | undefined,
  channel?: HistoryChannel,
): string {
  const url = new URL(href);
  if (channel) url.searchParams.set('channel', channel);
  else url.searchParams.delete('channel');
  if (period === DEFAULT_PERIOD) url.searchParams.delete('period');
  else url.searchParams.set('period', period);
  const value = dispositionParam(disposition);
  if (value === undefined) url.searchParams.delete('disposition');
  else url.searchParams.set('disposition', value);
  return url.toString();
}

/** seconds → m:ss or h:mm:ss */
export function formatTalk(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function dispositionCount(
  groups: readonly { disposition: string | null; count: number }[],
  completed: number,
  disposition: string | null | undefined,
): number {
  if (disposition === undefined) return completed;
  return groups.find((group) => group.disposition === disposition)?.count ?? 0;
}
