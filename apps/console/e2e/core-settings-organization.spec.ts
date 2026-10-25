import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
test.beforeAll(async ({ browser }) => {
  mkdirSync('../../artifacts/core-settings', { recursive: true });
  writeFileSync(
    '../../artifacts/core-settings/browser-config.json',
    JSON.stringify(
      {
        browser: browser.browserType().name(),
        version: browser.version(),
        node: process.version,
        tzdb: process.versions.tz,
        icu: process.versions.icu,
        vmUat: 'NOT_RUN',
      },
      null,
      2,
    ),
  );
});
test.beforeEach(async ({ request }) => {
  await request.post('/__core_test/restore');
});
test.afterEach(async ({ playwright }) => {
  const cleanup = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5188' });
  try {
    await cleanup.post('/__core_test/restore');
  } finally {
    await cleanup.dispose();
  }
});
interface Fixtures {
  tenant: string;
  otherTenant: string;
  password: string;
  users: Record<string, string>;
}
async function login(page: Page, request: APIRequestContext, alias = 'admin') {
  const config = (await (await request.get('/__core_test/config')).json()) as Fixtures;
  await page.goto(
    `/?tenant=${alias === 'foreign' ? config.otherTenant : config.tenant}&view=core-settings&page=organization`,
  );
  await page
    .getByRole('button', { name: /^(เข้าสู่ระบบอีกครั้ง|Sign in again)$/, exact: true })
    .click();
  await page.getByLabel('Username or email').fill(config.users[alias]);
  if ((await page.getByLabel('Password', { exact: true }).count()) === 0)
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /^(ตั้งค่าองค์กร|Organization settings)$/, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    (url) => !url.searchParams.has('code') && !url.searchParams.has('state'),
  );
  return config;
}
test('Rail: เปลี่ยน Home/องค์กรและ back/forward โดยคง document กับ OIDC session เดิม', async ({
  page,
  request,
}) => {
  const config = await login(page, request);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  let documents = 0,
    identityRequests = 0;
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) documents++;
    if (req.url().startsWith(config.issuer)) identityRequests++;
  });
  const rail = page.getByRole('navigation', { name: /^(เมนูหลัก|Main navigation)$/ });
  await rail.getByRole('link', { name: /^(หน้าแรก|Home)$/ }).click();
  await expect(
    page.getByRole('heading', {
      name: /^(วันนี้ต้องการทำอะไร\?|What would you like to do today\?)$/,
    }),
  ).toBeVisible();
  await rail.getByRole('link', { name: /^(ตั้งค่าองค์กร|Organization settings)$/ }).click();
  await expect(
    page.getByRole('heading', { name: /^(ตั้งค่าองค์กร|Organization settings)$/, exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/view=home/);
  await page.goForward();
  await expect(page).toHaveURL(/view=core-settings/);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  expect(documents).toBe(0);
  expect(identityRequests).toBe(0);
});
test('Rail: ร่างองค์กรคงอยู่เมื่อยกเลิก Rail/forward และยืนยันแล้วออกได้โดยไม่เสีย history', async ({
  page,
  request,
}) => {
  await login(page, request);
  const rail = page.getByRole('navigation', { name: /^(เมนูหลัก|Main navigation)$/ });
  const home = rail.getByRole('link', { name: /^(หน้าแรก|Home)$/ });
  const name = page.getByRole('textbox', {
    name: /^(ชื่อแสดงขององค์กร|Organization display name)$/,
  });
  const draft = 'ร่างสำหรับตรวจ Rail';
  await name.fill(draft);
  page.once('dialog', (dialog) => dialog.dismiss());
  await home.click();
  await expect(page).toHaveURL(/view=core-settings/);
  await expect(name).toHaveValue(draft);
  page.once('dialog', (dialog) => dialog.accept());
  await home.click();
  await expect(page).toHaveURL(/view=home/);
  await page.goBack();
  await expect(name).toBeVisible();
  await name.fill(draft);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.goForward();
  await expect(page).toHaveURL(/view=core-settings/);
  await expect(name).toHaveValue(draft);
  page.once('dialog', (dialog) => dialog.accept());
  await page.goForward();
  await expect(page).toHaveURL(/view=home/);
});
test('Rail: หน้าย่อย Governance คง tenant และ back/forward เดิมก่อนเปลี่ยนกลับ Home', async ({
  page,
  request,
}) => {
  const config = await login(page, request);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const rail = page.getByRole('navigation', { name: /^(เมนูหลัก|Main navigation)$/ });
  await rail.getByRole('link', { name: /Governance/ }).click();
  const nav = page.getByRole('navigation', { name: /^(Governance|Contact Governance)$/ });
  await nav.getByRole('link', { name: /^(นโยบาย|Policies)$/ }).click();
  await expect(page).toHaveURL(/section=policies/);
  await nav.getByRole('link', { name: /^(ภาพรวม|Overview)$/ }).click();
  await expect(page).toHaveURL(/section=overview/);
  await page.goBack();
  await expect(nav.getByRole('link', { name: /^(นโยบาย|Policies)$/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(new URL(page.url()).searchParams.get('tenant')).toBe(config.tenant);
  await rail.getByRole('link', { name: /^(หน้าแรก|Home)$/ }).click();
  await expect(page).toHaveURL(/view=home/);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
});
test('องค์กร: login จริง → แก้ชื่อ → readback และตั้ง defaults ครั้งแรกโดยหน้าเดิมไม่เปลี่ยนภาษา', async ({
  page,
  request,
}) => {
  await login(page, request);
  const name = page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true });
  await name.fill('องค์กรทดสอบ Browser');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  await expect(name).toHaveValue('องค์กรทดสอบ Browser');
  if (process.env.CORE_SETTINGS_VISUAL_EVIDENCE === '1')
    await page.screenshot({
      path: '../../artifacts/core-settings/organization-desktop.png',
      fullPage: true,
    });
  await page.getByRole('checkbox', { name: 'ตั้งค่าเริ่มต้นภาษาและเวลา' }).check();
  await page.getByRole('button', { name: 'ภาษาเริ่มต้น' }).click();
  await page.getByRole('option', { name: 'อังกฤษ', exact: true }).click();
  await page.getByRole('textbox', { name: 'เขตเวลาเริ่มต้น', exact: true }).fill('Asia/Bangkok');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  await expect(page.getByRole('heading', { name: 'ตั้งค่าองค์กร', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ภาษาเริ่มต้น' }).click();
  await page.getByRole('option', { name: 'ไทย', exact: true }).click();
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
});

test('องค์กร: validation ใกล้ field และ no-op หลัง normalize ไม่แจ้งเปลี่ยนข้อมูล', async ({
  page,
  request,
}) => {
  await login(page, request);
  const name = page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true });
  const current = await name.inputValue();
  await name.fill(' ');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByText('กรอกชื่อ 2–120 ตัวอักษร โดยไม่ใช้อักขระควบคุม')).toBeVisible();
  await name.fill(` ${current} `);
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ข้อมูลเหมือนเดิม ตรวจผลเรียบร้อยแล้ว');
});
test('องค์กร: Admin สองคนแก้ชนกันต้องให้ตรวจ latest และคงร่าง', async ({
  page,
  request,
  browser,
}) => {
  await login(page, request);
  const otherContext = await browser.newContext({ locale: 'th-TH' });
  const other = await otherContext.newPage();
  try {
    await login(other, request, 'admin-two');
    await page
      .getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })
      .fill('Admin หนึ่งบันทึก');
    await other
      .getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })
      .fill('ร่างของ Admin สอง');
    await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
    await other.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
    await expect(other.getByRole('status')).toContainText('ข้อมูลถูกแก้ไขแล้ว');
    await expect(
      other.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true }),
    ).toHaveValue('ร่างของ Admin สอง');
    other.once('dialog', (d) => d.accept());
    await other.getByRole('button', { name: 'โหลดค่าล่าสุดและเริ่มแก้ใหม่' }).click();
    await expect(
      other.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true }),
    ).toHaveValue('Admin หนึ่งบันทึก');
  } finally {
    await otherContext.close();
  }
});
test('องค์กร: response หายใช้ command-only recovery หลัง reload ไม่ส่ง business PATCH ซ้ำ', async ({
  page,
  request,
}) => {
  await login(page, request);
  await request.post('/__core_test/fault/lost-response');
  await page
    .getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })
    .fill('ยืนยันผลหลัง reload');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ยังยืนยันผลบันทึกไม่ได้');
  const refs = await page.evaluate(() =>
    Object.entries(sessionStorage).filter(([key]) => key.startsWith('dc:core-settings:command:')),
  );
  expect(refs).toHaveLength(1);
  expect(refs[0][1]).toMatch(/^[a-f0-9-]{36}$/);
  page.once('dialog', (d) => d.accept());
  await page.reload();
  // userStore เป็น memory: boot กู้ SSO แล้วตรวจ command เดิมก่อนแก้ โดยไม่ถาม login ซ้ำ
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  await expect(page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })).toHaveValue(
    'ยืนยันผลหลัง reload',
  );
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('dc:core-settings:command:')),
    ),
  ).toHaveLength(0);
});
test('องค์กร: readback ขาดหายคง UNKNOWN แล้วตรวจ receipt เดิมสำเร็จ', async ({ page, request }) => {
  await login(page, request);
  await request.post('/__core_test/fault/readback');
  await page
    .getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })
    .fill('อ่านกลับภายหลัง');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ยังยืนยันผลบันทึกไม่ได้');
  await page.getByRole('button', { name: 'ตรวจผลบันทึกอีกครั้ง' }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
});
test('องค์กร: narrow เก็บร่าง เตือนก่อนออก และ revoke ไม่ใช้ cached capability', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page
    .getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })
    .fill('ร่างยังอยู่ในหน้า');
  await page.setViewportSize({ width: 760, height: 800 });
  if (process.env.CORE_SETTINGS_VISUAL_EVIDENCE === '1')
    await page.screenshot({
      path: '../../artifacts/core-settings/organization-narrow.png',
      fullPage: true,
    });
  await expect(page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText('ร่างยังอยู่ในหน้านี้ เมื่อขยายจอจะตรวจข้อมูลและสิทธิ์ล่าสุดก่อนแก้ต่อ'),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })).toHaveValue(
    'ร่างยังอยู่ในหน้า',
  );
  await page.getByRole('button', { name: /^เมนูผู้ใช้ / }).click();
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('menuitem', { name: 'บัญชีของฉัน', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ตั้งค่าองค์กร', exact: true })).toBeVisible();
  await request.post('/__core_test/revoke');
  try {
    await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(
      'ไม่สามารถเข้าถึงการตั้งค่าองค์กรด้วยสิทธิ์ปัจจุบัน',
    );
    await expect(page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })).toHaveCount(
      0,
    );
  } finally {
    await request.post('/__core_test/restore');
  }
});
test('องค์กร: Supervisor อ่านอย่างเดียวและไม่มีปุ่ม Team placeholder', async ({
  page,
  request,
}) => {
  await login(page, request, 'supervisor');
  await expect(page.getByText('คุณมีสิทธิ์ดูข้อมูลเท่านั้น')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('link', { name: 'ทีม', exact: true })).toHaveCount(0);
});

