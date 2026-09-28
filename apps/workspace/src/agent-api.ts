import type { SipCredentialLease } from './dphone/dphone.js';

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
  subscribeLive?(
    handlers: WorkspaceLiveHandlers,
    options?: WorkspaceLiveOptions,
  ): WorkspaceLiveConnection;
}

export interface WorkspaceLiveHandlers {
  onEvent(event: unknown): void;
  /** `code` = WebSocket close code (เช่น 4409 เมื่อ server ไม่รับ work-session lease) */
  onDisconnect(code?: number): void;
}

export interface WorkspaceLiveOptions {
  /** E1.12: work-session lease ที่ถืออยู่ — แนบใน `auth:connect` (tenant ที่บังคับ lease) */
  leaseId?: string;
}

export interface WorkspaceLiveConnection {
  /** id ของ socket นี้ (สร้างฝั่ง client ต่อหนึ่งการเชื่อมต่อ) — socket ใหม่ = id ใหม่ */
  id?: string;
  close(): void;
  /** ส่งข้อความหลังยืนยันตัวตนแล้ว (เช่น `lease:heartbeat`) — socket ยังไม่เปิด/ปิดแล้วถูกทิ้ง */
  send?(message: Record<string, unknown>): void;
}

export interface AgentWorkspaceApiOptions {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
  /**
   * E1.14: fetch ที่แนบ token เอง (dphone ที่ถูกฝัง — `EmbeddedAuth.fetch` เข้าคิวเมื่อต้อง login ใหม่)
   * มีค่านี้ = REST ไม่ใช้ `accessToken()` (WS ยังใช้)
   */
  authorizedFetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export function createAgentWorkspaceApi(options: AgentWorkspaceApiOptions): AgentWorkspaceApi {
  const request = options.fetch ?? globalThis.fetch;
  const send = (path: string, init: RequestInit): Promise<Response> => {
    const url = `${options.baseUrl.replace(/\/$/, '')}${path}`;
    if (options.authorizedFetch) return options.authorizedFetch(url, init);
    const accessToken = options.accessToken();
    if (!accessToken) throw new Error('authenticated access token is required');
    return request(url, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  };
  async function get<T>(path: string): Promise<T> {
    const response = await send(path, {});
    if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}`);
    return (await response.json()) as T;
  }
  async function post(path: string, body: unknown): Promise<void> {
    const response = await send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    subscribeLive(handlers, liveOptions = {}) {
      const connectionId = crypto.randomUUID();
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
            tabId: connectionId,
            ...(liveOptions.leaseId ? { leaseId: liveOptions.leaseId } : {}),
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
      socket.addEventListener('close', (event) => handlers.onDisconnect(event.code));
      return {
        id: connectionId,
        close: () => socket.close(),
        send: (message) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
        },
      };
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
