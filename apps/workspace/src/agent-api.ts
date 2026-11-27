import { AgentApiError } from './agent-api-error.js';
import { createCallbackApi, type CallbackApi } from './callbacks/callback-api.js';
import { createWorkCustomerApi, type WorkCustomerApi } from './work-customer-api.js';
import { createWebchatApi, type WebchatApi } from './webchat/webchat-api.js';
import type { SipCredentialLease } from './dphone/dphone.js';

export interface AgentWorkspaceSnapshot {
  capabilities?: {
    voiceWrapupV1?: number;
    workCustomerV1?: number;
    agentStatusV1?: number;
    /** #1044 the deployment has web chat on */
    webchatV1?: number;
    /** #1061 the deployment has agent callbacks on */
    agentCallbacksV1?: number;
  };
  agent: {
    id: string;
    displayName: string;
    extension: string | null;
    state: 'OFFLINE' | 'AVAILABLE' | 'RESERVED' | 'BUSY' | 'ACW' | 'BREAK';
    /** #937 start time of the current state */
    stateSince?: string | null;
    /** #937 the tenant's Not Ready reason (only BREAK that the Agent chose) */
    reasonCode?: string | null;
    changedBy?: 'AGENT' | 'SUPERVISOR' | 'SYSTEM';
    changedByName?: string | null;
    changeNote?: string | null;
    afterWork?: AfterWork;
  };
  interaction: {
    voiceWrapupPolicy?: 'LEGACY' | 'VOICE_NOTE_V1';
    id: string;
    state: 'ASSIGNED' | 'ACTIVE' | 'WRAPUP';
    direction: 'INBOUND' | 'OUTBOUND';
    version: string;
    caller: string | null;
    /** #1061 an agent-scheduled callback (`caller` is the number being called back) */
    callback?: boolean;
    queue: { id: string; name: string } | null;
    offerExpiresAt: string | null;
    answeredAt: string | null;
    endedAt: string | null;
  } | null;
}

export type AfterWork = { state: 'AVAILABLE' } | { state: 'BREAK'; reasonCode: string };

