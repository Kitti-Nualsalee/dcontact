import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Cus360 C2 (#792): Console A (รายการ → โปรไฟล์เต็มหน้า) บน Chromium จริง
 * ทุก request ผ่าน API/RLS/DB จริงของ sandbox (identity เป็น stub — ไม่ใช่ actual OIDC boundary)
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

test('รายการ: loading แยกจาก empty, อ่านอย่างเดียว ไม่มี write control, count ตาม predicate เดียวกับ list', async ({
  page,
  request,
}) => {
  await control(request, 'delay/900');
  await list(page);
  await expect(page.getByRole('status')).toContainText('กำลังอ่านข้อมูล');
  await expect(page.getByText('ยังไม่มีลูกค้าที่คุณเข้าถึงได้')).toHaveCount(0);
  await expect(table(page)).toBeVisible();
  await expect(page.getByText(/ลูกค้าที่เข้าถึงได้ 37 รายการ/)).toBeVisible();
  await expect(page.getByText('หน้านี้อ่านอย่างเดียว')).toBeVisible();
  // ไม่มี control ที่ดูเหมือนเขียนได้ (แม้เป็น disabled)
  await expect(
    main(page).getByRole('button', {
      name: /^(สร้าง|แก้ไข|บันทึก|ลบ|เพิ่ม|Create|Edit|Save|Delete|Add)/,
    }),
  ).toHaveCount(0);
  await expect(page.getByText('ซ่อนจากทุกคน')).toHaveCount(0);
  await expect(page.getByText('Foreign Tenant')).toHaveCount(0);
  await expect(page.getByText('Predecessor Paul')).toHaveCount(0);
  // 20 แถวแรกแล้วโหลดเพิ่ม ไม่ซ้ำ
  expect(await table(page).getByRole('row').count()).toBe(21);
  await page.getByRole('button', { name: 'โหลดเพิ่ม' }).click();
  await expect(table(page).getByRole('row')).toHaveCount(38);
});

test('ค้นหา: NAME prefix, ตัวอักษรพิเศษ, PHONE/EMAIL เต็มค่า และ validation ใกล้ช่องโดยไม่สะท้อนค่า', async ({
  page,
}) => {
  await list(page);
  await expect(table(page)).toBeVisible();
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'สมชา');
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await expect(table(page)).toContainText('สมชาย ใจดี');
  // ไม่มี wildcard/substring
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', '%%');
  await expect(page.getByText('ไม่พบลูกค้าที่ตรงกับคำค้นหา')).toBeVisible();
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'ชาย');
  await expect(page.getByText('ไม่พบลูกค้าที่ตรงกับคำค้นหา')).toBeVisible();
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'ส');
  await expect(page.getByText('พิมพ์ชื่ออย่างน้อย 2 ตัวอักษร')).toBeVisible();

  // PHONE: ต้องเป็นรูปแบบสากล; เบอร์เดียวกันบนสอง contact ที่เข้าถึงได้ → สองรายการ ไม่รวมกัน
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
  // ล้างการค้นหากลับไปรายการทั้งหมด และ URL ไม่เก็บคำค้น
  await page.getByRole('button', { name: 'ล้างการค้นหา' }).click();
  await expect(table(page).getByRole('row')).toHaveCount(21);
  expect(page.url()).not.toContain('example');
  expect(page.url()).not.toContain('somchai');
});

