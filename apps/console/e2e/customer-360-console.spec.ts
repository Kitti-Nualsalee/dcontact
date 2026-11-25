import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Cus360 C2 (#792): Console A (list → full-page profile) on a real Chromium
 * every request goes through the sandbox's real API/RLS/DB (identity is a stub — not an actual OIDC boundary)
 */

interface Config {
  tenant: string;
  ids: Record<string, string>;
}

let config: Config;
const control = (request: APIRequestContext, path: string) => request.get(`/__c360_test/${path}`);

test.beforeEach(async ({ request }) => {
  config = (await (await request.get('/__c360_test/config')).json()) as Config;
  await control(request, 'reset');
});

const list = (page: Page) => page.goto(`/?view=customers&tenant=${config.tenant}`);
const profile = (page: Page, name: string) =>
  page.goto(`/?view=customers&tenant=${config.tenant}&contact=${config.ids[name]}`);
const main = (page: Page) => page.getByRole('main');
const table = (page: Page) => page.getByRole('grid', { name: 'รายการลูกค้า' });

async function search(page: Page, type: string, query: string) {
  await page.getByRole('button', { name: /ค้นหาด้วย/ }).click();
  await page.getByRole('option', { name: type }).click();
  await page.getByRole('textbox').fill(query);
  await page.getByRole('button', { name: 'ค้นหา', exact: true }).click();
}

test('list: loading is separate from empty, read-only with no write control, count by the same predicate as the list', async ({
  page,
  request,
}) => {
  await control(request, 'delay/900');
  await list(page);
  await expect(page.getByRole('status')).toContainText('กำลังอ่านข้อมูล');
  await expect(page.getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้')).toHaveCount(0);
  await expect(table(page)).toBeVisible();
  await expect(page.getByText(/ลูกค้าที่เข้าถึงได้ 37 รายการ/)).toBeVisible();
  await expect(page.getByText('การสร้างลูกค้าต้องได้รับสิทธิ์จากผู้ดูแล')).toBeVisible();
  // no control that looks writable (even disabled)
  await expect(
    main(page).getByRole('button', {
      name: /^(สร้าง|แก้ไข|บันทึก|ลบ|เพิ่ม|Create|Edit|Save|Delete|Add)/,
    }),
  ).toHaveCount(0);
  await expect(page.getByText('ซ่อนจากทุกคน')).toHaveCount(0);
  await expect(page.getByText('Foreign Tenant')).toHaveCount(0);
  await expect(page.getByText('Predecessor Paul')).toHaveCount(0);
  // the first 20 rows, then load more, with no duplicates
  expect(await table(page).getByRole('row').count()).toBe(21);
  await page.getByRole('button', { name: 'โหลดเพิ่ม' }).click();
  await expect(table(page).getByRole('row')).toHaveCount(38);
});

test('search: NAME prefix, special characters, PHONE/EMAIL full value, and validation near the field without echoing the value', async ({
  page,
}) => {
  await list(page);
  await expect(table(page)).toBeVisible();
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'สมชา');
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await expect(table(page)).toContainText('สมชาย ใจดี');
  // no wildcard/substring
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', '%%');
  await expect(page.getByText('ไม่พบลูกค้าที่ตรงกับคำค้นหา')).toBeVisible();
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'ชาย');
  await expect(page.getByText('ไม่พบลูกค้าที่ตรงกับคำค้นหา')).toBeVisible();
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'ส');
  await expect(page.getByText('พิมพ์ชื่ออย่างน้อย 2 ตัวอักษร')).toBeVisible();

  // PHONE: must be in international format; the same number on two accessible contacts → two entries, not merged
  await search(page, 'เบอร์โทรศัพท์ (เต็มค่า)', '0812345678');
  await expect(page.getByText(/ใส่เบอร์ในรูปแบบสากล/)).toBeVisible();
  await expect(page.getByText('0812345678', { exact: true })).toHaveCount(0);
  await search(page, 'เบอร์โทรศัพท์ (เต็มค่า)', '+66 (2) 123-4567');
  await expect(table(page).getByRole('row')).toHaveCount(3);
  await expect(table(page)).toContainText('+66•');
  await expect(table(page)).not.toContainText('123-4567');
  // EMAIL
  await search(page, 'อีเมล (เต็มค่า)', 'somchai@EXAMPLE.com');
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await search(page, 'อีเมล (เต็มค่า)', 'not-an-email');
  await expect(page.getByText(/อีเมลไม่ถูกต้อง/)).toBeVisible();
  // clear the search back to the whole list, and the URL does not keep the query
  await page.getByRole('button', { name: 'ล้างการค้นหา' }).click();
  await expect(table(page).getByRole('row')).toHaveCount(21);
  expect(page.url()).not.toContain('example');
  expect(page.url()).not.toContain('somchai');
});

test('keyboard: Enter searches, Tab enters the table + arrows to the open button, Enter opens the profile, focus is visible', async ({
  page,
}) => {
  await list(page);
  await expect(table(page)).toBeVisible();
  await page.getByRole('textbox').focus();
  await page.keyboard.type('Somsri');
  await page.keyboard.press('Enter');
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: 'ล้างการค้นหา' }).focus();
  await page.keyboard.press('Tab');
  // the table is a grid: arrows move between cells up to the open button
  const label = /เปิดโปรไฟล์ Somsri Rakdee/;
  for (let i = 0; i < 8; i += 1) {
    const focused = await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') ?? '',
    );
    if (label.test(focused)) break;
    await page.keyboard.press(i === 0 ? 'ArrowDown' : 'ArrowRight');
  }
  const open = page.getByRole('button', { name: label });
  await expect(open).toBeFocused();
  // the token's focus ring (box-shadow) must be visible when using the keyboard
  await expect(open).toHaveAttribute('data-focus-visible', 'true');
  const ring = await open.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Somsri Rakdee' })).toBeVisible();
  expect(page.url()).toContain(`contact=${config.ids.somsri}`);
});

