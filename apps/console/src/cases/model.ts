/**
 * #956 — logic ล้วนของหน้าเคสของทีม (URL, cursor, commandId, สถานะ, ไทม์ไลน์) แยกจาก React เพื่อทดสอบด้วย unit test
 */
import {
  CASE_PAGE_SIZE,
  CaseApiError,
  type CaseActivity,
  type CaseListFilter,
  type CasePeople,
  type CaseStatus,
  type CaseStatusFilter,
} from './api.js';

export type StatusFilterValue = CaseStatusFilter | 'ALL';
export type AssigneeScope = 'me' | 'team';

export interface CaseFilterState {
  status: StatusFilterValue;
  assignee: AssigneeScope;
}

export interface CasesRoute extends CaseFilterState {
  caseId: string | null;
}

export const DEFAULT_FILTER: CaseFilterState = { status: 'NOT_CLOSED', assignee: 'me' };
export const STATUS_FILTER_VALUES: readonly StatusFilterValue[] = [
  'NOT_CLOSED',
  'OPEN',
  'RESOLVED',
  'CLOSED',
  'ALL',
];

export function isDefaultFilter(filter: CaseFilterState): boolean {
  return filter.status === DEFAULT_FILTER.status && filter.assignee === DEFAULT_FILTER.assignee;
}

/** ค่าใน URL ที่ไม่รู้จักตกกลับค่าเริ่มต้น — ไม่ส่งค่าที่ผู้ใช้พิมพ์เองไป API */
export function parseCasesRoute(url: URL): CasesRoute {
  const status = url.searchParams.get('status');
  const assignee = url.searchParams.get('assignee');
  const caseId = url.searchParams.get('case')?.trim();
  return {
    status: STATUS_FILTER_VALUES.find((value) => value === status) ?? DEFAULT_FILTER.status,
    assignee: assignee === 'team' ? 'team' : 'me',
    caseId: caseId ? caseId : null,
  };
}

/** เขียนเฉพาะค่าที่ไม่ใช่ค่าเริ่มต้น และคง query อื่น (tenant, view) ไว้ — ไม่มี PII */
export function casesHref(base: URL, route: CasesRoute): URL {
  const next = new URL(base.href);
  next.searchParams.set('view', 'team-cases');
  for (const key of ['status', 'assignee', 'case']) next.searchParams.delete(key);
  if (route.status !== DEFAULT_FILTER.status) next.searchParams.set('status', route.status);
  if (route.assignee !== DEFAULT_FILTER.assignee) next.searchParams.set('assignee', route.assignee);
  if (route.caseId) next.searchParams.set('case', route.caseId);
  return next;
}

/** ลิงก์ไปประวัติงานของ Agent เอง (เฉพาะงานที่ `interactionMine`) */
export function historyHref(base: URL, interactionId: string): URL {
  const next = new URL(base.href);
  for (const key of ['status', 'assignee', 'case']) next.searchParams.delete(key);
  next.searchParams.set('view', 'agent-history');
  next.searchParams.set('interaction', interactionId);
  return next;
}

