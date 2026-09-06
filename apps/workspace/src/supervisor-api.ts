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
}

export function createSupervisorWorkspaceApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): SupervisorWorkspaceApi {
  const request = options.fetch ?? globalThis.fetch;
  return {
    async snapshot() {
      const accessToken = options.accessToken();
      if (!accessToken) throw new Error('authenticated access token is required');
      const response = await request(
        `${options.baseUrl.replace(/\/$/, '')}/api/v1/workspace/supervisor/snapshot`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (!response.ok) throw new Error(`Supervisor snapshot failed with HTTP ${response.status}`);
      return (await response.json()) as SupervisorSnapshot;
    },
  };
}
