import {
  NO_DISPOSITION,
  listQuery,
  type HistoryChannel,
  type HistoryFilter,
  type SummaryPeriod,
} from '../agent-history/model.js';
import { isWorkTranscript, type WorkTranscript } from '../chat-history/transcript.js';
import type { RecordedAtSource } from '../agent-history/api.js';

/** #986 team work history and summary — the API checks permission and team scope itself on every request */
export interface TeamRef {
  id: string;
  name: string | null;
}
export interface AgentRef {
  id: string;
  displayName: string | null;
}
export interface TeamOption {
  id: string;
  name: string;
  isActive: boolean;
}
export interface TeamHistoryItem {
  interactionId: string;
  channel: HistoryChannel;
  agent: AgentRef;
  team: TeamRef;
  startedAt: string;
  endedAt: string | null;
  talkSeconds: number | null;
  disposition: string | null;
  recordedAt: string;
  recordedAtSource: RecordedAtSource;
  legacy: boolean;
}
export interface TeamHistoryDetail {
  interactionId: string;
  channel: HistoryChannel;
  agent: AgentRef;
  team: TeamRef;
  startedAt: string;
  endedAt: string | null;
  talkSeconds: number | null;
  disposition: string | null;
  note: string | null;
  recordedAt: string;
  recordedAtSource: RecordedAtSource;
  legacy: boolean;
}
export interface TalkSummary {
  averageSeconds: number | null;
  measuredCount: number;
}
export interface TeamHistorySummary {
  teamId: string | null;
  period: { key: SummaryPeriod; from: string | null; to: string | null; timeZone: string };
  completed: number;
  talk: TalkSummary;
  byDisposition: { disposition: string | null; count: number }[];
  byAgent: { agent: AgentRef; completed: number; talk: TalkSummary }[];
}
export class TeamHistoryApiError extends Error {
  constructor(readonly status: number) {
    super(`Team history request failed (${status})`);
  }
}
export interface TeamHistoryFilter extends HistoryFilter {
  teamId?: string;
  agentId?: string;
}
export interface TeamHistoryApi {
  teams(): Promise<{ allTeams: boolean; items: TeamOption[] }>;
  list(
    cursor?: string,
    filter?: TeamHistoryFilter,
  ): Promise<{ teamId: string | null; items: TeamHistoryItem[]; nextCursor: string | null }>;
  summary(period: SummaryPeriod, teamId?: string): Promise<TeamHistorySummary>;
  item(interactionId: string): Promise<TeamHistoryDetail>;
  /** #1044: the conversation of a chat (a call answers an empty list); 404 = not found or not in scope */
  transcript(interactionId: string): Promise<WorkTranscript>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const instant = (value: unknown) => value === null || typeof value === 'string';
const talk = (value: unknown) => {
  const summary = value as TalkSummary | undefined;
  return (
    !!summary &&
    (summary.averageSeconds === null || count(summary.averageSeconds)) &&
    count(summary.measuredCount)
  );
};

export function isTeamHistorySummary(value: unknown): value is TeamHistorySummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as TeamHistorySummary;
  return (
    (summary.teamId === null || typeof summary.teamId === 'string') &&
    !!summary.period &&
    typeof summary.period.key === 'string' &&
    instant(summary.period.from) &&
    instant(summary.period.to) &&
    typeof summary.period.timeZone === 'string' &&
    count(summary.completed) &&
    talk(summary.talk) &&
    Array.isArray(summary.byDisposition) &&
    summary.byDisposition.every(
      (group) =>
        (group.disposition === null ||
          (typeof group.disposition === 'string' && group.disposition !== NO_DISPOSITION)) &&
        count(group.count),
    ) &&
    Array.isArray(summary.byAgent) &&
    summary.byAgent.every(
      (row) =>
        !!row.agent &&
        typeof row.agent.id === 'string' &&
        (row.agent.displayName === null || typeof row.agent.displayName === 'string') &&
        count(row.completed) &&
        talk(row.talk),
    )
  );
}

/** list query: the same filters as "My work" + team and Agent */
export function teamListQuery(filter: TeamHistoryFilter | undefined, cursor?: string): string {
  const query = new URLSearchParams(listQuery(filter, cursor));
  if (filter?.teamId) query.set('teamId', filter.teamId);
  if (filter?.agentId) query.set('agentId', filter.agentId);
  return query.toString();
}

export function createTeamHistoryApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): TeamHistoryApi {
  async function read(path: string) {
    const token = options.accessToken();
    if (!token) throw new TeamHistoryApiError(401);
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/api/v1/team-history/${path}`,
      {
        cache: 'no-store',
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok) throw new TeamHistoryApiError(response.status);
    return response.json();
  }
  return {
    async teams() {
      return (await read('teams')) as { allTeams: boolean; items: TeamOption[] };
    },
    async list(cursor, filter) {
      return (await read(`items?${teamListQuery(filter, cursor)}`)) as {
        teamId: string | null;
        items: TeamHistoryItem[];
        nextCursor: string | null;
      };
    },
    async summary(period, teamId) {
      const query = new URLSearchParams({ period });
      if (teamId) query.set('teamId', teamId);
      const summary: unknown = await read(`summary?${query.toString()}`);
      if (!isTeamHistorySummary(summary)) throw new TeamHistoryApiError(502);
      return summary;
    },
    async item(interactionId) {
      if (!UUID.test(interactionId)) throw new TeamHistoryApiError(404);
      return (await read(`items/${encodeURIComponent(interactionId)}`)) as TeamHistoryDetail;
    },
    async transcript(interactionId) {
      if (!UUID.test(interactionId)) throw new TeamHistoryApiError(404);
      const transcript: unknown = await read(
        `items/${encodeURIComponent(interactionId)}/transcript`,
      );
      if (!isWorkTranscript(transcript)) throw new TeamHistoryApiError(502);
      return transcript;
    },
  };
}
