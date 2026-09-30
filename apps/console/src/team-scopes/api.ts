export interface TeamViewScope {
  teamId: string;
  segmentId: string;
  grantId: string;
  updatedAt: string;
}

export interface TeamScopeApi {
  list(): Promise<{ scopes: TeamViewScope[] }>;
  grant(input: { teamId: string; segmentId: string }): Promise<void>;
  revoke(grantId: string, reasonCode: string): Promise<void>;
}

const base = '/api/v1/tenant/team-segment-scopes';

export function createTeamScopeApi(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): TeamScopeApi {
  const request = input.fetch ?? globalThis.fetch;
  const call = async <T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown) => {
    const token = input.accessToken();
    if (!token) throw new Error('AUTHORIZATION_CONTEXT_UNAVAILABLE');
    const response = await request(`${input.baseUrl.replace(/\/$/, '')}${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  };
  return {
    list: () => call('', 'GET'),
    grant: (body) => call('', 'POST', body),
    revoke: (grantId, reasonCode) =>
      call(`/${encodeURIComponent(grantId)}`, 'DELETE', { reasonCode }),
  };
}
