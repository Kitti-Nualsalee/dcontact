import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { th } from './catalog';

/**
 * #1061 agent callbacks in the Workspace: the list shows due callbacks first (with the team's), the
 * Agent schedules a callback from the call in hand, moves one and cancels one. The API is simulated by
 * routes, so this checks the screen only; scheduling rules, Governance and dialing are covered by the
 * API integration test and the SIP acceptance (`pnpm voice:callback:acceptance`).
 * `CALLBACK_EVIDENCE_DIR=<dir>` saves screenshots for the PR.
 */
test.use({ locale: 'th-TH', viewport: { width: 1280, height: 800 } });

const navigation = {
  groups: [{ id: 'live', labelKey: 'navigation.groups.live' }],
  apps: [
    {
      id: 'agent-workspace',
      groupId: 'live',
      labelKey: 'navigation.apps.agentWorkspace',
      hostApp: 'workspace',
      path: '/',
    },
  ],
  areas: [
    {
      id: 'workspace',
      labelKey: 'navigation.areas.workspace',
      sections: [
        { id: 'work', labelKey: 'navigation.sections.work', items: [{ appId: 'agent-workspace' }] },
      ],
    },
  ],
  pins: { appIds: ['agent-workspace'], source: 'TENANT', revision: 0 },
  limits: { maxPins: 15 },
  features: { shellV2: true },
};

const WORK = '44444444-4444-4444-8444-444444444444';
const minutes = (value: number) => new Date(Date.now() + value * 60_000).toISOString();

function callback(id: string, patch: Record<string, unknown>) {
  return {
    id,
    version: 1,
    state: 'SCHEDULED',
    contactId: `contact-${id}`,
    contactName: null,
    number: null,
    customerVisible: true,
    note: null,
    requestedFor: minutes(-5),
    expiresAt: minutes(24 * 60),
    due: true,
    team: false,
    mine: true,
    createdByName: 'Somying Jaidee',
    lastReasonCode: null,
    attemptCount: 0,
    ...patch,
  };
}

