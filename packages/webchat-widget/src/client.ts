/** #1044: the widget's calls to the public web chat API. All paths are relative to `/api/v1/webchat/`. */
export interface ChatMessage {
  id: string;
  at: string;
  from: 'visitor' | 'agent' | 'system';
  text?: string;
  event?: string;
  clientId?: string;
}

export type ServerStatus = 'NEW' | 'WAITING' | 'ACTIVE' | 'ENDED';

export interface ServerState {
  status: ServerStatus;
  endReason: string | null;
  staffed: boolean;
  messages: ChatMessage[];
  cursor: string | null;
  version: string;
}

export interface ChatBootstrap {
  tenantName: string;
  greeting: { th: string; en: string };
  idleTimeoutSec: number;
  staffed: boolean;
}

export interface StoredSession {
  sessionId: string;
  token: string;
}

export class ChatApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface ChatApi {
  bootstrap(): Promise<ChatBootstrap>;
  startSession(input: { origin: string; locale: string }): Promise<StoredSession>;
  state(
    session: StoredSession,
    query: { after?: string | null; known?: string; signal?: AbortSignal },
  ): Promise<ServerState>;
  send(
    session: StoredSession,
    input: { clientMessageId: string; text: string },
  ): Promise<ChatMessage>;
  end(session: StoredSession): Promise<void>;
}

export function createChatApi(base: string, tenantId: string, widgetId: string): ChatApi {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, base), {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { code?: string } | null;
      throw new ChatApiError(response.status, body?.code ?? 'REQUEST_FAILED');
    }
    return (await response.json()) as T;
  }
  const auth = (session: StoredSession) => ({ authorization: `Bearer ${session.token}` });
  const sessionPath = (session: StoredSession) =>
    `public/${tenantId}/sessions/${session.sessionId}`;
  return {
    bootstrap: () => call(`public/${tenantId}/${widgetId}/bootstrap`),
    async startSession(input) {
      const created = await call<StoredSession>(`public/${tenantId}/${widgetId}/sessions`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return { sessionId: created.sessionId, token: created.token };
    },
    state(session, query) {
      const params = new URLSearchParams();
      if (query.after) params.set('after', query.after);
      if (query.known) params.set('known', query.known);
      const suffix = params.size ? `?${params}` : '';
      return call(`${sessionPath(session)}${suffix}`, {
        headers: auth(session),
        signal: query.signal,
      });
    },
    async send(session, input) {
      const sent = await call<{ message: ChatMessage }>(`${sessionPath(session)}/messages`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify(input),
      });
      return sent.message;
    },
    async end(session) {
      await call(`${sessionPath(session)}/end`, { method: 'POST', headers: auth(session) });
    },
  };
}
