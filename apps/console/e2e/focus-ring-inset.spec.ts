import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { AuthoringMock, withShell } from './support/journey-authoring-mock';

/**
 * ring ด้านใน (`--dc-focus-ring-inset`) ของ control ที่อยู่ใน container ตัด overflow
 *
 * เดิมเขียน `inset var(--dc-focus-ring)` ซึ่งใส่ inset ให้แค่ชั้นแรก (ขาว) ชั้นสี brand จึงยังอยู่ด้านนอก
 * และถูก `overflow: hidden` ตัดจนมองไม่เห็นโฟกัส ชุดนี้ตรวจว่าทั้งสองชั้นเป็น inset (สีที่ขอบ ขาวด้านใน
 * จึงเห็นบนปุ่มพื้นสี brand ด้วย) และเก็บภาพเมื่อตั้ง FOCUS_RING_EVIDENCE_DIR
 */

const evidenceDir = process.env.FOCUS_RING_EVIDENCE_DIR;
const BRAND_RING_INSET =
  /rgb\(15, 118, 110\) 0px 0px 0px 2px inset, rgb\(255, 255, 255\) 0px 0px 0px 4px inset/;

test.use({
  locale: 'th-TH',
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: evidenceDir ? 2 : 1,
});

async function expectInsetRing(page: Page, target: Locator, name: string) {
  // โฟกัสด้วยคีย์บอร์ดจริงเพื่อให้ :focus-visible ทำงาน
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    const box = await target.boundingBox();
    if (!box) throw new Error(`ไม่พบตำแหน่งของ ${name}`);
    const pad = 32;
    await page.screenshot({
      path: join(evidenceDir, `${name}.png`),
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: box.width + pad * 2,
        height: box.height + pad * 2,
      },
      animations: 'disabled',
      caret: 'hide',
    });
  }
  const shadow = await target.evaluate((element) => getComputedStyle(element).boxShadow);
  expect.soft(shadow, name).toMatch(BRAND_RING_INSET);
}

test('ปุ่มคู่ของ Journey และปุ่มภาษาใน TopBar แสดง ring ด้านในที่ไม่ถูก overflow ตัด', async ({
  page,
}) => {
  await withShell(page, true);
  await new AuthoringMock().install(page);
  await page.goto('/?view=journeys');
  const filter = page.getByRole('group', { name: 'ตัวกรองรายการ' });
  await expect(filter).toBeVisible();

  await expectInsetRing(page, filter.getByRole('button', { name: 'ทั้งหมด' }), 'segmented-pressed');
  await expectInsetRing(page, filter.getByRole('button', { name: 'รอตรวจ' }), 'segmented');
  await expectInsetRing(page, page.getByRole('button', { name: 'English' }), 'topbar-language');
});