test('profile: core + timeline + governance as separate sections; open/return as an SPA and back/forward', async ({
  page,
}) => {
  await list(page);
  let loads = 0;
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) loads += 1;
  });
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'สมชาย');
  await page.getByRole('button', { name: /เปิดโปรไฟล์ สมชาย ใจดี/ }).click();
  await expect(page.getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
  await expect(main(page).getByText('VIP', { exact: true })).toBeVisible();
  await expect(page.getByText('+6621234567')).toBeVisible();
  await expect(page.getByText('somchai@example.com')).toBeVisible();
  await expect(page.getByText('รอตรวจสอบ ไม่ใช้ค้นหา')).toBeVisible();
  await expect(page.getByText('ลูกค้าสำคัญ')).toBeVisible();
  // timeline: only calls belonging to the user + a notice that it is incomplete; no notes/other channels
  const timeline = page.getByRole('region', { name: 'ประวัติการติดต่อ' });
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
  await expect(timeline.getByText(/พิสูจน์สิทธิ์ย้อนหลังให้คุณไม่ได้/)).toBeVisible();
  await expect(page.getByText('SECRET-NOTE')).toHaveCount(0);
  await expect(timeline.getByText(/webchat|line|email/i)).toHaveCount(0);
  // governance: no context specified yet → context-required and not an allow
  const governance = page.getByRole('region', { name: 'สถานะ Contact Governance' });
  await expect(governance.getByText('สรุปนี้ไม่ใช่การอนุญาตให้ติดต่อ')).toBeVisible();
  await expect(governance.getByText('เลือกช่องทางและวัตถุประสงค์ก่อน')).toBeVisible();
  await governance.getByRole('textbox').fill('SERVICE');
  await governance.getByRole('button', { name: 'ดูสถานะ' }).click();
  await expect(governance.getByText('ไม่มีความต้องการของลูกค้าที่ตรงบริบทนี้')).toBeVisible();
  await expect(governance.getByText(/ข้อจำกัดที่มีผลอยู่ 0 รายการ/)).toBeVisible();
  await expect(governance.getByText('สรุปนี้ไม่ใช่การอนุญาตให้ติดต่อ')).toBeVisible();

  await page.getByRole('button', { name: 'กลับไปรายการลูกค้า' }).click();
  await expect(page.getByRole('heading', { name: 'ค้นหาลูกค้า' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'ค้นหาลูกค้า' })).toBeVisible();
  expect(loads).toBe(0);
});

test('partial failure: Voice owner fails = only the timeline section fails and can recover; not empty', async ({
  page,
  request,
}) => {
  await profile(page, 'somchai');
  await expect(
    page.getByRole('region', { name: 'ประวัติการติดต่อ' }).getByRole('listitem'),
  ).toHaveCount(2);
  await control(request, 'owner/down');
  await profile(page, 'somchai');
  const timeline = page.getByRole('region', { name: 'ประวัติการติดต่อ' });
  await expect(timeline.getByRole('alert')).toContainText('อ่านประวัติการติดต่อไม่ได้ในขณะนี้');
  await expect(timeline.getByText('ยังไม่มีประวัติสายเสียง')).toHaveCount(0);
  // the core profile and other sections are still usable
  await expect(page.getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
  await expect(page.getByText('+6621234567')).toBeVisible();
  await expect(page.getByRole('region', { name: 'สถานะ Contact Governance' })).toBeVisible();
  await control(request, 'owner/up');
  await timeline.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
});

test('partial failure: Governance owner fails = unavailable, not interpreted as allowed, and can recover', async ({
  page,
  request,
}) => {
  await profile(page, 'somchai');
  const governance = page.getByRole('region', { name: 'สถานะ Contact Governance' });
  await control(request, 'cg/down');
  await governance.getByRole('textbox').fill('SERVICE');
  await governance.getByRole('button', { name: 'ดูสถานะ' }).click();
  await expect(governance.getByRole('alert')).toContainText(
    'ยังอ่านสถานะ Contact Governance ไม่ได้ ไม่ตีความว่าอนุญาตให้ติดต่อ',
  );
  await expect(governance.getByText('ไม่มีความต้องการของลูกค้า')).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'ประวัติการติดต่อ' }).getByRole('listitem'),
  ).toHaveCount(2);
  await control(request, 'cg/up');
  await governance.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(governance.getByText('ไม่มีความต้องการของลูกค้าที่ตรงบริบทนี้')).toBeVisible();
});

test('error + recovery: core fails temporarily → alert with try again; once recovered the profile shows', async ({
  page,
  request,
}) => {
  await control(request, 'fail/500/contacts/');
  await profile(page, 'somsri');
  await expect(page.getByRole('alert')).toContainText('อ่านข้อมูลไม่สำเร็จ ยังไม่ทราบผล');
  await expect(page.getByText('Somsri Rakdee')).toHaveCount(0);
  await control(request, 'fail/0/x');
  await page.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(page.getByRole('heading', { name: 'Somsri Rakdee' })).toBeVisible();
});

test('no permission/not found: the same message, does not reveal existence, and shows no data of a hidden contact', async ({
  page,
}) => {
  await profile(page, 'hidden');
  const hidden = await page.getByRole('alert').innerText();
  await page.goto(
    `/?view=customers&tenant=${config.tenant}&contact=00000000-0000-4000-8000-000000000001`,
  );
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.getByRole('alert').innerText()).toBe(hidden);
  expect(hidden).toContain('ไม่พบลูกค้ารายนี้หรือคุณไม่มีสิทธิ์เปิด');
  await expect(page.getByText('ซ่อนจากทุกคน')).toHaveCount(0);
  await page.goto(`/?view=customers&tenant=${config.tenant}&contact=not-a-uuid`);
  await expect(page.getByRole('alert')).toContainText('ไม่พบลูกค้ารายนี้หรือคุณไม่มีสิทธิ์เปิด');
});

