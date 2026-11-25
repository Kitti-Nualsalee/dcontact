/**
 * #956 — pure logic of the team cases page (URL, cursor, commandId, status, timeline), separated from React so it can be unit tested
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

/** an unknown URL value falls back to the default — a value the user typed is never sent to the API */
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

/** write only values that are not the default and keep other query params (tenant, view) — no PII */
export function casesHref(base: URL, route: CasesRoute): URL {
  const next = new URL(base.href);
  next.searchParams.set('view', 'team-cases');
  for (const key of ['status', 'assignee', 'case']) next.searchParams.delete(key);
  if (route.status !== DEFAULT_FILTER.status) next.searchParams.set('status', route.status);
  if (route.assignee !== DEFAULT_FILTER.assignee) next.searchParams.set('assignee', route.assignee);
  if (route.caseId) next.searchParams.set('case', route.caseId);
  return next;
}

/** link to the Agent's own work history (only for work with `interactionMine`) */
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

/** client-side cursor stack: the last entry is the cursor of the current page (undefined = first page) */
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

/** a write command with an unknown result: pressing again with the same command must use the same commandId only */
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
 * network error/timeout/5xx = unknown result (the command may have been recorded) → safe to resend the same commandId
 * conflict/validation = a definite result, the next press uses a new id
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

/** OPEN → RESOLVED → CLOSED; closing directly from OPEN is not allowed (item 8 question 2) */
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

/** oldest to newest — stable sort; the original server order decides when times are equal */
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
