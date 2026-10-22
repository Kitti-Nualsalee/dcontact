import { CatalogApiError, type Capabilities, type CatalogItem } from './api.js';

export interface ConfigCommand {
  commandId: string;
  expectedRevision: number;
  reasonCode: string;
  reason: string;
}
export interface SkillSet {
  configRevision: number;
  items: { skillId: string; level?: number; minLevel?: number }[];
}
export interface RosterUser {
  id: string;
  displayName: string;
  role: string;
  teamId: string | null;
  configRevision: number;
  state: string;
}
export interface Destination {
  id: string;
  destination: string;
  configRevision: number;
  queueId: string | null;
  entryMode: string;
  isActive: boolean;
  voiceConfigVersion: number | null;
}
export interface Eligibility {
  configRevision: number;
  evaluatedAt: string;
  candidates: {
    userId: string;
    displayName: string;
    eligible: boolean;
    available: boolean;
    reasons: string[];
  }[];
  warnings: string[];
}
export interface ConfigApi {
  capabilities(): Promise<Capabilities>;
  catalog(
    kind: 'queues' | 'skills',
    cursor?: string,
  ): Promise<{ items: CatalogItem[]; nextCursor: string | null }>;
  roster(cursor?: string): Promise<{ items: RosterUser[]; nextCursor: string | null }>;
  destinations(cursor?: string): Promise<{ items: Destination[]; nextCursor: string | null }>;
  skills(kind: 'queues' | 'people/users', id: string): Promise<SkillSet>;
  replace(
    kind: 'queues' | 'people/users',
    id: string,
    body: ConfigCommand & Pick<SkillSet, 'items'>,
  ): Promise<SkillSet>;
  bind(id: string, body: ConfigCommand & { queueId: string; isActive: false }): Promise<unknown>;
  eligibility(queueId: string): Promise<Eligibility>;
  command(commandId: string): Promise<{ state: string }>;
}
export function createConfigApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): ConfigApi {
  async function request(path: string, body?: unknown) {
    const token = options.accessToken();
    if (!token) throw new CatalogApiError(401, 'UNAUTHORIZED');
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/api/v1/tenant-voice/${path}`,
      {
        method: body ? 'PUT' : 'GET',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok) {
      let code =
        response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : 'FAILED';
      try {
        const problem = await response.json();
        if (typeof problem.code === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(problem.code))
          code = problem.code;
      } catch {}
      throw new CatalogApiError(response.status, code);
    }
    if (response.status !== 200) throw new CatalogApiError(502, 'FAILED');
    return response.json();
  }
  const page = (path: string, cursor?: string) =>
    request(`${path}?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`);
  const skillPath = (kind: 'queues' | 'people/users', id: string) =>
    `${kind}/${encodeURIComponent(id)}/${kind === 'queues' ? 'required-skills' : 'skills'}`;
  return {
    capabilities: () => request('capabilities'),
    catalog: (kind, cursor) => page(kind, cursor),
    roster: (cursor) => page('people/roster', cursor),
    destinations: (cursor) => page('destinations', cursor),
    skills: (kind, id) => request(skillPath(kind, id)),
    replace: (kind, id, body) => request(skillPath(kind, id), body),
    bind: (id, body) => request(`destinations/${encodeURIComponent(id)}/binding`, body),
    eligibility: (id) => request(`eligibility?${new URLSearchParams({ queueId: id })}`),
    command: (id) => request(`commands/${encodeURIComponent(id)}`),
  };
}
