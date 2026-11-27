import { expect, test } from '@playwright/test';
import { homeNavigation } from './support/home-navigation.js';
import { th } from './support/catalog';

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NOTE = '<img src=x onerror=alert(1)> Synthetic note';
test.use({ locale: 'th-TH' });

const interactionId = '7a33ac96-d87d-4ca4-ab75-f27e40e943be';
const nextId = '7a33ac96-d87d-4ca4-ab75-f27e40e943bf';
const emptySummary = {
  period: {
    key: '7d',
    from: '2026-11-15T17:00:00.000Z',
    to: '2026-11-22T17:00:00.000Z',
    timeZone: 'Asia/Bangkok',
  },
  completed: 0,
  talk: { averageSeconds: null, measuredCount: 0 },
  byDisposition: [],
};
const isSummary = (url: string) => new URL(url).pathname.endsWith('/history/summary');
const item = {
  interactionId,
  startedAt: '2026-10-17T07:00:00.000Z',
  endedAt: '2026-10-17T07:01:00.000Z',
  disposition: 'CUSTOMER_ASSISTED',
  recordedAt: '2026-10-17T07:02:00.000Z',
  recordedAtSource: 'SERVER_COMMIT',
  legacy: false,
};

test('production auth root opens a history deep link without forcing an Interaction context', async ({
  page,
}) => {
  await page.goto('/?view=agent-history&tenant=demo&authRootHarness=1');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: th('common:auth.contextMissing.title'), exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('main')).toContainText(
    new RegExp(
      `Identity Provider|${escapeRegExp(th('common:auth.signIn'))}|${escapeRegExp(th('history:title'))}`,
    ),
  );
});

test('auth surface: an identity change loads navigation again and drops the old account menu', async ({
  page,
}) => {
  const identities: string[] = [];
  await page.route('**/api/v1/me/navigation', (route) => {
    const identity = route.request().headers().authorization;
    identities.push(identity);
    return route.fulfill({
      json: homeNavigation(identity === 'Bearer e2e-first' ? ['agent'] : ['compliance']),
    });
  });
  await page.route('**/api/v1/workspace/agent/history**', (route) =>
    route.fulfill({
      json: isSummary(route.request().url()) ? emptySummary : { items: [], nextCursor: null },
    }),
  );
  await page.goto('/?view=agent-history&tenant=demo&identityHarness=1');
  await expect(page.locator('a[data-area="history"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Switch identity fixture', exact: true }).click();
  await expect.poll(() => identities.includes('Bearer e2e-second')).toBe(true);
  await expect(page.locator('a[data-area="history"]')).toHaveCount(0);
  await expect(page.locator('a[data-area="governance"]')).toHaveCount(1);
});

test('Agent opens the list/load more/plain-text detail/deep link without asking for a lease or SIP', async ({
  page,
}) => {
  const forbidden: string[] = [];
  page.on('request', (request) => {
    if (/work-session|sip-credentials/.test(request.url())) forbidden.push(request.url());
  });
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname === '/api/v1/workspace-session')
      forbidden.push(socket.url());
  });
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/workspace/agent/history**', (route) => {
    if (isSummary(route.request().url()))
      return route.fulfill({
        json: {
          ...emptySummary,
          completed: 2,
          byDisposition: [{ disposition: 'CUSTOMER_ASSISTED', count: 2 }],
        },
      });
    const more = new URL(route.request().url()).searchParams.has('cursor');
    return route.fulfill({
      json: {
        items: [
          more
            ? { ...item, interactionId: nextId, legacy: true, recordedAtSource: 'LEGACY_FALLBACK' }
            : item,
        ],
        nextCursor: more ? null : 'synthetic-cursor',
      },
    });
  });
  await page.route('**/wrapup-result', (route) =>
    route.fulfill({
      json: {
        ...item,
        policyVersion: 1,
        state: 'COMPLETED',
        note: NOTE,
      },
    }),
  );
  await page.goto('/?view=agent-history&tenant=demo');
  await expect(page.getByRole('heading', { name: th('history:title') })).toBeVisible();
  await page.getByRole('button', { name: th('history:more'), exact: true }).click();
  await expect(page.getByText(nextId, { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: th('history:openItem', { interactionId }), exact: true })
    .click();
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('interaction')).toBe(interactionId);
  expect(page.url()).not.toContain('Synthetic');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  expect(forbidden).toEqual([]);
});

