import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
let tenant = '';
async function login(
  page: Page,
  request: APIRequestContext,
  view = 'customer-overview',
  alias = 'admin',
) {
  const cfg = await (await request.get('/__core_test/config')).json();
  tenant = alias === 'foreign' ? cfg.otherTenant : cfg.tenant;
  await page.goto(`/?tenant=${tenant}&view=${view}`);
  await page.getByRole('button', { name: /^(เข้าสู่ระบบอีกครั้ง|Sign in again)$/ }).click();
  await page.getByLabel('Username or email').fill(cfg.users[alias]);
  if (!(await page.getByLabel('Password', { exact: true }).count()))
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(cfg.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).not.toHaveURL(/code=/);
}
test.beforeEach(async ({ request }) => {
  await request.post('/__core_test/restore');
});
test.afterEach(async ({ request }) => {
  await request.post('/__core_test/restore');
});
test('OIDC: empty จริง, partial failure retry แยก section และ asOf', async ({
  page,
  request,
}, info) => {
  let fail = true;
  await page.route('**/api/v1/customer-360/overview/tags', async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        json: { error: { code: 'CATALOG_UNAVAILABLE', retryable: true } },
      });
    else await route.continue();
  });
  await login(page, request);
  const customers = page.getByRole('region', { name: 'ลูกค้าที่เข้าถึงได้' });
  const tags = page.getByRole('region', { name: 'ชุดแท็ก' });
  await expect(customers.getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้')).toBeVisible();
  await expect(customers.locator('time')).toBeVisible();
  await expect(tags.getByRole('alert')).toContainText('ไม่สามารถอ่านข้อมูลส่วนนี้ได้');
  fail = false;
  await tags.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(tags.getByText('ยังไม่มีแท็กในชุดข้อมูลนี้')).toBeVisible();
  await expect(customers.getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้')).toBeVisible();
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.C360_OVERVIEW_EVIDENCE_DIR) {
    mkdirSync(process.env.C360_OVERVIEW_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: join(
        process.env.C360_OVERVIEW_EVIDENCE_DIR,
        `overview-${info.project.name}-${process.env.C360_DEV_TRIAL_ROUND ?? '1'}.png`,
      ),
      fullPage: true,
    });
  }
});
test('OIDC: rules version/constraints จาก writer registry ไม่มี editor และภาษาอังกฤษไม่ล้น', async ({
  page,
  request,
}) => {
  await login(page, request, 'customer-rules');
  await expect(page.getByText('c360-profile-v1', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(
    page.getByText(
      'trim,preserve-local-tokens,lowercase-domain,IDNA-validation-only,no-punycode,no-NFC,no-NFKC',
    ),
  ).toBeVisible();
  await expect(page.locator('main').getByText('บริษัท', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Data rules', exact: true, level: 1 }),
  ).toBeVisible();
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('OIDC: revoke ปิดทุก section, response เก่าไม่คืนข้อมูล และ retry คืนสิทธิ์', async ({
  page,
  request,
}) => {
  await login(page, request);
  await expect(page.getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้')).toBeVisible();
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/v1/customer-360/overview/customers', async (route) => {
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  await page
    .getByRole('region', { name: 'ลูกค้าที่เข้าถึงได้' })
    .getByRole('button', { name: 'อ่านข้อมูลใหม่' })
    .click();
  await reached;
  await request.post('/__core_test/revoke');
  await page
    .getByRole('region', { name: 'ชุดแท็ก' })
    .getByRole('button', { name: 'อ่านข้อมูลใหม่' })
    .click();
  await expect(page.getByRole('alert')).toContainText('คุณไม่มีสิทธิ์');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้')).toHaveCount(0);
});
test('OIDC: Supervisor ไม่ได้สิทธิ์ Overview จาก directory permission', async ({
  page,
  request,
}) => {
  await login(page, request, 'customer-overview', 'supervisor');
  await expect(page.getByRole('alert')).toContainText(
    'คุณไม่มีสิทธิ์อ่านข้อมูลนี้ โปรดติดต่อผู้ดูแล tenant',
  );
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Contact your tenant administrator.');
  await expect(page.locator('main time')).toHaveCount(0);
});

for (const kind of ['role', 'proof'] as const) {
  test(`context: OIDC ${kind} เปลี่ยนระหว่าง session ปิดทุก section จาก current server authorization`, async ({
    page,
    request,
  }) => {
    await login(page, request);
    await expect(
      page.getByRole('region', { name: 'ลูกค้าที่เข้าถึงได้' }).locator('time'),
    ).toBeVisible();
    await request.post(`/__core_test/overview/${kind}`);
    await page
      .getByRole('region', { name: 'ลูกค้าที่เข้าถึงได้' })
      .getByRole('button', { name: 'อ่านข้อมูลใหม่' })
      .click();
    await expect(page.getByRole('alert')).toContainText('โปรดติดต่อผู้ดูแล tenant');
    await expect(page.locator('main time')).toHaveCount(0);
    await expect(page.getByText('ยังไม่มีแท็กในชุดข้อมูลนี้')).toHaveCount(0);
  });
}

test('context: OIDC scope projection stale เป็น unavailable ไม่ใช่ zero และกู้จาก owner จริง', async ({
  page,
  request,
}) => {
  await login(page, request);
  const customers = page.getByRole('region', { name: 'ลูกค้าที่เข้าถึงได้' });
  await expect(customers.getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้')).toBeVisible();
  await request.post('/__core_test/overview/scope-lag');
  await customers.getByRole('button', { name: 'อ่านข้อมูลใหม่' }).click();
  await expect(customers.getByRole('alert')).toContainText('ไม่สามารถอ่านข้อมูลส่วนนี้ได้');
  await expect(customers.getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'ชุดแท็ก' }).locator('time')).toBeVisible();
  await request.post('/__core_test/restore');
  await customers.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(customers.getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้')).toBeVisible();
});

for (const alias of ['admin-two', 'foreign'] as const) {
  test(`context: OIDC เปลี่ยนเป็น ${alias} ระหว่าง response ค้าง ไม่คืน count ของ actor/tenant เดิม`, async ({
    page,
    request,
  }) => {
    await request.post('/__core_test/overview/grant-customer');
    await login(page, request);
    const customers = page.getByRole('region', { name: 'ลูกค้าที่เข้าถึงได้' });
    await expect(customers.locator('strong')).toHaveText('1');
    let release!: () => void;
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured = false;
    await page.route('**/api/v1/customer-360/overview/customers', async (route) => {
      if (captured) return route.continue();
      captured = true;
      const response = await route.fetch();
      expect((await response.json()).count).toBe('1');
      arrived();
      await held;
      // การเปลี่ยน document อาจ abort request เก่าก่อน fulfil ซึ่งเป็นผลที่ถูกต้อง
      await route.fulfill({ response }).catch(() => undefined);
    });
    await customers.getByRole('button', { name: 'อ่านข้อมูลใหม่' }).click();
    await reached;
    await page.context().clearCookies();
    await login(page, request, 'customer-overview', alias);
    await expect(
      page
        .getByRole('region', { name: 'ลูกค้าที่เข้าถึงได้' })
        .getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้'),
    ).toBeVisible();
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(
      page.getByRole('region', { name: 'ลูกค้าที่เข้าถึงได้' }).locator('strong'),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole('region', { name: 'ลูกค้าที่เข้าถึงได้' })
        .getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้'),
    ).toBeVisible();
  });
}