test('the list closes its data when the session expires while switching tabs', async ({
  page,
  request,
}) => {
  await list(page);
  await expect(table(page)).toBeVisible();
  await search(page, 'อีเมล (เต็มค่า)', 'somchai@example.com');
  await expect(table(page)).toContainText('สมชาย ใจดี');
  await control(request, 'session/expire');
  let searches = 0;
  page.on('request', (req) => {
    if (req.url().includes('/customer-360/contacts/search')) searches += 1;
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('alert')).toContainText('เซสชันหมดอายุ');
  await expect(table(page)).toHaveCount(0);
  await expect(page.getByText('สมชาย ใจดี')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveValue('');
  await page.waitForTimeout(200);
  expect(searches).toBe(1);
});

test('session expired: returning to the tab closes all PII on the page immediately, leaving no extra data', async ({
  page,
  request,
}) => {
  await profile(page, 'somchai');
  await expect(page.getByText('+6621234567')).toBeVisible();
  await control(request, 'session/expire');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('alert')).toContainText('เซสชันหมดอายุ ข้อมูลลูกค้าถูกปิดแล้ว');
  for (const text of ['สมชาย ใจดี', '+6621234567', 'somchai@example.com', 'ลูกค้าสำคัญ'])
    await expect(page.getByText(text)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'ประวัติการติดต่อ' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'สถานะ Contact Governance' })).toHaveCount(0);
  // the list closes as well
  await list(page);
  await expect(page.getByRole('alert')).toContainText('เซสชันหมดอายุ');
  await expect(table(page)).toHaveCount(0);
});

test('permission change (custodian revoked): recheck on return and close the whole profile', async ({
  page,
  request,
}) => {
  await profile(page, 'revokable');
  await expect(page.getByRole('heading', { name: 'Revoke Rita' })).toBeVisible();
  await control(request, 'revoke/revokable');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('alert')).toContainText('ไม่พบลูกค้ารายนี้หรือคุณไม่มีสิทธิ์เปิด');
  await expect(page.getByText('Revoke Rita')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'ประวัติการติดต่อ' })).toHaveCount(0);
});

test('permission revoked while open: a timeline retry closes the core PII of the whole page (not just the section)', async ({
  page,
  request,
}) => {
  await profile(page, 'revokableRetry');
  const timeline = page.getByRole('region', { name: 'ประวัติการติดต่อ' });
  await expect(timeline).toBeVisible();
  await control(request, 'owner/down');
  await profile(page, 'revokableRetry');
  await expect(timeline.getByRole('alert')).toBeVisible();
  await control(request, 'revoke/revokableRetry');
  await control(request, 'owner/up');
  await timeline.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(page.getByRole('alert')).toContainText('ไม่พบลูกค้ารายนี้หรือคุณไม่มีสิทธิ์เปิด');
  await expect(page.getByText('Revoke Retry Rex')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'สถานะ Contact Governance' })).toHaveCount(0);
});

test('permission revoked while open: viewing Governance status and loading more history close the PII of the whole page', async ({
  page,
  request,
}) => {
  await profile(page, 'revokableGovernance');
  const governance = page.getByRole('region', { name: 'สถานะ Contact Governance' });
  await expect(governance).toBeVisible();
  await expect(governance.getByRole('textbox')).toBeVisible();
  await control(request, 'revoke/revokableGovernance');
  await governance.getByRole('textbox').fill('SERVICE');
  await governance.getByRole('button', { name: 'ดูสถานะ' }).click();
  await expect(page.getByRole('alert')).toContainText('ไม่พบลูกค้ารายนี้หรือคุณไม่มีสิทธิ์เปิด');
  await expect(page.getByText('Revoke Gov Gus')).toHaveCount(0);

  await profile(page, 'revokableMore');
  const timeline = page.getByRole('region', { name: 'ประวัติการติดต่อ' });
  await expect(timeline.getByRole('listitem')).toHaveCount(20);
  await control(request, 'revoke/revokableMore');
  await timeline.getByRole('button', { name: 'โหลดประวัติเพิ่ม' }).click();
  await expect(page.getByRole('alert')).toContainText('ไม่พบลูกค้ารายนี้หรือคุณไม่มีสิทธิ์เปิด');
  await expect(page.getByText('Revoke More Mia')).toHaveCount(0);
  await expect(timeline).toHaveCount(0);
});

for (const [status, message] of [
  [401, 'เซสชันหมดอายุ ข้อมูลลูกค้าถูกปิดแล้ว'],
  [403, 'โปรไฟล์นี้ถูกปิดเพราะสิทธิ์ของคุณเปลี่ยนไป'],
  [503, 'สิทธิ์การเข้าถึงยังไม่พร้อม'],
] as const) {
  for (const section of ['timeline', 'governance-summary'] as const) {
    test(`section ${section} gets ${status}: close the PII of the whole page and focus on the text`, async ({
      page,
      request,
    }) => {
      await profile(page, 'somchai');
      await expect(page.getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
      // after core has loaded this section answers an error (except the first time of other sections)
      await control(request, `fail/${status}/${section}`);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const alert = page.getByRole('alert');
      await expect(alert).toContainText(message);
      await expect(alert).toBeFocused();
      for (const text of ['สมชาย ใจดี', '+6621234567', 'somchai@example.com', 'ลูกค้าสำคัญ'])
        await expect(page.getByText(text)).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'ประวัติการติดต่อ' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'สถานะ Contact Governance' })).toHaveCount(0);
    });
  }
}

