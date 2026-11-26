import type { PlaybackFormat } from './model.js';

export interface RecordingItem {
  recordingId: string;
  interactionId: string;
  status: 'READY' | 'ARCHIVING';
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  channelLayout: string;
  queueName: string | null;
  agentName: string | null;
  capabilities: { play: boolean };
}

export interface PlaybackSession {
  sessionId: string;
  expiresAt: string;
  format: PlaybackFormat;
}

export class RecordingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`Recording request failed (${status})`);
  }
}

export interface TeamRecordingsApi {
  history(input: {
    from: string;
    to: string;
    cursor?: string;
  }): Promise<{ items: RecordingItem[]; nextCursor: string | null }>;
  open(recordingId: string): Promise<PlaybackSession>;
  /** a short WAV that can play on its own; permission is re-checked on every request */
  chunk(
    recordingId: string,
    sessionId: string,
    startFrame: number,
    frameCount: number,
  ): Promise<ArrayBuffer>;
  close(recordingId: string, sessionId: string): Promise<void>;
}

export function createTeamRecordingsApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): TeamRecordingsApi {
  const root = `${options.baseUrl.replace(/\/$/, '')}/api/v1/recordings`;
  // the token is in the header only, never in the audio URL
  async function call(path: string, body?: unknown): Promise<Response> {
    const token = options.accessToken();
    if (!token) throw new RecordingApiError(401);
    const response = await fetch(`${root}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => undefined)) as
        { code?: unknown } | undefined;
      throw new RecordingApiError(
        response.status,
        typeof failure?.code === 'string' ? failure.code : undefined,
      );
    }
    return response;
  }
  const id = (value: string) => encodeURIComponent(value);
  return {
    async history({ from, to, cursor }) {
      const query = new URLSearchParams({ from, to, ...(cursor ? { cursor } : {}) });
      return (await (await call(`/history?${query.toString()}`)).json()) as {
        items: RecordingItem[];
        nextCursor: string | null;
      };
    },
    async open(recordingId) {
      return (await (
        await call(`/${id(recordingId)}/playback-sessions`, {})
      ).json()) as PlaybackSession;
    },
    async chunk(recordingId, sessionId, startFrame, frameCount) {
      const response = await call(`/${id(recordingId)}/playback-sessions/${id(sessionId)}/chunks`, {
        startFrame,
        frameCount,
      });
      return response.arrayBuffer();
    },
    async close(recordingId, sessionId) {
      await call(`/${id(recordingId)}/playback-sessions/${id(sessionId)}/close`, {});
    },
  };
}
