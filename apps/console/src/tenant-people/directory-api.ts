import { CatalogApiError } from '../voice-routing/api.js';
import { peopleUuid, type PeopleRole } from './api.js';

export interface PeopleDirectoryUser {
  disableOperationId?: string | null;
  disableCommandId?: string | null;
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
  deliveryState: string;
  invitationGeneration: number | null;
  invitationExpiresAt: string | null;
  isActive: boolean;
}
export interface InvitationCommand {
  commandId: string;
  expectedRevision: number;
  reasonCode: string;
  reason: string;
}
export interface PeopleDirectoryApi {
  list(cursor?: string): Promise<{ items: PeopleDirectoryUser[]; nextCursor: string | null }>;
  detail(userId: string): Promise<PeopleDirectoryUser>;
  invitationReady(): Promise<boolean>;
  invitation(
    userId: string,
    kind: 'resend' | 'reconcile',
    command: InvitationCommand,
  ): Promise<{ operationId: string }>;
  invitationCommand(commandId: string, userId: string): Promise<{ operationId: string }>;
  invitationOperation(operationId: string, userId: string): Promise<string>;
  disableReady?(): Promise<boolean>;
  disable?(userId: string, command: InvitationCommand): Promise<{ operationId: string }>;
  disableOperation?(operationId: string, userId: string): Promise<string>;
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
    disableOperationId: peopleUuid(value.disableOperationId) ? value.disableOperationId : null,
    disableCommandId: peopleUuid(value.disableCommandId) ? value.disableCommandId : null,
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
    deliveryState:
      typeof value.deliveryState === 'string' &&
      [
        'UNKNOWN',
        'NOT_STARTED',
        'INTENT',
        'DISPATCHING',
        'AMBIGUOUS',
        'SENT',
        'FAILED',
        'EXPIRED',
      ].includes(value.deliveryState)
        ? value.deliveryState
        : 'UNKNOWN',
    invitationGeneration:
      typeof value.invitationGeneration === 'number' &&
      Number.isSafeInteger(value.invitationGeneration) &&
      value.invitationGeneration > 0
        ? value.invitationGeneration
        : null,
    invitationExpiresAt:
      typeof value.invitationExpiresAt === 'string' &&
      Number.isFinite(Date.parse(value.invitationExpiresAt))
        ? value.invitationExpiresAt
        : null,
    isActive: value.isActive === true,
  };
}

export function createPeopleDirectoryApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): PeopleDirectoryApi {
  async function request(path: string, body?: InvitationCommand) {
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
        response.status === 403 ? 'FORBIDDEN' : response.status === 401 ? 'UNAUTHORIZED' : 'FAILED';
      try {
        const problem = object(await response.json());
        if (typeof problem.code === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(problem.code))
          code = problem.code;
      } catch {}
      throw new CatalogApiError(response.status, code);
    }
    if (response.status !== (body ? 202 : 200)) throw new CatalogApiError(502, 'FAILED');
    return object(await response.json());
  }
  return {
    async list(cursor) {
      const query = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
      const value = await request(`people/users?${query}`);
      if (
        !Array.isArray(value.items) ||
        (value.nextCursor !== null &&
          (typeof value.nextCursor !== 'string' || value.nextCursor.length > 2048))
      )
        throw new CatalogApiError(502, 'FAILED');
      return { items: value.items.map(account), nextCursor: value.nextCursor };
    },
    async disableReady() {
      const capability = await request('capabilities');
      const disable = capability.disable;
      return (
        capability.canWrite === true &&
        !!disable &&
        typeof disable === 'object' &&
        'ready' in disable &&
        disable.ready === true
      );
    },
    async disable(userId, command) {
      if (!peopleUuid(userId) || !peopleUuid(command.commandId))
        throw new CatalogApiError(400, 'FAILED');
      const accepted = await request(`people/users/${userId}/disable`, command);
      if (
        !peopleUuid(accepted.operationId) ||
        accepted.userId !== userId ||
        accepted.accountState !== 'DISABLING'
      )
        throw new CatalogApiError(502, 'FAILED');
      return { operationId: accepted.operationId };
    },
    async disableOperation(operationId, userId) {
      if (!peopleUuid(operationId) || !peopleUuid(userId)) throw new CatalogApiError(400, 'FAILED');
      const operation = await request(`operations/${operationId}`);
      if (
        operation.operationId !== operationId ||
        operation.userId !== userId ||
        operation.step !== 'DISABLE_ACCOUNT' ||
        typeof operation.state !== 'string' ||
        !['QUEUED', 'WAITING_EXTERNAL', 'SUCCEEDED', 'REJECTED', 'ACTION_REQUIRED'].includes(
          operation.state,
        )
      )
        throw new CatalogApiError(502, 'FAILED');
      return operation.state;
    },
    async detail(userId) {
      if (!peopleUuid(userId)) throw new CatalogApiError(400, 'FAILED');
      const value = account(await request(`people/users/${userId}`));
      if (value.id !== userId) throw new CatalogApiError(502, 'FAILED');
      return value;
    },
    async invitationReady() {
      const capability = await request('capabilities');
      const invitation = capability.invitation;
      return (
        capability.canWrite === true &&
        !!invitation &&
        typeof invitation === 'object' &&
        'ready' in invitation &&
        invitation.ready === true
      );
    },
    async invitation(userId, kind, command) {
      if (!peopleUuid(userId) || !peopleUuid(command.commandId))
        throw new CatalogApiError(400, 'FAILED');
      const accepted = await request(
        `people/users/${userId}/${kind === 'resend' ? 'invitation/resend' : 'reconcile'}`,
        command,
      );
      if (!peopleUuid(accepted.operationId) || accepted.userId !== userId)
        throw new CatalogApiError(502, 'FAILED');
      return { operationId: accepted.operationId };
    },
    async invitationCommand(commandId, userId) {
      if (!peopleUuid(commandId) || !peopleUuid(userId)) throw new CatalogApiError(400, 'FAILED');
      const command = await request(`commands/${commandId}`);
      const result = object(command.result);
      if (!peopleUuid(result.operationId) || result.userId !== userId)
        throw new CatalogApiError(502, 'FAILED');
      return { operationId: result.operationId };
    },
    async invitationOperation(operationId, userId) {
      if (!peopleUuid(operationId) || !peopleUuid(userId)) throw new CatalogApiError(400, 'FAILED');
      const operation = await request(`operations/${operationId}`);
      if (
        operation.operationId !== operationId ||
        operation.userId !== userId ||
        typeof operation.state !== 'string' ||
        ![
          'QUEUED',
          'RUNNING',
          'WAITING_EXTERNAL',
          'SUCCEEDED',
          'REJECTED',
          'ACTION_REQUIRED',
        ].includes(operation.state)
      )
        throw new CatalogApiError(502, 'FAILED');
      return operation.state;
    },
  };
}