export function toListFilter(filter: CaseFilterState, cursor?: string): CaseListFilter {
  return {
    ...(filter.status === 'ALL' ? {} : { status: filter.status }),
    ...(filter.assignee === 'me' ? { assignedToMe: true } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** stack ของ cursor ฝั่ง client: ตำแหน่งสุดท้ายคือ cursor ของหน้าปัจจุบัน (undefined = หน้าแรก) */
export type CursorStack = readonly (string | undefined)[];
export const FIRST_PAGE: CursorStack = [undefined];
export const goNext = (stack: CursorStack, nextCursor: string): CursorStack => [
  ...stack,
  nextCursor,
];
export const goPrevious = (stack: CursorStack): CursorStack =>
  stack.length > 1 ? stack.slice(0, -1) : stack;
export const currentCursor = (stack: CursorStack) => stack[stack.length - 1];

export function pageRange(stack: CursorStack, count: number): { from: number; to: number } {
  const from = (stack.length - 1) * CASE_PAGE_SIZE + 1;
  return { from, to: from + count - 1 };
}

/** คำสั่งเขียนที่ผลยังไม่ทราบ: กดซ้ำด้วยคำสั่งเดิมต้องใช้ commandId เดิมเท่านั้น */
export interface PendingCommand {
  signature: string;
  commandId: string;
}

export const commandSignature = (
  kind: 'note' | 'assign' | 'status',
  caseId: string,
  expectedVersion: number,
  payload: string,
) => JSON.stringify([kind, caseId, expectedVersion, payload]);

export function commandFor(
  unknown: PendingCommand | undefined,
  signature: string,
  makeId: () => string,
): PendingCommand {
  return unknown && unknown.signature === signature ? unknown : { signature, commandId: makeId() };
}

export type CommandFailure =
  'unauthorized' | 'unknown' | 'stale' | 'assignee' | 'invalid' | 'notFound' | 'failed';

/**
 * network error/timeout/5xx = ไม่ทราบผล (คำสั่งอาจถูกบันทึกแล้ว) → ส่ง commandId เดิมซ้ำได้อย่างปลอดภัย
 * conflict/validation = ผลชัดเจน กดครั้งถัดไปใช้ id ใหม่
 */
export function classifyFailure(error: unknown): CommandFailure {
  if (!(error instanceof CaseApiError)) return 'unknown';
  if (error.status === 401) return 'unauthorized';
  if (error.stale || error.code === 'INVALID_TRANSITION') return 'stale';
  if (error.code === 'ASSIGNEE_NOT_IN_TEAM') return 'assignee';
  if (error.code === 'INVALID_INPUT') return 'invalid';
  if (error.status === 403 || error.status === 404 || error.code === 'CASE_NOT_FOUND')
    return 'notFound';
  if (error.status === 408 || error.status >= 500) return 'unknown';
  return 'failed';
}

export type CaseAction = 'assign' | 'resolve' | 'reopen' | 'close';

/** OPEN → RESOLVED → CLOSED; ปิดจาก OPEN ตรงไม่ได้ (ข้อ 8 คำถาม 2) */
export function actionsFor(status: CaseStatus): readonly CaseAction[] {
  if (status === 'OPEN') return ['assign', 'resolve'];
  if (status === 'RESOLVED') return ['assign', 'reopen', 'close'];
  return [];
}

export const statusTone = (status: CaseStatus) =>
  status === 'OPEN' ? 'info' : status === 'RESOLVED' ? 'success' : 'neutral';

export const NOTE_MAX = 2000;
export const NOTE_COLLAPSE_CHARS = 300;
export const TIMELINE_WINDOW = 50;

export function validateNote(raw: string): { ok: true; value: string } | { ok: false } {
  const value = raw.trim();
  return value.length >= 1 && value.length <= NOTE_MAX ? { ok: true, value } : { ok: false };
}

/** เก่าไปใหม่ — sort เสถียร ลำดับเดิมจาก server ใช้ตัดสินเมื่อเวลาเท่ากัน */
export function orderActivities(activities: readonly CaseActivity[]): CaseActivity[] {
  return activities
    .map((activity, index) => ({ activity, index, time: Date.parse(activity.occurredAt) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map((entry) => entry.activity);
}

export function visibleActivities(ordered: readonly CaseActivity[], window: number) {
  const items = ordered.slice(Math.max(0, ordered.length - window));
  return { items, hidden: ordered.length - items.length };
}

export const isLongNote = (body: string) => body.length > NOTE_COLLAPSE_CHARS;

export const shortId = (id: string) => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);

export function personName(
  people: CasePeople,
  userId: string | null | undefined,
): string | undefined {
  return userId ? people[userId] : undefined;
}
