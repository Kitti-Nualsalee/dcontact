import { AgentApiError } from '../agent-api.js';

/** #1044: the Agent's web chats — the calls behind `/api/v1/workspace/agent/webchat`. */
export type WebchatEndReason = 'CUSTOMER_ENDED' | 'AGENT_ENDED' | 'IDLE_TIMEOUT' | 'CUSTOMER_LEFT';

export interface WebchatMessage {
  id: string;
  at: string;
  from: 'visitor' | 'agent' | 'system';
  text?: string;
  event?: 'AGENT_JOINED' | WebchatEndReason;
  /** the id this client gave a message it sent, to match the server copy with the one still on screen */
  clientId?: string;
}

export interface WebchatChat {
  interactionId: string;
  state: 'ASSIGNED' | 'ACTIVE' | 'WRAPUP';
  visitorLabel: string;
  origin: string;
  queueName: string | null;
  queuedAt: string;
  offerExpiresAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: WebchatEndReason | null;
  visitorOnline: boolean;
  idleClosesAt: string | null;
  lastMessage: WebchatMessage | null;
  visitorMessageCount: number;
}

export interface WebchatApi {
  chats(): Promise<{ maxChatsPerAgent: number; chats: WebchatChat[] }>;
  messages(
    interactionId: string,
    after?: string | null,
  ): Promise<{ messages: WebchatMessage[]; cursor: string | null }>;
  accept(interactionId: string): Promise<void>;
  send(interactionId: string, input: { commandId: string; text: string }): Promise<WebchatMessage>;
  end(interactionId: string): Promise<void>;
}

type Send = (path: string, init: RequestInit) => Promise<Response>;

export function createWebchatApi(send: Send): WebchatApi {
  const base = '/api/v1/workspace/agent/webchat';
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await send(`${base}${path}`, {
      ...init,
      cache: 'no-store',
      ...(init.body ? { headers: { 'content-type': 'application/json' } } : {}),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code =
        body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
          ? body.code
          : 'REQUEST_FAILED';
      throw new AgentApiError(response.status, code);
    }
    return body as T;
  }
  const chat = (interactionId: string) => `/${encodeURIComponent(interactionId)}`;
  return {
    chats: () => call(''),
    messages: (interactionId, after) =>
      call(`${chat(interactionId)}/messages${after ? `?after=${encodeURIComponent(after)}` : ''}`),
    async accept(interactionId) {
      await call(`${chat(interactionId)}/accept`, { method: 'POST' });
    },
    async send(interactionId, input) {
      const sent = await call<{ message: WebchatMessage }>(`${chat(interactionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return sent.message;
    },
    async end(interactionId) {
      await call(`${chat(interactionId)}/end`, { method: 'POST' });
    },
  };
}
