/**
 * #956 — เคสที่ Agent เปิดจากงานและดูแลในทีม
 *
 * Cases ยังเป็นผู้เขียน `cs_*` เพียงรายเดียว: apps/api เรียกฟังก์ชันในไฟล์นี้แบบ in-process
 * (pattern เดียวกับ owner writer ของ customer-360) ไม่เขียนตารางเคสเอง
 *
 * ขอบเขตรอบแรก: เห็นและแก้ได้เฉพาะเคสของทีมตนเอง, สถานะ OPEN/RESOLVED/CLOSED,
 * ทุกคำสั่งมี commandId (command_receipts) และ expectedVersion บน `cs_cases.version`
 * เคสจาก J2 ENSURE_CASE ไม่มี team_id จึงไม่ปรากฏในมุมมองนี้
 */
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';

export const AGENT_CASE_TYPE_KEY = 'GENERAL';
export const CASE_SUBJECT_MAX = 200;
export const CASE_NOTE_MAX = 2000;
export const CASE_LIST_MAX = 100;

export type AgentCaseStatus = 'OPEN' | 'RESOLVED' | 'CLOSED';

export type AgentCaseErrorCode =
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

/** ชนิดของ error บอก apps/api ว่าควรตอบ HTTP แบบไหน โดยไม่ผูก Cases กับ NestJS */
export type AgentCaseErrorKind = 'FORBIDDEN' | 'INVALID' | 'NOT_FOUND' | 'CONFLICT';

const ERROR_KIND: Record<AgentCaseErrorCode, AgentCaseErrorKind> = {
  AGENT_REQUIRED: 'FORBIDDEN',
  TEAM_REQUIRED: 'FORBIDDEN',
  INVALID_INPUT: 'INVALID',
  WORK_NOT_FOUND: 'NOT_FOUND',
  WORK_NOT_ACTIVE: 'CONFLICT',
  WORK_HAS_CASE: 'CONFLICT',
  CONTACT_REQUIRED: 'CONFLICT',
  ASSIGNEE_NOT_IN_TEAM: 'INVALID',
  CASE_NOT_FOUND: 'NOT_FOUND',
  CASE_CLOSED: 'CONFLICT',
  INVALID_TRANSITION: 'CONFLICT',
  VERSION_CONFLICT: 'CONFLICT',
  COMMAND_ID_REUSED: 'CONFLICT',
  COMMAND_PAYLOAD_MISMATCH: 'CONFLICT',
};

export class AgentCaseError extends Error {
  readonly kind: AgentCaseErrorKind;

  constructor(
    readonly code: AgentCaseErrorCode,
    readonly field?: string,
  ) {
    super(field ? `${code}: ${field}` : code);
    this.name = 'AgentCaseError';
    this.kind = ERROR_KIND[code];
  }
}

export interface AgentCaseActor {
  tenantId: string;
  userId: string;
}

export interface AgentCaseRef {
  caseId: string;
  version: number;
}

