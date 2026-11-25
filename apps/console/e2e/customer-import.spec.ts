import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { homeNavigation } from './support/home-navigation.js';

/**
 * CSV import (#909): UI check only — the API is mocked with routes; not HTTP→DB evidence
 * (the HTTP→PostgreSQL/RLS part is in apps/api/src/customer-360-import.integration.ts)
 */
test.use({ locale: 'th-TH', viewport: { width: 1280, height: 900 } });

const CSV =
  'ชื่อ,บริษัท,เบอร์โทร,อีเมล\nสมชาย ใจดี,บริษัท เอ,0812345678,a@example.test\nแถวเสีย,,123,\n';
const PLAN = 'a'.repeat(64);
const counts = { valid: 1, invalid: 1, warning: 0 };
const rowsOut = [
  {
    rowNo: 1,
    cells: ['สมชาย ใจดี', 'บริษัท เอ', '0812345678', 'a@example.test'],
    valid: true,
    fieldErrors: [],
    warnings: [],
  },
  {
    rowNo: 2,
    cells: ['แถวเสีย', '', '123', ''],
    valid: false,
    fieldErrors: [{ field: 'phone', code: 'PHONE_INVALID' }],
    warnings: [],
  },
];

async function open(page: Page) {
  await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: homeNavigation() }));
  await page.goto('/?view=customer-import&tenant=demo');
  await expect(page.getByRole('heading', { name: 'นำเข้าลูกค้าจาก CSV', level: 1 })).toBeVisible();
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
        headers: ['ชื่อ', 'บริษัท', 'เบอร์โทร', 'อีเมล'],
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
  await expect(page.getByRole('button', { name: 'ตรวจไฟล์' })).toBeEnabled();
  await page.getByRole('button', { name: 'ตรวจไฟล์' }).click();
  await expect(page.getByText('ผ่าน 1 แถว', { exact: true })).toBeVisible();
  await expect(page.getByText('ไม่ผ่าน 1 แถว')).toBeVisible();
  const grid = page.getByRole('grid', { name: 'ผลการตรวจ' });
  await expect(grid).toContainText('สมชาย ใจดี');
  await expect(grid).toContainText('เบอร์โทร: เบอร์โทรไม่ถูกต้อง');
  await page.getByRole('button', { name: 'นำเข้า 1 แถวที่ผ่าน' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('ระบบจะสร้างลูกค้าใหม่ 1 ราย');
  await dialog.getByRole('button', { name: 'นำเข้า 1 แถวที่ผ่าน' }).click();
  await expect(page.getByText('นำเข้าเสร็จสิ้น')).toBeVisible();
  await expect(page.getByRole('grid', { name: 'ผลการนำเข้า' })).toContainText('สร้างแล้ว');
  await expect(page.getByRole('button', { name: 'ส่งต่อ' })).toHaveCount(0);
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
        headers: ['ชื่อ', 'บริษัท', 'เบอร์โทร', 'อีเมล'],
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
  await page.getByRole('button', { name: 'ตรวจไฟล์' }).click();
  await page.getByRole('button', { name: 'นำเข้า 1 แถวที่ผ่าน' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'นำเข้า 1 แถวที่ผ่าน' }).click();
  await expect(page.getByText('ยังนำเข้าไม่ครบ')).toBeVisible();
  await page.getByRole('button', { name: 'ส่งต่อ' }).click();
  await expect(page.getByText('นำเข้าเสร็จสิ้น')).toBeVisible();
  const id = (body: string) => /name="commandId"\r\n\r\n([0-9a-f-]{36})/.exec(body)?.[1];
  expect(id(confirms[0]!)).toBeTruthy();
  expect(id(confirms[1]!)).toBe(id(confirms[0]!));

  await page.getByRole('button', { name: 'นำเข้าไฟล์ใหม่' }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from([0xff, 0xfe, 0x41]),
  });
  await expect(page.getByRole('alert')).toContainText('อ่านเป็น CSV แบบ UTF-8 ไม่ได้');
  await expect(page.getByRole('button', { name: 'ตรวจไฟล์' })).toHaveCount(0);
});
