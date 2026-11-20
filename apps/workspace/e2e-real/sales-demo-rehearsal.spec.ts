import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * ซ้อม Demo ของทีมขายฝั่ง Agent บน stack ที่ `scripts/sales-demo-stack.mjs` เปิดไว้แล้ว
 *
 * agent1000 login → เปิดรับสาย → SIPp โทรเข้าคิว 2000 → รับสาย → ค้นและเชื่อมลูกค้าที่นำเข้าจาก CSV →
 * แก้บริษัท → วางสาย → บันทึก disposition/โน้ต → เปิดผลในประวัติงาน
 *
 * เป็นเครื่องมือซ้อม ไม่ใช่ acceptance: เสียงเป็น fake media, ฐาน `dcontact_demo` ถูก seed สิทธิ์โดยตรง
 * ต้องนำเข้า `examples/sales-demo/customers.csv` ใน Console ก่อน (ลูกค้าแถวแรกใช้เบอร์ด้านล่าง)
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const shots = resolve(here, '../test-results-real/sales-demo');
const sippImage =
  'ctaloi/sipp@sha256:c459f2340443ddcc159227efc798217dbdaad0dbe88b76b78b1a876aa271986a';
const customerPhone = process.env.SALES_DEMO_CUSTOMER_PHONE ?? '+66895550110';