export interface AgentCaseSummary {
  id: string;
  subject: string;
  contactId: string;
  status: AgentCaseStatus;
  assigneeUserId: string | null;
  version: number;
  linkedWorkCount: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentCaseActivityKind =
  'CREATED' | 'LINKED' | 'REOPENED' | 'NOTE' | 'ASSIGNED' | 'STATUS_CHANGED';

export interface AgentCaseActivity {
  id: string;
  kind: AgentCaseActivityKind;
  occurredAt: string;
  actorUserId: string | null;
  interactionId: string | null;
  /** งานที่ผูกเป็นของผู้ดูเอง จึงเปิดดูในประวัติงานของตนได้ */
  interactionMine: boolean;
  interactionChannel: string | null;
  interactionDirection: 'INBOUND' | 'OUTBOUND' | null;
  body: string | null;
  fromStatus: AgentCaseStatus | null;
  toStatus: AgentCaseStatus | null;
  assigneeUserId: string | null;
}

export interface AgentCaseDetail extends AgentCaseSummary {
  teamId: string;
  /** false เมื่อผู้รับผิดชอบย้ายทีมหรือถูกปิดบัญชี ต้องมอบหมายใหม่ */
  assigneeInTeam: boolean;
  reopenCount: number;
  createdByUserId: string;
  sourceInteractionId: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  activities: AgentCaseActivity[];
}

export type AgentCaseStatusFilter = AgentCaseStatus | 'NOT_CLOSED';

export interface AgentCaseListFilter {
  status?: AgentCaseStatusFilter;
  assignedToMe?: boolean;
  limit?: number;
  cursor?: string;
}

export interface AgentCaseListPage {
  items: AgentCaseSummary[];
  nextCursor: string | null;
}

export interface TeamAgent {
  userId: string;
  displayName: string;
}

export interface OpenCaseInput {
  commandId: string;
  interactionId: string;
  subject: string;
  note: string;
  assigneeUserId?: string;
}

export interface CaseCommandInput {
  commandId: string;
  expectedVersion: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * เส้นทางสถานะที่ Agent ทำได้: ต้องผ่าน RESOLVED ก่อนปิด, RESOLVED กลับ OPEN ได้
 * และ CLOSED จบแล้วแก้ไม่ได้
 */
const TRANSITIONS: Record<AgentCaseStatus, readonly AgentCaseStatus[]> = {
  OPEN: ['RESOLVED'],
  RESOLVED: ['OPEN', 'CLOSED'],
  CLOSED: [],
};

export function canTransition(from: AgentCaseStatus, to: AgentCaseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function uuidInput(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new AgentCaseError('INVALID_INPUT', field);
  return value.toLowerCase();
}

/** ตัดช่องว่างหัวท้าย ข้อความว่างหรือยาวเกินถือว่าไม่ถูกต้อง */
export function textInput(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new AgentCaseError('INVALID_INPUT', field);
  const text = value.trim();
  if (text.length === 0 || [...text].length > max) throw new AgentCaseError('INVALID_INPUT', field);
  return text;
}

export function versionInput(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AgentCaseError('INVALID_INPUT', 'expectedVersion');
  }
  return value;
}

export function statusInput(value: unknown): AgentCaseStatus {
  if (value === 'OPEN' || value === 'RESOLVED' || value === 'CLOSED') return value;
  throw new AgentCaseError('INVALID_INPUT', 'status');
}

export function statusFilterInput(value: unknown): AgentCaseStatusFilter | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'NOT_CLOSED') return value;
  return statusInput(value);
}

/** cursor ผูกกับตำแหน่ง (updated_at, id) ของแถวสุดท้ายในหน้าก่อน */
export function encodeCaseCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([updatedAt.toISOString(), id]), 'utf8').toString('base64url');
}

export function decodeCaseCursor(value: unknown): { updatedAt: Date; id: string } | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 200)
    throw new AgentCaseError('INVALID_INPUT', 'cursor');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string') {
      const updatedAt = new Date(parsed[0]);
      if (!Number.isNaN(updatedAt.getTime())) {
        return { updatedAt, id: uuidInput(parsed[1], 'cursor') };
      }
    }
  } catch {
    // ตกไปตอบ INVALID_INPUT ด้านล่าง
  }
  throw new AgentCaseError('INVALID_INPUT', 'cursor');
}

export function listLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > CASE_LIST_MAX) {
    throw new AgentCaseError('INVALID_INPUT', 'limit');
  }
  return value;
}

type Transaction = Prisma.TransactionClient;

interface CaseRow {
  id: string;
  team_id: string | null;
  status: AgentCaseStatus;
  version: number;
  assignee_user_id: string | null;
}

interface TeamActor extends AgentCaseActor {
  teamId: string;
}

function digest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

export class AgentCases {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    options: { id?: () => string; now?: () => Date } = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async teamAgents(actor: AgentCaseActor): Promise<TeamAgent[]> {
    return this.read(actor, async (transaction, teamActor) => {
      const rows = await transaction.user.findMany({
        where: {
          tenantId: teamActor.tenantId,
          teamId: teamActor.teamId,
          role: 'AGENT',
          isActive: true,
        },
        select: { id: true, displayName: true },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      });
      return rows.map((row) => ({ userId: row.id, displayName: row.displayName }));
    });
  }