test('a hanging core response that answers 200 after permission is revoked must not reopen PII', async ({
  page,
  request,
}) => {
  await profile(page, 'revokableGovernance2');
  await expect(page.getByRole('heading', { name: 'Revoke Gov Two' })).toBeVisible();
  const governance = page.getByRole('region', { name: 'สถานะ Contact Governance' });
  await governance.getByRole('textbox').fill('SERVICE');
  // hold the core 200 response until it is confirmed that permission was revoked and the data closed
  await control(request, 'slow/hold/profile');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(async () => (await (await control(request, 'slow-state')).json()).status)
    .toBe(200);
  const abortedCore = page.waitForEvent('requestfailed', {
    predicate: (req) =>
      req.method() === 'GET' &&
      new URL(req.url()).pathname.endsWith(`/contacts/${config.ids.revokableGovernance2}`),
  });
  await control(request, 'revoke/revokableGovernance2');
  await governance.getByRole('button', { name: 'ดูสถานะ' }).click();
  await expect(page.getByRole('alert')).toContainText('ไม่พบลูกค้ารายนี้หรือคุณไม่มีสิทธิ์เปิด');
  const aborted = await abortedCore;
  expect(aborted.failure()?.errorText).toContain('ERR_ABORTED');
  // release the response after the browser confirms the request has been cancelled
  await control(request, 'slow-release');
  await expect
    .poll(async () => (await (await control(request, 'slow-state')).json()).sent)
    .toBe(true);
  await expect(page.getByRole('alert')).toContainText('ไม่พบลูกค้ารายนี้หรือคุณไม่มีสิทธิ์เปิด');
  await expect(page.getByText('Revoke Gov Two')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'ประวัติการติดต่อ' })).toHaveCount(0);
});

test('table: names of 80+ characters and long companies wrap inside the cell without overlapping the neighbor column; Enter on a row opens the profile; after load more focus the first added row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await list(page);
  await expect(table(page)).toBeVisible();
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'นางสาวสมหญิง');
  const row = table(page).getByRole('row').nth(1);
  await expect(row).toBeVisible();
  const geometry = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.cu-table tbody tr:first-child td')];
    const heads = [...document.querySelectorAll('.cu-table th')];
    return {
      heads: heads.map((h) => Math.round(h.getBoundingClientRect().width)),
      cells: cells.map((c) => ({
        client: c.clientWidth,
        scroll: c.scrollWidth,
        right: Math.round(c.getBoundingClientRect().right),
        innerRight: Math.max(
          ...[...c.querySelectorAll('*')].map((el) => Math.round(el.getBoundingClientRect().right)),
        ),
      })),
    };
  });
  // the name column must be wider than the channel column, and no content overflows the cell edge
  expect(geometry.heads[0]).toBeGreaterThan(geometry.heads[3]!);
  for (const cell of geometry.cells) {
    expect(cell.scroll).toBeLessThanOrEqual(cell.client + 1);
    expect(cell.innerRight).toBeLessThanOrEqual(cell.right + 1);
  }
  // keyboard: Tab enters the table, down arrow to the row, then Enter opens the profile without moving into the cell
  await page.getByRole('button', { name: 'ล้างการค้นหา' }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /นางสาวสมหญิง/ })).toBeVisible();
  await page.getByRole('button', { name: 'กลับไปรายการลูกค้า' }).click();
  await expect(table(page)).toBeVisible();
  await page.getByRole('button', { name: 'โหลดเพิ่ม' }).click();
  // the total row count depends on customers whose permission was revoked by earlier tests — check that every page is covered instead of a fixed number
  await expect(page.getByRole('button', { name: 'โหลดเพิ่ม' })).toHaveCount(0);
  expect(await table(page).getByRole('row').count()).toBeGreaterThan(21);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-cu-open'));
  expect(focused).toBeTruthy();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON');
});

test('focus: governance shows status/changes context → section heading; INCOMPLETE try again → list heading', async ({
  page,
  request,
}) => {
  await profile(page, 'somchai');
  const governance = page.getByRole('region', { name: 'สถานะ Contact Governance' });
  await governance.getByRole('textbox').fill('SERVICE');
  await governance.getByRole('button', { name: 'ดูสถานะ' }).click();
  await expect(governance.getByRole('heading', { name: 'สถานะ Contact Governance' })).toBeFocused();
  await governance.getByRole('button', { name: 'เปลี่ยนบริบท' }).click();
  await expect(governance.getByRole('heading', { name: 'สถานะ Contact Governance' })).toBeFocused();

  await control(request, 'actor/supervisor');
  await control(request, 'scope/lag');
  await list(page);
  await expect(page.getByText(/บางรายการยังตรวจสิทธิ์ไม่เสร็จ/)).toBeVisible();
  await control(request, 'scope/fresh');
  await page.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(page.getByRole('heading', { name: 'รายการลูกค้าที่เข้าถึงได้' })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'ไม่พบ' })).toHaveCount(0);
});

test('an empty search result is announced with role=status and the heading becomes the search result as soon as the search is sent', async ({
  page,
  request,
}) => {
  await list(page);
  await expect(table(page)).toBeVisible();
  await control(request, 'delay/1200');
  await page.getByRole('textbox').fill('zzzz');
  await page.getByRole('button', { name: 'ค้นหา', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ผลการค้นหา' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('ไม่พบลูกค้าที่ตรงกับคำค้นหา');
});

test('focus: open profile → customer name, back → search heading, retry section → section heading', async ({
  page,
  request,
}) => {
  await list(page);
  await expect(table(page)).toBeVisible();
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'Somsri');
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: /เปิดโปรไฟล์ Somsri Rakdee/ }).click();
  await expect(page.getByRole('heading', { name: 'Somsri Rakdee' })).toBeFocused();
  await page.getByRole('button', { name: 'กลับไปรายการลูกค้า' }).click();
  await expect(page.getByRole('heading', { name: 'ค้นหาลูกค้า' })).toBeFocused();
  await control(request, 'owner/down');
  await profile(page, 'somchai');
  const timeline = page.getByRole('region', { name: 'ประวัติการติดต่อ' });
  await expect(timeline.getByRole('alert')).toBeVisible();
  await control(request, 'owner/up');
  await timeline.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(timeline.getByRole('heading', { name: 'ประวัติการติดต่อ' })).toBeFocused();
});

