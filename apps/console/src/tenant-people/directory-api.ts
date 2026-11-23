import { CatalogApiError } from '../voice-routing/api.js';
import { peopleUuid, type PeopleRole } from './api.js';

export type PeopleAccountChangeKind = 'UPDATE_PROFILE' | 'ENABLE_ACCOUNT';
export const PEOPLE_ACCOUNT_CHANGE_STATES = [
  'QUEUED',
  'WAITING_EXTERNAL',
  'SUCCEEDED',
  'REJECTED',
  'ACTION_REQUIRED',
] as const;
export type PeopleAccountChangeState = (typeof PEOPLE_ACCOUNT_CHANGE_STATES)[number];
/** #998 1B/2: คำสั่งแก้ชื่อ/เปิดบัญชีกลับล่าสุดของผู้ใช้ */
export interface PeopleAccountChange {
  operationId: string;
  commandId: string;
  kind: PeopleAccountChangeKind;
  state: PeopleAccountChangeState;
}
export interface PeopleDirectoryUser {
  accountChange?: PeopleAccountChange | null;
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
/** ตัวกรองที่ server ใช้ — ค่าว่าง/undefined คือไม่กรอง */
export interface PeopleDirectoryFilters {
  q?: string;
  role?: PeopleRole;
  teamId?: string;
  /** สถานะเดียวกับ chip ใน Console (server คำนวณลำดับเดียวกับ `accountStatus()`) */
  status?: string;
}
export const PEOPLE_DIRECTORY_STATUSES = [
  'ACTIVE',
  'PENDING_ACTIVATION',
  'PROVISIONING',
  'DISABLING',
  'DISABLED',
  'ATTENTION_REQUIRED',
  'REJECTED',
  'UNKNOWN',
] as const;
export interface PeopleDirectoryApi {
  list(
    cursor?: string,
    filters?: PeopleDirectoryFilters,
  ): Promise<{ items: PeopleDirectoryUser[]; nextCursor: string | null }>;
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
  /** #998 1A: ย้ายทีม — ตอบผลทันที (ไม่มี operation) และ replay ได้ด้วย commandId เดิม */
  changeTeam?(userId: string, command: TeamChangeCommand): Promise<{ configRevision: number }>;
  /** #998 1B/2: แก้ชื่อที่แสดง/เปิดบัญชีกลับ — รับคำสั่ง (202) แล้วตามผลที่ operations/:id */
  accountChangeReady?(): Promise<boolean>;
  changeAccount?(
    userId: string,
    kind: PeopleAccountChangeKind,
    command: AccountChangeCommand,
  ): Promise<{ operationId: string }>;
  accountChangeOperation?(
    operationId: string,
    userId: string,
    kind: PeopleAccountChangeKind,
  ): Promise<PeopleAccountChangeState>;
}
export interface AccountChangeCommand {
  commandId: string;
  expectedRevision: number;
  reason: string;
  /** เฉพาะ UPDATE_PROFILE */
  displayName?: string;
}
export interface TeamChangeCommand {
  commandId: string;
  expectedRevision: number;
  teamId: string;
  reason: string;
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
  const change = value.accountChange ? object(value.accountChange) : null;
  return {
    id: value.id,
    accountChange:
      change &&
      peopleUuid(change.operationId) &&
      peopleUuid(change.commandId) &&
      (change.kind === 'UPDATE_PROFILE' || change.kind === 'ENABLE_ACCOUNT') &&
      (PEOPLE_ACCOUNT_CHANGE_STATES as readonly unknown[]).includes(change.state)
        ? {
            operationId: change.operationId,
            commandId: change.commandId,
            kind: change.kind,
            state: change.state as PeopleAccountChangeState,
          }
        : null,
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
  async function request(
    path: string,
    body?: InvitationCommand | object,
    expected?: number,
    method?: 'PATCH',
  ) {
    const token = options.accessToken();
    if (!token) throw new CatalogApiError(401, 'UNAUTHORIZED');
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/api/v1/tenant-voice/${path}`,
      {
        method: method ?? (body ? 'POST' : 'GET'),
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
    if (response.status !== (expected ?? (body ? 202 : 200)))
      throw new CatalogApiError(502, 'FAILED');
    return object(await response.json());
  }
  return {
    async list(cursor, filters = {}) {
      const q = filters.q?.trim() ?? '';
      const narrowed = {
        ...(q ? { q } : {}),
        ...(filters.role ? { role: filters.role } : {}),
        ...(filters.teamId && peopleUuid(filters.teamId) ? { teamId: filters.teamId } : {}),
        ...(filters.status &&
        (PEOPLE_DIRECTORY_STATUSES as readonly string[]).includes(filters.status)
          ? { status: filters.status }
          : {}),
      };
      // มีตัวกรองใช้ POST search ให้คำค้น (ชื่อ/email) อยู่ใน body ไม่อยู่ใน URL
      const value = Object.keys(narrowed).length
        ? await request(
            'people/users/search',
            { limit: 20, ...(cursor ? { cursor } : {}), ...narrowed },
            200,
          )
        : await request(
            `people/users?${new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) })}`,
          );
      if (
        !Array.isArray(value.items) ||
        (value.nextCursor !== null &&
          (typeof value.nextCursor !== 'string' || value.nextCursor.length > 2048))
      )
        throw new CatalogApiError(502, 'FAILED');
      return { items: value.items.map(account), nextCursor: value.nextCursor };
    },
    async changeTeam(userId, command) {
      if (!peopleUuid(userId) || !peopleUuid(command.commandId) || !peopleUuid(command.teamId))
        throw new CatalogApiError(400, 'FAILED');
      const result = await request(`people/users/${userId}/team`, command, 200, 'PATCH');
      if (
        result.userId !== userId ||
        result.teamId !== command.teamId ||
        typeof result.configRevision !== 'number' ||
        !Number.isSafeInteger(result.configRevision)
      )
        throw new CatalogApiError(502, 'FAILED');
      return { configRevision: result.configRevision };
    },
    async accountChangeReady() {
      const capability = await request('capabilities');
      const ready = capability.accountChange;
      return (
        capability.canWrite === true &&
        !!ready &&
        typeof ready === 'object' &&
        'ready' in ready &&
        ready.ready === true
      );
    },
    async changeAccount(userId, kind, command) {
      if (!peopleUuid(userId) || !peopleUuid(command.commandId))
        throw new CatalogApiError(400, 'FAILED');
      const body =
        kind === 'UPDATE_PROFILE'
          ? {
              commandId: command.commandId,
              expectedRevision: command.expectedRevision,
              displayName: command.displayName,
              reason: command.reason,
            }
          : {
              commandId: command.commandId,
              expectedRevision: command.expectedRevision,
              reason: command.reason,
            };
      const accepted =
        kind === 'UPDATE_PROFILE'
          ? await request(`people/users/${userId}/profile`, body, 202, 'PATCH')
          : await request(`people/users/${userId}/enable`, body);
      if (!peopleUuid(accepted.operationId) || accepted.userId !== userId || accepted.kind !== kind)
        throw new CatalogApiError(502, 'FAILED');
      return { operationId: accepted.operationId };
    },
    async accountChangeOperation(operationId, userId, kind) {
      if (!peopleUuid(operationId) || !peopleUuid(userId)) throw new CatalogApiError(400, 'FAILED');
      const operation = await request(`operations/${operationId}`);
      if (
        operation.operationId !== operationId ||
        operation.userId !== userId ||
        operation.step !== kind ||
        !(PEOPLE_ACCOUNT_CHANGE_STATES as readonly unknown[]).includes(operation.state)
      )
        throw new CatalogApiError(502, 'FAILED');
      return operation.state as PeopleAccountChangeState;
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