  async list(actor: AgentCaseActor, filter: AgentCaseListFilter = {}): Promise<AgentCaseListPage> {
    const limit = listLimit(filter.limit);
    const status = statusFilterInput(filter.status);
    const cursor = decodeCaseCursor(filter.cursor);
    const statusClause =
      status === 'NOT_CLOSED'
        ? Prisma.sql`AND c.status <> 'CLOSED'::"CsCaseStatus"`
        : status
          ? Prisma.sql`AND c.status = ${status}::"CsCaseStatus"`
          : Prisma.empty;
    return this.read(actor, async (transaction, teamActor) => {
      const rows = await transaction.$queryRaw<
        {
          id: string;
          subject: string;
          contact_id: string;
          status: AgentCaseStatus;
          assignee_user_id: string | null;
          version: number;
          linked_work_count: bigint;
          created_at: Date;
          updated_at: Date;
        }[]
      >(Prisma.sql`
        SELECT c.id, c.subject, c.contact_id, c.status::text AS status, c.assignee_user_id,
               c.version, c.created_at, c.updated_at,
               (SELECT count(*) FROM cs_case_activities a
                 WHERE a.tenant_id = c.tenant_id AND a.case_id = c.id AND a.kind = 'LINKED')
                 AS linked_work_count
          FROM cs_cases c
         WHERE c.tenant_id = ${teamActor.tenantId}::uuid
           AND c.team_id = ${teamActor.teamId}::uuid
           ${statusClause}
           ${filter.assignedToMe ? Prisma.sql`AND c.assignee_user_id = ${teamActor.userId}::uuid` : Prisma.empty}
           ${cursor ? Prisma.sql`AND (c.updated_at, c.id) < (${cursor.updatedAt.toISOString()}::timestamp(3), ${cursor.id}::uuid)` : Prisma.empty}
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT ${limit + 1}`);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const items = page.map((row) => ({
        id: row.id,
        subject: row.subject,
        contactId: row.contact_id,
        status: row.status,
        assigneeUserId: row.assignee_user_id,
        version: row.version,
        linkedWorkCount: Number(row.linked_work_count),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }));
      return {
        items,
        nextCursor: rows.length > limit && last ? encodeCaseCursor(last.updated_at, last.id) : null,
      };
    });
  }

  async detail(actor: AgentCaseActor, caseIdValue: unknown): Promise<AgentCaseDetail> {
    const caseId = uuidInput(caseIdValue, 'caseId');
    return this.read(actor, (transaction, teamActor) =>
      this.loadDetail(transaction, teamActor, caseId),
    );
  }

  async open(actor: AgentCaseActor, body: Record<string, unknown>): Promise<AgentCaseRef> {
    const commandId = uuidInput(body.commandId, 'commandId');
    const interactionId = uuidInput(body.interactionId, 'interactionId');
    const subject = textInput(body.subject, 'subject', CASE_SUBJECT_MAX);
    const note = textInput(body.note, 'note', CASE_NOTE_MAX);
    const requestedAssignee =
      body.assigneeUserId === undefined || body.assigneeUserId === null
        ? undefined
        : uuidInput(body.assigneeUserId, 'assigneeUserId');
    const payloadDigest = digest([1, interactionId, subject, note, requestedAssignee ?? null]);

    return this.write(
      actor,
      commandId,
      'case.open',
      payloadDigest,
      async (transaction, teamActor) => {
        const [interaction] = await transaction.$queryRaw<
          { contact_id: string | null; state: string }[]
        >(Prisma.sql`
        SELECT contact_id, state::text AS state FROM interactions
         WHERE tenant_id = ${teamActor.tenantId}::uuid AND id = ${interactionId}::uuid
           AND agent_id = ${teamActor.userId}::uuid
         FOR NO KEY UPDATE`);
        // งานของ Agent คนอื่นหรือของ tenant อื่นตอบเหมือนไม่พบ เพื่อไม่เปิดเผยว่ามีอยู่
        if (!interaction) throw new AgentCaseError('WORK_NOT_FOUND');
        // รอบแรกเปิดเคสได้ระหว่างคุยหรือสรุปผลเท่านั้น งานที่บันทึกผลจบแล้วไม่รับ
        if (interaction.state !== 'ACTIVE' && interaction.state !== 'WRAPUP') {
          throw new AgentCaseError('WORK_NOT_ACTIVE');
        }
        if (!interaction.contact_id) throw new AgentCaseError('CONTACT_REQUIRED');
        // ADR-016 case 1 : N interaction — งานหนึ่งอยู่ได้ในเคสเดียว (มี partial unique index กันซ้ำ)
        const existing = await transaction.csCase.findFirst({
          where: { tenantId: teamActor.tenantId, sourceInteractionId: interactionId },
          select: { id: true },
        });
        if (existing) throw new AgentCaseError('WORK_HAS_CASE');

        const assigneeUserId = requestedAssignee ?? teamActor.userId;
        await this.requireTeamAgent(transaction, teamActor, assigneeUserId);

        const caseId = this.id();
        const now = this.now();
        await transaction.csCase.create({
          data: {
            id: caseId,
            tenantId: teamActor.tenantId,
            contactId: interaction.contact_id,
            caseTypeKey: AGENT_CASE_TYPE_KEY,
            status: 'OPEN',
            version: 1,
            subject,
            teamId: teamActor.teamId,
            assigneeUserId,
            createdByUserId: teamActor.userId,
            sourceInteractionId: interactionId,
            createdAt: now,
          },
        });
        // ไทม์ไลน์เรียงตามเวลาแล้วตาม id จึงเลื่อนเวลาทีละ ms ให้ลำดับ เปิด → ผูกงาน → โน้ต คงที่
        await this.activity(transaction, teamActor, caseId, now, 0, {
          kind: 'CREATED',
          assigneeUserId,
        });
        await this.activity(transaction, teamActor, caseId, now, 1, {
          kind: 'LINKED',
          interactionId,
        });
        await this.activity(transaction, teamActor, caseId, now, 2, { kind: 'NOTE', body: note });
        return { caseId, version: 1 };
      },
    );
  }

