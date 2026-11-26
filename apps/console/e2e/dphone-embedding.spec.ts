import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { th } from './support/catalog';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const T = (key: string, options?: Record<string, unknown>) =>
  th(`integrations:dphoneEmbedding.${key}`, options);

/**
 * E1.11 (#485): Integrations › dphone embedding — the API is mocked with page.route (real permissions are checked in the API integration)
 */
test.use({ locale: 'th-TH' });

type Origin = {
  id: string;
  origin: string;
  label: string;
  enabled: boolean;
  screenPopLevel: 'off' | 'ids' | 'contact';
  revision: number;
  createdAt: string;
  updatedAt: string;
  activeSessions: number;
};

async function mockApi(
  page: Page,
  state: { entitled: boolean; flagEnabled: boolean; origins: Origin[] },
) {
  const writes: { method: string; body: unknown }[] = [];
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({
      status: 200,
      json: {
        groups: [],
        apps: [],
        pins: { appIds: [], source: 'SYSTEM', revision: 0 },
        limits: { maxPins: 15 },
        features: { shellV2: false },
      },
    }),
  );
  await page.route('**/api/v1/tenant/embed-origins**', async (route) => {
    const request = route.request();
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    if (method === 'GET') return route.fulfill({ status: 200, json: { ...state, limit: 10 } });
    writes.push({ method, body });
    if (method === 'POST') {
      const created: Origin = {
        id: `00000000-0000-4000-8000-00000000000${state.origins.length + 1}`,
        origin: (body as { origin: string }).origin,
        label: (body as { label: string }).label,
        enabled: true,
        screenPopLevel: 'off',
        revision: 1,
        createdAt: '2026-09-28T00:00:00.000Z',
        updatedAt: '2026-09-28T00:00:00.000Z',
        activeSessions: 0,
      };
      state.origins.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    const id = new URL(request.url()).pathname.split('/').pop();
    const index = state.origins.findIndex((origin) => origin.id === id);
    if (method === 'DELETE') {
      state.origins.splice(index, 1);
      return route.fulfill({ status: 204, body: '' });
    }
    const current = state.origins[index]!;
    Object.assign(current, body, { revision: current.revision + 1 });
    return route.fulfill({ status: 200, json: current });
  });
  return writes;
}

const sample = (): Origin => ({
  id: '00000000-0000-4000-8000-0000000000aa',
  origin: 'https://crm.example.test',
  label: 'Sales CRM',
  enabled: true,
  screenPopLevel: 'off',
  revision: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  activeSessions: 2,
});

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
}

test('ADMIN: check the origin as soon as it is typed, add an origin normalized, and there is a snippet', async ({
  page,
}) => {
  const writes = await mockApi(page, { entitled: true, flagEnabled: true, origins: [] });
  await page.goto('/?view=dphone-embedding&tenant=demo');
  await expect(page.getByRole('heading', { name: T('title'), level: 1 })).toBeVisible();
  await expect(page.getByText(T('table.empty'))).toBeVisible();

  const origin = page.getByRole('textbox', { name: 'Origin' });
  await origin.fill('https://*.example.test');
  await expect(page.getByText(T('rejections.WILDCARD'))).toBeVisible();
  await expect(page.getByRole('button', { name: T('form.submit') })).toBeDisabled();
  await origin.fill('HTTPS://Sales.Example.test:443/');
  await expect(
    page.getByText(T('form.normalized', { origin: 'https://sales.example.test' })),
  ).toBeVisible();
  await page.getByLabel(T('form.label')).fill('Internal CRM');
  await page.getByRole('button', { name: T('form.submit') }).click();
  await expect(
    page.getByRole('cell', { name: 'https://sales.example.test', exact: true }),
  ).toBeVisible();
  expect(writes[0]).toEqual({
    method: 'POST',
    body: { origin: 'https://sales.example.test', label: 'Internal CRM' },
  });
  await expect(page.locator('pre')).toContainText('/embed/v1/dphone-launcher.js');
  await expect(page.locator('pre')).toContainText('<dphone-launcher tenant="demo"');
  await expect(page.getByRole('link', { name: T('snippet.docs') })).toHaveAttribute(
    'href',
    /docs\/dphone-embed/,
  );
  await axe(page);
});

