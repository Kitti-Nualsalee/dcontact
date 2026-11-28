import { expect, test, type Page } from '@playwright/test';
import { th } from './support/catalog';

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SUBJECT = 'X200 unit is damaged, replacement requested';
test.use({ locale: 'th-TH' });

const caseId = '7a33ac96-d87d-4ca4-ab75-f27e40e943be';
const me = 'first'; // dc_user_id of the harness identity
const other = 'agent-2';
const people = { [me]: 'Somying Jaidee', [other]: 'Pakorn Srisuk' };

type Status = 'OPEN' | 'RESOLVED' | 'CLOSED';
interface Fixture {
  status: Status;
  version: number;
  assignee: string;
  notes: string[];
  commands: { path: string; commandId: string }[];
  failNext?: 'network' | 'conflict';
  seen: Set<string>;
  /** #1067: a case opened by a Journey has no subject and no author */
  automation?: boolean;
}

function activities(fixture: Fixture) {
  const blank = {
    interactionId: null,
    interactionMine: false,
    interactionChannel: null,
    interactionDirection: null,
    body: null,
    fromStatus: null,
    toStatus: null,
    assigneeUserId: null,
  };
  if (fixture.automation)
    return [
      {
        ...blank,
        id: 'a1',
        kind: 'CREATED',
        occurredAt: '2026-11-18T10:02:00.000Z',
        actorUserId: null,
        interactionId: '7f3c0000-0000-4000-8000-00000000a91e',
        interactionChannel: 'VOICE',
        interactionDirection: 'INBOUND',
      },
    ];
  return [
    {
      ...blank,
      id: 'a1',
      kind: 'CREATED',
      occurredAt: '2026-11-18T10:02:00.000Z',
      actorUserId: me,
      assigneeUserId: me,
    },
    {
      ...blank,
      id: 'a2',
      kind: 'LINKED',
      occurredAt: '2026-11-18T10:02:00.000Z',
      actorUserId: me,
      interactionId: '7f3c0000-0000-4000-8000-00000000a91e',
      interactionMine: true,
      interactionChannel: 'VOICE',
      interactionDirection: 'INBOUND',
    },
    ...fixture.notes.map((body, index) => ({
      ...blank,
      id: `n${index}`,
      kind: 'NOTE',
      occurredAt: `2026-11-19T09:0${index}:00.000Z`,
      actorUserId: me,
      body,
    })),
  ];
}

async function mockCases(page: Page, fixture: Fixture) {
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/workspace/agent/cases**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/workspace/agent/cases', '');
    if (request.method() === 'GET' && path === '') {
      const mine = url.searchParams.get('mine') === '1';
      const include =
        (!mine || (fixture.assignee === me && !fixture.automation)) &&
        (url.searchParams.get('status') !== 'NOT_CLOSED' || fixture.status !== 'CLOSED');
      return route.fulfill({
        json: {
          items: include
            ? [
                {
                  id: caseId,
                  subject: fixture.automation ? null : SUBJECT,
                  contactId: 'c1',
                  contactDisplayName: 'Napa Chanphen',
                  status: fixture.status,
                  assigneeUserId: fixture.automation ? null : fixture.assignee,
                  version: fixture.version,
                  linkedWorkCount: 1,
                  createdAt: '2026-11-18T10:02:00.000Z',
                  updatedAt: '2026-11-19T02:15:00.000Z',
                },
              ]
            : [],
          nextCursor: null,
          people,
          teamName: 'Retail Support',
        },
      });
    }
    if (request.method() === 'GET' && path === '/team-agents')
      return route.fulfill({
        json: {
          items: [
            { userId: me, displayName: people[me] },
            { userId: other, displayName: people[other] },
          ],
        },
      });
    if (request.method() === 'GET' && path === `/${caseId}`)
      return route.fulfill({
        json: {
          case: {
            id: caseId,
            subject: fixture.automation ? null : SUBJECT,
            contactId: 'c1',
            contactDisplayName: 'Napa Chanphen',
            status: fixture.status,
            assigneeUserId: fixture.automation ? null : fixture.assignee,
            version: fixture.version,
            linkedWorkCount: 1,
            createdAt: '2026-11-18T10:02:00.000Z',
            updatedAt: '2026-11-19T02:15:00.000Z',
            teamId: 't1',
            assigneeInTeam: true,
            reopenCount: 0,
            createdByUserId: fixture.automation ? null : me,
            sourceInteractionId: null,
            resolvedAt: null,
            closedAt: fixture.status === 'CLOSED' ? '2026-11-20T03:00:00.000Z' : null,
            activities: activities(fixture),
          },
          people,
          teamName: 'Retail Support',
          customer: { displayName: 'Napa Chanphen', company: 'Siam Retail Co.' },
        },
      });
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as {
        commandId: string;
        expectedVersion: number;
        note?: string;
        status?: Status;
        assigneeUserId?: string;
      };
      fixture.commands.push({ path, commandId: body.commandId });
      if (fixture.failNext === 'network') {
        fixture.failNext = undefined;
        // unknown result: the server recorded it but the response did not reach the user
        fixture.seen.add(body.commandId);
        apply(fixture, path, body);
        return route.abort('failed');
      }
      if (fixture.failNext === 'conflict') {
        fixture.failNext = undefined;
        return route.fulfill({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      }
      if (!fixture.seen.has(body.commandId)) {
        fixture.seen.add(body.commandId);
        apply(fixture, path, body);
      }
      return route.fulfill({ json: { caseId, version: fixture.version } });
    }
    return route.fulfill({ status: 404 });
  });
}