test('คีย์บอร์ด: Enter ค้นหา, Tab เข้าตาราง + ลูกศรไปปุ่มเปิด, Enter เปิดโปรไฟล์, focus มองเห็น', async ({
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
  // ตารางเป็น grid: ลูกศรเลื่อนระหว่างเซลล์จนถึงปุ่มเปิด
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
  // focus ring ของ token (box-shadow) ต้องมองเห็นเมื่อใช้คีย์บอร์ด
  await expect(open).toHaveAttribute('data-focus-visible', 'true');
  const ring = await open.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Somsri Rakdee' })).toBeVisible();
  expect(page.url()).toContain(`contact=${config.ids.somsri}`);
});

test('โปรไฟล์: core + timeline + governance แยก section; เปิด/กลับแบบ SPA และ back/forward', async ({
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
  // timeline: เฉพาะสายที่เป็นของผู้ใช้ + แจ้งว่าไม่ครบ; ไม่มีโน้ต/ช่องทางอื่น
  const timeline = page.getByRole('region', { name: 'ประวัติการติดต่อ' });
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
  await expect(timeline.getByText(/พิสูจน์สิทธิ์ย้อนหลังให้คุณไม่ได้/)).toBeVisible();
  await expect(page.getByText('SECRET-NOTE')).toHaveCount(0);
  await expect(timeline.getByText(/webchat|line|email/i)).toHaveCount(0);
  // governance: ยังไม่ระบุบริบท → context-required และไม่ใช่การอนุญาต
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

test('partial failure: Voice owner ล้ม = timeline ล้มเฉพาะ section และกู้ได้; ไม่ใช่ empty', async ({
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
  // core profile และ section อื่นยังใช้ได้
  await expect(page.getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
  await expect(page.getByText('+6621234567')).toBeVisible();
  await expect(page.getByRole('region', { name: 'สถานะ Contact Governance' })).toBeVisible();
  await control(request, 'owner/up');
  await timeline.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
});

test('partial failure: Governance owner ล้ม = unavailable ไม่ตีความว่าอนุญาต และกู้ได้', async ({
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

test('error + recovery: core ล้มชั่วคราว → alert พร้อมลองอีกครั้ง; กู้แล้วเห็นโปรไฟล์', async ({
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

test('ไม่มีสิทธิ์/ไม่พบ: ข้อความเดียวกัน ไม่เปิดเผยการมีอยู่ และไม่แสดงข้อมูลของ contact ที่ซ่อน', async ({
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

test('รายการปิดข้อมูลเมื่อ session หมดระหว่างสลับแท็บ', async ({ page, request }) => {
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

test('session หมด: กลับมาที่แท็บแล้วปิด PII ทั้งหน้าทันที ไม่ค้างข้อมูลเสริม', async ({
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
  // รายการก็ปิดเช่นกัน
  await list(page);
  await expect(page.getByRole('alert')).toContainText('เซสชันหมดอายุ');
  await expect(table(page)).toHaveCount(0);
});

test('สิทธิ์เปลี่ยน (ถอน custodian): ตรวจใหม่เมื่อกลับมาแล้วปิดโปรไฟล์ทั้งหมด', async ({
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

test('สิทธิ์ถูกถอนระหว่างเปิด: retry ของ timeline ปิด PII ของ core ทั้งหน้า (ไม่ใช่แค่ section)', async ({
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

test('สิทธิ์ถูกถอนระหว่างเปิด: ดูสถานะ Governance และโหลดประวัติเพิ่มปิด PII ทั้งหน้า', async ({
  page,
  request,
}) => {
  await profile(page, 'revokableGovernance');
  const governance = page.getByRole('region', { name: 'สถานะ Contact Governance' });
  await expect(governance).toBeVisible();
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
    test(`section ${section} ได้ ${status}: ปิด PII ทั้งหน้าและ focus ที่ข้อความ`, async ({
      page,
      request,
    }) => {
      await profile(page, 'somchai');
      await expect(page.getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
      // หลัง core โหลดแล้ว section นี้ตอบ error (ยกเว้นครั้งแรกของ section อื่น)
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

test('response ของ core ที่ยิงค้างตอบ 200 มาหลังสิทธิ์ถูกถอน ต้องไม่เปิด PII กลับ', async ({
  page,
  request,
}) => {
  await profile(page, 'revokableGovernance2');
  await expect(page.getByRole('heading', { name: 'Revoke Gov Two' })).toBeVisible();
  const governance = page.getByRole('region', { name: 'สถานะ Contact Governance' });
  await governance.getByRole('textbox').fill('SERVICE');
  // ค้าง response 200 ของ core จนกว่าจะยืนยันว่าถอนสิทธิ์และปิดข้อมูลแล้ว
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
  // ปล่อย response หลัง browser ยืนยันว่า request ถูกยกเลิกแล้ว
  await control(request, 'slow-release');
  await expect
    .poll(async () => (await (await control(request, 'slow-state')).json()).sent)
    .toBe(true);
  await expect(page.getByRole('alert')).toContainText('ไม่พบลูกค้ารายนี้หรือคุณไม่มีสิทธิ์เปิด');
  await expect(page.getByText('Revoke Gov Two')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'ประวัติการติดต่อ' })).toHaveCount(0);
});

test('ตาราง: ชื่อ 80+ ตัวและบริษัทยาวตัดบรรทัดในเซลล์ ไม่ทับคอลัมน์ข้าง; Enter ที่แถวเปิดโปรไฟล์; โหลดเพิ่มแล้ว focus แถวแรกที่เพิ่ม', async ({
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
  // คอลัมน์กว้างไม่เท่ากันตาม CSS (36/26/22/16) และไม่มีเนื้อหาล้นเกินขอบเซลล์
  expect(geometry.heads[0]).toBeGreaterThan(geometry.heads[3]! * 1.5);
  for (const cell of geometry.cells) {
    expect(cell.scroll).toBeLessThanOrEqual(cell.client + 1);
    expect(cell.innerRight).toBeLessThanOrEqual(cell.right + 1);
  }
  // คีย์บอร์ด: Tab เข้าตาราง ลูกศรลงไปที่แถว แล้ว Enter เปิดโปรไฟล์ได้โดยไม่ต้องเลื่อนเข้าเซลล์
  await page.getByRole('button', { name: 'ล้างการค้นหา' }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /นางสาวสมหญิง/ })).toBeVisible();
  await page.getByRole('button', { name: 'กลับไปรายการลูกค้า' }).click();
  await expect(table(page)).toBeVisible();
  await page.getByRole('button', { name: 'โหลดเพิ่ม' }).click();
  // จำนวนแถวรวมขึ้นกับลูกค้าที่ถูกถอนสิทธิ์โดย test ก่อนหน้า — ตรวจว่าครบทุกหน้าแล้วแทนตัวเลขตายตัว
  await expect(page.getByRole('button', { name: 'โหลดเพิ่ม' })).toHaveCount(0);
  expect(await table(page).getByRole('row').count()).toBeGreaterThan(21);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-cu-open'));
  expect(focused).toBeTruthy();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON');
});

test('focus: governance แสดงสถานะ/เปลี่ยนบริบท → หัว section; INCOMPLETE ลองอีกครั้ง → หัวข้อรายการ', async ({
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

test('ผลค้นหาว่างประกาศด้วย role=status และหัวข้อเป็นผลการค้นหาทันทีที่ส่งค้นหา', async ({
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

test('focus: เปิดโปรไฟล์ → ชื่อลูกค้า, กลับ → หัวข้อค้นหา, retry section → หัว section', async ({
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

test('รายการ: INCOMPLETE มีปุ่มลองอีกครั้ง, validation ไม่ทิ้งผลเก่า, สลับชนิดค้นหาล้างคำค้น, หัวข้อเปลี่ยนเป็นผลการค้นหา', async ({
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
  // validation ล้ม: ผลเดิมของ Somsri ยังอยู่และไม่ถูกตีความเป็นผลของคำค้นใหม่
  await search(page, 'ชื่อ (ขึ้นต้นด้วย)', 'x');
  await expect(page.getByText('พิมพ์ชื่ออย่างน้อย 2 ตัวอักษร')).toBeVisible();
  await expect(table(page)).toContainText('Somsri Rakdee');
  // สลับชนิดค้นหา → ล้างคำค้นเดิม
  await page.getByRole('button', { name: /ค้นหาด้วย/ }).click();
  await page.getByRole('option', { name: 'อีเมล (เต็มค่า)' }).click();
  await expect(page.getByRole('textbox')).toHaveValue('');
});

test('Supervisor: อ่านเฉพาะรายการใน IAM VIEW; projection lag = INCOMPLETE/สิทธิ์ยังไม่พร้อม ไม่ใช่ว่าง/ศูนย์', async ({
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

test('Agent/Compliance: ไม่มี generic directory — แสดงไม่มีสิทธิ์ ไม่มีข้อมูลลูกค้า', async ({
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

test('MERGED/AMBIGUOUS/legacy: อ่านอย่างเดียว ไม่ redirect อัตโนมัติ และเปิด canonical เมื่อกดเองเท่านั้น', async ({
  page,
}) => {
  await profile(page, 'predecessor');
  await expect(page.getByRole('heading', { name: 'Predecessor Paul' })).toBeVisible();
  await expect(page.getByText(/ถูกรวมเข้ากับโปรไฟล์อื่นแล้ว/)).toBeVisible();
  expect(page.url()).toContain(`contact=${config.ids.predecessor}`);
  // governance ของ predecessor ใช้ไม่ได้ (ไม่ canonical)
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

test('i18n: สลับ TH/EN ในหน้าเดิมโดยไม่ reload และข้อความครบทั้งสองภาษา', async ({ page }) => {
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

// หมายเหตุ: shared shell (rail + SubNav ใน @d-contact/ui-react) ไม่มี breakpoint ใต้ ~760px
// ที่ 390px พื้นที่เนื้อหาเหลือราว 74px จึงไม่นับเป็นหลักฐานจอแคบของหน้านี้ — ตรวจตั้งแต่ tablet 768 ขึ้นไป
for (const [name, size] of [
  ['tablet 768', { width: 768, height: 1024 }],
  ['laptop 1280', { width: 1280, height: 800 }],
] as const) {
  test(`responsive ${name}: เนื้อหาไม่ล้นทั้งหน้าและพื้นที่เนื้อหา, ชื่อ/บริษัทยาวถูก wrap`, async ({
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
    await profile(page, 'longName');
    await expect(page.getByRole('heading', { name: /นางสาวสมหญิง/ })).toBeVisible();
    expect(await overflow()).toEqual({ page: 0, content: 0 });
    await profile(page, 'somchai');
    await expect(page.getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
    expect(await overflow()).toEqual({ page: 0, content: 0 });
  });
}

test('accessibility: รายการและโปรไฟล์ไม่มี axe violation ระดับ serious/critical ในเนื้อหาหลัก', async ({
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