test('องค์กร: same identity reauth อยู่หน้าเดิมคงร่าง แล้วตรวจคำสั่งก่อนแก้ใหม่', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })).toBeVisible();
  await request.post('/__core_test/fault/reauth');
  const name = page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true });
  await name.fill('ร่างก่อน session หมด');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('session หมดอายุ');
  await expect(name).toHaveValue('ร่างก่อน session หมด');
  await page.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('คำสั่งนี้ไม่ได้เปลี่ยนข้อมูล');
  await expect(name).toHaveValue('ร่างก่อน session หมด');
});
test('องค์กร: keyboard warning ยกเลิก sign-out คงร่าง แล้ว sign-out ล้างร่างและ command reference', async ({
  page,
  request,
}) => {
  await login(page, request);
  await request.post('/__core_test/fault/readback');
  await page
    .getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })
    .fill('ข้อมูลบัญชีก่อนหน้า');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ยังยืนยันผลบันทึกไม่ได้');
  await page.getByRole('button', { name: /^เมนูผู้ใช้ / }).click();
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('menuitem', { name: 'ออกจากระบบ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ตั้งค่าองค์กร', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^เมนูผู้ใช้ / }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('menuitem', { name: 'ออกจากระบบ', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('dc:core-settings:command:')),
    ),
  ).toHaveLength(0);
  await login(page, request, 'foreign');
  await expect(
    page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true }),
  ).not.toHaveValue('ข้อมูลบัญชีก่อนหน้า');
});