  async addNote(
    actor: AgentCaseActor,
    caseIdValue: unknown,
    body: Record<string, unknown>,
  ): Promise<AgentCaseRef> {
    const caseId = uuidInput(caseIdValue, 'caseId');
    const command = this.command(body);
    const note = textInput(body.note, 'note', CASE_NOTE_MAX);
    const payloadDigest = digest([1, caseId, command.expectedVersion, note]);
    return this.write(
      actor,
      command.commandId,
      'case.note',
      payloadDigest,
      async (transaction, teamActor) => {
        const current = await this.lockOpenCase(
          transaction,
          teamActor,
          caseId,
          command.expectedVersion,
        );
        return this.bump(transaction, teamActor, current, {}, { kind: 'NOTE', body: note });
      },
      caseId,
    );
  }

  async assign(
    actor: AgentCaseActor,
    caseIdValue: unknown,
    body: Record<string, unknown>,
  ): Promise<AgentCaseRef> {
    const caseId = uuidInput(caseIdValue, 'caseId');
    const command = this.command(body);
    const assigneeUserId = uuidInput(body.assigneeUserId, 'assigneeUserId');
    const payloadDigest = digest([1, caseId, command.expectedVersion, assigneeUserId]);
    return this.write(
      actor,
      command.commandId,
      'case.assign',
      payloadDigest,
      async (transaction, teamActor) => {
        const current = await this.lockOpenCase(
          transaction,
          teamActor,
          caseId,
          command.expectedVersion,
        );
        await this.requireTeamAgent(transaction, teamActor, assigneeUserId);
        return this.bump(
          transaction,
          teamActor,
          current,
          { assigneeUserId },
          { kind: 'ASSIGNED', assigneeUserId },
        );
      },
      caseId,
    );
  }

  async changeStatus(
    actor: AgentCaseActor,
    caseIdValue: unknown,
    body: Record<string, unknown>,
  ): Promise<AgentCaseRef> {
    const caseId = uuidInput(caseIdValue, 'caseId');
    const command = this.command(body);
    const toStatus = statusInput(body.status);
    const payloadDigest = digest([1, caseId, command.expectedVersion, toStatus]);
    return this.write(
      actor,
      command.commandId,
      'case.status',
      payloadDigest,
      async (transaction, teamActor) => {
        const current = await this.lockOpenCase(
          transaction,
          teamActor,
          caseId,
          command.expectedVersion,
        );
        if (!canTransition(current.status, toStatus))
          throw new AgentCaseError('INVALID_TRANSITION');
        const now = this.now();
        const reopening = current.status === 'RESOLVED' && toStatus === 'OPEN';
        return this.bump(
          transaction,
          teamActor,
          current,
          {
            status: toStatus,
            ...(toStatus === 'RESOLVED' ? { resolvedAt: now } : {}),
            ...(reopening ? { resolvedAt: null, reopenCount: { increment: 1 } } : {}),
            ...(toStatus === 'CLOSED' ? { closedAt: now } : {}),
          },
          { kind: 'STATUS_CHANGED', fromStatus: current.status, toStatus },
        );
      },
      caseId,
    );
  }

