import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { th } from './support/catalog';
import { homeNavigation } from './support/home-navigation.js';

const T = (key: string, options?: Record<string, unknown>) => th(`lineChannel:${key}`, options);

/**
 * #1054: Customer channels › LINE settings — the API is mocked with page.route
 * (real permissions, revisions and the LINE token check are covered by the API integration)
 */
test.use({ locale: 'th-TH' });

const tenantId = '7a33ac96-d87d-4ca4-ab75-f27e40e94a01';
const queues = [
  { id: 'q-line', name: 'LINE Support', teamName: 'Retail Support' },
  { id: 'q-general', name: 'General Support', teamName: null },
];
const SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'tokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';

type Channel = {
  id: string | null;
  revision: number;
  enabled: boolean;
  queueId: string | null;
  lineChannelId: string;
  autoReplyText: string;
  idleTimeoutSec: number;
  hasChannelSecret: boolean;
  hasAccessToken: boolean;
  channelSecretHint: string | null;
  accessTokenHint: string | null;
  botName: string;
  credentialsVerifiedAt: string | null;
  webhookPath: string | null;
};

const firstTime = (): Channel => ({
  id: null,
  revision: 0,
  enabled: false,
  queueId: null,
  lineChannelId: '',
  autoReplyText: '',
  idleTimeoutSec: 1800,
  hasChannelSecret: false,
  hasAccessToken: false,
  channelSecretHint: null,
  accessTokenHint: null,
  botName: '',
  credentialsVerifiedAt: null,
  webhookPath: null,
});
const saved = (): Channel => ({
  id: 'ch-7Hq2Lx9P',
  revision: 4,
  enabled: true,
  queueId: 'q-line',
  lineChannelId: '1234567890',
  autoReplyText: 'We will be right with you',
  idleTimeoutSec: 900,
  hasChannelSecret: true,
  hasAccessToken: true,
  channelSecretHint: 'cdef',
  accessTokenHint: 'abcd',
  botName: 'Demo Shop',
  credentialsVerifiedAt: '2026-11-27T03:00:00.000Z',
  webhookPath: `/api/v1/line/webhook/${tenantId}/ch-7Hq2Lx9P`,
});

/** the registry only lists LINE when the deployment sets `LINE_CHAT=on`, so add its entry to the fixture */
function navigationWithLine() {
  const navigation = homeNavigation(['admin']);
  return {
    ...navigation,
    apps: [
      ...navigation.apps,
      {
        id: 'line-settings',
        groupId: 'settings',
        labelKey: 'navigation.apps.lineSettings',
        hostApp: 'console',
        path: '/?view=line-settings',
      },
    ],
    areas: navigation.areas.map((area) =>
      area.id === 'integrations'
        ? {
            ...area,
            sections: [
              ...area.sections,
              {
                id: 'channels',
                labelKey: 'navigation.sections.channels',
                items: [{ appId: 'line-settings' }],
              },
            ],
          }
        : area,
    ),
  };
}

async function mockApi(
  page: Page,
  state: { channel: Channel; canEdit?: boolean },
  options: { putStatus?: number; putBody?: unknown } = {},
) {
  const puts: Record<string, unknown>[] = [];
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/line/channel', (route) => {
    const request = route.request();
    const body = () => ({
      tenantId,
      canEdit: state.canEdit ?? true,
      channel: state.channel,
      lastSaved: state.channel.id
        ? { at: '2026-11-27T03:00:00.000Z', byName: 'Somying Admin' }
        : null,
      queues,
    });
    if (request.method() === 'GET') return route.fulfill({ json: body() });
    puts.push(request.postDataJSON() as Record<string, unknown>);
    if (options.putStatus && options.putStatus !== 200)
      return route.fulfill({ status: options.putStatus, json: options.putBody ?? {} });
    const input = request.postDataJSON() as Record<string, unknown>;
    const id = state.channel.id ?? 'ch-NEW00001';
    state.channel = {
      ...state.channel,
      id,
      revision: state.channel.revision + 1,
      enabled: input.enabled as boolean,
      queueId: input.queueId as string | null,
      lineChannelId: input.lineChannelId as string,
      autoReplyText: input.autoReplyText as string,
      idleTimeoutSec: input.idleTimeoutSec as number,
      ...(typeof input.channelSecret === 'string'
        ? { hasChannelSecret: true, channelSecretHint: input.channelSecret.slice(-4) }
        : {}),
      ...(typeof input.accessToken === 'string'
        ? {
            hasAccessToken: true,
            accessTokenHint: input.accessToken.slice(-4),
            botName: 'Demo Shop',
            credentialsVerifiedAt: '2026-11-27T04:00:00.000Z',
          }
        : {}),
      webhookPath: `/api/v1/line/webhook/${tenantId}/${id}`,
    };
    return route.fulfill({ json: body() });
  });
  return puts;
}

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
}