async function open(page: Page) {
  const server = {
    items: [
      callback('cb-1', { contactName: 'Anan Thongdee', number: '1202', note: 'After the meeting' }),
      callback('cb-2', {
        contactName: 'Somchai Prasert',
        number: '1203',
        team: true,
        mine: false,
        createdByName: 'Malee Agent',
        requestedFor: minutes(-40),
        version: 2,
      }),
      callback('cb-3', {
        contactName: null,
        number: null,
        customerVisible: false,
        requestedFor: minutes(90),
      }),
    ] as Record<string, unknown>[],
    scheduled: [] as Record<string, unknown>[],
    commands: [] as { path: string; body: Record<string, unknown> }[],
  };
  await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: navigation }));
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      json: {
        capabilities: { voiceWrapupV1: 1, agentCallbacksV1: 1 },
        agent: {
          id: 'agent-1000',
          displayName: 'Somying Jaidee',
          extension: '1000',
          state: 'BUSY',
        },
        interaction: {
          id: WORK,
          state: 'ACTIVE',
          direction: 'INBOUND',
          voiceWrapupPolicy: 'VOICE_NOTE_V1',
          version: '7',
          caller: '1201',
          callback: false,
          queue: { id: 'queue-1', name: 'Customer care' },
          offerExpiresAt: null,
          answeredAt: minutes(-3),
          endedAt: null,
        },
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/callbacks', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      server.scheduled.push(body);
      server.items.push(
        callback('cb-new', {
          contactName: 'Malee Jaidee',
          number: '1201',
          requestedFor: body.requestedFor,
          note: body.note,
        }),
      );
      return route.fulfill({ status: 201, json: { callbackId: 'cb-new', version: 1 } });
    }
    return route.fulfill({
      json: {
        serverTime: new Date().toISOString(),
        items: [...server.items].sort((a, b) =>
          String(a.requestedFor).localeCompare(String(b.requestedFor)),
        ),
      },
    });
  });
  await page.route('**/api/v1/workspace/agent/callbacks/options**', (route) =>
    route.fulfill({
      json: {
        interactionId: WORK,
        contactId: 'contact-malee',
        contactName: 'Malee Jaidee',
        numbers: [
          { identityId: 'identity-internal', value: '1201', dialable: true },
          { identityId: 'identity-mobile', value: '+66812345678', dialable: false },
        ],
        queue: { id: 'queue-1', name: 'Customer care' },
        existingCallbackId: null,
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/callbacks/*/*', (route) => {
    const request = route.request();
    const [id, action] = new URL(request.url()).pathname.split('/').slice(-2);
    const body = request.postDataJSON() as Record<string, unknown>;
    server.commands.push({ path: `${id}/${action}`, body });
    if (action === 'cancel') server.items = server.items.filter((item) => item.id !== id);
    if (action === 'reschedule')
      server.items = server.items.map((item) =>
        item.id === id ? { ...item, requestedFor: body.requestedFor, version: 2 } : item,
      );
    return route.fulfill({ json: { callbackId: id, version: 2 } });
  });
  await page.goto('/?tenant=demo');
  await expect(page.getByText('Somying Jaidee')).toBeVisible();
  return server;
}

async function evidence(page: Page, name: string) {
  const dir = process.env.CALLBACK_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

test('the list puts due callbacks first, shows the team ones and hides a customer the team may no longer see', async ({
  page,
}) => {
  await open(page);
  const tab = page
    .locator('.aw-v3-list-tabs')
    .getByRole('tab', { name: th('workspace:layout.list.callbacksTab') });
  // the tab says how many are due, also to screen readers
  await expect(tab).toContainText(th('workspace:layout.list.callbacksDue', { count: 2 }));
  await tab.click();
  const list = page.getByRole('list', { name: th('workspace:callback.listLabel') });
  const rows = list.getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Somchai Prasert');
  await expect(rows.nth(0)).toContainText(th('workspace:callback.teamBadge'));
  await expect(rows.nth(0)).toContainText(
    th('workspace:callback.teamHint', { name: 'Malee Agent' }),
  );
  await expect(rows.nth(1)).toContainText('Anan Thongdee');
  await expect(rows.nth(1)).toContainText('After the meeting');
  await expect(rows.nth(2)).toContainText(th('workspace:callback.customerHiddenShort'));
  await expect(rows.nth(2)).toContainText(th('workspace:callback.upcoming'));
  // the Agent is in a call: dialing waits and says why
  await expect(page.getByText(th('workspace:callback.error.notReady'))).toBeVisible();
  await expect(
    rows.nth(1).getByRole('button', {
      name: th('workspace:callback.dialLabel', { name: 'Anan Thongdee' }),
    }),
  ).toBeDisabled();
  await evidence(page, 'callback-list');
  const axe = await new AxeBuilder({ page }).include('.aw-v3-list').analyze();
  expect(axe.violations).toEqual([]);
});

test('the Agent schedules a callback from the call in hand, then moves and cancels callbacks', async ({
  page,
}) => {
  const server = await open(page);
  await page
    .getByRole('tab', { name: th('workspace:layout.inspector.tabs.callback'), exact: true })
    .click();
  const panel = page.locator('.aw-callback');
  await expect(panel.getByText('Malee Jaidee')).toBeVisible();
  // only the internal number can be dialed
  await expect(panel.getByText(th('workspace:callback.numberNotDialable'))).toBeVisible();
  await panel.getByLabel(th('workspace:callback.note')).fill('  Call after lunch  ');
  await evidence(page, 'callback-schedule');
  await panel.getByRole('button', { name: th('workspace:callback.submit') }).click();
  await expect(panel.getByText(th('workspace:callback.scheduled'))).toBeVisible();
  expect(server.scheduled).toHaveLength(1);
  expect(server.scheduled[0]).toMatchObject({
    interactionId: WORK,
    identityId: 'identity-internal',
    note: 'Call after lunch',
  });
  expect(Date.parse(String(server.scheduled[0]!.requestedFor))).toBeGreaterThan(Date.now());

  await panel.getByRole('button', { name: th('workspace:callback.showList') }).click();
  const list = page.getByRole('list', { name: th('workspace:callback.listLabel') });
  await expect(list.getByRole('listitem')).toHaveCount(4);

  // move Anan's callback
  const anan = list.getByRole('listitem').filter({ hasText: 'Anan Thongdee' });
  await anan
    .getByRole('button', {
      name: th('workspace:callback.rescheduleLabel', { name: 'Anan Thongdee' }),
    })
    .click();
  const move = page.getByRole('dialog', {
    name: th('workspace:callback.rescheduleTitleFor', { name: 'Anan Thongdee' }),
  });
  await move.getByLabel(th('workspace:callback.time')).fill('23:59');
  await move.getByRole('button', { name: th('workspace:callback.rescheduleSave') }).click();
  await expect(move).toBeHidden();
  expect(server.commands.at(-1)).toMatchObject({
    path: 'cb-1/reschedule',
    body: { expectedVersion: 1 },
  });

  // cancel the team's callback after confirming
  const somchai = list.getByRole('listitem').filter({ hasText: 'Somchai Prasert' });
  await somchai
    .getByRole('button', {
      name: th('workspace:callback.cancelLabel', { name: 'Somchai Prasert' }),
    })
    .click();
  const confirm = page.getByRole('alertdialog', { name: th('workspace:callback.cancelTitle') });
  await confirm.getByRole('button', { name: th('workspace:callback.cancelConfirm') }).click();
  await expect(confirm).toBeHidden();
  expect(server.commands.at(-1)).toMatchObject({
    path: 'cb-2/cancel',
    body: { expectedVersion: 2 },
  });
  await expect(list.getByRole('listitem').filter({ hasText: 'Somchai Prasert' })).toHaveCount(0);
  // the row is gone: focus moved to the next callback, not lost on the page
  await expect(page.locator(':focus')).toHaveAttribute('data-callback-move', /.+/);
});
