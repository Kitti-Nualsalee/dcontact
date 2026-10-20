import { CatalogApiError } from '../voice-routing/api.js';
import { peopleUuid, type PeopleRole } from './api.js';

export interface PeopleDirectoryUser {
  id: string;
  displayName: string;
  email: string;
  username: string;
  role: PeopleRole;
  extensionRef: string | null;
  teamId: string | null;
  configRevision: number;
  accountState: string;
  provisioningState: string;
  activationState: string;
  operationId: string | null;
  commandId: string | null;
}
export interface PeopleDirectoryApi {
  list(cursor?: string): Promise<{ items: PeopleDirectoryUser[]; nextCursor: string | null }>;
  detail(userId: string): Promise<PeopleDirectoryUser>;
}

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new CatalogApiError(502, 'FAILED');
  return Object.fromEntries(Object.entries(raw));
}
function account(raw: unknown): PeopleDirectoryUser {
  const value = object(raw);
  if (
    !peopleUuid(value.id) ||
    typeof value.displayName !== 'string' ||
    typeof value.email !== 'string' ||
    value.username !== value.email ||
    !['AGENT', 'SUPERVISOR', 'ADMIN'].includes(String(value.role)) ||
    typeof value.role !== 'string' ||
    !Number.isSafeInteger(value.configRevision) ||
    typeof value.configRevision !== 'number' ||
    value.configRevision < 1 ||
    typeof value.accountState !== 'string' ||
    typeof value.provisioningState !== 'string' ||
    typeof value.activationState !== 'string' ||
    (value.teamId !== null && !peopleUuid(value.teamId)) ||
    (value.extensionRef !== null &&
      (typeof value.extensionRef !== 'string' || !/^[0-9]{4,6}$/.test(value.extensionRef))) ||
    (value.operationId !== null && !peopleUuid(value.operationId)) ||
    (value.commandId !== null && !peopleUuid(value.commandId)) ||
    (value.operationId === null) !== (value.commandId === null)
  )
    throw new CatalogApiError(502, 'FAILED');
  return {
    id: value.id,
    displayName: value.displayName,
    email: value.email,
    username: value.email,
    role: value.role === 'AGENT' ? 'AGENT' : value.role === 'SUPERVISOR' ? 'SUPERVISOR' : 'ADMIN',
    configRevision: value.configRevision,
    teamId: value.teamId,
    extensionRef: value.extensionRef,
    accountState: value.accountState,
    provisioningState: value.provisioningState,
    activationState: value.activationState,
    operationId: value.operationId,
    commandId: value.commandId,
  };
}

export function createPeopleDirectoryApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): PeopleDirectoryApi {
  async function request(path: string) {
    const token = options.accessToken();
    if (!token) throw new CatalogApiError(401, 'UNAUTHORIZED');
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/api/v1/tenant-voice/people/users${path}`,
      { cache: 'no-store', redirect: 'error', headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok)
      throw new CatalogApiError(
        response.status,
        response.status === 403 ? 'FORBIDDEN' : response.status === 401 ? 'UNAUTHORIZED' : 'FAILED',
      );
    return object(await response.json());
  }
  return {
    async list(cursor) {
      const query = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
      const value = await request(`?${query}`);
      if (
        !Array.isArray(value.items) ||
        (value.nextCursor !== null &&
          (typeof value.nextCursor !== 'string' || value.nextCursor.length > 2048))
      )
        throw new CatalogApiError(502, 'FAILED');
      return { items: value.items.map(account), nextCursor: value.nextCursor };
    },
    async detail(userId) {
      if (!peopleUuid(userId)) throw new CatalogApiError(400, 'FAILED');
      const value = account(await request(`/${userId}`));
      if (value.id !== userId) throw new CatalogApiError(502, 'FAILED');
      return value;
    },
  };
}
