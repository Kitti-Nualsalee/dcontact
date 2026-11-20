import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * ซ้อม Demo ของทีมขายฝั่ง Agent บน stack ที่ `scripts/sales-demo-stack.mjs` เปิดไว้แล้ว
 *
 * agent1000 login → เลือก Ready ที่หน้าเลือกสถานะ → SIPp โทรเข้าคิว 2000 → รับสาย → ค้นและเชื่อมลูกค้าที่นำเข้าจาก CSV →
 * แก้บริษัท → วางสาย → บันทึก disposition/โน้ต → เปิดผลในประวัติงาน
 *
 * เป็นเครื่องมือซ้อม ไม่ใช่ acceptance: เสียงเป็น fake media, ฐาน `dcontact_demo` ถูก seed สิทธิ์โดยตรง
 * ต้องนำเข้า `examples/sales-demo/customers.csv` ใน Console ก่อน (ลูกค้าแถวแรกใช้เบอร์ด้านล่าง)
 *
 * ล้มเร็วพร้อมบอกสาเหตุแทนการรอจนหมดเวลา: ฐานยังไม่มีลูกค้าที่ใช้ซ้อม, ค้นแล้วไม่พบลูกค้า,
 * หน้า Workspace โหลดใหม่/dev server หลุดกลางรอบ (stack ถูกปิดหรือเปิดใหม่ระหว่างซ้อม)
 * หรือรอบก่อนทิ้งสายที่ยังคุยอยู่จนเปลี่ยนเป็น Ready ไม่ได้
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

