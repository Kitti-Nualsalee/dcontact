import type { SipCredentialLease } from './softphone.js';

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
  sipCredentials(): Promise<SipCredentialLease>;
  submitWrapup(input: {
    interactionId: string;
    disposition: string;
    commandId: string;
  }): Promise<void>;
}

export interface AgentWorkspaceApiOptions {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}

export function createAgentWorkspaceApi(options: AgentWorkspaceApiOptions): AgentWorkspaceApi {
  const request = options.fetch ?? globalThis.fetch;
  async function get<T>(path: string): Promise<T> {
    const accessToken = options.accessToken();
    if (!accessToken) throw new Error('authenticated access token is required');
    const response = await request(`${options.baseUrl.replace(/\/$/, '')}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}`);
    return (await response.json()) as T;
  }
  async function post(path: string, body: unknown): Promise<void> {
    const accessToken = options.accessToken();
    if (!accessToken) throw new Error('authenticated access token is required');
    const response = await request(`${options.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}`);
  }
  return {
    async snapshot() {
      return get<AgentWorkspaceSnapshot>('/api/v1/workspace/agent/snapshot');
    },
    async sipCredentials() {
      return get<SipCredentialLease>('/api/v1/workspace/agent/sip-credentials');
    },
    async submitWrapup(input) {
      await post(
        `/api/v1/workspace/agent/interactions/${encodeURIComponent(input.interactionId)}/wrapup`,
        {
          disposition: input.disposition,
          commandId: input.commandId,
        },
      );
    },
  };
}