test('list: INCOMPLETE has a try-again button, validation does not drop the old results, switching search type clears the query, the heading becomes the search result', async ({
  page,
  request,
}) => {
  await control(request, 'actor/supervisor');
  await control(request, 'scope/lag');
  await list(page);
  await expect(page.getByText(/บางรายการยังตรวจสิทธิ์ไม่เสร็จ/)).toBeVisible();
  await control(request, 'scope/fresh');
  await page.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await expect(page.getByText(/บางรายการยังตรวจสิทธิ์ไม่เสร็จ/)).toHaveCount(0);

  await control(request, 'actor/admin');
  await list(page);
  await expect(table(page)).toBeVisible();
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'Somsri');
  await expect(page.getByRole('heading', { name: 'ผลการค้นหา' })).toBeVisible();
  await expect(table(page).getByRole('row')).toHaveCount(2);
  // validation fails: Somsri's original result stays and is not interpreted as the result of the new query
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'x');
  await expect(page.getByText('พิมพ์ชื่ออย่างน้อย 2 ตัวอักษร')).toBeVisible();
  await expect(table(page)).toContainText('Somsri Rakdee');
  // switch search type → clear the original query
  await page.getByRole('button', { name: /ค้นหาด้วย/ }).click();
  await page.getByRole('option', { name: 'อีเมล (เต็มค่า)' }).click();
  await expect(page.getByRole('textbox')).toHaveValue('');
});

test('Supervisor: reads only the list in IAM VIEW; projection lag = INCOMPLETE/permission not ready, not empty/zero', async ({
  page,
  request,
}) => {
  await control(request, 'actor/supervisor');
  await list(page);
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await expect(page.getByText(/ลูกค้าที่เข้าถึงได้ 1 รายการ/)).toBeVisible();
  await expect(page.getByText('สมชาย ใจดี')).toHaveCount(0);
  await page.getByRole('button', { name: /เปิดโปรไฟล์/ }).click();
  await expect(page.getByRole('heading', { name: 'ลูกค้า C1' })).toBeVisible();

  await control(request, 'scope/lag');
  await list(page);
  await expect(page.getByText(/บางรายการยังตรวจสิทธิ์ไม่เสร็จ/)).toBeVisible();
  await expect(page.getByText(/ยังนับจำนวนไม่ได้/)).toBeVisible();
  await expect(page.getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้')).toHaveCount(0);
  await expect(page.getByText(/ลูกค้าที่เข้าถึงได้ 0 รายการ/)).toHaveCount(0);
  await profile(page, 'scoped');
  await expect(page.getByRole('alert')).toContainText('สิทธิ์การเข้าถึงยังไม่พร้อม');
  await expect(page.getByText('ลูกค้า C1')).toHaveCount(0);
  await control(request, 'scope/fresh');
  await page.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(page.getByRole('heading', { name: 'ลูกค้า C1' })).toBeVisible();
});

test('Agent/Compliance: no generic directory — shows no permission and no customer data', async ({
  page,
  request,
}) => {
  await control(request, 'actor/agent');
  await list(page);
  await expect(page.getByRole('alert')).toContainText('คุณไม่มีสิทธิ์เปิดรายการลูกค้า');
  await expect(table(page)).toHaveCount(0);
  await profile(page, 'somchai');
  await expect(page.getByRole('alert')).toContainText('โปรไฟล์นี้ถูกปิดเพราะสิทธิ์ของคุณเปลี่ยนไป');
  await expect(page.getByText('สมชาย ใจดี')).toHaveCount(0);
});

test('MERGED/AMBIGUOUS/legacy: read-only, no automatic redirect, and the canonical opens only when pressed by the user', async ({
  page,
}) => {
  await profile(page, 'predecessor');
  await expect(page.getByRole('heading', { name: 'Predecessor Paul' })).toBeVisible();
  await expect(page.getByText(/ถูกรวมเข้ากับโปรไฟล์อื่นแล้ว/)).toBeVisible();
  expect(page.url()).toContain(`contact=${config.ids.predecessor}`);
  // the predecessor's governance is unusable (not canonical)
  await page.getByRole('textbox').fill('SERVICE');
  await page.getByRole('button', { name: 'ดูสถานะ' }).click();
  await expect(page.getByText(/ข้อมูลระบุตัวตนยังไม่ใช่โปรไฟล์หลัก/)).toBeVisible();
  await page.getByRole('button', { name: 'เปิดโปรไฟล์หลักที่คุณมีสิทธิ์' }).click();
  await expect(page.getByRole('heading', { name: 'Canonical Carol' })).toBeVisible();
  expect(page.url()).toContain(`contact=${config.ids.canonical}`);

  await profile(page, 'ambiguous');
  await expect(page.getByText(/ต้องตรวจสอบ/).first()).toBeVisible();
  await expect(page.getByText(/ระบบไม่เลือก ผูก หรือรวมข้อมูลให้เอง/)).toBeVisible();
  await profile(page, 'legacy');
  await expect(page.getByText(/ข้อมูลเดิมที่ยังไม่มีสถานะ identity/)).toBeVisible();
});

test('i18n: switching TH/EN on the same page without reload, and the text is complete in both languages', async ({
  page,
}) => {
  await profile(page, 'somchai');
  await expect(page.getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
  let loads = 0;
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) loads += 1;
  });
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Interaction timeline' })).toBeVisible();
  await expect(page.getByText('This summary is not permission to contact')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to customers' })).toBeVisible();
  await page.getByRole('button', { name: 'ไทย', exact: true }).click();
  await expect(page.getByRole('region', { name: 'ประวัติการติดต่อ' })).toBeVisible();
  expect(loads).toBe(0);
});

