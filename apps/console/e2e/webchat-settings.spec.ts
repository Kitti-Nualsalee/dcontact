import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { th } from './support/catalog';
import { homeNavigation } from './support/home-navigation.js';

const T = (key: string, options?: Record<string, unknown>) => th(`webchat:${key}`, options);

/**
 * #1044: Customer channels › Web Chat settings — the API is mocked with page.route
 * (real permissions and revisions are checked by the API integration)
 */
test.use({ locale: 'th-TH' });

const tenantId = '7a33ac96-d87d-4ca4-ab75-f27e40e94a01';
const queues = [
  { id: 'q-sales', name: 'Online Sales', teamName: 'Retail Support' },
  { id: 'q-support', name: 'General Support', teamName: null },
];

type Widget = {
  id: string | null;
  revision: number;
  enabled: boolean;
  queueId: string | null;
  allowedOrigins: string[];
  greetingTh: string;
  greetingEn: string;
  maxChatsPerAgent: number;
  idleTimeoutSec: number;
};

const firstTime = (): Widget => ({
  id: null,
  revision: 0,
  enabled: false,
  queueId: null,
  allowedOrigins: [],
  greetingTh: '',
  greetingEn: '',
  maxChatsPerAgent: 3,
  idleTimeoutSec: 600,
});
const saved = (): Widget => ({
  id: 'wc_7Hq2Lx9P',
  revision: 4,
  enabled: true,
  queueId: 'q-sales',
  allowedOrigins: ['https://shop.example.com'],
  greetingTh: 'Welcome',
  greetingEn: 'Hello',
  maxChatsPerAgent: 4,
  idleTimeoutSec: 900,
});

/** the registry only lists Web Chat when the deployment sets `WEBCHAT=on`, so add its entry to the fixture */
function navigationWithWebchat() {
  const navigation = homeNavigation(['admin']);
  return {
    ...navigation,
    apps: [
      ...navigation.apps,
      {
        id: 'webchat-settings',
        groupId: 'settings',
        labelKey: 'navigation.apps.webchatSettings',
        hostApp: 'console',
        path: '/?view=webchat-settings',
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
                items: [{ appId: 'webchat-settings' }],
              },
            ],
          }
        : area,
    ),
  };
}

