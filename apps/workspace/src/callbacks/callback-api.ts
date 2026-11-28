import { AgentApiError } from '../agent-api-error.js';

/** an API refusal with the detail the server gave (for Governance: its reason, e.g. CONSENT_REQUIRED) */
export class CallbackApiError extends AgentApiError {
  constructor(
    status: number,
    code: string,
    readonly field?: string,
  ) {
    super(status, code);
  }
}

/** #1061: agent-scheduled callbacks — the calls behind `/api/v1/workspace/agent/callbacks`. */
export interface AgentCallback {
  id: string;
  version: number;
  state: 'SCHEDULED' | 'ORIGINATING';
  contactId: string;
  /** null when the team may no longer see this customer */
  contactName: string | null;
  number: string | null;
  customerVisible: boolean;
  note: string | null;
  requestedFor: string;
  expiresAt: string;
  due: boolean;
  /** moved to the team because the Agent who scheduled it was not online */
  team: boolean;
  mine: boolean;
  createdByName: string | null;
  lastReasonCode: string | null;
  attemptCount: number;
}

export interface CallbackList {
  items: AgentCallback[];
  serverTime: string;
}

export interface CallbackOptions {
  interactionId: string;
  contactId: string;
  contactName: string | null;
  numbers: { identityId: string; value: string; dialable: boolean }[];
  queue: { id: string; name: string } | null;
  existingCallbackId: string | null;
}

export interface CallbackRef {
  callbackId: string;
  version: number;
}

export type CallbackDialResult =
  | (CallbackRef & { status: 'DIALING'; interactionId: string })
  | (CallbackRef & { status: 'DEFERRED'; requestedFor: string; reasonCode: string })
  | (CallbackRef & { status: 'BLOCKED'; reasonCode: string })
  | (CallbackRef & { status: 'REVIEW'; reasonCode: string });

export interface CallbackApi {
  list(): Promise<CallbackList>;
  options(interactionId: string): Promise<CallbackOptions>;
  schedule(input: {
    commandId: string;
    interactionId: string;
    identityId: string;
    requestedFor: string;
    note: string;
  }): Promise<CallbackRef>;
  reschedule(
    callbackId: string,
    input: { commandId: string; expectedVersion: number; requestedFor: string },
  ): Promise<CallbackRef>;
  cancel(
    callbackId: string,
    input: { commandId: string; expectedVersion: number },
  ): Promise<CallbackRef>;
  dial(
    callbackId: string,
    input: { commandId: string; expectedVersion: number },
  ): Promise<CallbackDialResult>;
}

type Send = (path: string, init: RequestInit) => Promise<Response>;

export function createCallbackApi(send: Send): CallbackApi {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await send(`/api/v1/workspace/agent/callbacks${path}`, {
      ...init,
      cache: 'no-store',
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code =
        body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
          ? body.code
          : 'REQUEST_FAILED';
      const field =
        body && typeof body === 'object' && 'field' in body && typeof body.field === 'string'
          ? body.field
          : undefined;
      throw new CallbackApiError(response.status, code, field);
    }
    if (!body || typeof body !== 'object') throw new Error('Invalid callback response');
    return body as T;
  }
  const post = <T>(path: string, body: unknown) =>
    call<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const id = (value: string) => `/${encodeURIComponent(value)}`;
  return {
    list: () => call<CallbackList>(''),
    options: (interactionId) =>
      call<CallbackOptions>(`/options?interactionId=${encodeURIComponent(interactionId)}`),
    schedule: (input) =>
      post<CallbackRef>('', { ...input, ...(input.note.trim() ? {} : { note: null }) }),
    reschedule: (callbackId, input) => post<CallbackRef>(`${id(callbackId)}/reschedule`, input),
    cancel: (callbackId, input) => post<CallbackRef>(`${id(callbackId)}/cancel`, input),
    dial: (callbackId, input) => post<CallbackDialResult>(`${id(callbackId)}/dial`, input),
  };
}
