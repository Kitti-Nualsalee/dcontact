export interface QmContext {
  interaction: { id: string; channel: string; queueName: string };
  recording: {
    id: string;
    status: 'AVAILABLE' | 'DELETED';
    pauseIntervals: { startMs: number; endMs: number; reason: string }[];
  } | null;
  transcript: {
    id: string;
    language: string;
    segments: { id: string; speaker: string; startMs: number; endMs: number; text: string }[];
  } | null;
  evaluation: {
    id: string;
    status: 'DRAFT' | 'PUBLISHED';
    source: string;
    answers: { score?: number };
  } | null;
}

export interface ConsoleApi {
  context(contextId: string): Promise<QmContext>;
  playback(recordingId: string): Promise<{ url: string; expiresAt: string }>;
  publish(evaluationId: string, commandId: string): Promise<void>;
}

export function createConsoleApi(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): ConsoleApi {
  const request = input.fetch ?? globalThis.fetch;
  const call = async (path: string, init?: RequestInit) => {
    const token = input.accessToken();
    if (!token) throw new Error('authenticated access token is required');
    const response = await request(`${input.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!response.ok) throw new Error(`Console API failed with HTTP ${response.status}`);
    return response;
  };
  return {
    context: async (id) =>
      (await (
        await call(`/api/v1/qm/console-contexts/${encodeURIComponent(id)}`)
      ).json()) as QmContext,
    playback: async (id) =>
      (await (
        await call(`/api/v1/recordings/${encodeURIComponent(id)}/playback`, { method: 'POST' })
      ).json()) as { url: string; expiresAt: string },
    publish: async (id, commandId) => {
      await call(`/api/v1/qm/evaluations/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ commandId }),
      });
    },
  };
}
