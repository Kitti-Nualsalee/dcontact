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
  subscribeLive?(handlers: WorkspaceLiveHandlers): WorkspaceLiveConnection;
}

export interface WorkspaceLiveHandlers {
  onEvent(event: unknown): void;
  onDisconnect(): void;
}

export interface WorkspaceLiveConnection {
  close(): void;
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
    subscribeLive(handlers) {
      const socket = new WebSocket(workspaceSocketUrl(options.baseUrl));
      socket.addEventListener('open', () => {
        const accessToken = options.accessToken();
        if (!accessToken) {
          socket.close();
          return;
        }
        socket.send(
          JSON.stringify({
            type: 'auth:connect',
            accessToken,
            tabId: crypto.randomUUID(),
          }),
        );
      });
      socket.addEventListener('message', (event) => {
        try {
          handlers.onEvent(JSON.parse(String(event.data)));
        } catch {
          // ข้อความที่อ่านไม่ได้ไม่มี authority ใด จึงไม่เปลี่ยน Workspace state
        }
      });
      socket.addEventListener('close', handlers.onDisconnect);
      return { close: () => socket.close() };
    },
  };
}

export function workspaceSocketUrl(baseUrl: string): string {
  const fallbackOrigin =
    typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const url = new URL(baseUrl || fallbackOrigin, fallbackOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/v1/workspace-session';
  url.search = '';
  return url.toString();
}
