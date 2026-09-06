export interface SupervisorSnapshot {
  sequence: number;
  agents: {
    id: string;
    displayName: string;
    extension: string | null;
    teamId: string | null;
    state: 'OFFLINE' | 'AVAILABLE' | 'RESERVED' | 'BUSY' | 'ACW' | 'BREAK';
  }[];
  queues: { id: string; name: string; teamId: string | null; isActive: boolean }[];
  interactions: { id: string; state: 'QUEUED' | 'ASSIGNED' | 'ACTIVE' | 'WRAPUP' }[];
  audit: unknown[];
}

export interface SupervisorWorkspaceApi {
  snapshot(): Promise<SupervisorSnapshot>;
  forceAgentState(input: {
    agentId: string;
    state: 'OFFLINE' | 'AVAILABLE' | 'BREAK';
    reason: string;
    commandId: string;
  }): Promise<void>;
  setQueueAvailability(input: {
    queueId: string;
    isActive: boolean;
    reason: string;
    commandId: string;
  }): Promise<void>;
}

export function createSupervisorWorkspaceApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): SupervisorWorkspaceApi {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const authorizedRequest = async (path: string, init?: RequestInit): Promise<Response> => {
    const accessToken = options.accessToken();
    if (!accessToken) throw new Error('authenticated access token is required');
    return request(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  };
  return {
    async snapshot() {
      const response = await authorizedRequest('/api/v1/workspace/supervisor/snapshot');
      if (!response.ok) throw new Error(`Supervisor snapshot failed with HTTP ${response.status}`);
      return (await response.json()) as SupervisorSnapshot;
    },
    async forceAgentState(input) {
      const response = await authorizedRequest(
        `/api/v1/workspace/supervisor/agents/${encodeURIComponent(input.agentId)}/state`,
        {
          method: 'PUT',
          body: JSON.stringify({
            state: input.state,
            reason: input.reason,
            commandId: input.commandId,
          }),
        },
      );
      if (!response.ok) throw new Error(`Agent state mutation failed with HTTP ${response.status}`);
    },
    async setQueueAvailability(input) {
      const response = await authorizedRequest(
        `/api/v1/workspace/supervisor/queues/${encodeURIComponent(input.queueId)}/availability`,
        {
          method: 'PUT',
          body: JSON.stringify({
            isActive: input.isActive,
            reason: input.reason,
            commandId: input.commandId,
          }),
        },
      );
      if (!response.ok) throw new Error(`Queue mutation failed with HTTP ${response.status}`);
    },
  };
}
