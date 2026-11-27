/**
 * #1044: Console client of `/api/v1/webchat/widget` (one widget per tenant)
 *
 * tenant and actor come from the bearer token the gateway has verified — the body holds only the settings
 */
export interface WebchatWidget {
  /** null until the first save */
  id: string | null;
  /** 0 until the first save */
  revision: number;
  enabled: boolean;
  queueId: string | null;
  allowedOrigins: string[];
  greetingTh: string;
  greetingEn: string;
  maxChatsPerAgent: number;
  idleTimeoutSec: number;
}

export interface WebchatQueueOption {
  id: string;
  name: string;
  teamName: string | null;
}

export interface WebchatSettings {
  tenantId: string;
  canEdit: boolean;
  widget: WebchatWidget;
  queues: WebchatQueueOption[];
}

export interface WebchatSaveInput {
  expectedRevision: number;
  enabled: boolean;
  queueId: string | null;
  allowedOrigins: string[];
  greetingTh: string;
  greetingEn: string;
  maxChatsPerAgent: number;
  idleTimeoutSec: number;
}

export class WebchatApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly field?: string,
  ) {
    super(code ?? `webchat API failed with HTTP ${status}`);
    this.name = 'WebchatApiError';
  }
}

export interface WebchatApi {
  get(): Promise<WebchatSettings>;
  save(input: WebchatSaveInput): Promise<WebchatSettings>;
}

const PATH = '/api/v1/webchat/widget';

/** a response that does not have the documented shape is a server fault, not something to render */
export function isWebchatSettings(value: unknown): value is WebchatSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as WebchatSettings;
  const widget = settings.widget as WebchatWidget | undefined;
  return (
    typeof settings.tenantId === 'string' &&
    typeof settings.canEdit === 'boolean' &&
    !!widget &&
    (widget.id === null || typeof widget.id === 'string') &&
    Number.isInteger(widget.revision) &&
    typeof widget.enabled === 'boolean' &&
    (widget.queueId === null || typeof widget.queueId === 'string') &&
    Array.isArray(widget.allowedOrigins) &&
    widget.allowedOrigins.every((origin) => typeof origin === 'string') &&
    Number.isInteger(widget.maxChatsPerAgent) &&
    Number.isInteger(widget.idleTimeoutSec) &&
    Array.isArray(settings.queues)
  );
}

export function createWebchatApi(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): WebchatApi {
  const request = input.fetch ?? globalThis.fetch;
  const call = async (method: 'GET' | 'PUT', body?: unknown): Promise<WebchatSettings> => {
    const token = input.accessToken();
    if (!token) throw new WebchatApiError(401, 'AUTHORIZATION_CONTEXT_UNAVAILABLE');
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await request(`${input.baseUrl.replace(/\/$/, '')}${PATH}`, {
      method,
      cache: 'no-store',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        { code?: string; field?: string } | undefined;
      throw new WebchatApiError(response.status, payload?.code, payload?.field);
    }
    const settings: unknown = await response.json();
    if (!isWebchatSettings(settings)) throw new WebchatApiError(502, 'INVALID_RESPONSE');
    return {
      ...settings,
      widget: {
        ...settings.widget,
        greetingTh: settings.widget.greetingTh ?? '',
        greetingEn: settings.widget.greetingEn ?? '',
      },
    };
  };
  return {
    get: () => call('GET'),
    save: (body) => call('PUT', body),
  };
}
