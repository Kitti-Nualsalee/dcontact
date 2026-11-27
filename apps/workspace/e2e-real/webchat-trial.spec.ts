import { mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type FrameLocator, type Page } from '@playwright/test';
import { th } from '../e2e/catalog';
import { escapeRegExp } from '../e2e/locale-match';

/**
 * #1044 web chat from the visitor's widget to the history, on the real stack (`WEBCHAT=on`):
 *
 * the Admin turns the widget on in Console → a visitor writes from the preview page → agent1000 accepts in
 * Workspace and they talk both ways without a reload → the visitor's page is reloaded and returns to the
 * same chat → a second visitor makes a second room → the Agent ends one chat and the visitor ends the
 * other → both results are saved → the Agent and the Admin read the conversations in the history.
 *
 * A trial tool, not acceptance of identity: the tenant is seeded by `scripts/sales-demo-stack.mjs` and
 * the Agent's phone uses fake media. Texts come from the apps' own catalogs.
 */
const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, '../test-results-real/webchat-trial');
const workspaceOrigin = 'http://localhost:5173';
const consoleOrigin = 'http://localhost:5174';
/** pages the test serves itself: a site the widget is allowed on and one it is not */
const tenantSite = 'http://127.0.0.1:8899';
const otherSite = 'http://127.0.0.1:8898';
const apiOrigin = 'http://localhost:3000';

type Catalog = Record<string, unknown>;
const load = (path: string) => JSON.parse(readFileSync(resolve(here, path), 'utf8')) as Catalog;
const catalogs = {
  webchat: load('../../console/src/i18n/locales/th/webchat.json'),
  history: load('../../console/src/i18n/locales/th/history.json'),
  teamHistory: load('../../console/src/i18n/locales/th/team-history.json'),
  common: load('../../console/src/i18n/locales/th/common.json'),
  widget: load('../../../packages/webchat-widget/src/locales/th/widget.json'),
};
/** Text of another app's catalog (Console, widget); a missing key fails loudly. */
function text(catalog: keyof typeof catalogs, key: string, values: Record<string, string> = {}) {
  let node: unknown = catalogs[catalog];
  for (const part of key.split('.'))
    node = node && typeof node === 'object' ? (node as Catalog)[part] : undefined;
  if (typeof node !== 'string') throw new Error(`Missing catalog key: ${catalog}:${key}`);
  return node.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? '');
}

