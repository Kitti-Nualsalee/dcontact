export type RecordedAtSource = 'SERVER_COMMIT' | 'LEGACY_EVENT' | 'LEGACY_FALLBACK';
export interface HistoryItem {
  interactionId: string;
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
export class HistoryApiError extends Error {
  constructor(readonly status: number) {
    super(`History request failed (${status})`);
  }
}
export interface AgentHistoryApi {
  list(cursor?: string): Promise<{ items: HistoryItem[]; nextCursor: string | null }>;
  result(interactionId: string): Promise<HistoryDetail>;
}
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
    async list(cursor) {
      const query = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
      return (await read(`history?${query}`)) as {
        items: HistoryItem[];
        nextCursor: string | null;
      };
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
  };
}
