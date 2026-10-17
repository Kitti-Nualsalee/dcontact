import type { SipCredentialLease } from './dphone/dphone.js';

export interface AgentWorkspaceSnapshot {
  capabilities?: { voiceWrapupV1?: number };
  agent: {
    id: string;
    displayName: string;
    extension: string | null;
    state: 'OFFLINE' | 'AVAILABLE' | 'RESERVED' | 'BUSY' | 'ACW' | 'BREAK';
  };
  interaction: {
    voiceWrapupPolicy?: 'LEGACY' | 'VOICE_NOTE_V1';
    id: string;
    state: 'ASSIGNED' | 'ACTIVE' | 'WRAPUP';
    direction: 'INBOUND' | 'OUTBOUND';
    version: string;
    caller: string | null;
    queue: { id: string; name: string } | null;
    offerExpiresAt: string | null;
    answeredAt: string | null;
    endedAt: string | null;
  } | null;
}

export interface WrapupResultV1 {
  interactionId: string;
  policyVersion: 1;
  state: 'COMPLETED';
  disposition: string;
  note: string;
  recordedAt: string;
  legacy: false;
}

export interface WrapupIntentV1 {
  interactionId: string;
  disposition: string;
  note: string;
  commandId: string;
}

export class AgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Agent API failed with HTTP ${status}`);
  }
}

export interface AgentWorkspaceApi {
  snapshot(): Promise<AgentWorkspaceSnapshot>;
  becomeAvailable(workSessionLeaseId: string): Promise<void>;
  sipCredentials(workSessionLeaseId: string): Promise<SipCredentialLease>;
  submitWrapup(input: {
    interactionId: string;
    disposition: string;
    commandId: string;
  }): Promise<void>;
  submitWrapupV1?(input: WrapupIntentV1): Promise<WrapupResultV1>;
  wrapupResult?(interactionId: string): Promise<WrapupResultV1>;
  wrapupCommand?(
    interactionId: string,
    commandId: string,
  ): Promise<{ status: 'COMMITTED'; result: Omit<WrapupResultV1, 'note' | 'legacy'> }>;
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
  async function resultRequest(path: string, init: RequestInit): Promise<WrapupResultV1> {
    const response = await send(path, { ...init, cache: 'no-store' });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const code =
        body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
          ? body.code
          : 'REQUEST_FAILED';
      throw new AgentApiError(response.status, code);
    }
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== 'object' ||
      !('interactionId' in result) ||
      typeof result.interactionId !== 'string' ||
      !('note' in result) ||
      typeof result.note !== 'string' ||
      !('policyVersion' in result) ||
      result.policyVersion !== 1 ||
      !('state' in result) ||
      result.state !== 'COMPLETED' ||
      !('disposition' in result) ||
      !['CUSTOMER_ASSISTED', 'FOLLOW_UP_REQUIRED'].includes(String(result.disposition)) ||
      !('recordedAt' in result) ||
      typeof result.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(result.recordedAt)) ||
      !('legacy' in result) ||
      result.legacy !== false
    ) {
      throw new Error('Invalid wrapup result');
    }
    return result as WrapupResultV1;
  }
  return {
    async wrapupCommand(interactionId, commandId) {
      const response = await send(
        `/api/v1/workspace/agent/interactions/${encodeURIComponent(interactionId)}/wrapup-commands/${encodeURIComponent(commandId)}`,
        { cache: 'no-store' },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        const code =
          body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
            ? body.code
            : 'REQUEST_FAILED';
        throw new AgentApiError(response.status, code);
      }
      if (
        !body ||
        typeof body !== 'object' ||
        !('status' in body) ||
        body.status !== 'COMMITTED' ||
        !('result' in body) ||
        !body.result ||
        typeof body.result !== 'object' ||
        !('interactionId' in body.result) ||
        body.result.interactionId !== interactionId
      )
        throw new Error('Invalid wrapup command status');
      return body as { status: 'COMMITTED'; result: Omit<WrapupResultV1, 'note' | 'legacy'> };
    },
    submitWrapupV1(input) {
      return resultRequest(
        `/api/v1/workspace/agent/interactions/${encodeURIComponent(input.interactionId)}/wrapup-v1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            disposition: input.disposition,
            note: input.note,
            commandId: input.commandId,
          }),
        },
      );
    },
    wrapupResult(interactionId) {
      return resultRequest(
        `/api/v1/workspace/agent/interactions/${encodeURIComponent(interactionId)}/wrapup-result`,
        {},
      );
    },
    async snapshot() {
      return get<AgentWorkspaceSnapshot>('/api/v1/workspace/agent/snapshot');
    },
    async becomeAvailable(workSessionLeaseId) {
      const response = await send('/api/v1/workspace/agent/availability', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-work-session-lease-id': workSessionLeaseId,
        },
        body: JSON.stringify({ state: 'AVAILABLE' }),
      });
      if (!response.ok) throw new Error(`availability failed with HTTP ${response.status}`);
      const outcome: unknown = await response.json();
      if (
        !outcome ||
        typeof outcome !== 'object' ||
        !('state' in outcome) ||
        outcome.state !== 'AVAILABLE'
      )
        throw new Error('availability acknowledgement is invalid');
    },
    async sipCredentials(workSessionLeaseId) {
      const response = await send('/api/v1/workspace/agent/sip-credentials', {
        headers: { 'x-work-session-lease-id': workSessionLeaseId },
      });
      if (!response.ok) {
        throw new Error(
          `/api/v1/workspace/agent/sip-credentials failed with HTTP ${response.status}`,
        );
      }
      return (await response.json()) as SipCredentialLease;
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