/** the secret inputs only: a stored value is a group and a button that carry the same name */
const secretInput = (page: Page, name: string) =>
  page.getByLabel(name, { exact: true }).and(page.locator('input'));

const saveButton = (page: Page) => page.getByRole('button', { name: T('save'), exact: true });

test('first time: checklist, a first save sends the secret and token and then shows the webhook URL', async ({
  page,
}) => {
  const puts = await mockApi(page, { channel: firstTime() });
  await page.route('**/api/v1/me/navigation**', (route) =>
    route.fulfill({ json: navigationWithLine() }),
  );
  await page.goto('/?view=line-settings&tenant=demo');
  await expect(
    page.getByRole('link', { name: th('common:navigation.apps.lineSettings') }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: T('title'), level: 1 })).toBeVisible();
  await expect(page.getByText(T('status.notConfigured'))).toBeVisible();
  await expect(page.getByText(T('firstTime', { minutes: 30 }))).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: T('routing.idle') })).toHaveValue('30');
  await expect(page.getByText(T('webhook.afterSave'))).toBeVisible();
  await expect(page.getByRole('button', { name: T('webhook.copy') })).toBeDisabled();
  await axe(page);

  await page.getByRole('button', { name: new RegExp(T('routing.queuePlaceholder')) }).click();
  await page.getByRole('option', { name: /LINE Support/ }).click();
  await page.getByRole('textbox', { name: T('connection.channelId') }).fill('1234567890');
  const secret = secretInput(page, T('connection.secret'));
  await expect(secret).toHaveAttribute('type', 'password');
  await secret.fill(SECRET);
  await secretInput(page, T('connection.token')).fill(TOKEN);
  await page.getByRole('textbox', { name: T('autoReply.label') }).fill('Back soon');
  await page.getByText(T('state.toggle'), { exact: true }).click();
  await page.getByRole('button', { name: T('saveFirst') }).click();

  await expect(page.getByText(T('saved'))).toBeVisible();
  expect(puts[0]).toEqual({
    expectedRevision: 0,
    enabled: true,
    queueId: 'q-line',
    lineChannelId: '1234567890',
    channelSecret: SECRET,
    accessToken: TOKEN,
    autoReplyText: 'Back soon',
    idleTimeoutSec: 1800,
  });
  // the secrets leave the form and come back only as hints
  await expect(page.getByText(T('secret.saved', { hint: '…cdef' }))).toBeVisible();
  await expect(page.getByText(T('secret.saved', { hint: '…abcd' }))).toBeVisible();
  await expect(secretInput(page, T('connection.secret'))).toHaveCount(0);
  await expect(
    page.getByText(
      T('connection.verified', {
        bot: 'Demo Shop',
        when: new Date('2026-11-27T04:00:00.000Z').toLocaleString('th-TH'),
      }),
    ),
  ).toBeVisible();
  await expect(page.getByText(T('status.enabled'), { exact: true })).toBeVisible();
  const webhook = page.getByLabel(T('webhook.label'));
  await expect(webhook).toContainText(`/api/v1/line/webhook/${tenantId}/ch-NEW00001`);
  const origin = new URL(page.url()).origin;
  await expect(webhook).toContainText(`${origin}/api/v1/line/webhook/`);
});

test('saved secrets are not retyped: the save leaves them out and they stay saved', async ({
  page,
}) => {
  const puts = await mockApi(page, { channel: saved() });
  await page.goto('/?view=line-settings&tenant=demo');
  await expect(page.getByText(T('secret.saved', { hint: '…cdef' }))).toBeVisible();
  await expect(secretInput(page, T('connection.token'))).toHaveCount(0);
  await expect(saveButton(page)).toBeDisabled();
  await page.getByRole('textbox', { name: T('autoReply.label') }).fill('Updated reply');
  await saveButton(page).click();
  await expect.poll(() => puts.length).toBe(1);
  await expect(saveButton(page)).toBeDisabled();
  expect(puts[0]).toEqual({
    expectedRevision: 4,
    enabled: true,
    queueId: 'q-line',
    lineChannelId: '1234567890',
    autoReplyText: 'Updated reply',
    idleTimeoutSec: 900,
  });
  expect('channelSecret' in puts[0]!).toBe(false);
  expect('accessToken' in puts[0]!).toBe(false);
  await expect(page.getByText(T('secret.saved', { hint: '…abcd' }))).toBeVisible();
  await expect(page.getByText(/Somying Admin/)).toBeVisible();
});

