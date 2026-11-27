import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { th } from '../e2e/catalog';
import { escapeRegExp } from '../e2e/locale-match';

/**
 * #1054 LINE chat on the real stack (`LINE_CHAT=on`, LINE simulator on 127.0.0.1:8890):
 *
 * the Admin connects the LINE channel in Console → a LINE user writes while nobody is online and gets
 * the auto reply once → agent1000 signs in, accepts the offer and answers; the answer reaches the user
 * as a push → a sticker shows as a placeholder → a push LINE refuses shows as not delivered → the Agent
 * ends and saves the result → the same user writes again and new work opens → the Admin reads the
 * conversation in the team history.
 *
 * A trial tool, not acceptance of LINE itself: the simulator stands in for LINE's API and its users.
 */
const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, '../test-results-real/line-trial');
// The dev stack by default; set these to run the same trial against another deployment (e.g. UAT Solo).
const workspaceOrigin = process.env.WEBCHAT_TRIAL_WORKSPACE ?? 'http://localhost:5173';
const consoleOrigin = process.env.WEBCHAT_TRIAL_CONSOLE ?? 'http://localhost:5174';
/** dev realm passwords unless given; never printed */
const adminPassword = process.env.WEBCHAT_TRIAL_ADMIN_PASSWORD ?? 'admin1234';
const agentPassword = process.env.WEBCHAT_TRIAL_AGENT_PASSWORD ?? 'agent1234';
const simulator = process.env.LINE_TRIAL_SIMULATOR ?? 'http://127.0.0.1:8890';
/** fixed so the same channel can be saved again on every run */
const channelSecret = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const accessToken = 'sim-long-lived-token-0123456789abcdef';

type Catalog = Record<string, unknown>;
const load = (path: string) => JSON.parse(readFileSync(resolve(here, path), 'utf8')) as Catalog;
const catalogs = {
  line: load('../../console/src/i18n/locales/th/line-channel.json'),
  history: load('../../console/src/i18n/locales/th/history.json'),
  teamHistory: load('../../console/src/i18n/locales/th/team-history.json'),
  common: load('../../console/src/i18n/locales/th/common.json'),
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
  await useThai(page);
}

/** The language is a saved preference of the user; this run reads the Thai catalogs, so pick Thai. */
async function useThai(page: Page) {
  const thai = page.getByRole('button', { name: 'ไทย', exact: true }); // allow-thai: the language name the shell shows
  await thai.waitFor({ timeout: 30_000 });
  if ((await thai.getAttribute('aria-pressed')) !== 'true') await thai.click();
  await expect(thai).toHaveAttribute('aria-pressed', 'true');
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

async function sim<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${simulator}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as T;
}
type SimMessage = { from: 'user' | 'bot'; kind: string; text?: string; type?: string };
const thread = (userId: string) =>
  sim<{ messages: SimMessage[] }>(`/sim/messages?userId=${userId}`).then((r) => r.messages);

