/**
 * #956 — client ของ API เคสของ Agent (`/api/v1/workspace/agent/cases`)
 * ใช้ token และ base URL ชุดเดียวกับ agent-history
 */
export type CaseStatus = 'OPEN' | 'RESOLVED' | 'CLOSED';
export type CaseActivityKind =
  'CREATED' | 'LINKED' | 'REOPENED' | 'NOTE' | 'ASSIGNED' | 'STATUS_CHANGED';

export interface CaseSummary {
  id: string;
  subject: string;
  contactId: string;
  /**
   * ชื่อลูกค้าจาก Customer 360 ตามสิทธิ์ WORK ของผู้ดู
   * `undefined` ไม่มีข้อมูลลูกค้า (ถูกซ่อน/merge/หมดสิทธิ์), `null` มีลูกค้าแต่ไม่ระบุชื่อ
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
  /** เฉพาะ LINKED: งานเป็นของผู้ดูเอง จึงแสดงลิงก์ "เปิดในประวัติงาน" ได้ */
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
  /** false เมื่อผู้รับผิดชอบย้ายทีมหรือถูกปิดบัญชี */
  assigneeInTeam: boolean;
  reopenCount: number;
  createdByUserId: string;
  sourceInteractionId: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  activities: CaseActivity[];
}

/** ชื่อของผู้ใช้ที่ปรากฏในรายการหรือไทม์ไลน์ รวมคนที่ออกจากทีมไปแล้ว */
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
  /** null เมื่อโหลดลูกค้าไม่ได้หรือไม่มีสิทธิ์ ไทม์ไลน์และ action ยังใช้ได้ */
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

  /** มีคนแก้เคสก่อน หรือเคสถูกปิดไปแล้ว ต้องโหลดใหม่ก่อนทำต่อ */
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
   * คำสั่งเขียนรับ commandId จากผู้เรียก เพื่อให้กดส่งซ้ำหลังเครือข่ายล้มใช้ id เดิม
   * แล้ว server ตอบผลเดิมแทนการสร้างโน้ตหรือ activity ซ้ำ
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
