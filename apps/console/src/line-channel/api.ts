/**
 * #1054: Console client of `/api/v1/line/channel` (one LINE Official Account per tenant)
 *
 * tenant and actor come from the bearer token the gateway has verified. The API never returns the channel
 * secret or the access token: only whether each is stored and its last characters.
 */
export interface LineChannel {
  /** null until the first save */
  id: string | null;
  /** 0 until the first save */
  revision: number;
  enabled: boolean;
  queueId: string | null;
  lineChannelId: string;
  autoReplyText: string;
  idleTimeoutSec: number;
  hasChannelSecret: boolean;
  hasAccessToken: boolean;
  channelSecretHint: string | null;
  accessTokenHint: string | null;
  /** name of the LINE bot the stored token belongs to; empty until a token was checked */
  botName: string;
  credentialsVerifiedAt: string | null;
  /** path LINE must call; null until the first save */
  webhookPath: string | null;
}

export interface LineQueueOption {
  id: string;
  name: string;
  teamName: string | null;
}

export interface LineSettings {
  tenantId: string;
  canEdit: boolean;
  channel: LineChannel;
  /** when the settings were last saved and by whom; null until the first save */
  lastSaved: { at: string; byName: string | null } | null;
  queues: LineQueueOption[];
}

/** `channelSecret` and `accessToken` are left out to keep the stored ones */
export interface LineSaveInput {
  expectedRevision: number;
  enabled: boolean;
  queueId: string | null;
  lineChannelId: string;
  channelSecret?: string;
  accessToken?: string;
  autoReplyText: string;
  idleTimeoutSec: number;
}

export class LineApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly field?: string,
  ) {
    super(code ?? `LINE API failed with HTTP ${status}`);
    this.name = 'LineApiError';
  }
}

export interface LineApi {
  get(): Promise<LineSettings>;
  save(input: LineSaveInput): Promise<LineSettings>;
}

const PATH = '/api/v1/line/channel';

const nullableString = (value: unknown) => value === null || typeof value === 'string';

/** a response that does not have the documented shape is a server fault, not something to render */
export function isLineSettings(value: unknown): value is LineSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as LineSettings;
  const channel = settings.channel as LineChannel | undefined;
  return (
    typeof settings.tenantId === 'string' &&
    typeof settings.canEdit === 'boolean' &&
    !!channel &&
    nullableString(channel.id) &&
    Number.isInteger(channel.revision) &&
    typeof channel.enabled === 'boolean' &&
    nullableString(channel.queueId) &&
    Number.isInteger(channel.idleTimeoutSec) &&
    typeof channel.hasChannelSecret === 'boolean' &&
    typeof channel.hasAccessToken === 'boolean' &&
    nullableString(channel.channelSecretHint) &&
    nullableString(channel.accessTokenHint) &&
    nullableString(channel.webhookPath) &&
    Array.isArray(settings.queues)
  );
}

export function createLineApi(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): LineApi {
  const request = input.fetch ?? globalThis.fetch;
  const call = async (method: 'GET' | 'PUT', body?: unknown): Promise<LineSettings> => {
    const token = input.accessToken();
    if (!token) throw new LineApiError(401, 'AUTHORIZATION_CONTEXT_UNAVAILABLE');
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
      throw new LineApiError(response.status, payload?.code, payload?.field);
    }
    const settings: unknown = await response.json();
    if (!isLineSettings(settings)) throw new LineApiError(502, 'INVALID_RESPONSE');
    return {
      ...settings,
      lastSaved: settings.lastSaved ?? null,
      channel: {
        ...settings.channel,
        lineChannelId: settings.channel.lineChannelId ?? '',
        autoReplyText: settings.channel.autoReplyText ?? '',
        botName: settings.channel.botName ?? '',
        credentialsVerifiedAt: settings.channel.credentialsVerifiedAt ?? null,
      },
    };
  };
  return {
    get: () => call('GET'),
    save: (body) => call('PUT', body),
  };
}