test('LINE chat: Console setup → auto reply → Agent answers by push → sticker → failed push → wrap-up → new work → history', async ({
  browser,
  page: agent,
}) => {
  mkdirSync(shots, { recursive: true });
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: resolve(shots, `${name}.png`) });
  const stamp = Date.now().toString(36);
  // a new LINE user on every run, so the run does not meet work an earlier run left behind
  const user = `U${(stamp + '0'.repeat(32)).replace(/[^0-9a-f]/g, 'a').slice(0, 32)}`;
  await sim('/sim/reset', {});

  // ── the Admin connects the LINE channel ──
  const adminContext = await browser.newContext({
    locale: 'th-TH',
    viewport: { width: 1440, height: 900 },
  });
  const admin = await adminContext.newPage();
  await signIn(
    admin,
    `${consoleOrigin}/?tenant=demo&view=line-settings`,
    'admin@demo.local',
    adminPassword,
    text('common', 'auth.signIn'),
  );
  await admin.goto(`${consoleOrigin}/?tenant=demo&view=line-settings`);
  await useThai(admin);
  await expect(admin.getByRole('heading', { level: 1, name: text('line', 'title') })).toBeVisible();
  const queue = admin.getByRole('button', { name: new RegExp(text('line', 'routing.queue')) });
  if (!(await queue.innerText()).includes('General')) {
    await queue.click();
    await admin.getByRole('option').first().click();
  }
  // a stored secret and token are kept; a first run types them
  for (const [label, value] of [
    [text('line', 'connection.secret'), channelSecret],
    [text('line', 'connection.token'), accessToken],
  ] as const) {
    const replace = admin.getByRole('button', {
      name: text('line', 'secret.replaceLabel', { name: label }),
    });
    if (await replace.isVisible()) continue;
    await admin.getByLabel(label, { exact: true }).fill(value);
  }
  const autoReply = `Thanks for writing, we will answer soon ${stamp}`;
  await admin.getByLabel(text('line', 'autoReply.label'), { exact: true }).fill(autoReply);
  const toggle = admin.getByRole('switch', { name: text('line', 'state.toggle') });
  if (!(await toggle.isChecked())) await toggle.click({ force: true });
  const save = admin.getByRole('button', {
    name: new RegExp(
      `^(${escapeRegExp(text('line', 'saveFirst'))}|${escapeRegExp(text('line', 'save'))})$`,
    ),
  });
  await save.click();
  await expect(save).toBeDisabled();
  await expect(
    admin
      .getByText(
        new RegExp(
          escapeRegExp(
            text('line', 'connection.verified', { bot: 'D-Contact Demo OA', when: '' })
              .trim()
              .split(' ')[0]!,
          ),
        ),
      )
      .first(),
  ).toBeVisible();
  const webhookUrl = (await admin.getByLabel(text('line', 'webhook.label')).innerText()).trim();
  expect(webhookUrl).toMatch(/\/api\/v1\/line\/webhook\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  await shot(admin, '01-console-line-settings');
  await sim('/sim/config', { webhookUrl, channelSecret });

  // ── a LINE user writes: with nobody online the auto reply answers once and the chat waits ──
  // A previous run may have left agent1000 Ready; then nobody gets an auto reply. Either way the user
  // gets at most one, and only the text the Admin set.
  const first = `Where is my parcel ${stamp}`;
  expect((await sim<{ status: number }>('/sim/send', { userId: user, text: first })).status).toBe(
    200,
  );
  await sim('/sim/send', { userId: user, text: `Hello? ${stamp}` });
  await agent.waitForTimeout(3_000);
  const replies = (await thread(user)).filter((m) => m.kind === 'reply').map((m) => m.text);
  expect(replies.length).toBeLessThanOrEqual(1);
  if (replies.length) expect(replies).toEqual([autoReply]);
  test.info().annotations.push({
    type: 'auto reply',
    description: replies.length ? 'sent once (nobody online)' : 'not sent (an Agent was online)',
  });

  // ── the Agent signs in and is offered the waiting chat ──
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
    agentPassword,
    th('dphone:embedAuth.signIn'),
  );
  await agentReady(agent);
  const offers = agent.getByRole('region', { name: th('workspace:chat.offer.region') });
  // The offer shows the customer's latest message. The status page can come back once after the work
  // session moved here; keep answering it, and allow for an offer that timed out on the way to come
  // round again after the re-offer pause.
  const mine = offers.locator('article').filter({ hasText: `Hello? ${stamp}` });
  const deadline = Date.now() + 120_000;
  while (!(await mine.isVisible())) {
    if (Date.now() > deadline) throw new Error('the LINE offer did not reach the Agent');
    await agentReady(agent);
    await agent.waitForTimeout(1_000);
  }
  await expect(offers.locator('article').filter({ hasText: stamp })).toContainText(
    th('workspace:layout.channelLine'),
  );
  await shot(agent, '02-workspace-line-offer');
  await offers
    .locator('article')
    .filter({ hasText: stamp })
    .getByRole('button', { name: th('workspace:chat.offer.accept') })
    .click();
  const log = agent.getByRole('log');
  await expect(log).toContainText(first);
  await expect(log).toContainText(`Hello? ${stamp}`);

  // ── the answer reaches the LINE user as a push ──
  const composer = agent.getByRole('textbox', { name: th('workspace:chat.composer.label') });
  await composer.fill(`Your parcel is on its way ${stamp}`);
  await composer.press('Enter');
  await expect
    .poll(async () => (await thread(user)).filter((m) => m.kind === 'push').map((m) => m.text))
    .toEqual([`Your parcel is on its way ${stamp}`]);
  await expect(log.getByText(th('workspace:chat.delivery.sending'))).toHaveCount(0, {
    timeout: 15_000,
  });

  // ── a sticker shows as a placeholder; the user's next text arrives live ──
  await sim('/sim/send', { userId: user, type: 'sticker' });
  await expect(log).toContainText(th('workspace:chat.other.sticker'));
  await sim('/sim/send', { userId: user, text: `Thank you ${stamp}` });
  await expect(log).toContainText(`Thank you ${stamp}`);
  expect(notices.length, 'changes were announced over the Workspace socket').toBeGreaterThan(0);

  // ── a push LINE refuses is shown as not delivered ──
  await sim('/sim/faults', { push: '400' });
  await composer.fill(`This one will fail ${stamp}`);
  await composer.press('Enter');
  await expect(log.getByText(th('workspace:chat.delivery.failed'))).toBeVisible({
    timeout: 20_000,
  });
  await sim('/sim/faults', { push: 'ok' });
  await shot(agent, '03-workspace-line-chat');

  // ── the Agent ends the chat and saves the result ──
  await agent.getByRole('button', { name: th('workspace:chat.end') }).click();
  await agent.getByRole('button', { name: th('workspace:chat.end') }).click();
  await agent.getByRole('button', { name: th('workspace:chat.closed.goWrapup') }).click();
  const wrapup = agent.getByRole('article', { name: th('workspace:chat.wrapup.title') });
  await wrapup.getByRole('button', { name: th('workspace:wrapup.assisted') }).click();
  await wrapup.getByLabel(th('workspace:wrapup.note')).fill(`Parcel tracked ${stamp}`);
  await wrapup.getByRole('button', { name: th('workspace:wrapup.submit') }).click();
  await expect(agent.getByText(th('workspace:chat.capacity', { count: 0, max: 3 }))).toBeVisible({
    timeout: 20_000,
  });

  // ── the same LINE user writes again: new work, no auto reply while the Agent is on ──
  await sim('/sim/send', { userId: user, text: `One more thing ${stamp}` });
  await expect(offers).toContainText(`One more thing ${stamp}`, { timeout: 30_000 });
  // the Agent is on: no new auto reply
  expect((await thread(user)).filter((m) => m.kind === 'reply')).toHaveLength(replies.length);
  await offers
    .locator('article')
    .filter({ hasText: stamp })
    .getByRole('button', { name: th('workspace:chat.offer.accept') })
    .click();
  await expect(log).toContainText(`One more thing ${stamp}`);
  await expect(log).not.toContainText(first);
  await agent.getByRole('button', { name: th('workspace:chat.end') }).click();
  await agent.getByRole('button', { name: th('workspace:chat.end') }).click();
  await agent.getByRole('button', { name: th('workspace:chat.closed.goWrapup') }).click();
  const again = agent.getByRole('article', { name: th('workspace:chat.wrapup.title') });
  await again.getByRole('button', { name: th('workspace:wrapup.followUp') }).click();
  await again.getByLabel(th('workspace:wrapup.note')).fill(`Second question ${stamp}`);
  await again.getByRole('button', { name: th('workspace:wrapup.submit') }).click();
  await expect(agent.getByText(th('workspace:chat.capacity', { count: 0, max: 3 }))).toBeVisible({
    timeout: 20_000,
  });

  // ── the Admin reads the LINE conversation in the team history ──
  await admin.goto(`${consoleOrigin}/?tenant=demo&view=team-history&channel=LINE`);
  await useThai(admin);
  const rows = admin.getByRole('row').filter({ hasText: text('history', 'channels.line') });
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await rows.first().getByRole('button').click();
  const transcript = admin.getByRole('log', { name: text('history', 'chat.transcript') });
  await expect(transcript).toContainText(stamp);
  await shot(admin, '04-console-team-history-line');
});