async function mockApi(
  page: Page,
  state: { widget: Widget; canEdit?: boolean },
  options: { putStatus?: number; putBody?: unknown } = {},
) {
  const puts: Record<string, unknown>[] = [];
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/webchat/widget', (route) => {
    const request = route.request();
    const body = () => ({
      tenantId,
      canEdit: state.canEdit ?? true,
      widget: state.widget,
      queues,
    });
    if (request.method() === 'GET') return route.fulfill({ json: body() });
    puts.push(request.postDataJSON() as Record<string, unknown>);
    if (options.putStatus && options.putStatus !== 200)
      return route.fulfill({ status: options.putStatus, json: options.putBody ?? {} });
    const input = request.postDataJSON() as Omit<Widget, 'id' | 'revision' | 'idleTimeoutSec'> & {
      idleTimeoutSec: number;
    };
    state.widget = {
      ...state.widget,
      ...input,
      id: state.widget.id ?? 'wc_NEW00001',
      revision: state.widget.revision + 1,
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

test('first time: defaults, checklist, and a first save creates the embed code', async ({
  page,
}) => {
  const puts = await mockApi(page, { widget: firstTime() });
  await page.route('**/api/v1/me/navigation**', (route) =>
    route.fulfill({ json: navigationWithWebchat() }),
  );
  await page.goto('/?view=webchat-settings&tenant=demo');
  await expect(
    page.getByRole('link', { name: th('common:navigation.apps.webchatSettings') }),
  ).toBeVisible();
  await expect(
    page.getByText(th('common:navigation.sections.channels'), { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: T('title'), level: 1 })).toBeVisible();
  await expect(page.getByText(T('status.notConfigured'))).toBeVisible();
  await expect(page.getByText(T('firstTime', { capacity: 3, minutes: 10 }))).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: T('routing.capacity') })).toHaveValue('3');
  await expect(page.getByRole('spinbutton', { name: T('routing.idle') })).toHaveValue('10');
  await expect(page.getByText(T('snippet.afterSave'))).toBeVisible();
  await expect(page.getByRole('button', { name: T('snippet.copy') })).toBeDisabled();
  await axe(page);

  await page.getByRole('button', { name: new RegExp(T('routing.queuePlaceholder')) }).click();
  await page.getByRole('option', { name: /Online Sales/ }).click();
  await page
    .getByRole('textbox', { name: T('origins.newLabel') })
    .fill('HTTPS://Shop.Example.com/');
  await page.getByRole('button', { name: T('origins.add') }).click();
  await expect(page.getByText('https://shop.example.com', { exact: true })).toBeVisible();
  await page.getByText(T('state.toggle'), { exact: true }).click();
  await page.getByRole('button', { name: T('saveFirst') }).click();

  await expect(page.getByText(T('saved'))).toBeVisible();
  expect(puts[0]).toEqual({
    expectedRevision: 0,
    enabled: true,
    queueId: 'q-sales',
    allowedOrigins: ['https://shop.example.com'],
    greetingTh: '',
    greetingEn: '',
    maxChatsPerAgent: 3,
    idleTimeoutSec: 600,
  });
  const snippet = page.getByLabel(T('snippet.label'));
  await expect(snippet).toContainText('/api/v1/webchat/widget.js');
  await expect(snippet).toContainText(`data-tenant="${tenantId}"`);
  await expect(snippet).toContainText('data-widget="wc_NEW00001"');
  await expect(page.getByText(T('status.enabled'), { exact: true })).toBeVisible();
  const preview = page.getByRole('link', { name: T('preview.open') });
  await expect(preview).toHaveAttribute(
    'href',
    /\/api\/v1\/webchat\/demo\?tenant=.*&widget=wc_NEW00001/,
  );
  await expect(preview).toHaveAttribute('target', '_blank');
});

test('loading shows a skeleton with a status message and no form yet', async ({ page }) => {
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v1/webchat/widget', async (route) => {
    await gate;
    return route.fulfill({ json: { tenantId, canEdit: true, widget: saved(), queues } });
  });
  await page.goto('/?view=webchat-settings&tenant=demo');
  await expect(page.getByRole('status')).toContainText(T('loading'));
  await expect(page.getByRole('switch')).toHaveCount(0);
  release();
  await expect(page.getByRole('heading', { name: T('title'), level: 1 })).toBeVisible();
});

test('cannot turn on without a domain: errors under the field, a checklist, and nothing is sent', async ({
  page,
}) => {
  const puts = await mockApi(page, {
    widget: { ...saved(), enabled: false, allowedOrigins: [], queueId: 'q-sales' },
  });
  await page.goto('/?view=webchat-settings&tenant=demo');
  await expect(page.getByText(T('status.disabled'), { exact: true })).toBeVisible();
  await page.getByText(T('state.toggle'), { exact: true }).click();
  await page.getByRole('button', { name: T('save'), exact: true }).click();
  await expect(page.getByText(T('errors.originRequired'))).toBeVisible();
  await expect(page.getByText(T('state.cannotEnable', { count: 1 }))).toBeVisible();
  // focus goes to the first field that is wrong
  await expect(page.getByRole('textbox', { name: T('origins.newLabel') })).toBeFocused();
  expect(puts).toHaveLength(0);
  await axe(page);
});

test('wrong values are reported under their own field before anything is sent', async ({
  page,
}) => {
  const puts = await mockApi(page, { widget: saved() });
  await page.goto('/?view=webchat-settings&tenant=demo');
  await page.getByRole('spinbutton', { name: T('routing.capacity') }).fill('12');
  await page
    .getByRole('textbox', { name: T('origins.newLabel') })
    .fill('https://shop.example.com/checkout');
  await page.getByRole('button', { name: T('origins.add') }).click();
  await expect(page.getByText(T('origins.invalid'))).toBeVisible();
  await page.getByRole('button', { name: T('save'), exact: true }).click();
  await expect(page.getByText(T('errors.capacityRange'))).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: T('routing.capacity') })).toBeFocused();
  expect(puts).toHaveLength(0);
});