// note: the shared shell (rail + SubNav in @d-contact/ui-react) has no breakpoint below ~760px
// at 390px the content area is only about 74px, so it does not count as narrow-screen evidence for this page — checked from tablet 768 upward
for (const [name, size] of [
  ['tablet 768', { width: 768, height: 1024 }],
  ['tablet 950', { width: 950, height: 900 }],
  ['laptop 1280', { width: 1280, height: 800 }],
] as const) {
  test(`responsive ${name}: content does not overflow the page or the content area, and long names/companies wrap`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const overflow = () =>
      page.evaluate(() => {
        const content = document.querySelector('main.cu-root')!;
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          content: content.scrollWidth - content.clientWidth,
        };
      });
    await list(page);
    await expect(table(page)).toBeVisible();
    expect(await overflow()).toEqual({ page: 0, content: 0 });
    const headersFit = () =>
      page
        .locator('.cu-table th')
        .evaluateAll((cells) => cells.every((cell) => cell.scrollWidth <= cell.clientWidth));
    const badgesFit = () =>
      page.locator('.cu-table td .cu-badges > span').evaluateAll((badges) =>
        badges.every((badge) => {
          const cell = badge.closest('td');
          return (
            cell !== null &&
            badge.scrollWidth <= badge.clientWidth &&
            badge.getBoundingClientRect().right <= cell.getBoundingClientRect().right
          );
        }),
      );
    await expect(
      page.locator('.cu-badges').filter({ hasText: 'ข้อมูลเดิม (อ่านอย่างเดียว)' }).first(),
    ).toBeVisible();
    expect(await headersFit()).toBe(true);
    expect(await badgesFit()).toBe(true);
    await expect(page.getByRole('button', { name: /เมนูผู้ใช้/ })).toBeInViewport({ ratio: 1 });
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(page.getByRole('columnheader', { name: 'Matched channel' })).toBeVisible();
    await expect(
      page.locator('.cu-badges').filter({ hasText: 'Legacy record (read-only)' }).first(),
    ).toBeVisible();
    expect(await headersFit()).toBe(true);
    expect(await badgesFit()).toBe(true);
    await expect(page.getByRole('button', { name: /User menu/ })).toBeInViewport({ ratio: 1 });
    await page.getByRole('button', { name: 'ไทย', exact: true }).click();
    await profile(page, 'longName');
    await expect(page.getByRole('heading', { name: /นางสาวสมหญิง/ })).toBeVisible();
    expect(await overflow()).toEqual({ page: 0, content: 0 });
    await profile(page, 'somchai');
    await expect(page.getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
    expect(await overflow()).toEqual({ page: 0, content: 0 });
  });
}

test('accessibility: the list and profile have no serious/critical axe violations in the main content', async ({
  page,
}) => {
  await list(page);
  await expect(table(page)).toBeVisible();
  await page.getByRole('button', { name: 'ค้นหา', exact: true }).evaluate(async (button) => {
    await Promise.all(button.getAnimations().map((animation) => animation.finished));
  });
  const serious = (results: Awaited<ReturnType<AxeBuilder['analyze']>>) =>
    results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious(await new AxeBuilder({ page }).include('main').analyze())).toEqual([]);
  await profile(page, 'somchai');
  await expect(
    page.getByRole('region', { name: 'ประวัติการติดต่อ' }).getByRole('listitem'),
  ).toHaveCount(2);
  expect(serious(await new AxeBuilder({ page }).include('main').analyze())).toEqual([]);
});

test('C4: create a customer and read the data back before showing the profile', async ({
  page,
  request,
}) => {
  await control(request, 'grant-create');
  await list(page);
  await page.getByRole('button', { name: 'สร้างลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ลูกค้าทดลอง C4');
  await page.getByLabel('บริษัท').fill('บริษัท ทดสอบ');
  await page.getByLabel('เบอร์โทรศัพท์').fill('+1 213 373 4253');
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await expect(page.getByRole('heading', { name: 'ลูกค้าทดลอง C4' })).toBeVisible();
  await expect(page.getByText('บันทึกและอ่านข้อมูลลูกค้ากลับแล้ว')).toBeVisible();
  await expect(page.getByText('บริษัท ทดสอบ')).toBeVisible();
  await expect(page.getByText('+12133734253')).toBeVisible();
  expect(page.url()).not.toContain('ลูกค้าทดลอง');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('ลูกค้าทดลอง C4');
  expect(stored).not.toContain('213 373');
});

test('C4: edit data that changed concurrently, keeping the draft and showing the latest data', async ({
  page,
  request,
}) => {
  await profile(page, 'somchai');
  await page.getByRole('button', { name: 'แก้ไขลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ร่างที่ต้องเก็บ');
  const current = await (
    await request.get(`/api/v1/customer-360/contacts/${config.ids.somchai}`)
  ).json();
  const changed = await request.patch(`/api/v1/customer-360/contacts/${config.ids.somchai}`, {
    data: {
      commandId: crypto.randomUUID(),
      expectedProfileRevision: current.revisions.profile,
      expectedLineageRevision: String(current.revisions.lineage),
      displayName: 'ชื่อจากผู้ใช้อื่น',
    },
  });
  expect(changed.status()).toBe(200);
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await expect(page.getByRole('alert')).toContainText('ข้อมูลเปลี่ยนระหว่างแก้ไข');
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveValue('ร่างที่ต้องเก็บ');
  await page.getByRole('button', { name: 'ตรวจข้อมูลล่าสุด' }).click();
  await expect(page.getByText(/ข้อมูลล่าสุด:/)).toContainText('ชื่อจากผู้ใช้อื่น');
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveValue('ร่างที่ต้องเก็บ');
});

test('C4: add, replace and retire a channel, and remove a tag, with readback', async ({ page }) => {
  await profile(page, 'somchai');
  await page.getByRole('button', { name: 'แก้ไขลูกค้า' }).click();
  await page.getByLabel('ข้อมูลช่องทางติดต่อ').fill('+1 415 555 2671');
  await page.getByRole('button', { name: 'เพิ่มช่องทาง' }).click();
  await expect(page.getByText('+14155552671')).toBeVisible();
  await page.getByRole('button', { name: 'แก้ไขลูกค้า' }).click();
  await page
    .locator('li')
    .filter({ hasText: '+14155552671' })
    .getByRole('button', { name: 'เปลี่ยน' })
    .click();
  await page.getByLabel('ข้อมูลช่องทางใหม่').fill('+44 20 7946 0018');
  await page.getByRole('button', { name: 'บันทึกช่องทางใหม่' }).click();
  await expect(page.getByText('+442079460018')).toBeVisible();
  await expect(page.getByText('+14155552671')).toHaveCount(0);
  await page.getByRole('button', { name: 'แก้ไขลูกค้า' }).click();
  await page
    .locator('li')
    .filter({ hasText: '+442079460018' })
    .getByRole('button', { name: 'เลิกใช้' })
    .click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'เลิกใช้' }).click();
  await expect(page.getByText('+442079460018')).toHaveCount(0);
  await page.getByRole('button', { name: 'แก้ไขลูกค้า' }).click();
  await page.getByLabel('ลูกค้าสำคัญ').uncheck();
  await page.getByRole('button', { name: 'บันทึกแท็ก' }).click();
  await expect(page.getByText('ลูกค้าสำคัญ')).toHaveCount(0);
});

