export interface AgentWorkspaceSnapshot {
  agent: {
    id: string;
    displayName: string;
    extension: string | null;
    state: 'OFFLINE' | 'AVAILABLE' | 'RESERVED' | 'BUSY' | 'ACW' | 'BREAK';
  };
  interaction: {
    id: string;
    state: 'ASSIGNED' | 'ACTIVE' | 'WRAPUP';
    version: string;
    caller: string | null;
    queue: { id: string; name: string } | null;
    offerExpiresAt: string | null;
    answeredAt: string | null;
    endedAt: string | null;
  } | null;
}

export interface AgentWorkspaceApi {
  snapshot(): Promise<AgentWorkspaceSnapshot>;
}

export interface AgentWorkspaceApiOptions {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}

export function createAgentWorkspaceApi(options: AgentWorkspaceApiOptions): AgentWorkspaceApi {
  const request = options.fetch ?? globalThis.fetch;
  return {
    async snapshot() {
      const accessToken = options.accessToken();
      if (!accessToken) throw new Error('authenticated access token is required');
      const response = await request(
        `${options.baseUrl.replace(/\/$/, '')}/api/v1/workspace/agent/snapshot`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (!response.ok) throw new Error(`Agent snapshot failed with HTTP ${response.status}`);
      return (await response.json()) as AgentWorkspaceSnapshot;
    },
  };
}