for (const [status, message] of [
  [401, th('history:unauthorized')],
  [403, th('history:forbidden')],
  [404, th('history:notFound')],
  [503, th('history:failed')],
] as const) {
  test(`history separates ${status} and retry can return to empty`, async ({ page }) => {
    let failed = true;
    await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
    await page.route('**/api/v1/workspace/agent/history**', (route) =>
      failed
        ? route.fulfill({ status })
        : route.fulfill({
            json: isSummary(route.request().url()) ? emptySummary : { items: [], nextCursor: null },
          }),
    );
    await page.goto('/?view=agent-history&tenant=demo');
    await expect(page.getByRole('alert')).toContainText(message);
    failed = false;
    await page.getByRole('button', { name: th('history:retry'), exact: true }).click();
    await expect(page.getByText(th('history:summary.emptyPeriod'), { exact: true })).toBeVisible();
  });
}

test('summary by period: pressing a disposition makes the list use the same period as the summary, and reload keeps the filter', async ({
  page,
}) => {
  const summaries: string[] = [];
  const lists: URLSearchParams[] = [];
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/workspace/agent/history**', (route) => {
    const url = new URL(route.request().url());
    if (isSummary(url.href)) {
      const period = url.searchParams.get('period') ?? '';
      summaries.push(period);
      return route.fulfill({
        json:
          period === 'today'
            ? {
                ...emptySummary,
                period: { ...emptySummary.period, key: 'today', from: '2026-11-21T17:00:00.000Z' },
              }
            : {
                ...emptySummary,
                completed: 3,
                talk: { averageSeconds: 150, measuredCount: 2 },
                byDisposition: [
                  { disposition: 'CUSTOMER_ASSISTED', count: 2 },
                  { disposition: 'FOLLOW_UP_REQUIRED', count: 1 },
                ],
              },
      });
    }
    lists.push(url.searchParams);
    const disposition = url.searchParams.get('disposition');
    if (url.searchParams.get('from') === '2026-11-21T17:00:00.000Z')
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({
      json: {
        items:
          disposition === 'FOLLOW_UP_REQUIRED'
            ? [{ ...item, interactionId: nextId, disposition }]
            : [item, { ...item, interactionId: nextId, disposition: 'FOLLOW_UP_REQUIRED' }],
        nextCursor: null,
      },
    });
  });
  await page.goto('/?view=agent-history&tenant=demo');
  const summary = page.getByRole('region', { name: th('history:summary.title') });
  await expect(summary).toContainText('16 พ.ย. 2569 – 22 พ.ย. 2569 · เวลาอินโดจีน'); // allow-thai: Thai Buddhist-era date and time zone formatting
  await expect(summary).toContainText('2:30');
  await expect(summary).toContainText(th('history:summary.talkBasis', { count: 2 }));
  await expect(
    page.getByRole('button', { name: th('history:summary.period.7d'), exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('heading', {
      name: th('history:summary.listTitle', {
        period: th('history:summary.period.7d'),
        channel: th('history:channels.all'),
        disposition: th('history:summary.allDispositions'),
        count: 3,
      }),
    }),
  ).toBeVisible();
  expect(lists.at(-1)?.get('from')).toBe('2026-11-15T17:00:00.000Z');
  expect(lists.at(-1)?.get('to')).toBe('2026-11-22T17:00:00.000Z');
  expect(lists.at(-1)?.has('disposition')).toBe(false);

  const followUp = summary.getByRole('button', {
    name: new RegExp(escapeRegExp(th('history:followUp'))),
  });
  await followUp.click();
  await expect(followUp).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('heading', {
      name: th('history:summary.listTitle', {
        period: th('history:summary.period.7d'),
        channel: th('history:channels.all'),
        disposition: th('history:followUp'),
        count: 1,
      }),
    }),
  ).toBeVisible();
  await expect(page.getByText(interactionId, { exact: true })).toHaveCount(0);
  await expect(page.getByText(nextId, { exact: true })).toBeVisible();
  expect(lists.at(-1)?.get('disposition')).toBe('FOLLOW_UP_REQUIRED');
  expect(lists.at(-1)?.get('from')).toBe('2026-11-15T17:00:00.000Z');
  expect(new URL(page.url()).searchParams.get('disposition')).toBe('FOLLOW_UP_REQUIRED');

  await page.reload();
  await expect(
    summary.getByRole('button', { name: new RegExp(escapeRegExp(th('history:followUp'))) }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(lists.at(-1)?.get('disposition')).toBe('FOLLOW_UP_REQUIRED');

  await summary.getByRole('button', { name: th('history:summary.showAll', { count: 3 }) }).click();
  await expect(
    page.getByRole('heading', {
      name: th('history:summary.listTitle', {
        period: th('history:summary.period.7d'),
        channel: th('history:channels.all'),
        disposition: th('history:summary.allDispositions'),
        count: 3,
      }),
    }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has('disposition')).toBe(false);

  await page.getByRole('button', { name: th('history:summary.period.today'), exact: true }).click();
  await expect(summary).toContainText('22 พ.ย. 2569 · เวลาอินโดจีน'); // allow-thai: Thai Buddhist-era date and time zone formatting
  await expect(page.getByText(th('history:summary.emptyPeriod'), { exact: true })).toBeVisible();
  expect(summaries.at(-1)).toBe('today');
  expect(new URL(page.url()).searchParams.get('period')).toBe('today');
});

test("an identity change clears the detail cache and does not accept the old identity's note answer", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received = false;
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/wrapup-result', async (route) => {
    if (route.request().headers().authorization === 'Bearer e2e-first') {
      received = true;
      await held;
      await route.fulfill({
        json: { ...item, policyVersion: 1, note: 'private synthetic old identity note' },
      });
    } else await route.fulfill({ status: 404 });
  });
  await page.goto(
    `/?view=agent-history&tenant=demo&interaction=${interactionId}&identityHarness=1`,
  );
  await expect.poll(() => received).toBe(true);
  await page.getByRole('button', { name: 'Switch identity fixture', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(th('history:notFound'));
  release?.();
  await expect(page.getByText('private synthetic old identity note', { exact: true })).toHaveCount(
    0,
  );
});

test('legacy detail says there is no note and reference time, and does not create retroactive text', async ({
  page,
}) => {
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/wrapup-result', (route) =>
    route.fulfill({
      json: {
        ...item,
        note: null,
        legacy: true,
        policyVersion: null,
        recordedAtSource: 'LEGACY_EVENT',
      },
    }),
  );
  await page.goto(`/?view=agent-history&tenant=demo&interaction=${interactionId}`);
  await expect(page.getByText(th('history:legacy'), { exact: true })).toBeVisible();
  await expect(page.getByText(th('history:noNote'), { exact: true })).toBeVisible();
  await expect(page.getByText(th('history:LEGACY_EVENT'), { exact: true })).toBeVisible();
});