test('C4: a response lost after commit recovers the receipt after reload without duplicating or keeping PII', async ({
  page,
}) => {
  await list(page);
  await page.getByRole('button', { name: 'สร้างลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ทดสอบกู้คำสั่ง');
  let delivered!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  await page.route('**/api/v1/customer-360/contacts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
    delivered();
  });
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await disconnected;
  await expect(page.getByRole('button', { name: 'ตรวจสถานะการบันทึก' })).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('ทดสอบกู้คำสั่ง');
  await page.unrouteAll();
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'ตรวจสถานะการบันทึก' }).click();
  await expect(page.getByRole('heading', { name: 'ทดสอบกู้คำสั่ง' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ตรวจสถานะการบันทึก' })).toHaveCount(0);
});

test('C4: session expiry hides data, keeps the draft in memory, and checks the original command after reauthorize', async ({
  page,
  request,
}) => {
  await list(page);
  await page.getByRole('button', { name: 'สร้างลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ร่างหลังเข้าสู่ระบบใหม่');
  await control(request, 'session/expire');
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await expect(page.getByRole('alert')).toContainText('ไม่สามารถแสดงข้อมูลลูกค้าได้');
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveCount(0);
  await control(request, 'session/restore');
  await page.getByRole('alert').getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveValue('ร่างหลังเข้าสู่ระบบใหม่');
  await page.getByRole('button', { name: 'ตรวจสถานะการบันทึก' }).click();
  await expect(page.getByText('ยืนยันแล้วว่าคำสั่งเดิมไม่มีผล สามารถเริ่มใหม่ได้')).toBeVisible();
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await expect(page.getByRole('heading', { name: 'ร่างหลังเข้าสู่ระบบใหม่' })).toBeVisible();
});

test('C4: the TH/EN form does not overflow at 768/1280/1440 and passes axe at serious/critical level', async ({
  page,
  request,
}) => {
  await control(request, 'grant-create');
  await list(page);
  await page.getByRole('button', { name: 'สร้างลูกค้า' }).click();
  for (const width of [768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ['ไทย', 'English']) {
      await page.getByRole('button', { name: language, exact: true }).click();
      await expect(page.locator('form.cu-form')).toBeVisible();
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('main.cu-root')!;
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          content: main.scrollWidth - main.clientWidth,
        };
      });
      expect(overflow).toEqual({ page: 0, content: 0 });
      const results = await new AxeBuilder({ page })
        .include('main')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(
        results.violations.filter((violation) =>
          ['serious', 'critical'].includes(violation.impact ?? ''),
        ),
      ).toEqual([]);
    }
  }
});

test('C4: a capability service outage says permission cannot be checked, and can retry', async ({
  page,
  request,
}) => {
  await control(request, 'grant-create');
  await control(request, 'fail/503/capabilities');
  await list(page);
  await expect(
    page.getByText('ตรวจสิทธิ์การสร้างหรือแก้ไขลูกค้าไม่ได้ในขณะนี้ กรุณาลองอีกครั้ง'),
  ).toBeVisible();
  await expect(page.getByText('การสร้างลูกค้าต้องได้รับสิทธิ์จากผู้ดูแล')).toHaveCount(0);
  await control(request, 'fail/0/capabilities');
  await page.getByRole('status').getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(page.getByRole('button', { name: 'สร้างลูกค้า' })).toBeVisible();
});

test('C4: a tag selector outage shows unavailable and does not allow saving an incomplete list', async ({
  page,
  request,
}) => {
  await control(request, 'fail/500/tags');
  await profile(page, 'somchai');
  await page.getByRole('button', { name: 'แก้ไขลูกค้า' }).click();
  await expect(page.getByText('โหลดรายการแท็กไม่ได้ในขณะนี้ กรุณาลองอีกครั้ง')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกแท็ก' })).toBeDisabled();
  await control(request, 'fail/0/tags');
  await page.getByRole('status').getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(page.getByRole('button', { name: 'บันทึกแท็ก' })).toBeEnabled();
});

test('C4: saving unchanged data returns NO_OP and reads the current data back', async ({
  page,
}) => {
  await profile(page, 'somchai');
  await page.getByRole('button', { name: 'แก้ไขลูกค้า' }).click();
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'PATCH' &&
      candidate.url().endsWith(`/contacts/${config.ids.somchai}`),
  );
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  expect((await (await response).json()).command.outcome).toBe('NO_OP');
  await expect(page.getByText('ข้อมูลไม่เปลี่ยนแปลง อ่านข้อมูลล่าสุดกลับแล้ว')).toBeVisible();
  await expect(page.getByRole('button', { name: 'แก้ไขลูกค้า' })).toBeVisible();
});