test('องค์กร: English UI ผ่าน real OIDC/API ใน tenant แยก', async ({ browser, request }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  try {
    await login(page, request, 'foreign');
    await page
      .getByRole('textbox', { name: 'Organization display name', exact: true })
      .fill('English organization');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved and verified');
  } finally {
    await context.close();
  }
});

test('Console session: เปลี่ยนเมนูและ reload ต้องกู้ SSO โดยไม่ถาม login ซ้ำ', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.getByRole('button', { name: /^เมนูผู้ใช้ / }).click();
  await page.getByRole('menuitem', { name: 'บัญชีของฉัน', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'บัญชีของฉัน', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'หน้าแรก', exact: true }).first().click();
  await expect(
    page.getByRole('heading', { name: 'วันนี้ต้องการทำอะไร?', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'บัญชีของฉัน', exact: true })).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole('heading', { name: 'วันนี้ต้องการทำอะไร?', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'วันนี้ต้องการทำอะไร?', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^เมนูผู้ใช้ / })).toBeVisible();
  expect(
    await page.evaluate(() =>
      [localStorage, sessionStorage].some((storage) =>
        Object.values(storage).some((value) =>
          /"(?:access_token|refresh_token|id_token)"\s*:/.test(String(value)),
        ),
      ),
    ),
  ).toBe(false);
});