test('ADMIN: disable/delete must be confirmed with the number of embedded sessions and send expectedRevision', async ({
  page,
}) => {
  const writes = await mockApi(page, { entitled: true, flagEnabled: true, origins: [sample()] });
  await page.goto('/?view=dphone-embedding&tenant=demo');
  await page
    .getByRole('button', { name: `${T('actions.disable')} https://crm.example.test` })
    .click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(T('confirm.sessions', { count: 2 }));
  await axe(page);
  await dialog.getByRole('button', { name: T('confirm.confirmDisable') }).click();
  await expect(page.getByRole('cell', { name: T('table.disabled'), exact: true })).toBeVisible();
  expect(writes[0]).toEqual({ method: 'PATCH', body: { expectedRevision: 1, enabled: false } });

  await page
    .getByRole('button', { name: `${T('actions.delete')} https://crm.example.test` })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: T('confirm.confirmDelete') })
    .click();
  await expect(page.getByText(T('table.empty'))).toBeVisible();
  expect(writes[1]).toEqual({ method: 'DELETE', body: { expectedRevision: 2 } });
});

test('E1.14: the screen-pop level defaults to off; changing needs a reason; custom cannot be selected yet', async ({
  page,
}) => {
  const writes = await mockApi(page, { entitled: true, flagEnabled: true, origins: [sample()] });
  await page.goto('/?view=dphone-embedding&tenant=demo');
  await expect(
    page.getByRole('cell', { name: T('screenPop.levels.off.label'), exact: true }),
  ).toBeVisible();

  await page
    .getByRole('button', { name: `${T('actions.screenPop')} https://crm.example.test` })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Contact Governance');
  const save = dialog.getByRole('button', { name: T('screenPop.confirm') });
  await dialog
    .getByRole('button', { name: `${T('screenPop.levels.off.label')} ${T('screenPop.level')}` })
    .click();
  await expect(
    page.getByRole('option', {
      name: new RegExp(escapeRegExp(T('screenPop.levels.custom.label'))),
    }),
  ).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('option', { name: T('screenPop.levels.contact.label') }).click();
  await expect(dialog).toContainText(T('screenPop.levels.contact.description'));
  await expect(save).toBeDisabled();
  await dialog
    .getByRole('textbox', { name: T('screenPop.reason') })
    .fill('CRM must show the customer name');
  await axe(page);
  await save.click();
  await expect(
    page.getByRole('cell', { name: T('screenPop.levels.contact.label'), exact: true }),
  ).toBeVisible();
  expect(writes[0]).toEqual({
    method: 'PATCH',
    body: {
      expectedRevision: 1,
      screenPopLevel: 'contact',
      reason: 'CRM must show the customer name',
    },
  });
});

test('SUPERVISOR is view-only; no entitlement = a locked page; flag off = a notice', async ({
  page,
}) => {
  await mockApi(page, { entitled: true, flagEnabled: false, origins: [sample()] });
  await page.goto('/?view=dphone-embedding&tenant=demo&viewer=SUPERVISOR');
  await expect(page.getByText(T('readOnly'))).toBeVisible();
  await expect(page.getByText(T('flagOff'))).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: new RegExp(
        `${escapeRegExp(T('actions.delete'))}|${escapeRegExp(T('actions.disable'))} https`,
      ),
    }),
  ).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Origin' })).toHaveCount(0);

  await page.unrouteAll();
  await mockApi(page, { entitled: false, flagEnabled: false, origins: [] });
  await page.goto('/?view=dphone-embedding&tenant=demo');
  await expect(page.getByRole('heading', { name: T('locked.title') })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await axe(page);
});
