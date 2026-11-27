import {
  NO_DISPOSITION,
  listQuery,
  type HistoryChannel,
  type HistoryFilter,
  type SummaryPeriod,
} from './model.js';
import { isWorkTranscript, type WorkTranscript } from '../chat-history/transcript.js';

export type RecordedAtSource = 'SERVER_COMMIT' | 'LEGACY_EVENT' | 'LEGACY_FALLBACK';
export interface HistoryItem {
  interactionId: string;
  channel: HistoryChannel;
  startedAt: string;
  endedAt: string | null;
  disposition: string | null;
  recordedAt: string;
  recordedAtSource: RecordedAtSource;
  legacy: boolean;
}
export interface HistoryDetail {
  interactionId: string;
  disposition: string | null;
  note: string | null;
  recordedAt: string;
  recordedAtSource: RecordedAtSource;
  legacy: boolean;
}
/** #964 summary of an Agent's finished work — the numbers are counted by the same definition as the list */
export interface HistorySummary {
  period: { key: SummaryPeriod; from: string | null; to: string | null; timeZone: string };
  completed: number;
  talk: { averageSeconds: number | null; measuredCount: number };
  byDisposition: { disposition: string | null; count: number }[];
  /** #1044 the channels of this deployment; channel filters and wording appear only when there are two */
  channels?: string[];
}
export class HistoryApiError extends Error {
  constructor(readonly status: number) {
    super(`History request failed (${status})`);
  }
}
export interface AgentHistoryApi {
  list(
    cursor?: string,
    filter?: HistoryFilter,
  ): Promise<{ items: HistoryItem[]; nextCursor: string | null }>;
  /** `channel` narrows the numbers the same way it narrows the list */
  summary(period: SummaryPeriod, channel?: HistoryChannel): Promise<HistorySummary>;
  result(interactionId: string): Promise<HistoryDetail>;
  /** #1044: the conversation of a chat (a call answers an empty list); 404 = not found or not yours */
  transcript(interactionId: string): Promise<WorkTranscript>;
}

const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const instant = (value: unknown) => value === null || typeof value === 'string';

export function isHistorySummary(value: unknown): value is HistorySummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as HistorySummary;
  return (
    !!summary.period &&
    typeof summary.period.key === 'string' &&
    instant(summary.period.from) &&
    instant(summary.period.to) &&
    typeof summary.period.timeZone === 'string' &&
    count(summary.completed) &&
    !!summary.talk &&
    (summary.talk.averageSeconds === null || count(summary.talk.averageSeconds)) &&
    count(summary.talk.measuredCount) &&
    Array.isArray(summary.byDisposition) &&
    summary.byDisposition.every(
      (group) =>
        (group.disposition === null ||
          (typeof group.disposition === 'string' && group.disposition !== NO_DISPOSITION)) &&
        count(group.count),
    )
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createAgentHistoryApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): AgentHistoryApi {
  async function read(path: string) {
    const token = options.accessToken();
    if (!token) throw new HistoryApiError(401);
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/api/v1/workspace/agent/${path}`,
      {
        cache: 'no-store',
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok) throw new HistoryApiError(response.status);
    return response.json();
  }
  return {
    async list(cursor, filter) {
      return (await read(`history?${listQuery(filter, cursor)}`)) as {
        items: HistoryItem[];
        nextCursor: string | null;
      };
    },
    async summary(period, channel) {
      const query = new URLSearchParams({ period });
      if (channel) query.set('channel', channel);
      const summary: unknown = await read(`history/summary?${query.toString()}`);
      if (!isHistorySummary(summary)) throw new HistoryApiError(502);
      return summary;
    },
    async result(interactionId) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          interactionId,
        )
      )
        throw new HistoryApiError(404);
      return (await read(
        `interactions/${encodeURIComponent(interactionId)}/wrapup-result`,
      )) as HistoryDetail;
    },
    async transcript(interactionId) {
      if (!UUID.test(interactionId)) throw new HistoryApiError(404);
      const transcript: unknown = await read(
        `history/${encodeURIComponent(interactionId)}/transcript`,
      );
      if (!isWorkTranscript(transcript)) throw new HistoryApiError(502);
      return transcript;
    },
  };
}
