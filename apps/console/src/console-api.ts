export interface QmContext {
  interaction: { id: string; channel: string; queueName: string };
  recording: {
    id: string;
    status: 'AVAILABLE' | 'DELETED';
    pauseIntervals: { startMs: number; endMs: number; reason: string }[];
  } | null;
  transcript: {
    id: string;
    language: string;
    segments: { id: string; speaker: string; startMs: number; endMs: number; text: string }[];
  } | null;
  evaluation: {
    id: string;
    status: 'DRAFT' | 'PUBLISHED';
    source: string;
    answers: { score?: number };
  } | null;
}

export interface ConsoleApi {
  context(contextId: string): Promise<QmContext>;
  playback(recordingId: string): Promise<{ url: string; expiresAt: string }>;
  publish(evaluationId: string, commandId: string): Promise<void>;
  preferenceHistory(contactId: string): Promise<PreferenceHistory>;
  effectivePreference(input: EffectivePreferenceInput): Promise<EffectivePreference>;
  setPreference(input: SetPreferenceInput): Promise<PreferenceMutation>;
  requestCallback(input: CallbackRequestInput): Promise<CallbackMutation>;
}

export type PreferenceDecision = 'ALLOW' | 'BLOCK' | 'DEFER';
export type ContactChannel = 'VOICE' | 'WEBCHAT' | 'LINE' | 'FACEBOOK' | 'WHATSAPP' | 'EMAIL';

export interface PreferenceRecord {
  id: string;
  version: number;
  channel?: ContactChannel;
  purpose?: string;
  decision?: PreferenceDecision;
  timezone?: string;
  preferredWindows: { daysOfWeek: number[]; startLocal: string; endLocal: string }[];
  mutationKind: 'SET' | 'REVOKE';
  occurredAt: string;
  effectiveFrom: string;
  effectiveTo?: string;
  evidenceRef: string;
  actorClass: string;
  sourceKind: string;
}

export interface PreferenceHistory {
  preferences: PreferenceRecord[];
  callbacks: CallbackRecord[];
  aggregateVersion: number;
}

export interface CallbackRecord {
  id: string;
  version: number;
  channel: ContactChannel;
  purpose: string;
  requestedAt: string;
  requestedTimezone: string;
  expiresAt: string;
  mutationKind: 'REQUEST' | 'CONSUME' | 'REVOKE';
  actorClass: string;
}

export interface EffectivePreferenceInput {
  contactId: string;
  channel: ContactChannel;
  purpose: string;
  contactKind?: string;
}

export interface EffectivePreference {
  decision?: PreferenceDecision;
  version: number;
  reason?: string;
}

export interface SetPreferenceInput {
  contactId: string;
  channel: ContactChannel;
  purpose: string;
  decision: PreferenceDecision;
  timezone?: string;
  preferredWindows: { daysOfWeek: number[]; startLocal: string; endLocal: string }[];
  evidenceRef: string;
  expectedVersion: number;
  commandId: string;
}

export interface PreferenceMutation {
  aggregateVersion: number;
  preference: PreferenceRecord;
}

export interface CallbackRequestInput {
  contactId: string;
  channel: ContactChannel;
  purpose: string;
  requestedAt: string;
  requestedTimezone: string;
  expiresAt: string;
  evidenceRef: string;
  expectedVersion: number;
  commandId: string;
}

export interface CallbackMutation {
  mutationId: string;
  callbackRequest: CallbackRecord;
  oneUseToken: string;
}

export class ConsoleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(code ?? `Console API failed with HTTP ${status}`);
    this.name = 'ConsoleApiError';
  }
}

export function createConsoleApi(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): ConsoleApi {
  const request = input.fetch ?? globalThis.fetch;
  const call = async (path: string, init?: RequestInit) => {
    const token = input.accessToken();
    if (!token) throw new Error('authenticated access token is required');
    const response = await request(`${input.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { code?: string } | undefined;
      throw new ConsoleApiError(response.status, body?.code);
    }
    return response;
  };
  return {
    context: async (id) =>
      (await (
        await call(`/api/v1/qm/console-contexts/${encodeURIComponent(id)}`)
      ).json()) as QmContext,
    playback: async (id) =>
      (await (
        await call(`/api/v1/recordings/${encodeURIComponent(id)}/playback`, { method: 'POST' })
      ).json()) as { url: string; expiresAt: string },
    publish: async (id, commandId) => {
      await call(`/api/v1/qm/evaluations/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ commandId }),
      });
    },
    preferenceHistory: async (contactId) => {
      const response = await call(
        `/api/v1/contact-governance/contacts/${encodeURIComponent(contactId)}/preferences`,
      );
      const body = (await response.json()) as {
        preferences: PreferenceRecord[];
        callbacks?: CallbackRecord[];
      };
      return {
        preferences: body.preferences,
        callbacks: body.callbacks ?? [],
        aggregateVersion: aggregateVersion(
          response.headers.get('etag'),
          body.preferences[0]?.version,
        ),
      };
    },
    effectivePreference: async (input) => {
      const query = new URLSearchParams({ channel: input.channel, purpose: input.purpose });
      if (input.contactKind) query.set('contactKind', input.contactKind);
      const response = await call(
        `/api/v1/contact-governance/contacts/${encodeURIComponent(input.contactId)}/effective-preference?${query}`,
      );
      const body = (await response.json()) as {
        aggregateVersion?: number;
        preference?: { decision?: PreferenceDecision; version?: number };
      };
      return {
        decision: body.preference?.decision,
        version: aggregateVersion(response.headers.get('etag'), body.aggregateVersion),
      };
    },
    setPreference: async (input) =>
      (await (
        await call('/api/v1/contact-governance/preferences', {
          method: 'POST',
          headers: { 'idempotency-key': input.commandId },
          body: JSON.stringify({
            contactId: input.contactId,
            channel: input.channel,
            purpose: input.purpose,
            decision: input.decision,
            timezone: input.timezone,
            preferredWindows: input.preferredWindows,
            occurredAt: new Date().toISOString(),
            effectiveFrom: new Date().toISOString(),
            evidenceRef: input.evidenceRef,
            expectedVersion: input.expectedVersion,
          }),
        })
      ).json()) as PreferenceMutation,
    requestCallback: async (input) =>
      (await (
        await call('/api/v1/contact-governance/callback-requests', {
          method: 'POST',
          headers: { 'idempotency-key': input.commandId },
          body: JSON.stringify({
            contactId: input.contactId,
            channel: input.channel,
            purpose: input.purpose,
            requestedAt: input.requestedAt,
            requestedTimezone: input.requestedTimezone,
            expiresAt: input.expiresAt,
            evidenceRef: input.evidenceRef,
            expectedVersion: input.expectedVersion,
          }),
        })
      ).json()) as CallbackMutation,
  };
}

function aggregateVersion(etag: string | null, fallback = 0): number {
  const match = etag?.match(/^cg-contact-v(\d+)$/);
  return match ? Number(match[1]) : fallback;
}
