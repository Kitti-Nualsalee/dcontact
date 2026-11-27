import { expect, test, type Page } from '@playwright/test';
import { th } from './support/catalog';

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
test.use({ locale: 'th-TH' });

/** #986 team history and summary — mock API, verifies UI only and does not replace permission evidence from the DB (that is in integration) */
const teamA = '7a33ac96-d87d-4ca4-ab75-f27e40e94a01';
const teamB = '7a33ac96-d87d-4ca4-ab75-f27e40e94a02';
const agentA = '7a33ac96-d87d-4ca4-ab75-f27e40e94b01';
const agentA2 = '7a33ac96-d87d-4ca4-ab75-f27e40e94b02';
const callA = '7a33ac96-d87d-4ca4-ab75-f27e40e94c01';
const callA2 = '7a33ac96-d87d-4ca4-ab75-f27e40e94c02';
const callB = '7a33ac96-d87d-4ca4-ab75-f27e40e94c03';
const period = {
  key: '7d',
  from: '2026-11-15T17:00:00.000Z',
  to: '2026-11-22T17:00:00.000Z',
  timeZone: 'Asia/Bangkok',
};
const item = (
  interactionId: string,
  agent: { id: string; displayName: string },
  team: { id: string; name: string },
  disposition: string,
) => ({
  interactionId,
  agent,
  team,
  startedAt: '2026-11-20T07:00:00.000Z',
  endedAt: '2026-11-20T07:01:10.000Z',
  talkSeconds: 70,
  disposition,
  recordedAt: '2026-11-20T07:02:00.000Z',
  recordedAtSource: 'SERVER_COMMIT',
  legacy: false,
});
const A = { id: teamA, name: 'Customer Care' };
const B = { id: teamB, name: 'Sales' };
const agentOne = { id: agentA, displayName: 'Somchai' };
const agentTwo = { id: agentA2, displayName: 'Somying' };
const rows = [
  item(callA, agentOne, A, 'CUSTOMER_ASSISTED'),
  item(callA2, agentTwo, A, 'FOLLOW_UP_REQUIRED'),
  item(callB, { id: agentA, displayName: 'Somchai' }, B, 'CUSTOMER_ASSISTED'),
];

async function harness(page: Page, role: 'supervisor' | 'admin') {
  const requests: string[] = [];
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/team-history/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.split('/team-history/')[1];
    requests.push(`${path}?${url.searchParams.toString()}`);
    const teamId = url.searchParams.get('teamId') ?? (role === 'supervisor' ? teamA : null);
    const scoped = rows.filter((row) => !teamId || row.team.id === teamId);
    if (path === 'teams')
      return route.fulfill({
        json:
          role === 'admin'
            ? {
                allTeams: true,
                items: [
                  { ...A, isActive: true },
                  { ...B, isActive: false },
                ],
              }
            : { allTeams: false, items: [{ ...A, isActive: true }] },
      });
    if (path === 'summary') {
      const byAgent = [agentOne, agentTwo]
        .map((agent) => ({
          agent,
          completed: scoped.filter((row) => row.agent.id === agent.id).length,
          talk: { averageSeconds: 70, measuredCount: 1 },
        }))
        .filter((row) => row.completed);
      return route.fulfill({
        json: {
          teamId,
          period,
          completed: scoped.length,
          talk: { averageSeconds: 70, measuredCount: scoped.length },
          byDisposition: ['CUSTOMER_ASSISTED', 'FOLLOW_UP_REQUIRED']
            .map((disposition) => ({
              disposition,
              count: scoped.filter((row) => row.disposition === disposition).length,
            }))
            .filter((group) => group.count),
          byAgent,
        },
      });
    }
    if (path === 'items') {
      const agentId = url.searchParams.get('agentId');
      const disposition = url.searchParams.get('disposition');
      return route.fulfill({
        json: {
          teamId,
          items: scoped.filter(
            (row) =>
              (!agentId || row.agent.id === agentId) &&
              (!disposition || row.disposition === disposition),
          ),
          nextCursor: null,
        },
      });
    }
    if (path === `items/${callA2}`)
      return route.fulfill({
        json: {
          ...rows[1],
          talkSeconds: 125,
          note: 'The customer asked for a call back tomorrow\nbefore 10 a.m.',
        },
      });
    return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });
  return requests;
}