test('replacing a token: an input appears, and keeping the saved value goes back to the hint', async ({
  page,
}) => {
  const puts = await mockApi(page, { channel: saved() });
  await page.goto('/?view=line-settings&tenant=demo');
  await page
    .getByRole('button', { name: T('secret.replaceLabel', { name: T('connection.token') }) })
    .click();
  const token = secretInput(page, T('connection.token'));
  await expect(token).toBeFocused();
  await token.fill(TOKEN);
  await expect(saveButton(page)).toBeEnabled();
  await page.getByRole('button', { name: T('secret.keep') }).click();
  await expect(secretInput(page, T('connection.token'))).toHaveCount(0);
  // the keyboard stays on the field: back on its "Replace" button, not lost to the page
  await expect(
    page.getByRole('button', { name: T('secret.replaceLabel', { name: T('connection.token') }) }),
  ).toBeFocused();
  await expect(saveButton(page)).toBeDisabled();
  expect(puts).toHaveLength(0);
});

test('LINE does not accept the token: the message is under the token field and what was typed stays', async ({
  page,
}) => {
  await mockApi(
    page,
    { channel: saved() },
    {
      putStatus: 422,
      putBody: { code: 'LINE_TOKEN_REJECTED', field: 'accessToken' },
    },
  );
  await page.goto('/?view=line-settings&tenant=demo');
  await page
    .getByRole('button', { name: T('secret.replaceLabel', { name: T('connection.token') }) })
    .click();
  await secretInput(page, T('connection.token')).fill(TOKEN);
  await saveButton(page).click();
  await expect(page.getByText(T('errors.tokenRejected'))).toBeVisible();
  await expect(secretInput(page, T('connection.token'))).toHaveValue(TOKEN);
  await expect(secretInput(page, T('connection.token'))).toBeFocused();
  await axe(page);
});

test('cannot turn on without a queue, secret and token: errors under the fields and nothing is sent', async ({
  page,
}) => {
  const puts = await mockApi(page, { channel: firstTime() });
  await page.goto('/?view=line-settings&tenant=demo');
  await page.getByText(T('state.toggle'), { exact: true }).click();
  await page.getByRole('button', { name: T('saveFirst') }).click();
  await expect(page.getByText(T('errors.queueRequired'))).toBeVisible();
  await expect(page.getByText(T('errors.secretRequired'))).toBeVisible();
  await expect(page.getByText(T('errors.tokenRequired'))).toBeVisible();
  await expect(page.getByText(T('state.cannotEnable', { count: 3 }))).toBeVisible();
  expect(puts).toHaveLength(0);
  await axe(page);
});

test('wrong values are reported under their own field before anything is sent', async ({
  page,
}) => {
  const puts = await mockApi(page, { channel: firstTime() });
  await page.goto('/?view=line-settings&tenant=demo');
  await page.getByRole('textbox', { name: T('connection.channelId') }).fill('12ab');
  await secretInput(page, T('connection.secret')).fill('not-hex');
  await secretInput(page, T('connection.token')).fill('short');
  await page.getByRole('spinbutton', { name: T('routing.idle') }).fill('2000');
  await page.getByRole('button', { name: T('saveFirst') }).click();
  await expect(page.getByText(T('errors.channelIdInvalid'))).toBeVisible();
  await expect(page.getByText(T('errors.secretInvalid'))).toBeVisible();
  await expect(page.getByText(T('errors.tokenInvalid'))).toBeVisible();
  await expect(page.getByText(T('errors.idleRange', { min: 1, max: 1440 }))).toBeVisible();
  expect(puts).toHaveLength(0);
});