/** #937 Not Ready reasons the Agent can choose, in the order the Admin set */
export interface NotReadyReason {
  code: string;
  labelTh: string;
  labelEn: string;
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

/** #956 open a case from the current work */
export interface OpenCaseIntent {
  interactionId: string;
  subject: string;
  note: string;
  assigneeUserId?: string;
  commandId: string;
}

export interface OpenedCase {
  caseId: string;
  version: number;
}

export interface CaseTeamAgent {
  userId: string;
  displayName: string;
}

// in its own module so clients this file imports (callbacks) can extend it without an import cycle
export { AgentApiError };

export interface AgentWorkspaceApi {
  customer?: WorkCustomerApi;
  /** #1044 the Agent's web chats */
  webchat?: WebchatApi;
  /** #1061 agent-scheduled callbacks */
  callbacks?: CallbackApi;
  snapshot(): Promise<AgentWorkspaceSnapshot>;
  becomeAvailable(workSessionLeaseId: string): Promise<void>;
  /** #937 the Agent sets Not Ready + reason, or Offline, themselves */
  setAgentState?(
    workSessionLeaseId: string,
    state: { state: 'BREAK'; reasonCode: string } | { state: 'OFFLINE' },
  ): Promise<void>;
  notReadyReasons?(): Promise<NotReadyReason[]>;
  setAfterWork?(afterWork: AfterWork): Promise<AfterWork>;
  sipCredentials(workSessionLeaseId: string): Promise<SipCredentialLease>;
  submitWrapup(input: {
    interactionId: string;
    disposition: string;
    commandId: string;
  }): Promise<void>;
  submitWrapupV1?(input: WrapupIntentV1): Promise<WrapupResultV1>;
  /** #956 */
  openCase?(input: OpenCaseIntent): Promise<OpenedCase>;
  caseTeamAgents?(): Promise<CaseTeamAgent[]>;
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
  /** `code` = WebSocket close code (e.g. 4409 when the server does not accept the work-session lease) */
  onDisconnect(code?: number): void;
}

export interface WorkspaceLiveOptions {
  /** E1.12: work-session lease currently held — attached in `auth:connect` (tenants that enforce the lease) */
  leaseId?: string;
}

export interface WorkspaceLiveConnection {
  /** id of this socket (created client-side per connection) — a new socket = a new id */
  id?: string;
  close(): void;
  /** send a message after authentication (e.g. `lease:heartbeat`) — a socket that is not yet open/already closed is dropped */
  send?(message: Record<string, unknown>): void;
}

export interface AgentWorkspaceApiOptions {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
  /**
   * E1.14: fetch that attaches the token itself (embedded dphone — `EmbeddedAuth.fetch` queues when a new login is needed)
   * with this value = REST does not use `accessToken()` (WS still does)
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
  async function caseRequest(path: string, init?: RequestInit): Promise<unknown> {
    const response = await send(`/api/v1/workspace/agent/cases${path}`, {
      ...init,
      cache: 'no-store',
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code =
        body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
          ? body.code
          : 'REQUEST_FAILED';
      throw new AgentApiError(response.status, code);
    }
    return body;
  }
  return {
    customer: createWorkCustomerApi(send),
    webchat: createWebchatApi(send),
    callbacks: createCallbackApi(send),
    async openCase(input) {
      const body = await caseRequest('', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: input.commandId,
          interactionId: input.interactionId,
          subject: input.subject,
          note: input.note,
          ...(input.assigneeUserId ? { assigneeUserId: input.assigneeUserId } : {}),
        }),
      });
      if (
        !body ||
        typeof body !== 'object' ||
        !('caseId' in body) ||
        typeof body.caseId !== 'string' ||
        !('version' in body) ||
        typeof body.version !== 'number'
      )
        throw new Error('Invalid open case result');
      return { caseId: body.caseId, version: body.version };
    },
    async caseTeamAgents() {
      const body = await caseRequest('/team-agents');
      if (!body || typeof body !== 'object' || !('items' in body) || !Array.isArray(body.items))
        throw new Error('Invalid team agents');
      return (body.items as unknown[]).flatMap((item) =>
        item &&
        typeof item === 'object' &&
        'userId' in item &&
        typeof item.userId === 'string' &&
        'displayName' in item &&
        typeof item.displayName === 'string'
          ? [{ userId: item.userId, displayName: item.displayName }]
          : [],
      );
    },
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
      // #1044 an Agent who comes back while still holding chats continues them: the server answers the
      // state those chats put them in instead of AVAILABLE
      if (
        !outcome ||
        typeof outcome !== 'object' ||
        !('state' in outcome) ||
        !['AVAILABLE', 'RESERVED', 'BUSY', 'ACW'].includes(String(outcome.state))
      )
        throw new Error('availability acknowledgement is invalid');
    },
    async setAgentState(workSessionLeaseId, state) {
      const response = await send('/api/v1/workspace/agent/availability', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-work-session-lease-id': workSessionLeaseId,
        },
        body: JSON.stringify(state),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { code?: string };
        throw new AgentApiError(response.status, body.code ?? 'AGENT_STATE_FAILED');
      }
    },
    async notReadyReasons() {
      return (await get<{ reasons: NotReadyReason[] }>('/api/v1/workspace/agent/not-ready-reasons'))
        .reasons;
    },
    async setAfterWork(afterWork) {
      const response = await send('/api/v1/workspace/agent/after-work', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(afterWork),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { code?: string };
        throw new AgentApiError(response.status, body.code ?? 'AFTER_WORK_FAILED');
      }
      return ((await response.json()) as { afterWork: AfterWork }).afterWork;
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
          // an unreadable message has no authority, so it does not change Workspace state
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