async function signIn(page: Page, url: string, username: string, password: string, button: string) {
  await page.goto(url);
  await page.getByRole('button', { name: button }).first().click();
  await page.waitForURL(/\/realms\/dcontact\//);
  await page.locator('#username').fill(username);
  if (!(await page.locator('#password').isVisible())) await page.locator('#kc-login').click();
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await page.waitForURL((current) => current.origin === new URL(url).origin);
}

/** The Agent holds the work session and is Ready, whatever a previous run left behind. */
async function agentReady(page: Page) {
  const takeOver = page.getByRole('button', { name: th('workspace:lease.move') });
  const startHere = page.getByRole('button', { name: th('workspace:lease.start') });
  await page.addLocatorHandler(
    takeOver.or(startHere),
    async () => {
      if (await startHere.isVisible()) {
        await startHere.click({ timeout: 2_000 }).catch(() => undefined);
        return;
      }
      await takeOver.click({ timeout: 2_000 }).catch(() => undefined);
      await page
        .getByRole('button', { name: th('workspace:lease.confirm') })
        .click({ timeout: 5_000 })
        .catch(() => undefined);
    },
    { noWaitAfter: true },
  );
  const gate = page.getByRole('region', {
    name: new RegExp(`^${escapeRegExp(th('workspace:agentStatus.gate.title', { name: '' }))}`),
  });
  const workList = page.getByRole('region', { name: th('workspace:layout.work') });
  // The status page can come back after a takeover of the work session, so keep answering it until the
  // work list is on screen.
  const deadline = Date.now() + 90_000;
  while (!(await workList.isVisible())) {
    if (Date.now() > deadline) throw new Error('the Agent did not reach the Workspace in time');
    if (await gate.isVisible()) {
      await gate.getByRole('radio', { name: /^Ready/ }).check();
      await gate
        .getByRole('button', { name: th('workspace:agentStatus.gate.enter') })
        .click({ timeout: 5_000 })
        .catch(() => undefined);
    }
    await page.waitForTimeout(1_000);
  }
}

interface Visitor {
  page: Page;
  frame: FrameLocator;
  send(message: string): Promise<void>;
}

async function openVisitor(browser: Browser, previewUrl: string): Promise<Visitor> {
  const context = await browser.newContext({
    locale: 'th-TH',
    viewport: { width: 900, height: 760 },
  });
  const page = await context.newPage();
  await page.goto(previewUrl);
  await page
    .getByRole('button', { name: new RegExp(escapeRegExp(text('widget', 'launcher'))) })
    .click();
  const frame = page.frameLocator('iframe');
  const composer = frame.getByRole('textbox', { name: text('widget', 'composer.label') });
  await expect(composer).toBeEnabled();
  return {
    page,
    frame,
    async send(message) {
      await composer.fill(message);
      await composer.press('Enter');
    },
  };
}

test('web chat: widget → queue → Agent accepts → two-way chat → two rooms → wrap-up → history', async ({
  browser,
  page: agent,
}) => {
  mkdirSync(shots, { recursive: true });
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: resolve(shots, `${name}.png`) });
  const stamp = Date.now().toString(36);
  const firstQuestion = `Where is my order ${stamp}`;
  const secondQuestion = `Do you ship to Chiang Mai ${stamp}`;

  // ── Admin turns the widget on in Console ──
  const adminContext = await browser.newContext({
    locale: 'th-TH',
    viewport: { width: 1440, height: 900 },
  });
  const admin = await adminContext.newPage();
  await signIn(
    admin,
    `${consoleOrigin}/?tenant=demo&view=webchat-settings`,
    'admin@demo.local',
    'admin1234',
    text('common', 'auth.signIn'),
  );
  await admin.goto(`${consoleOrigin}/?tenant=demo&view=webchat-settings`);
  await expect(
    admin.getByRole('heading', { level: 1, name: text('webchat', 'title') }),
  ).toBeVisible();
  const toggle = admin.getByRole('switch', { name: text('webchat', 'state.toggle') });
  await expect(toggle).toBeVisible();
  // The trial embeds the widget from a page on another loopback origin. (A public https page cannot
  // reach an API on localhost: the browser's private-network rule blocks it, which says nothing about
  // the widget.)
  const origins = admin.getByRole('list', { name: text('webchat', 'origins.list') });
  const needsOrigin = !(await origins.getByText(tenantSite).count());
  const wasOn = await toggle.isChecked();
  if (
    !(
      await admin
        .getByRole('button', { name: new RegExp(text('webchat', 'routing.queue')) })
        .innerText()
    ).includes('General')
  ) {
    await admin.getByRole('button', { name: new RegExp(text('webchat', 'routing.queue')) }).click();
    await admin.getByRole('option').first().click();
  }
  if (needsOrigin) {
    await admin
      .getByRole('textbox', { name: text('webchat', 'origins.newLabel') })
      .fill(tenantSite);
    await admin.getByRole('button', { name: text('webchat', 'origins.add') }).click();
  }
  if (!wasOn) await toggle.click({ force: true });
  const save = admin.getByRole('button', {
    name: new RegExp(
      `^(${escapeRegExp(text('webchat', 'saveFirst'))}|${escapeRegExp(text('webchat', 'save'))})$`,
    ),
  });
  if (await save.isEnabled()) {
    await save.click();
    await expect(save).toBeDisabled();
  }
  await expect(admin.getByText(text('webchat', 'status.enabled')).first()).toBeVisible();
  await shot(admin, '01-console-settings');
  const snippet = await admin.getByLabel(text('webchat', 'snippet.label')).innerText();
  const tenantId = /data-tenant="([0-9a-f-]{36})"/.exec(snippet)?.[1];
  const widgetId = /data-widget="([0-9a-f-]{36})"/.exec(snippet)?.[1];
  expect(tenantId && widgetId, `embed code: ${snippet}`).toBeTruthy();
  const previewUrl = `${apiOrigin}/api/v1/webchat/demo?tenant=${tenantId}&widget=${widgetId}`;
  await expect(admin.getByRole('link', { name: text('webchat', 'preview.open') })).toHaveAttribute(
    'href',
    /\/api\/v1\/webchat\/demo\?tenant=/,
  );

  // ── the tenant's own site shows the widget; a site that is not on the list shows nothing ──
  // Real local servers, not routed pages: Chrome treats a routed page as public and blocks its requests
  // to the loopback API, which says nothing about the widget.
  const hostPage = (title: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${snippet}</body></html>`;
  const serve = (origin: string, title: string) =>
    new Promise<Server>((done) => {
      const server = createServer((_, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(hostPage(title));
      });
      server.listen(Number(new URL(origin).port), '127.0.0.1', () => done(server));
    });
  const servers = await Promise.all([
    serve(tenantSite, 'Demo Retail shop'),
    serve(otherSite, 'Another site'),
  ]);
  const sites = await browser.newContext({ locale: 'th-TH' });
  const launcher = new RegExp(escapeRegExp(text('widget', 'launcher')));
  const shop = await sites.newPage();
  await shop.goto(`${tenantSite}/`);
  // on a real site the button names the tenant (the preview page has no tenant name to show)
  const siteLauncher = text('widget', 'launcherLabel', { tenant: 'Demo Company' });
  await shop.getByRole('button', { name: siteLauncher }).click();
  // Before the Agent signs in the widget says no agent is online and nothing can be sent; a previous
  // run may have left the Agent Ready, and then it opens for chat. Either way the state must be one of them.
  const shopFrame = shop.frameLocator('iframe');
  const shopComposer = shopFrame.getByRole('textbox', { name: text('widget', 'composer.label') });
  const offline = shopFrame.getByText(text('widget', 'offline.title'));
  await expect(offline.or(shopFrame.getByText(text('widget', 'safety')))).toBeVisible();
  if (await offline.isVisible()) await expect(shopComposer).toBeDisabled();
  else await expect(shopComposer).toBeEnabled();
  await shot(shop, '02a-widget-on-tenant-site');
  const other = await sites.newPage();
  // the loader asks the API first; the answer to a site not on the list is a 404 the page may not read
  const asked = other.waitForRequest((request) => request.url().endsWith('/embed'));
  await other.goto(`${otherSite}/`);
  const embedUrl = (await asked).url();
  const direct = await other.request.get(embedUrl, { headers: { origin: otherSite } });
  expect(direct.status()).toBe(404);
  expect(direct.headers()['access-control-allow-origin']).not.toBe(otherSite);
  await other.waitForTimeout(1_500);
  await expect(other.getByRole('button', { name: siteLauncher })).toHaveCount(0);
  await expect(other.getByRole('button', { name: launcher })).toHaveCount(0);
  // even framing the chat directly is refused by the browser for a site that is not on the list
  const framed = await other.evaluate(
    (source) =>
      new Promise<string>((done) => {
        const frame = document.createElement('iframe');
        frame.src = source;
        frame.addEventListener('load', () => {
          try {
            done(frame.contentDocument ? 'readable' : 'blocked');
          } catch {
            done('blocked');
          }
        });
        document.body.append(frame);
        setTimeout(() => done('no-load'), 5_000);
      }),
    /src="([^"]+)widget\.js"/.exec(snippet)![1] + `frame?tenant=${tenantId}&widget=${widgetId}`,
  );
  expect(framed).not.toBe('readable');
  await sites.close();
  for (const server of servers) server.close();

  // ── the Agent signs in and is Ready ──
  // the socket must carry the "your chats changed" notice; the slow re-read alone would also pass the rest
  const notices: string[] = [];
  agent.on('websocket', (socket) =>
    socket.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string' && frame.payload.includes('webchat.changed'))
        notices.push(frame.payload);
    }),
  );
  await signIn(
    agent,
    `${workspaceOrigin}/?tenant=demo`,
    'agent1000@demo.local',
    'agent1234',
    th('dphone:embedAuth.signIn'),
  );
  await agentReady(agent);
  await expect(agent.getByText(th('workspace:chat.capacity', { count: 0, max: 3 }))).toBeVisible({
    timeout: 30_000,
  });

  // ── a visitor writes from the widget ──
  const one = await openVisitor(browser, previewUrl);
  await expect(one.frame.getByText(text('widget', 'safety'))).toBeVisible();
  await one.send(firstQuestion);
  await expect(one.frame.getByText(text('widget', 'waiting'))).toBeVisible();
  await shot(one.page, '02-widget-waiting');

  // ── the offer reaches the Agent without a reload; accepting opens the room ──
  const offers = agent.getByRole('region', { name: th('workspace:chat.offer.region') });
  await expect(offers).toContainText(firstQuestion, { timeout: 30_000 });
  expect(notices.length, 'the offer was announced over the Workspace socket').toBeGreaterThan(0);
  await shot(agent, '03-workspace-offer');
  await offers.getByRole('button', { name: th('workspace:chat.offer.accept') }).click();
  const log = agent.getByRole('log');
  await expect(log).toContainText(firstQuestion);
  const composer = agent.getByRole('textbox', { name: th('workspace:chat.composer.label') });
  await expect(composer).toBeFocused();
  await expect(one.frame.getByText(text('widget', 'system.joined'))).toBeVisible();

  // ── both ways, live ──
  await composer.fill(`Let me check ${stamp}`);
  await composer.press('Enter');
  await expect(one.frame.getByText(`Let me check ${stamp}`)).toBeVisible();
  await one.send(`Thank you ${stamp}`);
  await expect(log).toContainText(`Thank you ${stamp}`);
  await shot(one.page, '04-widget-chatting');

  // ── the visitor reloads the page and is back in the same chat ──
  await one.page.reload();
  const again = one.page.frameLocator('iframe');
  await expect(again.getByText(firstQuestion)).toBeVisible({ timeout: 20_000 });
  await expect(again.getByText(`Let me check ${stamp}`)).toBeVisible();
  await again
    .getByRole('textbox', { name: text('widget', 'composer.label') })
    .fill(`Still here ${stamp}`);
  await again.getByRole('textbox', { name: text('widget', 'composer.label') }).press('Enter');
  await expect(log).toContainText(`Still here ${stamp}`);

  // ── a second visitor: a second room beside the first, and its draft does not leak ──
  await composer.fill('draft for the first room');
  const two = await openVisitor(browser, previewUrl);
  await two.send(secondQuestion);
  await expect(offers).toContainText(secondQuestion, { timeout: 30_000 });
  await offers.getByRole('button', { name: th('workspace:chat.offer.accept') }).click();
  await expect(log).toContainText(secondQuestion);
  await expect(composer).toHaveValue('');
  await expect(agent.getByText(th('workspace:chat.capacity', { count: 2, max: 3 }))).toBeVisible();
  await composer.fill(`Yes we do ${stamp}`);
  await composer.press('Enter');
  await expect(two.frame.getByText(`Yes we do ${stamp}`)).toBeVisible();
  // only the selected view of the room is on screen: the customer panel stays mounted but hidden
  await expect(
    agent.getByRole('tabpanel', { name: th('workspace:chat.tab.conversation') }),
  ).toBeVisible();
  await expect(agent.locator('.aw-chat-tabs > [data-inert="true"]')).toBeHidden();
  await shot(agent, '05-workspace-two-rooms');

  // ── the second visitor ends their chat; the Agent sees it and saves the result ──
  await two.frame.getByRole('button', { name: text('widget', 'end') }).click();
  await two.frame
    .getByRole('alertdialog')
    .getByRole('button', { name: text('widget', 'endConfirm') })
    .click();
  await expect(
    two.frame.getByRole('button', { name: new RegExp(text('widget', 'startNew')) }),
  ).toBeVisible();
  await expect(agent.getByText(th('workspace:chat.closed.hint'))).toBeVisible({ timeout: 20_000 });
  await agent.getByRole('button', { name: th('workspace:chat.closed.goWrapup') }).click();
  let wrapup = agent.getByRole('article', { name: th('workspace:chat.wrapup.title') });
  await wrapup.getByRole('button', { name: th('workspace:wrapup.followUp') }).click();
  await wrapup.getByLabel(th('workspace:wrapup.note')).fill(`Shipping question ${stamp}`);
  await shot(agent, '06-workspace-wrapup');
  await wrapup.getByRole('button', { name: th('workspace:wrapup.submit') }).click();
  await expect(
    agent.getByText(
      new RegExp(
        escapeRegExp(th('workspace:chat.wrapup.saved', { visitor: '' }).trim().split(' ')[0]!),
      ),
    ),
  ).toBeVisible();

  // ── the first room comes back into view with its draft; the Agent ends it ──
  await expect(log).toContainText(firstQuestion);
  await expect(composer).toHaveValue('draft for the first room');
  await agent.getByRole('button', { name: th('workspace:chat.end') }).click();
  await agent.getByRole('button', { name: th('workspace:chat.end') }).click();
  await expect(agent.getByText(th('workspace:chat.closed.hint'))).toBeVisible();
  await expect(again.getByText(text('widget', 'system.agentEnded'))).toBeVisible({
    timeout: 30_000,
  });
  await shot(one.page, '07-widget-ended');
  await agent.getByRole('button', { name: th('workspace:chat.closed.goWrapup') }).click();
  wrapup = agent.getByRole('article', { name: th('workspace:chat.wrapup.title') });
  await wrapup.getByRole('button', { name: th('workspace:wrapup.assisted') }).click();
  await wrapup.getByLabel(th('workspace:wrapup.note')).fill(`Order located ${stamp}`);
  await wrapup.getByRole('button', { name: th('workspace:wrapup.submit') }).click();
  await expect(agent.getByText(th('workspace:chat.capacity', { count: 0, max: 3 }))).toBeVisible({
    timeout: 20_000,
  });
  await shot(agent, '08-workspace-done');

  // ── the Admin reads both conversations in the team history ──
  await admin.goto(`${consoleOrigin}/?tenant=demo&view=team-history&channel=WEBCHAT`);
  const rows = admin.getByRole('row').filter({ hasText: text('history', 'channels.webchat') });
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await rows.first().getByRole('button').click();
  const transcript = admin.getByRole('log', { name: text('history', 'chat.transcript') });
  await expect(transcript).toContainText(stamp);
  await shot(admin, '09-console-team-history-chat');
});