/** #1044: a chat shows next to a call, can be filtered, and opens as a read-only conversation */
const chatId = '7a33ac96-d87d-4ca4-ab75-f27e40e943c0';
const chatItem = { ...item, interactionId: chatId, channel: 'WEBCHAT' };
const callItem = { ...item, channel: 'VOICE' };
const chatTranscript = (change: Record<string, unknown> = {}) => ({
  interactionId: chatId,
  channel: 'WEBCHAT',
  endReason: 'IDLE_TIMEOUT',
  customerLinked: false,
  visitorLabel: 'A1B2',
  queueName: 'Online Sales',
  messages: [
    { id: 'm1', at: '2026-11-27T03:29:00.000Z', from: 'visitor', text: 'My order has not arrived' },
    { id: 'm2', at: '2026-11-27T03:31:00.000Z', from: 'system', event: 'AGENT_JOINED' },
    { id: 'm3', at: '2026-11-27T03:31:30.000Z', from: 'agent', text: 'Let me check that for you' },
    { id: 'm4', at: '2026-11-27T03:39:00.000Z', from: 'system', event: 'IDLE_TIMEOUT' },
  ],
  ...change,
});

async function chatHarness(page: import('@playwright/test').Page) {
  const lists: URLSearchParams[] = [];
  let transcriptFails = true;
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/workspace/agent/history**', (route) => {
    const url = new URL(route.request().url());
    if (isSummary(url.href))
      return route.fulfill({
        json: {
          ...emptySummary,
          completed: 2,
          byDisposition: [{ disposition: 'CUSTOMER_ASSISTED', count: 2 }],
        },
      });
    if (url.pathname.endsWith('/transcript'))
      return transcriptFails
        ? route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } })
        : route.fulfill({ json: chatTranscript() });
    lists.push(url.searchParams);
    const channel = url.searchParams.get('channel');
    const all = [chatItem, callItem];
    return route.fulfill({
      json: { items: all.filter((row) => !channel || row.channel === channel), nextCursor: null },
    });
  });
  await page.route('**/wrapup-result', (route) =>
    route.fulfill({ json: { ...chatItem, policyVersion: 1, state: 'COMPLETED', note: NOTE } }),
  );
  return { lists, allowTranscript: () => (transcriptFails = false) };
}