function placeCall(): ChildProcess {
  return spawn(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'd-contact-dev_default',
      '-v',
      `${resolve(repoRoot, 'scripts/fixtures/d1-real-call-uac.xml')}:/scenario.xml:ro`,
      sippImage,
      'freeswitch:5080',
      '-sf',
      '/scenario.xml',
      '-cid_str',
      `dcontact-sales-demo-${process.pid}-%u@%s`,
      '-m',
      '1',
      '-timeout',
      '150s',
      '-timeout_error',
      '-nostdin',
      '-trace_err',
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
}

async function login(page: Page) {
  await page.goto('/?tenant=demo');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.waitForURL(/\/realms\/dcontact\//);
  await page.locator('#username').fill('agent1000@demo.local');
  if (!(await page.locator('#password').isVisible())) await page.locator('#kc-login').click();
  await page.locator('#password').fill('agent1234');
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === 'http://localhost:5173');
}

test('ซ้อม Demo: รับสาย เชื่อมลูกค้า แก้ข้อมูล บันทึกผล และเปิดประวัติ', async ({
  page,
  context,
}) => {
  mkdirSync(shots, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: resolve(shots, `${name}.png`) });

  // วินิจฉัยตอนซ้อมล้ม: ผลของ work API ฝั่งลูกค้า (เฉพาะ status/code ไม่มีข้อมูลลูกค้า)
  page.on('response', async (response) => {
    const url = response.url();
    if (!/customer-360\/work|workspace\/agent\/session/.test(url) || response.status() < 400)
      return;
    const body = await response.text().catch(() => '');
    console.log(`[work-api] ${response.status()} ${new URL(url).pathname} ${body.slice(0, 200)}`);
  });
  await login(page);
  // รอบซ้อมก่อนหน้าหรือแท็บอื่นอาจยังถือ work session ของ agent1000 อยู่
  const takeOver = page.getByRole('button', { name: 'ย้ายมาที่นี่' });
  const dphone = page.getByRole('region', { name: 'dphone' });
  const status = dphone.getByRole('status', { name: 'dphone' });
  // หน้าต่างย้าย session โผล่ได้ทุกเมื่อหลัง snapshot แรก — ให้ Playwright กดให้ทุกครั้งที่บังการกด
  // บางรอบหน้าต่างหายเองเมื่อไม่มีผู้ถือ session แล้ว จึงไม่ถือว่าการกดไม่ทันเป็นความล้มเหลว
  await page.addLocatorHandler(
    takeOver,
    async () => {
      await takeOver.click({ timeout: 2_000 }).catch(() => undefined);
      await page
        .getByRole('button', { name: 'ยืนยันย้าย' })
        .click({ timeout: 5_000 })
        .catch(() => undefined);
    },
    { noWaitAfter: true },
  );
  await expect(dphone).toBeVisible({ timeout: 30_000 });
  // รอบซ้อมที่ล้มกลางทางทิ้งงาน WRAPUP ไว้ — ปิดก่อน ไม่งั้น Router ไม่ส่งสายใหม่ให้
  await page.getByRole('tab', { name: 'สรุปผล', exact: true }).click();
  const pending = page.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' });
  if (await pending.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await pending.click();
    await page.getByRole('textbox', { name: 'โน้ตสรุป' }).fill('ปิดงานค้างจากรอบซ้อมก่อนหน้า');
    await page.getByRole('button', { name: 'บันทึกผล' }).click();
    await expect(page.getByRole('heading', { name: 'บันทึกผลแล้ว' })).toBeVisible();
  }
  await page.getByRole('tab', { name: 'ความพร้อม', exact: true }).click();
  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  await expect(status).toHaveText('โทรศัพท์พร้อม');
  await page.getByRole('button', { name: 'เปิดรับสาย' }).click();
  await shot('01-ready');

  const caller = placeCall();
  try {
    await expect(status).toHaveText('มีสายเรียกเข้า', { timeout: 60_000 });
    await shot('02-ringing');
    await dphone.getByRole('button', { name: 'รับสาย' }).click();
    await expect(status).toHaveText('กำลังสนทนา');

    // Cus360 ต้องยืนยัน session ของงานกับ server ก่อนแสดงข้อมูลลูกค้า (เหมือนรอบทดลอง #796)
    const unlinked = page.getByText('งานนี้ยังไม่เชื่อมกับลูกค้า');
    const confirmSession = page.getByRole('button', { name: 'ยืนยันตัวตน' });
    await expect(unlinked.or(confirmSession).first()).toBeVisible();
    if (await confirmSession.isVisible()) await confirmSession.click();
    await expect(unlinked).toBeVisible();
    await page.getByLabel('เบอร์โทรศัพท์สากลหรืออีเมลเต็มค่า').fill(customerPhone);
    await page.getByRole('button', { name: 'ค้นหาลูกค้าสำหรับงานนี้' }).click();
    await page.getByRole('button', { name: 'เลือกเชื่อมลูกค้า' }).click();
    await shot('03-customer-found');
    await page.getByRole('button', { name: 'ยืนยัน', exact: true }).click();
    await expect(page.getByText('บันทึกข้อมูลลูกค้าแล้ว')).toBeVisible();

    await page.getByRole('button', { name: 'แก้ชื่อและบริษัท' }).click();
    // ค่าต้องต่างจากรอบก่อน ไม่งั้น server ตอบว่าข้อมูลไม่เปลี่ยนแปลง
    const stamp = new Date().toLocaleTimeString('th-TH', { hour12: false });
    await page.getByLabel('บริษัท').fill(`บริษัท สยามโลจิสติกส์ จำกัด (ซ้อม ${stamp})`);
    await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
    await expect(page.getByText('บันทึกข้อมูลลูกค้าแล้ว')).toBeVisible();
    await shot('04-customer-linked');

    await dphone.getByRole('button', { name: 'วางสาย' }).click();
  } finally {
    caller.kill('SIGTERM');
  }

  await expect(page.getByRole('heading', { name: 'สรุปผลหลังสาย' })).toBeVisible();
  await page.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' }).click();
  await page
    .getByRole('textbox', { name: 'โน้ตสรุป' })
    .fill('ลูกค้าสอบถามสถานะการจัดส่ง แจ้งกำหนดส่งแล้ว');
  await shot('05-wrapup');
  await page.getByRole('button', { name: 'บันทึกผล' }).click();
  await expect(page.getByRole('heading', { name: 'บันทึกผลแล้ว' })).toBeVisible();
  await shot('06-saved');

  const [history] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: 'เปิดผลในประวัติงาน (แท็บใหม่)' }).click(),
  ]);
  await expect(history.getByText('ลูกค้าสอบถามสถานะการจัดส่ง แจ้งกำหนดส่งแล้ว')).toBeVisible();
  await history.screenshot({ path: resolve(shots, '07-history.png') });
});
