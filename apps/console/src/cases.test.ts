import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseApiError, type CaseActivity } from './cases/api.js';
import {
  FIRST_PAGE,
  actionsFor,
  casesHref,
  classifyFailure,
  commandFor,
  commandSignature,
  currentCursor,
  goNext,
  goPrevious,
  historyHref,
  orderActivities,
  pageRange,
  parseCasesRoute,
  toListFilter,
  validateNote,
  visibleActivities,
} from './cases/model.js';

const base = 'https://console.example/?view=team-cases&tenant=demo';

test('route: the default is not-closed + mine, and an unknown value falls back to the default', () => {
  assert.deepEqual(parseCasesRoute(new URL(base)), {
    status: 'NOT_CLOSED',
    assignee: 'me',
    caseId: null,
  });
  const route = parseCasesRoute(new URL(`${base}&status=EVIL&assignee=all&case=abc`));
  assert.equal(route.status, 'NOT_CLOSED');
  assert.equal(route.assignee, 'me');
  assert.equal(route.caseId, 'abc');
  assert.equal(parseCasesRoute(new URL(`${base}&status=ALL&assignee=team`)).status, 'ALL');
});

test('href: writes only non-default values, keeps tenant and carries no old value over', () => {
  const defaults = casesHref(new URL(`${base}&status=OPEN&case=x`), {
    status: 'NOT_CLOSED',
    assignee: 'me',
    caseId: null,
  });
  assert.equal(defaults.search, '?view=team-cases&tenant=demo');
  const detail = casesHref(new URL(base), { status: 'ALL', assignee: 'team', caseId: 'c1' });
  assert.equal(detail.searchParams.get('status'), 'ALL');
  assert.equal(detail.searchParams.get('assignee'), 'team');
  assert.equal(detail.searchParams.get('case'), 'c1');
  assert.equal(detail.searchParams.get('tenant'), 'demo');
  const history = historyHref(new URL(`${base}&status=OPEN&case=x`), 'i1');
  assert.equal(history.search, '?view=agent-history&tenant=demo&interaction=i1');
});

test('list filter: all statuses send no status, mine sends assignedToMe', () => {
  assert.deepEqual(toListFilter({ status: 'NOT_CLOSED', assignee: 'me' }), {
    status: 'NOT_CLOSED',
    assignedToMe: true,
  });
  assert.deepEqual(toListFilter({ status: 'ALL', assignee: 'team' }, 'c2'), { cursor: 'c2' });
});

test('cursor stack: next/previous and the row range at 25 per page', () => {
  assert.equal(currentCursor(FIRST_PAGE), undefined);
  assert.deepEqual(pageRange(FIRST_PAGE, 25), { from: 1, to: 25 });
  const second = goNext(FIRST_PAGE, 'c1');
  assert.equal(currentCursor(second), 'c1');
  assert.deepEqual(pageRange(second, 7), { from: 26, to: 32 });
  const third = goNext(second, 'c2');
  assert.equal(currentCursor(goPrevious(third)), 'c1');
  assert.equal(goPrevious(FIRST_PAGE), FIRST_PAGE);
});

test('commandId: reuse the same id only when the command is exactly the same', () => {
  let n = 0;
  const make = () => `id-${++n}`;
  const sig = commandSignature('note', 'c1', 3, 'hello');
  const first = commandFor(undefined, sig, make);
  assert.equal(first.commandId, 'id-1');
  // pressing again after an unknown result = the same id, make is not called
  assert.equal(commandFor(first, sig, make).commandId, 'id-1');
  assert.equal(n, 1);
  // version or content changed = a new command
  assert.equal(
    commandFor(first, commandSignature('note', 'c1', 4, 'hello'), make).commandId,
    'id-2',
  );
  assert.equal(
    commandFor(first, commandSignature('note', 'c1', 3, 'edit'), make).commandId,
    'id-3',
  );
});

test('failure: network/5xx = unknown result, conflict/validation = definite result', () => {
  assert.equal(classifyFailure(new TypeError('Failed to fetch')), 'unknown');
  assert.equal(classifyFailure(new CaseApiError(503)), 'unknown');
  assert.equal(classifyFailure(new CaseApiError(408)), 'unknown');
  assert.equal(classifyFailure(new CaseApiError(401)), 'unauthorized');
  assert.equal(classifyFailure(new CaseApiError(409, 'VERSION_CONFLICT')), 'stale');
  assert.equal(classifyFailure(new CaseApiError(409, 'CASE_CLOSED')), 'stale');
  assert.equal(classifyFailure(new CaseApiError(409, 'INVALID_TRANSITION')), 'stale');
  assert.equal(classifyFailure(new CaseApiError(422, 'ASSIGNEE_NOT_IN_TEAM')), 'assignee');
  assert.equal(classifyFailure(new CaseApiError(400, 'INVALID_INPUT')), 'invalid');
  assert.equal(classifyFailure(new CaseApiError(404, 'CASE_NOT_FOUND')), 'notFound');
  assert.equal(classifyFailure(new CaseApiError(403)), 'notFound');
  assert.equal(classifyFailure(new CaseApiError(409, 'COMMAND_PAYLOAD_MISMATCH')), 'failed');
});

test('actions by status: cannot close directly from OPEN, and CLOSED is read-only', () => {
  assert.deepEqual(actionsFor('OPEN'), ['assign', 'resolve']);
  assert.deepEqual(actionsFor('RESOLVED'), ['assign', 'reopen', 'close']);
  assert.deepEqual(actionsFor('CLOSED'), []);
});

test('note: after trimming it must be 1–2,000 long', () => {
  assert.deepEqual(validateNote('  ok  '), { ok: true, value: 'ok' });
  assert.equal(validateNote('   ').ok, false);
  assert.equal(validateNote('ก'.repeat(2000)).ok, true); // allow-thai: limit counts Thai characters, not bytes
  assert.equal(validateNote('ก'.repeat(2001)).ok, false); // allow-thai: limit counts Thai characters, not bytes
});

const activity = (id: string, occurredAt: string): CaseActivity => ({
  id,
  kind: 'NOTE',
  occurredAt,
  actorUserId: null,
  interactionId: null,
  interactionMine: false,
  interactionChannel: null,
  interactionDirection: null,
  body: id,
  fromStatus: null,
  toStatus: null,
  assigneeUserId: null,
});

test('timeline: oldest to newest, equal times keep the server order, and it is cut to the latest entries', () => {
  const ordered = orderActivities([
    activity('c', '2026-11-19T09:00:00Z'),
    activity('a1', '2026-11-18T10:00:00Z'),
    activity('a2', '2026-11-18T10:00:00Z'),
    activity('a3', '2026-11-18T10:00:00Z'),
  ]);
  assert.deepEqual(
    ordered.map((a) => a.id),
    ['a1', 'a2', 'a3', 'c'],
  );
  const window = visibleActivities(ordered, 2);
  assert.deepEqual(
    window.items.map((a) => a.id),
    ['a3', 'c'],
  );
  assert.equal(window.hidden, 2);
  assert.equal(visibleActivities(ordered, 50).hidden, 0);
});