  private command(body: Record<string, unknown>): CaseCommandInput {
    return {
      commandId: uuidInput(body.commandId, 'commandId'),
      expectedVersion: versionInput(body.expectedVersion),
    };
  }

  /** ผู้เรียกต้องเป็น Agent ที่ active และมีทีม ตรวจใหม่ทุกคำสั่งภายใต้ transaction เดียวกัน */
  private async teamActor(transaction: Transaction, actor: AgentCaseActor): Promise<TeamActor> {
    const user = await transaction.user.findFirst({
      where: { id: actor.userId, tenantId: actor.tenantId, role: 'AGENT', isActive: true },
      select: { teamId: true },
    });
    if (!user) throw new AgentCaseError('AGENT_REQUIRED');
    if (!user.teamId) throw new AgentCaseError('TEAM_REQUIRED');
    return { ...actor, teamId: user.teamId };
  }

  private async requireTeamAgent(
    transaction: Transaction,
    actor: TeamActor,
    userId: string,
  ): Promise<void> {
    const assignee = await transaction.user.findFirst({
      where: {
        id: userId,
        tenantId: actor.tenantId,
        teamId: actor.teamId,
        role: 'AGENT',
        isActive: true,
      },
      select: { id: true },
    });
    if (!assignee) throw new AgentCaseError('ASSIGNEE_NOT_IN_TEAM');
  }