function apply(
  fixture: Fixture,
  path: string,
  body: { note?: string; status?: Status; assigneeUserId?: string },
) {
  fixture.version += 1;
  if (path.endsWith('/notes') && body.note) fixture.notes.push(body.note);
  if (path.endsWith('/status') && body.status) fixture.status = body.status;
  if (path.endsWith('/assignment') && body.assigneeUserId) fixture.assignee = body.assigneeUserId;
}

const newFixture = (): Fixture => ({
  status: 'OPEN',
  version: 1,
  assignee: me,
  notes: ['The customer reported a crack on the back cover'],
  commands: [],
  seen: new Set(),
});

test('an Agent views the list, opens a detail, adds a note, marks resolved, and closes the case with an alertdialog', async ({
  page,
}) => {
  const fixture = newFixture();
  await mockCases(page, fixture);
  await page.goto('/?view=team-cases&tenant=demo');

  // list: the default is not-closed + mine
  await expect(page.getByRole('heading', { name: th('cases:title'), level: 1 })).toBeVisible();
  await expect(page.getByRole('grid', { name: th('cases:list') })).toContainText(th('cases:you'));
  await expect(page.getByText(th('cases:page.range', { from: 1, to: 1 }))).toBeVisible();
  await page.getByRole('button', { name: th('cases:openItem', { subject: SUBJECT }) }).click();

  // detail: URL, timeline and the work history link (the viewer's own work)
  await expect(page.getByRole('heading', { name: /X200/, level: 1 })).toBeFocused();
  expect(new URL(page.url()).searchParams.get('case')).toBe(caseId);
  await expect(
    page.getByText(th('cases:timeline.openedSelf', { actor: people[me] })),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: th('cases:timeline.openHistory') })).toHaveAttribute(
    'href',
    /view=agent-history&.*interaction=/,
  );

  // add a note
  const note = page.getByRole('textbox', { name: th('cases:note.label') });
  await note.fill('<b>Warehouse</b> confirmed the stock');
  await page.getByRole('button', { name: th('cases:note.submit') }).click();
  await expect(
    page.getByText('<b>Warehouse</b> confirmed the stock', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.cs-note b')).toHaveCount(0);
  await expect(note).toBeFocused();
  await expect(note).toHaveValue('');

  // mark resolved: no confirmation, a new set of buttons and focus
  await page.getByRole('button', { name: th('cases:action.resolve') }).click();
  await expect(page.getByRole('button', { name: th('cases:action.reopen') })).toBeVisible();
  await expect(
    page
      .getByRole('group', { name: th('cases:detail.actions') })
      .getByRole('button')
      .first(),
  ).toBeFocused();

  // close the case: the alertdialog focus starts at cancel
  await page.getByRole('button', { name: th('cases:action.close'), exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('X200');
  await expect(dialog.getByRole('button', { name: th('cases:cancel') })).toBeFocused();
  await dialog.getByRole('button', { name: th('cases:action.close'), exact: true }).click();
  await expect(page.locator('.cs-bar-brand')).toContainText(
    th('cases:closedNotice', { time: '{TIME}' }).split('{TIME}')[0]!.trim(),
  );
  await expect(page.locator('.cs-bar-brand')).toBeFocused();
  await expect(page.getByRole('textbox', { name: th('cases:note.label') })).toHaveCount(0);
  await expect(page.getByRole('button', { name: th('cases:action.assign') })).toHaveCount(0);

  // every command has a distinct commandId
  expect(fixture.commands.map((c) => c.path.split('/').pop())).toEqual([
    'notes',
    'status',
    'status',
  ]);
  expect(new Set(fixture.commands.map((c) => c.commandId)).size).toBe(3);

  // Back returns to the list
  await page.goBack();
  await expect(page.getByRole('grid', { name: th('cases:list') })).toHaveCount(0);
  await expect(page.getByText(th('cases:emptyFilter'))).toHaveCount(0);
  await expect(page.getByRole('heading', { name: th('cases:title'), level: 1 })).toBeVisible();
});

test('assign through a Dialog and the whole-team filter is in the URL', async ({ page }) => {
  const fixture = newFixture();
  await mockCases(page, fixture);
  await page.goto('/?view=team-cases&tenant=demo&assignee=team&status=ALL');
  await expect(page.getByRole('grid', { name: th('cases:list') })).toBeVisible();
  await page.getByRole('link', { name: /X200/ }).click();
  await page.getByRole('button', { name: th('cases:action.assign') }).click();
  const dialog = page.getByRole('dialog', { name: th('cases:assign.title') });
  await dialog
    .getByRole('button', { name: new RegExp(escapeRegExp(th('cases:assign.field'))) })
    .click();
  await page.getByRole('option', { name: 'Pakorn Srisuk' }).click();
  await dialog.getByRole('button', { name: th('cases:assign.submit'), exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Pakorn Srisuk').first()).toBeVisible();
  expect(fixture.assignee).toBe(other);
  expect(new URL(page.url()).searchParams.get('assignee')).toBe('team');
});

test('unknown result: pressing send on the original command uses the original commandId and does not create a duplicate note', async ({
  page,
}) => {
  const fixture = newFixture();
  await mockCases(page, fixture);
  await page.goto(`/?view=team-cases&tenant=demo&case=${caseId}`);
  const note = page.getByRole('textbox', { name: th('cases:note.label') });
  await note.fill('Called the customer back');
  fixture.failNext = 'network';
  await page.getByRole('button', { name: th('cases:note.submit') }).click();
  const retry = page.getByRole('button', { name: th('cases:action.unknown') });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByText('Called the customer back', { exact: true })).toBeVisible();
  expect(fixture.commands).toHaveLength(2);
  expect(fixture.commands[1].commandId).toBe(fixture.commands[0].commandId);
  expect(fixture.notes.filter((n) => n === 'Called the customer back')).toHaveLength(1);
});

test('conflict: show the bar, keep the note draft, and load the latest case', async ({ page }) => {
  const fixture = newFixture();
  await mockCases(page, fixture);
  await page.goto(`/?view=team-cases&tenant=demo&case=${caseId}`);
  const note = page.getByRole('textbox', { name: th('cases:note.label') });
  await note.fill('A draft that must not be lost');
  fixture.failNext = 'conflict';
  await page.getByRole('button', { name: th('cases:note.submit') }).click();
  const alert = page.getByRole('alert').filter({ hasText: th('cases:conflict') });
  await expect(alert).toBeFocused();
  await expect(page.getByRole('button', { name: th('cases:note.submit') })).toBeDisabled();
  await expect(note).toHaveValue('A draft that must not be lost');
  fixture.version += 1;
  await page.getByRole('button', { name: th('cases:conflictReload') }).click();
  await expect(alert).toHaveCount(0);
  await expect(note).toHaveValue('A draft that must not be lost');
  await page.getByRole('button', { name: th('cases:note.submit') }).click();
  expect(fixture.commands[1].commandId).not.toBe(fixture.commands[0].commandId);
  expect(fixture.notes).toContain('A draft that must not be lost');
});

test('#1067 a case opened by a Journey shows a fallback subject and the automation as its author, and the team works it as usual', async ({
  page,
}) => {
  const fixture = { ...newFixture(), notes: [], automation: true };
  await mockCases(page, fixture);
  await page.goto(`/?view=team-cases&tenant=demo&assignee=team&case=${caseId}`);

  const subject = th('cases:automationSubject');
  await expect(page.getByRole('heading', { name: subject, level: 1 })).toBeVisible();
  const summary = page.locator('.cs-summary, .cs-detail').first();
  await expect(summary).toContainText(th('cases:actor.automation'));
  // the timeline names the automation instead of "user no longer in team"
  await expect(page.getByText(th('cases:actor.unknown'))).toHaveCount(0);
  await expect(page.locator('.cs-event-created')).toContainText(th('cases:actor.automation'));
  await expect(page.locator('.cs-event-created')).toContainText('7f3c');

  // nobody is assigned yet; the team takes it over with the normal commands
  await page
    .getByRole('textbox', { name: th('cases:note.label') })
    .fill('Called the customer back');
  await page.getByRole('button', { name: th('cases:note.submit') }).click();
  await expect
    .poll(() => fixture.commands.map((command) => command.path))
    .toEqual([`/${caseId}/notes`]);

  await page.getByRole('button', { name: th('cases:detail.back') }).click();
  await expect(page.getByRole('button', { name: th('cases:openItem', { subject }) })).toBeVisible();
});