test('Console session: SSO ใช้ไม่ได้จบที่ login UI และไม่วน auth request', async ({
  page,
  request,
  context,
}) => {
  await login(page, request);
  await context.clearCookies();
  let attempts = 0;
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (
      url.pathname.endsWith('/protocol/openid-connect/auth') &&
      url.searchParams.get('prompt') === 'none'
    )
      attempts++;
  });
  await page.reload();
  await expect(
    page.getByRole('button', { name: /^(เข้าสู่ระบบอีกครั้ง|Sign in again)$/, exact: true }),
  ).toBeVisible({ timeout: 15000 });
  expect(attempts).toBe(1);
  expect(new URL(page.url()).pathname).toBe('/');
});

test('Console session: explicit sign-out และ reload ต้องไม่กู้ SSO กลับเข้าเอง', async ({
  page,
  request,
}) => {
  const config = await login(page, request);
  let attempts = 0;
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (
      url.pathname.endsWith('/protocol/openid-connect/auth') &&
      url.searchParams.get('prompt') === 'none'
    )
      attempts++;
  });
  await page.getByRole('button', { name: /^เมนูผู้ใช้ / }).click();
  await page.getByRole('menuitem', { name: 'ออกจากระบบ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ออกจากระบบแล้ว', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'ออกจากระบบแล้ว', exact: true })).toBeVisible();
  await page.goto(`/?tenant=${config.tenant}&view=core-settings&page=organization`);
  await expect(
    page.getByRole('button', { name: /^(เข้าสู่ระบบอีกครั้ง|Sign in again)$/, exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(0);
});

test('Console session: discovery ค้างต้องจบที่ login UI ตาม network timeout', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.route('**/.well-known/openid-configuration', () => {});
  await page.reload();
  await expect(
    page.getByRole('button', { name: /^(เข้าสู่ระบบอีกครั้ง|Sign in again)$/, exact: true }),
  ).toBeVisible({ timeout: 12000 });
});

test('Console session: token request ค้างต้องจบที่ login UI ตาม network timeout', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.route('**/protocol/openid-connect/token', () => {});
  await page.reload();
  await expect(
    page.getByRole('button', { name: /^(เข้าสู่ระบบอีกครั้ง|Sign in again)$/, exact: true }),
  ).toBeVisible({ timeout: 12000 });
});
