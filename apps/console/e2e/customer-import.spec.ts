import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { th } from './support/catalog';
import { homeNavigation } from './support/home-navigation.js';

/**
 * CSV import (#909): UI check only — the API is mocked with routes; not HTTP→DB evidence
 * (the HTTP→PostgreSQL/RLS part is in apps/api/src/customer-360-import.integration.ts)
 */
test.use({ locale: 'th-TH', viewport: { width: 1280, height: 900 } });

const HEADERS = ['ชื่อ', 'บริษัท', 'เบอร์โทร', 'อีเมล']; // allow-thai: Thai header names are what the column guess recognizes
const CSV = `${HEADERS.join(',')}\nSomchai Jaidee,Company A,0812345678,a@example.test\nBad row,,123,\n`;
const PLAN = 'a'.repeat(64);
const counts = { valid: 1, invalid: 1, warning: 0 };
const rowsOut = [
  {
    rowNo: 1,
    cells: ['Somchai Jaidee', 'Company A', '0812345678', 'a@example.test'],
    valid: true,
    fieldErrors: [],
    warnings: [],
  },
  {
    rowNo: 2,
    cells: ['Bad row', '', '123', ''],
    valid: false,
    fieldErrors: [{ field: 'phone', code: 'PHONE_INVALID' }],
    warnings: [],
  },
];

async function open(page: Page) {
  await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: homeNavigation() }));
  await page.goto('/?view=customer-import&tenant=demo');
  await expect(
    page.getByRole('heading', { name: th('customerImport:title'), level: 1 }),
  ).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({
    name: 'customers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV, 'utf8'),
  });
}

test('upload → map → check → confirm → per-row result', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const posts: string[] = [];
  await page.route('**/api/v1/customer-360/imports/preview', (route) => {
    posts.push('preview');
    return route.fulfill({
      json: {
        rulesVersion: 'v1',
        planHash: PLAN,
        headers: HEADERS,
        counts,
        rows: rowsOut,
      },
    });
  });
  await page.route('**/api/v1/customer-360/imports/confirm', (route) => {
    posts.push(route.request().postData() ?? '');
    return route.fulfill({
      json: {
        state: 'COMPLETED',
        planHash: PLAN,
        counts: {
          applied: 1,
          rejected: 0,
          notSelected: 1,
          pending: 0,
          unknown: 0,
          notAttempted: 0,
        },
        rows: [
          { rowNo: 1, state: 'APPLIED', contactId: '11111111-1111-4111-8111-111111111111' },
          {
            rowNo: 2,
            state: 'NOT_SELECTED',
            code: 'ROW_INVALID',
            fieldErrors: [{ field: 'phone', code: 'PHONE_INVALID' }],
          },
        ],
      },
    });
  });
  await open(page);
  // the mapping was already guessed from the Thai column headers: can send immediately
  await expect(page.getByRole('button', { name: th('customerImport:preview') })).toBeEnabled();
  await page.getByRole('button', { name: th('customerImport:preview') }).click();
  await expect(
    page.getByText(th('customerImport:countValid', { count: 1 }), { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(th('customerImport:countInvalid', { count: 1 }))).toBeVisible();
  const grid = page.getByRole('grid', { name: th('customerImport:stepPreview') });
  await expect(grid).toContainText('Somchai Jaidee');
  await expect(grid).toContainText(
    `${th('customerImport:fields.phone')}: ${th('customerImport:fieldCodes.PHONE_INVALID')}`,
  );
  await page.getByRole('button', { name: th('customerImport:confirm', { count: 1 }) }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(th('customerImport:confirmBody', { count: 1 }));
  await dialog.getByRole('button', { name: th('customerImport:confirm', { count: 1 }) }).click();
  await expect(page.getByText(th('customerImport:resultDone'))).toBeVisible();
  await expect(page.getByRole('grid', { name: th('customerImport:stepResult') })).toContainText(
    th('customerImport:resultState.APPLIED'),
  );
  await expect(page.getByRole('button', { name: th('customerImport:resume') })).toHaveCount(0);
  expect(posts[1]).toMatch(/name="planHash"\r\n\r\na{64}/);
  expect(errors).toEqual([]);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? '')),
  ).toEqual([]);
});

test('incomplete result: continue with the original commandId, and a non-CSV file is rejected before sending', async ({
  page,
}) => {
  const confirms: string[] = [];
  await page.route('**/api/v1/customer-360/imports/preview', (route) =>
    route.fulfill({
      json: {
        rulesVersion: 'v1',
        planHash: PLAN,
        headers: HEADERS,
        counts,
        rows: rowsOut,
      },
    }),
  );
  await page.route('**/api/v1/customer-360/imports/confirm', (route) => {
    confirms.push(route.request().postData() ?? '');
    const first = confirms.length === 1;
    return route.fulfill({
      json: {
        state: first ? 'INCOMPLETE' : 'COMPLETED',
        planHash: PLAN,
        counts: first
          ? { applied: 0, rejected: 0, notSelected: 1, pending: 0, unknown: 1, notAttempted: 0 }
          : { applied: 1, rejected: 0, notSelected: 1, pending: 0, unknown: 0, notAttempted: 0 },
        rows: [
          first
            ? { rowNo: 1, state: 'UNKNOWN', code: 'RETRY_SAME_COMMAND' }
            : { rowNo: 1, state: 'APPLIED' },
          { rowNo: 2, state: 'NOT_SELECTED', code: 'ROW_INVALID' },
        ],
      },
    });
  });
  await open(page);
  await page.getByRole('button', { name: th('customerImport:preview') }).click();
  await page.getByRole('button', { name: th('customerImport:confirm', { count: 1 }) }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: th('customerImport:confirm', { count: 1 }) })
    .click();
  await expect(page.getByText(th('customerImport:resultIncomplete'))).toBeVisible();
  await page.getByRole('button', { name: th('customerImport:resume') }).click();
  await expect(page.getByText(th('customerImport:resultDone'))).toBeVisible();
  const id = (body: string) => /name="commandId"\r\n\r\n([0-9a-f-]{36})/.exec(body)?.[1];
  expect(id(confirms[0]!)).toBeTruthy();
  expect(id(confirms[1]!)).toBe(id(confirms[0]!));

  await page.getByRole('button', { name: th('customerImport:startOver') }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from([0xff, 0xfe, 0x41]),
  });
  await expect(page.getByRole('alert')).toContainText(th('customerImport:fileErrors.NOT_CSV'));
  await expect(page.getByRole('button', { name: th('customerImport:preview') })).toHaveCount(0);
});