/** จำนวนเบอร์ลูกค้าที่ใช้ซ้อมใน tenant demo — ส่งเบอร์เป็นตัวแปรของ psql ไม่ต่อสตริง SQL */
function customerPhoneCount(): number {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'infra/docker/docker-compose.dev.yml',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'dcontact',
      '-d',
      'dcontact_demo',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `phone=${customerPhone}`,
      '-At',
      '-f',
      '-',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      input: `SELECT count(*) FROM c360_contact_points p JOIN tenants t ON t.id = p.tenant_id
        WHERE t.slug = 'demo' AND p.kind = 'PHONE' AND p.retired_at IS NULL
          AND p.normalized_value = :'phone';`,
    },
  );
  if (result.status !== 0)
    throw new Error(
      `อ่านฐาน dcontact_demo ไม่ได้ — เปิด stack ด้วย node scripts/sales-demo-stack.mjs ก่อน (${result.stderr.trim().split('\n')[0]})`,
    );
  return Number(result.stdout.trim());
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
  expect(
    customerPhoneCount(),
    `ฐาน dcontact_demo ยังไม่มีลูกค้าเบอร์ ${customerPhone} ใน tenant demo — ` +
      'นำเข้า examples/sales-demo/customers.csv ใน Console ก่อนซ้อม (หลัง --reset ต้องนำเข้าใหม่)',
  ).toBeGreaterThan(0);
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
  // หลัง login หน้า Workspace ต้องไม่โหลดใหม่จนจบรอบ ถ้าโหลดใหม่ auth ในหน่วยความจำหายและหน้ากลับไปที่ปุ่ม
  // เข้าสู่ระบบ ทุกขั้นถัดไปจะรอจนหมดเวลา — ปิดหน้าให้คำสั่งที่รออยู่ล้มทันทีแล้วรายงานสาเหตุ
  let aborted: string | undefined;
  const abort = (reason: string) => {
    if (aborted) return;
    aborted = reason;
    void page.close();
  };
  // 'load' = โหลดเอกสารใหม่ทั้งหน้า ไม่นับการเปลี่ยน URL ในหน้าเดิม (history API)
  page.on('load', () =>
    abort(
      `หน้า Workspace โหลดใหม่กลางรอบ (${page.url()}) — stack อาจถูกปิดหรือเปิดใหม่ระหว่างซ้อม`,
    ),
  );
  page.on('console', (message) => {
    if (message.text().includes('server connection lost'))
      abort('dev server ของ Workspace หลุดกลางรอบ — stack ถูกปิดหรือเปิดใหม่ระหว่างซ้อม');
  });
  try {
    await rehearse();
  } catch (error) {
    if (aborted) throw new Error(aborted, { cause: error });
    throw error;
  }

  async function rehearse() {
    // รอบซ้อมก่อนหน้าหรือแท็บอื่นอาจยังถือ work session ของ agent1000 อยู่ (ย้ายมาที่นี่)
    // หรือ session เดิมหมดอายุแล้วและยังไม่มีใครรับงาน (เริ่มรับงานที่นี่)
    const takeOver = page.getByRole('button', { name: 'ย้ายมาที่นี่' });
    const startHere = page.getByRole('button', { name: 'เริ่มรับงานที่นี่' });
    const dphone = page.getByRole('region', { name: 'dphone' });
    const status = dphone.getByRole('status', { name: 'dphone' });
    // หน้าต่าง work session โผล่ได้ทุกเมื่อหลัง snapshot แรก — ให้ Playwright กดให้ทุกครั้งที่บังการกด
    // บางรอบหน้าต่างหายเองเมื่อไม่มีผู้ถือ session แล้ว จึงไม่ถือว่าการกดไม่ทันเป็นความล้มเหลว
    await page.addLocatorHandler(
      takeOver.or(startHere),
      async () => {
        if (await startHere.isVisible()) {
          await startHere.click({ timeout: 2_000 }).catch(() => undefined);
          return;
        }
        await takeOver.click({ timeout: 2_000 }).catch(() => undefined);
        await page
          .getByRole('button', { name: 'ยืนยันย้าย' })
          .click({ timeout: 5_000 })
          .catch(() => undefined);
      },
      { noWaitAfter: true },
    );
    await expect(dphone).toBeVisible({ timeout: 30_000 });
    // #938 หน้าเลือกสถานะหลัง login — มีงานค้างจากรอบก่อนจะข้ามหน้านี้ไปที่ Workspace เลย
    const gate = page.getByRole('region', { name: /^สวัสดี / });
    const workList = page.getByRole('region', { name: 'งานของฉัน' });
    await expect(gate.or(workList).first()).toBeVisible({ timeout: 30_000 });
    if (await gate.isVisible()) {
      await gate.getByRole('radio', { name: /^Ready/ }).check();
      await gate.getByRole('button', { name: 'เข้า Workspace' }).click();
      await expect(gate)
        .toHaveCount(0, { timeout: 30_000 })
        .catch(async () => {
          const failure = await gate
            .getByRole('alert')
            .innerText()
            .catch(() => '');
          throw new Error(
            `เตรียมรับสายจากหน้าเลือกสถานะไม่สำเร็จ: ${failure || 'ไม่มีข้อความแจ้ง'}`,
          );
        });
    } else {
      // รอบซ้อมที่ล้มกลางทางทิ้งงาน WRAPUP ไว้ — ปิดก่อน ไม่งั้น Router ไม่ส่งสายใหม่ให้
      await page.getByRole('tab', { name: 'สรุปผล', exact: true }).click();
      const pending = page.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' });
      if (await pending.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await pending.click();
        await page.getByRole('textbox', { name: 'โน้ตสรุป' }).fill('ปิดงานค้างจากรอบซ้อมก่อนหน้า');
        await page.getByRole('button', { name: 'บันทึกผล' }).click();
        await expect(page.getByRole('heading', { name: 'บันทึกผลแล้ว' })).toBeVisible();
      }
      // รอบที่ล้มกลางสายทิ้งสายที่ยังคุยอยู่ไว้ ตัวเลือกสถานะจึงยังไม่ขึ้นจนสายจบ
      const selector = page.getByRole('button', { name: /สถานะของฉัน/ });
      await expect(selector)
        .toBeVisible({ timeout: 20_000 })
        .catch(async () => {
          const notice = (await page.getByRole('alert').allInnerTexts()).join(' / ');
          throw new Error(
            `เปลี่ยนเป็น Ready ไม่ได้ (${notice || 'ไม่มีข้อความแจ้ง'}) — รอบก่อนอาจทิ้งสายที่ยังคุยอยู่` +
              'หรือแท็บอื่นยังถือ work session รอให้สายจบ (ราว 2–3 นาที) แล้วซ้อมใหม่',
          );
        });
      await selector.click();
      await page.getByRole('option', { name: 'Ready', exact: true }).click();
    }
    await expect(status).toHaveText('โทรศัพท์พร้อม');
    await expect(page.getByRole('button', { name: /สถานะของฉัน/ })).toContainText('Ready');
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
      const select = page.getByRole('button', { name: 'เลือกเชื่อมลูกค้า' });
      const notFound = page.getByText('ไม่พบลูกค้าที่เลือกได้');
      await expect(select.or(notFound).first()).toBeVisible();
      if (await notFound.isVisible())
        throw new Error(
          `ค้นเบอร์ ${customerPhone} แล้วไม่พบลูกค้าที่เลือกได้ — ตรวจว่านำเข้า CSV แล้ว` +
            'และทีม Customer Care มีสิทธิ์ WORK บน "ลูกค้าทั้งหมด"',
        );
      await select.click();
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
  }
});