test('a failed save keeps what was typed and can be tried again', async ({ page }) => {
  const puts = await mockApi(page, { widget: saved() }, { putStatus: 503 });
  await page.goto('/?view=webchat-settings&tenant=demo');
  await page.getByRole('textbox', { name: T('welcome.en') }).fill('Hello from the shop');
  await page.getByRole('button', { name: T('save'), exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(T('saveFailed'));
  await expect(page.getByRole('textbox', { name: T('welcome.en') })).toHaveValue(
    'Hello from the shop',
  );
  await page.getByRole('button', { name: T('retrySave') }).click();
  expect(puts).toHaveLength(2);
});

test('a revision conflict says so, keeps the typed text, and lets the person take the latest', async ({
  page,
}) => {
  await mockApi(
    page,
    { widget: saved() },
    { putStatus: 409, putBody: { code: 'REVISION_CONFLICT' } },
  );
  await page.goto('/?view=webchat-settings&tenant=demo');
  await page.getByRole('textbox', { name: T('welcome.en') }).fill('My edit');
  await page.getByRole('button', { name: T('save'), exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(T('conflict'));
  await expect(page.getByRole('textbox', { name: T('welcome.en') })).toHaveValue('My edit');
  await page.getByRole('button', { name: T('conflictUseLatest') }).click();
  await expect(page.getByRole('textbox', { name: T('welcome.en') })).toHaveValue('Hello');
});

test('Supervisor sees the settings read-only with the reason, and can still copy the embed code', async ({
  page,
}) => {
  await mockApi(page, { widget: saved(), canEdit: false });
  await page.goto('/?view=webchat-settings&tenant=demo');
  await expect(page.getByText(T('readOnly'))).toBeVisible();
  await expect(page.getByRole('switch', { name: T('state.toggle') })).toBeDisabled();
  await expect(page.getByRole('spinbutton', { name: T('routing.capacity') })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: T('welcome.th') })).toBeDisabled();
  await expect(page.getByRole('button', { name: T('save'), exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: T('origins.add') })).toHaveCount(0);
  await expect(page.getByRole('button', { name: T('snippet.copy') })).toBeEnabled();
  await axe(page);
});

test('copying the embed code switches the button to "copied"', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockApi(page, { widget: saved() });
  await page.goto('/?view=webchat-settings&tenant=demo');
  await page.getByRole('button', { name: T('snippet.copy') }).click();
  await expect(page.getByRole('button', { name: T('snippet.copied') })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    'data-widget="wc_7Hq2Lx9P"',
  );
});

test('403 shows the no-access page and 404 (feature off) the locked page', async ({ page }) => {
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/webchat/widget', (route) =>
    route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } }),
  );
  await page.goto('/?view=webchat-settings&tenant=demo');
  await expect(page.getByRole('heading', { name: T('forbidden.title') })).toBeVisible();
  await page.unrouteAll();
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/webchat/widget', (route) =>
    route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } }),
  );
  await page.goto('/?view=webchat-settings&tenant=demo');
  await expect(page.getByRole('heading', { name: T('locked.title') })).toBeVisible();
  await axe(page);
});

test('long origins and a full list keep the page usable', async ({ page }) => {
  const origins = Array.from(
    { length: 10 },
    (_, index) => `https://very-long-subdomain-name-${index}.shop-with-a-long-name.example.co.th`,
  );
  await mockApi(page, { widget: { ...saved(), allowedOrigins: origins } });
  await page.goto('/?view=webchat-settings&tenant=demo');
  await expect(page.getByText(T('origins.limit', { limit: 10 }))).toBeVisible();
  await expect(page.getByRole('textbox', { name: T('origins.newLabel') })).toHaveCount(0);
  await page.getByRole('button', { name: T('origins.remove', { origin: origins[0] }) }).click();
  await expect(page.getByRole('textbox', { name: T('origins.newLabel') })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
