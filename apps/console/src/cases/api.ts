/**
 * #956 — client of the Agent cases API (`/api/v1/workspace/agent/cases`)
 * uses the same token and base URL as agent-history
 */
export type CaseStatus = 'OPEN' | 'RESOLVED' | 'CLOSED';
export type CaseActivityKind =
  'CREATED' | 'LINKED' | 'REOPENED' | 'NOTE' | 'ASSIGNED' | 'STATUS_CHANGED';

export interface CaseSummary {
  id: string;
  /** null for a case opened by an automation (Journey), which has no subject */
  subject: string | null;
  contactId: string;
  /**
   * customer name from Customer 360 per the viewer's WORK permission
   * `undefined` no customer data (hidden/merged/no permission), `null` a customer exists but has no name
   */
  contactDisplayName?: string | null;
  status: CaseStatus;
  assigneeUserId: string | null;
  version: number;
  linkedWorkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CaseActivity {
  id: string;
  kind: CaseActivityKind;
  occurredAt: string;
  actorUserId: string | null;
  interactionId: string | null;
  /** LINKED only: the work belongs to the viewer, so an "open in work history" link can be shown */
  interactionMine: boolean;
  interactionChannel: string | null;
  interactionDirection: 'INBOUND' | 'OUTBOUND' | null;
  body: string | null;
  fromStatus: CaseStatus | null;
  toStatus: CaseStatus | null;
  assigneeUserId: string | null;
}

export interface CaseDetail extends CaseSummary {
  teamId: string;
  /** false when the owner moved teams or was deactivated */
  assigneeInTeam: boolean;
  reopenCount: number;
  /** null for a case opened by an automation (Journey) */
  createdByUserId: string | null;
  sourceInteractionId: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  activities: CaseActivity[];
}

/** name of a user who appears in the list or timeline, including people who have left the team */
export type CasePeople = Record<string, string>;

export interface CaseCustomer {
  displayName: string | null;
  company: string | null;
}

export interface CaseListPage {
  items: CaseSummary[];
  nextCursor: string | null;
  people: CasePeople;
  teamName: string;
}

export interface CaseDetailResponse {
  case: CaseDetail;
  people: CasePeople;
  teamName: string;
  /** null when the customer could not load or there is no permission; the timeline and actions still work */
  customer: CaseCustomer | null;
}

export interface TeamAgent {
  userId: string;
  displayName: string;
}

export interface CaseRef {
  caseId: string;
  version: number;
}

export type CaseErrorCode =
  | 'AGENT_REQUIRED'
  | 'TEAM_REQUIRED'
  | 'INVALID_INPUT'
  | 'WORK_NOT_FOUND'
  | 'WORK_NOT_ACTIVE'
  | 'WORK_HAS_CASE'
  | 'CONTACT_REQUIRED'
  | 'ASSIGNEE_NOT_IN_TEAM'
  | 'CASE_NOT_FOUND'
  | 'CASE_CLOSED'
  | 'INVALID_TRANSITION'
  | 'VERSION_CONFLICT'
  | 'COMMAND_ID_REUSED'
  | 'COMMAND_PAYLOAD_MISMATCH';

export class CaseApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: CaseErrorCode | string,
  ) {
    super(`Case request failed (${status}${code ? ` ${code}` : ''})`);
  }

  /** someone edited the case first, or the case is already closed; reload before continuing */
  get stale(): boolean {
    return this.code === 'VERSION_CONFLICT' || this.code === 'CASE_CLOSED';
  }
}

export type CaseStatusFilter = CaseStatus | 'NOT_CLOSED';

export interface CaseListFilter {
  status?: CaseStatusFilter;
  assignedToMe?: boolean;
  cursor?: string;
}

export const CASE_PAGE_SIZE = 25;

export interface CasesApi {
  list(filter?: CaseListFilter): Promise<CaseListPage>;
  detail(caseId: string): Promise<CaseDetailResponse>;
  teamAgents(): Promise<TeamAgent[]>;
  /**
   * write commands take a commandId from the caller, so pressing send again after a network failure uses the same id
   * and the server answers with the original result instead of creating a duplicate note or activity
   */
  addNote(command: CaseCommand, note: string): Promise<CaseRef>;
  assign(command: CaseCommand, assigneeUserId: string): Promise<CaseRef>;
  changeStatus(command: CaseCommand, status: CaseStatus): Promise<CaseRef>;
}

export interface CaseCommand {
  caseId: string;
  expectedVersion: number;
  commandId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createCasesApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): CasesApi {
  async function request(path: string, body?: unknown) {
    const token = options.accessToken();
    if (!token) throw new CaseApiError(401);
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/api/v1/workspace/agent/cases${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        { code?: string } | undefined;
      throw new CaseApiError(response.status, payload?.code);
    }
    return response.json();
  }

  function caseRef(caseId: string): string {
    if (!UUID.test(caseId)) throw new CaseApiError(404, 'CASE_NOT_FOUND');
    return `/${encodeURIComponent(caseId)}`;
  }

  return {
    async list(filter = {}) {
      const query = new URLSearchParams({
        limit: String(CASE_PAGE_SIZE),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.assignedToMe ? { mine: '1' } : {}),
        ...(filter.cursor ? { cursor: filter.cursor } : {}),
      });
      return (await request(`?${query}`)) as CaseListPage;
    },
    async detail(caseId) {
      return (await request(caseRef(caseId))) as CaseDetailResponse;
    },
    async teamAgents() {
      return ((await request('/team-agents')) as { items: TeamAgent[] }).items;
    },
    async addNote(command, note) {
      return (await request(`${caseRef(command.caseId)}/notes`, {
        commandId: command.commandId,
        expectedVersion: command.expectedVersion,
        note,
      })) as CaseRef;
    },
    async assign(command, assigneeUserId) {
      return (await request(`${caseRef(command.caseId)}/assignment`, {
        commandId: command.commandId,
        expectedVersion: command.expectedVersion,
        assigneeUserId,
      })) as CaseRef;
    },
    async changeStatus(command, status) {
      return (await request(`${caseRef(command.caseId)}/status`, {
        commandId: command.commandId,
        expectedVersion: command.expectedVersion,
        status,
      })) as CaseRef;
    },
  };
}