test('a Supervisor sees their own team summary, presses an Agent number, and sees the source list and notes', async ({
  page,
}) => {
  const requests = await harness(page, 'supervisor');
  await page.goto('/?view=team-history&tenant=demo');
  await expect(
    page.getByRole('heading', { name: th('teamHistory:title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Customer Care', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: th('teamHistory:team') })).toHaveCount(0);
  const summary = page.getByRole('region', { name: th('teamHistory:summary.title') });
  await expect(
    summary.getByRole('button', { name: th('teamHistory:summary.showAll', { count: 2 }) }),
  ).toBeVisible();
  await expect(
    page.getByRole('grid', { name: th('teamHistory:list') }).getByRole('row'),
  ).toHaveCount(3);
  await summary
    .getByRole('button', {
      name: new RegExp(
        `^${escapeRegExp(th('teamHistory:summary.agentCountNoTalk', { agent: 'Somying', count: 1 }))}`,
      ),
    })
    .click();
  await expect(
    summary.getByRole('button', {
      name: new RegExp(
        `^${escapeRegExp(th('teamHistory:summary.agentCountNoTalk', { agent: 'Somying', count: 1 }))}`,
      ),
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('heading', {
      name: th('teamHistory:summary.listTitle', {
        period: th('teamHistory:summary.period.7d'),
        channel: th('history:channels.all'),
        agent: 'Somying',
        disposition: th('teamHistory:summary.allDispositions'),
        count: 1,
      }),
    }),
  ).toBeVisible();
  await expect
    .poll(() => requests.some((request) => request.includes(`agentId=${agentA2}`)))
    .toBe(true);
  await expect(page).toHaveURL(new RegExp(`agent=${agentA2}`));
  await page
    .getByRole('button', {
      name: th('teamHistory:openItem', { interactionId: callA2, agent: 'Somying' }),
    })
    .click();
  await expect(page.getByRole('heading', { name: th('teamHistory:detail') })).toBeVisible();
  await expect(page.getByText(/The customer asked for a call back tomorrow/)).toBeVisible();
  await expect(page.getByText(`${th('teamHistory:talk')}: 2:05`)).toBeVisible();
  await page.getByRole('button', { name: th('teamHistory:back') }).click();
  await expect(
    page.getByRole('heading', {
      name: th('teamHistory:summary.listTitle', {
        period: th('teamHistory:summary.period.7d'),
        channel: th('history:channels.all'),
        agent: 'Somying',
        disposition: th('teamHistory:summary.allDispositions'),
        count: 1,
      }),
    }),
  ).toBeVisible();
  // both Agent and disposition selected: the summary has no count for this pair, so the list heading shows no count
  await summary
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(th('teamHistory:followUp'))}`) })
    .click();
  await expect(
    page.getByRole('heading', {
      name: th('teamHistory:summary.listTitleNoCount', {
        period: th('teamHistory:summary.period.7d'),
        channel: th('history:channels.all'),
        agent: 'Somying',
        disposition: th('teamHistory:followUp'),
      }),
      exact: true,
    }),
  ).toBeVisible();
  expect(requests.every((request) => !request.includes(`teamId=${teamB}`))).toBe(true);
});

test('an Admin views all teams then picks one at a time, and a disabled team can still be selected to view history', async ({
  page,
}) => {
  const requests = await harness(page, 'admin');
  await page.goto('/?view=team-history&tenant=demo');
  const summary = page.getByRole('region', { name: th('teamHistory:summary.title') });
  await expect(
    summary.getByRole('button', { name: th('teamHistory:summary.showAll', { count: 3 }) }),
  ).toBeVisible();
  await expect(page.getByRole('columnheader', { name: th('teamHistory:team') })).toBeVisible();
  await page
    .getByRole('button', { name: new RegExp(escapeRegExp(th('teamHistory:team'))) })
    .first()
    .click();
  await page
    .getByRole('option', { name: th('teamHistory:teamInactive', { name: 'Sales' }) })
    .click();
  await expect(
    summary.getByRole('button', { name: th('teamHistory:summary.showAll', { count: 1 }) }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`team=${teamB}`));
  await expect(page.getByRole('columnheader', { name: th('teamHistory:team') })).toHaveCount(0);
  expect(requests.some((request) => request.startsWith('summary') && request.includes(teamB))).toBe(
    true,
  );
});

test('the API rejects permission, then shows a message and a try-again button', async ({
  page,
}) => {
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/team-history/**', (route) =>
    route.fulfill({ status: 403, json: { code: 'TEAM_HISTORY_ACCESS_DENIED' } }),
  );
  await page.goto('/?view=team-history&tenant=demo');
  await expect(page.getByRole('alert')).toContainText(th('teamHistory:forbidden'));
  await expect(page.getByRole('button', { name: th('teamHistory:retry') })).toBeVisible();
});

test('a failed team-list load shows a message instead of a page for the wrong role, and can retry', async ({
  page,
}) => {
  await harness(page, 'admin');
  let fail = true;
  await page.route('**/api/v1/team-history/teams', (route) =>
    fail
      ? route.fulfill({ status: 500, json: { code: 'INTERNAL' } })
      : route.fulfill({ json: { allTeams: true, items: [{ ...A, isActive: true }] } }),
  );
  await page.goto('/?view=team-history&tenant=demo');
  await expect(page.getByRole('alert')).toContainText(th('teamHistory:failed'));
  await expect(page.getByText(th('teamHistory:readOnlySupervisor'))).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: th('teamHistory:retry') }).click();
  await expect(page.getByText(th('teamHistory:readOnlyAdmin'))).toBeVisible();
  await expect(page.getByRole('region', { name: th('teamHistory:summary.title') })).toBeVisible();
});

/** #1044: a team chat shows next to a call, can be filtered and opens as a read-only conversation */
test('#1044 channel filter and a chat detail with the conversation beside the recorded outcome', async ({
  page,
}) => {
  const chatId = '7a33ac96-d87d-4ca4-ab75-f27e40e94c09';
  const chatRow = { ...item(chatId, agentOne, A, 'FOLLOW_UP_REQUIRED'), channel: 'WEBCHAT' };
  const callRow = { ...rows[1]!, channel: 'VOICE' };
  const requests = await harness(page, 'supervisor');
  const channels: (string | null)[] = [];
  await page.route(
    (url) => url.pathname.endsWith('/team-history/items'),
    (route) => {
      const channel = new URL(route.request().url()).searchParams.get('channel');
      channels.push(channel);
      return route.fulfill({
        json: {
          teamId: teamA,
          items: [chatRow, callRow].filter((row) => !channel || row.channel === channel),
          nextCursor: null,
        },
      });
    },
  );
  await page.route(`**/api/v1/team-history/items/${chatId}`, (route) =>
    route.fulfill({
      json: { ...chatRow, talkSeconds: 492, note: 'Asked about delivery' },
    }),
  );
  await page.route(`**/api/v1/team-history/items/${chatId}/transcript`, (route) =>
    route.fulfill({
      json: {
        interactionId: chatId,
        channel: 'WEBCHAT',
        endReason: 'CUSTOMER_LEFT',
        customerLinked: true,
        messages: [
          { id: 'm1', at: '2026-11-27T03:29:00.000Z', from: 'visitor', text: 'Hello there' },
          { id: 'm2', at: '2026-11-27T03:31:00.000Z', from: 'agent', text: 'Hi, how can I help?' },
          { id: 'm3', at: '2026-11-27T03:39:00.000Z', from: 'system', event: 'CUSTOMER_LEFT' },
        ],
      },
    }),
  );
  await page.goto('/?view=team-history&tenant=demo');
  const table = page.getByRole('grid', { name: th('teamHistory:list') });
  await expect(table.getByRole('columnheader', { name: th('history:channel') })).toBeVisible();
  await expect(table.getByText(th('history:channels.webchat'), { exact: true })).toBeVisible();

  const group = page.getByRole('group', { name: th('history:channelFilter') });
  await group.getByRole('button', { name: th('history:channels.webchat'), exact: true }).click();
  await expect(table.getByText(th('history:channels.voice'), { exact: true })).toHaveCount(0);
  expect(channels.at(-1)).toBe('WEBCHAT');
  expect(new URL(page.url()).searchParams.get('channel')).toBe('WEBCHAT');

  await page
    .getByRole('button', {
      name: th('teamHistory:openItem', { interactionId: chatId, agent: 'Somchai' }),
    })
    .click();
  const log = page.getByRole('log', { name: th('history:chat.transcript') });
  await expect(log).toContainText('Hello there');
  await expect(log).toContainText('Somchai');
  await expect(log).toContainText(th('history:chat.system.CUSTOMER_LEFT'));
  await expect(page.getByText('Asked about delivery')).toBeVisible();
  await expect(page.getByText(th('history:chat.linked'), { exact: true })).toBeVisible();
  await expect(
    page.locator('dl > div', { hasText: th('history:chat.closedByLabel') }),
  ).toContainText(th('history:chat.closedBy.CUSTOMER'));
  await expect(page.getByText('8:12')).toBeVisible();
  await page.getByRole('button', { name: th('teamHistory:back') }).click();
  await expect(group.getByRole('button', { name: th('history:channels.webchat') })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // a call keeps the detail it always had and loads no conversation
  await group.getByRole('button', { name: th('history:channels.voice'), exact: true }).click();
  await page
    .getByRole('button', {
      name: th('teamHistory:openItem', { interactionId: callA2, agent: 'Somying' }),
    })
    .click();
  await expect(page.getByRole('heading', { name: th('teamHistory:detail') })).toBeVisible();
  await expect(page.getByRole('log')).toHaveCount(0);
  expect(requests.filter((request) => request.includes(`${callA2}/transcript`))).toHaveLength(0);
});
