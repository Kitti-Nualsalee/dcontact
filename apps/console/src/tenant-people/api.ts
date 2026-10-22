import { CatalogApiError } from '../voice-routing/api.js';
import { createConfigApi, type ConfigApi } from '../voice-routing/config-api.js';
import { createPeopleDirectoryApi, type PeopleDirectoryApi } from './directory-api.js';

export type PeopleRole = 'AGENT' | 'SUPERVISOR' | 'ADMIN';
export interface PeopleCommand {
  commandId: string;
  displayName: string;
  email: string;
  role: PeopleRole;
  teamId: string;
  extensionRef?: string;
}
export interface PeopleAccepted {
  operationId: string;
  userId: string;
}
export interface PeopleStatus extends PeopleAccepted {
  state: string;
  accountState: string;
  activationState: string;
  provisioningState: string;
}
export interface PeopleApi {
  config?: ConfigApi;
  directory?: PeopleDirectoryApi;
  options(): Promise<{
    ready: boolean;
    teams: { id: string; name: string }[];
    extensions: string[];
  }>;
  create(command: PeopleCommand): Promise<PeopleAccepted>;
  command(commandId: string): Promise<PeopleAccepted>;
  operation(operationId: string): Promise<PeopleStatus>;
}
export const peopleUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CatalogApiError(502, 'FAILED');
  return Object.fromEntries(Object.entries(value));
}
function accepted(raw: unknown): PeopleAccepted {
  const value = object(raw);
  if (!peopleUuid(value.operationId) || !peopleUuid(value.userId))
    throw new CatalogApiError(502, 'FAILED');
  return { operationId: value.operationId, userId: value.userId };
}
export function createPeopleApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): PeopleApi {
  async function request(
    path: string,
    body?: PeopleCommand,
    expected = 200,
  ): Promise<Record<string, unknown>> {
    const token = options.accessToken();
    if (!token) throw new CatalogApiError(401, 'UNAUTHORIZED');
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/api/v1/tenant-voice/${path}`,
      {
        method: body ? 'POST' : 'GET',
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
        const problem = object(await response.json());
        if (typeof problem.code === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(problem.code))
          code = problem.code;
      } catch {}
      throw new CatalogApiError(response.status, code);
    }
    if (response.status !== expected) throw new CatalogApiError(502, 'FAILED');
    return object(await response.json());
  }
  return {
    config: createConfigApi(options),
    directory: createPeopleDirectoryApi(options),
    async options() {
      const [caps, teams] = await Promise.all([request('capabilities'), request('teams')]);
      const capability = caps.peopleProvisioning;
      const ready =
        caps.canWrite === true &&
        !!capability &&
        typeof capability === 'object' &&
        'ready' in capability &&
        capability.ready === true;
      const pool = ready ? await request('extension-pool') : { items: [] };
      if (!Array.isArray(teams.items) || !Array.isArray(pool.items))
        throw new CatalogApiError(502, 'FAILED');
      return {
        ready,
        teams: teams.items.map((raw) => {
          const item = object(raw);
          if (!peopleUuid(item.id) || typeof item.name !== 'string')
            throw new CatalogApiError(502, 'FAILED');
          return { id: item.id, name: item.name };
        }),
        extensions: pool.items.map((raw) => {
          const item = object(raw);
          if (typeof item.ref !== 'string' || !/^[0-9]{4,6}$/.test(item.ref))
            throw new CatalogApiError(502, 'FAILED');
          return item.ref;
        }),
      };
    },
    async create(command) {
      return accepted(await request('people/users', command, 202));
    },
    async command(commandId) {
      if (!peopleUuid(commandId)) throw new CatalogApiError(400, 'FAILED');
      return accepted((await request(`commands/${commandId}`)).result);
    },
    async operation(operationId) {
      if (!peopleUuid(operationId)) throw new CatalogApiError(400, 'FAILED');
      const value = await request(`operations/${operationId}`);
      const identity = accepted(value);
      if (
        identity.operationId !== operationId ||
        typeof value.state !== 'string' ||
        ![
          'QUEUED',
          'RUNNING',
          'WAITING_EXTERNAL',
          'SUCCEEDED',
          'REJECTED',
          'ACTION_REQUIRED',
        ].includes(value.state) ||
        typeof value.accountState !== 'string' ||
        typeof value.activationState !== 'string' ||
        typeof value.provisioningState !== 'string'
      )
        throw new CatalogApiError(502, 'FAILED');
      return {
        ...identity,
        state: value.state,
        accountState: value.accountState,
        activationState: value.activationState,
        provisioningState: value.provisioningState,
      };
    },
  };
}