test('a failed save, LINE being unreachable and a missing secret key each say so and keep the form', async ({
  page,
}) => {
  const puts = await mockApi(page, { channel: saved() }, { putStatus: 503 });
  await page.goto('/?view=line-settings&tenant=demo');
  await page.getByRole('textbox', { name: T('autoReply.label') }).fill('Typed text');
  await saveButton(page).click();
  await expect(page.getByRole('alert')).toContainText(T('saveFailed'));
  await expect(page.getByRole('textbox', { name: T('autoReply.label') })).toHaveValue('Typed text');
  await page.getByRole('button', { name: T('retrySave') }).click();
  expect(puts).toHaveLength(2);

  await page.unrouteAll();
  await mockApi(
    page,
    { channel: saved() },
    { putStatus: 503, putBody: { code: 'LINE_UNAVAILABLE' } },
  );
  await page.goto('/?view=line-settings&tenant=demo');
  await page.getByRole('textbox', { name: T('autoReply.label') }).fill('Typed again');
  await saveButton(page).click();
  await expect(page.getByRole('alert')).toContainText(T('lineUnavailable'));
  await expect(page.getByRole('button', { name: T('retrySave') })).toBeVisible();

  await page.unrouteAll();
  await mockApi(
    page,
    { channel: saved() },
    { putStatus: 503, putBody: { code: 'SECRET_STORE_UNAVAILABLE' } },
  );
  await page.goto('/?view=line-settings&tenant=demo');
  await page.getByRole('textbox', { name: T('autoReply.label') }).fill('Typed third');
  await saveButton(page).click();
  await expect(page.getByRole('alert')).toContainText(T('secretStoreUnavailable'));
  await expect(page.getByRole('button', { name: T('retrySave') })).toHaveCount(0);
});

test('a revision conflict says so, keeps the typed text, and lets the person take the latest', async ({
  page,
}) => {
  await mockApi(
    page,
    { channel: saved() },
    { putStatus: 409, putBody: { code: 'REVISION_CONFLICT' } },
  );
  await page.goto('/?view=line-settings&tenant=demo');
  await page.getByRole('textbox', { name: T('autoReply.label') }).fill('My edit');
  await saveButton(page).click();
  await expect(page.getByRole('alert')).toContainText(T('conflict'));
  await expect(page.getByRole('textbox', { name: T('autoReply.label') })).toHaveValue('My edit');
  await page.getByRole('button', { name: T('conflictUseLatest') }).click();
  await expect(page.getByRole('textbox', { name: T('autoReply.label') })).toHaveValue(
    'We will be right with you',
  );
});

test('Supervisor sees the settings read-only with the webhook URL and the steps', async ({
  page,
}) => {
  await mockApi(page, { channel: saved(), canEdit: false });
  await page.goto('/?view=line-settings&tenant=demo');
  await expect(page.getByText(T('readOnly'))).toBeVisible();
  await expect(page.getByRole('switch', { name: T('state.toggle') })).toBeDisabled();
  await expect(page.getByRole('spinbutton', { name: T('routing.idle') })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: T('autoReply.label') })).toBeDisabled();
  await expect(page.getByRole('button', { name: T('save'), exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: T('secret.replace') })).toHaveCount(0);
  await expect(page.getByText(T('secret.saved', { hint: '…cdef' }))).toBeVisible();
  await expect(page.getByLabel(T('webhook.label'))).toContainText('/api/v1/line/webhook/');
  await expect(page.getByRole('button', { name: T('webhook.copy') })).toBeEnabled();
  await expect(page.getByText(T('steps.autoResponse'))).toBeVisible();
  await expect(page.getByText(T('quota'))).toBeVisible();
  await axe(page);
});

test('copying the webhook URL switches the button to "copied"', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockApi(page, { channel: saved() });
  await page.goto('/?view=line-settings&tenant=demo');
  await page.getByRole('button', { name: T('webhook.copy') }).click();
  await expect(page.getByRole('button', { name: T('webhook.copied') })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${new URL(page.url()).origin}/api/v1/line/webhook/${tenantId}/ch-7Hq2Lx9P`,
  );
});

test('403 shows the no-access page and 404 (feature off) the locked page', async ({ page }) => {
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/line/channel', (route) =>
    route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } }),
  );
  await page.goto('/?view=line-settings&tenant=demo');
  await expect(page.getByRole('heading', { name: T('forbidden.title') })).toBeVisible();
  await page.unrouteAll();
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/line/channel', (route) =>
    route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } }),
  );
  await page.goto('/?view=line-settings&tenant=demo');
  await expect(page.getByRole('heading', { name: T('locked.title') })).toBeVisible();
  await axe(page);
});

test('loading shows a skeleton with a status message and no form yet', async ({ page }) => {
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v1/line/channel', async (route) => {
    await gate;
    return route.fulfill({
      json: { tenantId, canEdit: true, channel: saved(), lastSaved: null, queues },
    });
  });
  await page.goto('/?view=line-settings&tenant=demo');
  await expect(page.getByRole('status')).toContainText(T('loading'));
  await expect(page.getByRole('switch')).toHaveCount(0);
  release();
  await expect(page.getByRole('heading', { name: T('title'), level: 1 })).toBeVisible();
});