  private async read<T>(
    actor: AgentCaseActor,
    work: (transaction: Transaction, actor: TeamActor) => Promise<T>,
  ): Promise<T> {
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) =>
      work(transaction, await this.teamActor(transaction, actor)),
    );
  }

  /**
   * ทุกคำสั่งเขียนผ่านที่นี่: lock ต่อ commandId, ส่งผลเดิมคืนถ้าคำสั่งเคย commit แล้ว,
   * แล้วบันทึก receipt ใน transaction เดียวกับการเปลี่ยนเคส
   */
  private async write(
    actor: AgentCaseActor,
    commandId: string,
    action: string,
    payloadDigest: string,
    work: (transaction: Transaction, actor: TeamActor) => Promise<AgentCaseRef>,
    resourceId?: string,
  ): Promise<AgentCaseRef> {
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.tenantId}:${commandId}`}, 0))`,
      );
      const teamActor = await this.teamActor(transaction, actor);
      const receipt = await transaction.commandReceipt.findUnique({
        where: { tenantId_commandId: { tenantId: actor.tenantId, commandId } },
      });
      if (receipt) {
        if (
          receipt.actorUserId !== actor.userId ||
          receipt.action !== action ||
          (resourceId !== undefined && receipt.resourceId !== resourceId)
        ) {
          throw new AgentCaseError('COMMAND_ID_REUSED');
        }
        if (receipt.payloadDigest !== payloadDigest) {
          throw new AgentCaseError('COMMAND_PAYLOAD_MISMATCH');
        }
        return receipt.result as unknown as AgentCaseRef;
      }
      const result = await work(transaction, teamActor);
      await transaction.commandReceipt.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          commandId,
          resourceId: result.caseId,
          action,
          payloadDigest,
          result: { caseId: result.caseId, version: result.version },
        },
      });
      return result;
    });
  }

  /** เคสของทีมอื่นหรือเคสจาก J2 ที่ไม่มีทีม ตอบเหมือนไม่พบ */
  private async lockOpenCase(
    transaction: Transaction,
    actor: TeamActor,
    caseId: string,
    expectedVersion: number,
  ): Promise<CaseRow> {
    const [row] = await transaction.$queryRaw<CaseRow[]>(Prisma.sql`
      SELECT id, team_id, status::text AS status, version, assignee_user_id
        FROM cs_cases
       WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${caseId}::uuid
         AND team_id = ${actor.teamId}::uuid
       FOR UPDATE`);
    if (!row) throw new AgentCaseError('CASE_NOT_FOUND');
    if (row.status === 'CLOSED') throw new AgentCaseError('CASE_CLOSED');
    if (row.version !== expectedVersion) throw new AgentCaseError('VERSION_CONFLICT');
    return row;
  }

  private async bump(
    transaction: Transaction,
    actor: TeamActor,
    current: CaseRow,
    data: Prisma.CsCaseUpdateInput,
    activity: ActivityInput,
  ): Promise<AgentCaseRef> {
    const updated = await transaction.csCase.update({
      where: { id: current.id },
      data: { ...data, version: { increment: 1 } },
      select: { version: true },
    });
    await this.activity(transaction, actor, current.id, this.now(), 0, activity);
    return { caseId: current.id, version: updated.version };
  }

  private async activity(
    transaction: Transaction,
    actor: TeamActor,
    caseId: string,
    at: Date,
    offsetMs: number,
    input: ActivityInput,
  ): Promise<void> {
    await transaction.csCaseActivity.create({
      data: {
        id: this.id(),
        tenantId: actor.tenantId,
        caseId,
        kind: input.kind,
        actorUserId: actor.userId,
        occurredAt: new Date(at.getTime() + offsetMs),
        ...(input.interactionId ? { interactionId: input.interactionId } : {}),
        ...(input.body ? { body: input.body } : {}),
        ...(input.fromStatus ? { fromStatus: input.fromStatus } : {}),
        ...(input.toStatus ? { toStatus: input.toStatus } : {}),
        ...(input.assigneeUserId ? { assigneeUserId: input.assigneeUserId } : {}),
      },
    });
  }

  private async loadDetail(
    transaction: Transaction,
    actor: TeamActor,
    caseId: string,
  ): Promise<AgentCaseDetail> {
    const found = await transaction.csCase.findFirst({
      where: { id: caseId, tenantId: actor.tenantId, teamId: actor.teamId },
    });
    if (!found || !found.subject || !found.teamId || !found.createdByUserId) {
      throw new AgentCaseError('CASE_NOT_FOUND');
    }
    const activities = await transaction.csCaseActivity.findMany({
      where: { tenantId: actor.tenantId, caseId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    const linkedIds = activities.flatMap((activity) =>
      activity.kind === 'LINKED' && activity.interactionId && UUID.test(activity.interactionId)
        ? [activity.interactionId]
        : [],
    );
    const [linkedWork, assignee] = await Promise.all([
      linkedIds.length === 0
        ? Promise.resolve([])
        : transaction.interaction.findMany({
            where: { tenantId: actor.tenantId, id: { in: linkedIds } },
            select: { id: true, agentId: true, channel: true, direction: true },
          }),
      found.assigneeUserId
        ? transaction.user.findFirst({
            where: {
              id: found.assigneeUserId,
              tenantId: actor.tenantId,
              teamId: found.teamId,
              role: 'AGENT',
              isActive: true,
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    const work = new Map(linkedWork.map((row) => [row.id, row]));
    return {
      id: found.id,
      subject: found.subject,
      contactId: found.contactId,
      status: found.status,
      assigneeUserId: found.assigneeUserId,
      version: found.version,
      linkedWorkCount: activities.filter((activity) => activity.kind === 'LINKED').length,
      createdAt: found.createdAt.toISOString(),
      updatedAt: found.updatedAt.toISOString(),
      teamId: found.teamId,
      assigneeInTeam: assignee !== null,
      reopenCount: found.reopenCount,
      createdByUserId: found.createdByUserId,
      sourceInteractionId: found.sourceInteractionId,
      resolvedAt: found.resolvedAt?.toISOString() ?? null,
      closedAt: found.closedAt?.toISOString() ?? null,
      activities: activities.map((activity) => ({
        id: activity.id,
        kind: activity.kind,
        occurredAt: activity.occurredAt.toISOString(),
        actorUserId: activity.actorUserId,
        interactionId: activity.interactionId,
        interactionMine:
          activity.interactionId !== null &&
          work.get(activity.interactionId)?.agentId === actor.userId,
        interactionChannel:
          (activity.interactionId && work.get(activity.interactionId)?.channel) || null,
        interactionDirection:
          (activity.interactionId && work.get(activity.interactionId)?.direction) || null,
        body: activity.body,
        fromStatus: activity.fromStatus,
        toStatus: activity.toStatus,
        assigneeUserId: activity.assigneeUserId,
      })),
    };
  }
}

interface ActivityInput {
  kind: 'CREATED' | 'LINKED' | 'NOTE' | 'ASSIGNED' | 'STATUS_CHANGED';
  interactionId?: string;
  body?: string;
  fromStatus?: AgentCaseStatus;
  toStatus?: AgentCaseStatus;
  assigneeUserId?: string;
}