test('C4: an old permission-check response arriving late after session expiry does not reopen the draft', async ({
  page,
  request,
}) => {
  await control(request, 'grant-create');
  await list(page);
  await page.getByRole('button', { name: 'สร้างลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ร่างห้ามเปิดจากผลเก่า');
  await control(request, 'slow/hold/capabilities');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect
    .poll(async () => (await (await control(request, 'slow-state')).json()).status)
    .toBe(200);
  await control(request, 'session/expire');
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveCount(0);
  await control(request, 'slow-release');
  await expect
    .poll(async () => (await (await control(request, 'slow-state')).json()).sent)
    .toBe(true);
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveCount(0);
});

test('C4: after checking the receipt, revoked permission must hide the draft until the permission check passes again', async ({
  page,
  request,
}) => {
  await profile(page, 'somchai');
  await page.getByRole('button', { name: 'แก้ไขลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ร่างตรวจสิทธิ์ receipt');
  let delivered!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  await page.route(`**/api/v1/customer-360/contacts/${config.ids.somchai}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await route.fetch();
    await route.abort('failed');
    delivered();
  });
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await disconnected;
  await page.unrouteAll();
  await control(request, 'fail/403/commands');
  await page.getByRole('button', { name: 'ตรวจสถานะการบันทึก' }).click();
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('ไม่สามารถแสดงข้อมูลลูกค้าได้');
  await control(request, 'fail/0/commands');
  await page.getByRole('alert').getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveValue('ร่างตรวจสิทธิ์ receipt');
  await page.getByRole('button', { name: 'ตรวจสถานะการบันทึก' }).click();
  await expect(page.getByRole('heading', { name: 'ร่างตรวจสิทธิ์ receipt' })).toBeVisible();
});

test('C4: recover a conflicted receipt, keep the draft and force a check of the latest data before saving', async ({
  page,
  request,
}) => {
  await profile(page, 'somchai');
  await page.getByRole('button', { name: 'แก้ไขลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ร่าง conflict ที่กู้ได้');
  const current = await (
    await request.get(`/api/v1/customer-360/contacts/${config.ids.somchai}`)
  ).json();
  const changed = await request.patch(`/api/v1/customer-360/contacts/${config.ids.somchai}`, {
    data: {
      commandId: crypto.randomUUID(),
      expectedProfileRevision: current.revisions.profile,
      expectedLineageRevision: String(current.revisions.lineage),
      displayName: 'ข้อมูลล่าสุดจากอีกเครื่อง',
    },
  });
  expect(changed.status()).toBe(200);
  let delivered!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  await page.route(`**/api/v1/customer-360/contacts/${config.ids.somchai}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await route.fetch();
    await route.abort('failed');
    delivered();
  });
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await disconnected;
  await page.unrouteAll();
  await page.getByRole('button', { name: 'ตรวจสถานะการบันทึก' }).click();
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveValue('ร่าง conflict ที่กู้ได้');
  await expect(page.getByRole('button', { name: 'บันทึกลูกค้า' })).toBeDisabled();
  await page.getByRole('button', { name: 'ตรวจข้อมูลล่าสุด' }).click();
  await expect(page.getByText(/ข้อมูลล่าสุด:/)).toContainText('ข้อมูลล่าสุดจากอีกเครื่อง');
  await expect(page.getByRole('button', { name: 'บันทึกลูกค้า' })).toBeEnabled();
});

test('C4: does not show success before the readback answers', async ({ page, request }) => {
  await control(request, 'grant-create');
  await list(page);
  await page.getByRole('button', { name: 'สร้างลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('รออ่านกลับ');
  let arrived!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/v1\/customer-360\/contacts\/[0-9a-f-]{36}$/, async (route) => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await waiting;
  await expect(page.getByText('บันทึกและอ่านข้อมูลลูกค้ากลับแล้ว')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ตรวจสถานะการบันทึก' })).toBeVisible();
  release();
  await expect(page.getByText('บันทึกและอ่านข้อมูลลูกค้ากลับแล้ว')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'รออ่านกลับ' })).toBeVisible();
});

test('C4: show the committed revision and the current data when there was a further edit before the readback', async ({
  page,
  request,
}) => {
  await profile(page, 'somchai');
  await page.getByRole('button', { name: 'แก้ไขลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ชื่อที่คำสั่งแรกบันทึก');
  let committedRevision = '';
  let currentRevision = '';
  await page.route(`**/api/v1/customer-360/contacts/${config.ids.somchai}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch();
    const saved = await response.json();
    expect(saved.command.outcome).toBe('APPLIED');
    committedRevision = saved.command.committedRevisions.profile;
    const current = await (
      await request.get(`/api/v1/customer-360/contacts/${config.ids.somchai}`)
    ).json();
    const next = await request.patch(`/api/v1/customer-360/contacts/${config.ids.somchai}`, {
      data: {
        commandId: crypto.randomUUID(),
        expectedProfileRevision: current.revisions.profile,
        expectedLineageRevision: String(current.revisions.lineage),
        displayName: 'ชื่อที่ถูกแก้ไขต่อ',
      },
    });
    expect(next.status()).toBe(200);
    currentRevision = (await next.json()).command.committedRevisions.profile;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await expect(page.getByRole('heading', { name: 'ชื่อที่ถูกแก้ไขต่อ' })).toBeVisible();
  const notice = page
    .getByRole('status')
    .filter({ hasText: 'ข้อมูลปัจจุบันมีการเปลี่ยนแปลงต่อแล้ว' });
  await expect(notice).toBeVisible();
  expect(BigInt(currentRevision)).toBe(BigInt(committedRevision) + 1n);
  await expect(notice).toContainText(
    `โปรไฟล์: revision ที่บันทึก ${committedRevision}; revision ปัจจุบัน ${currentRevision}`,
  );
});