test('#1044 channel column and filter: the choice is sent to the API and kept in the URL', async ({
  page,
}) => {
  const { lists } = await chatHarness(page);
  await page.goto('/?view=agent-history&tenant=demo');
  const table = page.getByRole('grid', { name: th('history:list') });
  await expect(table.getByRole('columnheader', { name: th('history:channel') })).toBeVisible();
  await expect(table.getByText(th('history:channels.webchat'), { exact: true })).toBeVisible();
  await expect(table.getByText(th('history:channels.voice'), { exact: true })).toBeVisible();
  expect(lists.at(-1)?.has('channel')).toBe(false);

  const group = page.getByRole('group', { name: th('history:channelFilter') });
  await group.getByRole('button', { name: th('history:channels.webchat'), exact: true }).click();
  await expect(group.getByRole('button', { name: th('history:channels.webchat') })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(table.getByText(th('history:channels.voice'), { exact: true })).toHaveCount(0);
  expect(lists.at(-1)?.get('channel')).toBe('WEBCHAT');
  expect(new URL(page.url()).searchParams.get('channel')).toBe('WEBCHAT');
  await expect(
    page.getByRole('heading', {
      name: th('history:summary.listTitleNoCount', {
        period: th('history:summary.period.7d'),
        channel: th('history:channels.webchat'),
        disposition: th('history:summary.allDispositions'),
      }),
    }),
  ).toBeVisible();

  await page.reload();
  await expect(group.getByRole('button', { name: th('history:channels.webchat') })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(lists.at(-1)?.get('channel')).toBe('WEBCHAT');
  await group.getByRole('button', { name: th('history:channels.all') }).click();
  expect(new URL(page.url()).searchParams.has('channel')).toBe(false);
});

test('#1044 a chat opens as a read-only conversation; when it fails the outcome stays and retry loads it', async ({
  page,
}) => {
  const { allowTranscript } = await chatHarness(page);
  await page.goto('/?view=agent-history&tenant=demo');
  await page
    .getByRole('button', { name: th('history:openItem', { interactionId: chatId }), exact: true })
    .click();
  // partial: the conversation did not load, the recorded outcome beside it is still shown
  await expect(page.getByRole('alert')).toContainText(th('history:chat.transcriptFailed'));
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  allowTranscript();
  await page.getByRole('button', { name: th('history:chat.retry') }).click();
  const log = page.getByRole('log', { name: th('history:chat.transcript') });
  await expect(log).toContainText('My order has not arrived');
  await expect(log).toContainText(th('history:chat.sender.customer'));
  await expect(log).toContainText('Let me check that for you');
  await expect(log).toContainText(th('history:chat.system.IDLE_TIMEOUT'));
  await expect(page.getByText(th('history:chat.transcriptMeta', { count: 2 }))).toBeVisible();
  await expect(page.getByText(th('history:chat.unlinked'), { exact: true })).toBeVisible();
  await expect(page.getByText(th('history:chat.closedBy.IDLE'), { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  // the visitor's label and the queue come with the conversation, the same label the Agent saw in Workspace
  await expect(
    page.getByRole('heading', { name: th('history:chat.visitor', { code: 'A1B2' }) }),
  ).toBeVisible();
  await expect(page.getByText(/Online Sales/)).toBeVisible();
  // a link pasted straight to the chat (no list loaded) still finds out it is a chat from the conversation
  await page.reload();
  await expect(page.getByRole('log', { name: th('history:chat.transcript') })).toContainText(
    'My order has not arrived',
  );
});
