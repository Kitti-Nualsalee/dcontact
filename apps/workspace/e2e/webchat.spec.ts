import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { th } from './catalog';

/**
 * #1044 web chat in the Agent Workspace: an offer arrives while the Agent works in another room, the
 * Agent accepts it, answers, ends the chat and records the result. The API is simulated by routes, so
 * this checks the screen only; routing, permissions and storage are covered by the API integration test.
 * `WEBCHAT_EVIDENCE_DIR=<dir>` saves screenshots for the PR.
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

interface Message {
  id: string;
  at: string;
  from: 'visitor' | 'agent' | 'system';
  text?: string;
  event?: string;
  clientId?: string;
}

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const ROOM = '11111111-1111-4111-8111-111111111111';
const OFFER = '22222222-2222-4222-8222-222222222222';

function chat(id: string, label: string, patch: Record<string, unknown> = {}) {
  return {
    interactionId: id,
    state: 'ACTIVE',
    visitorLabel: label,
    origin: 'https://shop.demo-retail.test',
    queueName: 'Online Sales',
    queuedAt: ago(600),
    offerExpiresAt: null,
    answeredAt: ago(480),
    endedAt: null,
    endReason: null,
    visitorOnline: true,
    idleClosesAt: null,
    lastMessage: null,
    visitorMessageCount: 0,
    ...patch,
  };
}

async function open(page: Page) {
  const messages = new Map<string, Message[]>([
    [
      ROOM,
      [
        { id: 'm1', at: ago(590), from: 'visitor', text: 'Where is my order from the 20th?' },
        { id: 'm2', at: ago(480), from: 'system', event: 'AGENT_JOINED' },
        {
          id: 'm3',
          at: ago(470),
          from: 'agent',
          text: 'Happy to help. May I have the order number?',
        },
        { id: 'm4', at: ago(60), from: 'visitor', text: 'SO-2569-118842' },
      ],
    ],
    [OFFER, [{ id: 'o1', at: ago(5), from: 'visitor', text: 'Do you ship to Chiang Mai?' }]],
  ]);
  const server = {
    chats: [
      chat(ROOM, 'A1B2'),
      chat(OFFER, 'G7H8', {
        state: 'ASSIGNED',
        answeredAt: null,
        queuedAt: ago(5),
        offerExpiresAt: new Date(Date.now() + 25_000).toISOString(),
      }),
    ],
    wrapups: [] as Record<string, unknown>[],
  };
  const view = () =>
    server.chats.map((entry) => {
      const all = messages.get(entry.interactionId) ?? [];
      return {
        ...entry,
        lastMessage: all.at(-1) ?? null,
        visitorMessageCount: all.filter((message) => message.from === 'visitor').length,
      };
    });
  const patch = (id: string, change: Record<string, unknown>) => {
    server.chats = server.chats.map((entry) =>
      entry.interactionId === id ? { ...entry, ...change } : entry,
    );
  };

  await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: navigation }));
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      json: {
        capabilities: { voiceWrapupV1: 1, webchatV1: 1 },
        agent: {
          id: 'agent-1000',
          displayName: 'Somying Jaidee',
          extension: '1000',
          state: 'BUSY',
        },
        interaction: null,
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/webchat', (route) =>
    route.fulfill({ json: { maxChatsPerAgent: 3, chats: view() } }),
  );
  await page.route('**/api/v1/workspace/agent/webchat/*/messages**', async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split('/').at(-2)!;
    const all = messages.get(id) ?? [];
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { commandId: string; text: string };
      const message: Message = {
        id: `sent-${all.length}`,
        at: new Date().toISOString(),
        from: 'agent',
        text: body.text,
        clientId: body.commandId,
      };
      messages.set(id, [...all, message]);
      return route.fulfill({ status: 201, json: { message } });
    }
    const after = new URL(request.url()).searchParams.get('after');
    const page_ = after ? all.filter((message) => message.at > after) : all;
    return route.fulfill({ json: { messages: page_, cursor: page_.at(-1)?.at ?? after } });
  });
  await page.route('**/api/v1/workspace/agent/webchat/*/accept', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    patch(id, { state: 'ACTIVE', answeredAt: new Date().toISOString(), offerExpiresAt: null });
    messages.set(id, [
      ...(messages.get(id) ?? []),
      { id: 'joined', at: new Date().toISOString(), from: 'system', event: 'AGENT_JOINED' },
    ]);
    return route.fulfill({ json: { interactionId: id, state: 'ACTIVE' } });
  });
  await page.route('**/api/v1/workspace/agent/webchat/*/end', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    patch(id, { state: 'WRAPUP', endedAt: new Date().toISOString(), endReason: 'AGENT_ENDED' });
    messages.set(id, [
      ...(messages.get(id) ?? []),
      { id: 'ended', at: new Date().toISOString(), from: 'system', event: 'AGENT_ENDED' },
    ]);
    return route.fulfill({ json: { interactionId: id, state: 'WRAPUP' } });
  });
  await page.route('**/api/v1/workspace/agent/interactions/*/wrapup-v1', (route) => {
    const body = route.request().postDataJSON() as Record<string, string>;
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    server.wrapups.push({ id, ...body });
    server.chats = server.chats.filter((entry) => entry.interactionId !== id);
    return route.fulfill({
      json: {
        interactionId: id,
        policyVersion: 1,
        state: 'COMPLETED',
        disposition: body.disposition,
        note: body.note,
        recordedAt: new Date().toISOString(),
        recordedAtSource: 'SERVER_COMMIT',
        legacy: false,
      },
    });
  });
  await page.goto('/?tenant=demo');
  await expect(page.getByText('Somying Jaidee')).toBeVisible();
  return server;
}

async function evidence(page: Page, name: string) {
  const dir = process.env.WEBCHAT_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

const visitor = (code: string) => th('workspace:chat.visitor', { code });

test('an offer arrives beside the room in view; the Agent accepts, answers, ends the chat and saves the result', async ({
  page,
}) => {
  const server = await open(page);
  const composer = page.getByRole('textbox', { name: th('workspace:chat.composer.label') });
  const log = page.getByRole('log');

  // the room in hand is in view with its conversation; the offer is a card, not a dialog
  await expect(log).toContainText('SO-2569-118842');
  await expect(log).toContainText(th('workspace:chat.system.joined', { agent: 'Somying Jaidee' }));
  await expect(page.getByText(th('workspace:chat.capacity', { count: 1, max: 3 }))).toBeVisible();
  const offers = page.getByRole('region', { name: th('workspace:chat.offer.region') });
  await expect(offers).toContainText(
    th('workspace:chat.offer.title', { visitor: visitor('G7H8') }),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await evidence(page, 'workspace-webchat-offer');

  // a draft belongs to its room and survives accepting another chat
  await composer.fill('Checking with the warehouse');
  await offers.getByRole('button', { name: th('workspace:chat.offer.accept') }).click();
  await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: 'x' })).toHaveCount(0);
  await expect(log).toContainText('Do you ship to Chiang Mai?');
  await expect(composer).toHaveValue('');
  await expect(composer).toBeFocused();
  await expect(page.getByText(th('workspace:chat.capacity', { count: 2, max: 3 }))).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`^${visitor('A1B2')}`) }).click();
  await expect(composer).toHaveValue('Checking with the warehouse');

  // Enter sends, Shift+Enter makes a new line, and the sent message shows once
  await composer.press('Shift+Enter');
  await composer.pressSequentially('one moment please');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(log.getByText('Checking with the warehouse\none moment please')).toHaveCount(1);
  await evidence(page, 'workspace-webchat-room');

  // ending asks once, in the header, without a modal
  await page.getByRole('button', { name: th('workspace:chat.end') }).click();
  await expect(page.getByText(th('workspace:chat.endConfirm'))).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText(th('workspace:chat.endConfirm'))).toHaveCount(0);
  await page.getByRole('button', { name: th('workspace:chat.end') }).click();
  await page.getByRole('button', { name: th('workspace:chat.end') }).click();
  await expect(page.getByText(th('workspace:chat.closed.hint'))).toBeVisible();
  await expect(composer).toHaveCount(0);

  // the result is recorded in the work panel with the same form as a call
  await page.getByRole('button', { name: th('workspace:chat.closed.goWrapup') }).click();
  const wrapup = page.getByRole('article', { name: th('workspace:chat.wrapup.title') });
  await expect(wrapup.getByRole('button', { name: th('workspace:wrapup.assisted') })).toBeFocused();
  await wrapup.getByRole('button', { name: th('workspace:wrapup.assisted') }).click();
  await wrapup.getByLabel(th('workspace:wrapup.note')).fill('Order located, arriving tomorrow');
  await expect(wrapup.getByRole('button', { name: th('workspace:wrapup.submit') })).toBeEnabled();
  await evidence(page, 'workspace-webchat-wrapup');
  await wrapup.getByRole('button', { name: th('workspace:wrapup.submit') }).click();
  await expect(
    page.getByText(th('workspace:chat.wrapup.saved', { visitor: visitor('A1B2') })),
  ).toBeVisible();
  expect(server.wrapups).toEqual([
    expect.objectContaining({
      id: ROOM,
      disposition: 'CUSTOMER_ASSISTED',
      note: 'Order located, arriving tomorrow',
    }),
  ]);
  // the other room comes into view and the finished one is listed as closed
  await expect(log).toContainText('Do you ship to Chiang Mai?');
  await expect(
    page.getByRole('tab', { name: th('workspace:layout.list.closed', { count: 1 }) }),
  ).toBeVisible();

  const axe = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    axe.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map((violation) => violation.id),
  ).toEqual([]);
});
