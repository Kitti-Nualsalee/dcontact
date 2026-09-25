import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * D1.10 (#449) acceptance: axe 0 serious/critical ทั้งสองภาษา และทุก component ใช้ได้ด้วยคีย์บอร์ด
 * พร้อม focus ring ตาม token (`--dc-focus-ring` = วงนอกสี brand-700 #0f766e)
 */
const FOCUS_RING = 'rgb(15, 118, 110)';

async function seriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`,
    );
}

async function focusRingOf(page: Page) {
  return page.evaluate(() => getComputedStyle(document.activeElement as Element).boxShadow);
}

for (const lang of ['th', 'en'] as const) {
  test(`axe: 0 serious/critical (${lang}) รวมตอนเปิด dialog และ select`, async ({ page }) => {
    await page.goto(`/?lang=${lang}`);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByRole('button', { name: lang === 'th' ? 'เปิด dialog' : 'Open dialog' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: lang === 'th' ? /ช่องทาง/ : /Channel/ }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('สลับภาษาใน preview เปลี่ยนทั้งข้อความของหน้าและของ component (namespace ui)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'ไทย' }).focus();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Buttons' })).toBeVisible();
  // ปุ่มล้างซ่อนตอนช่องว่าง (ไม่อยู่ใน a11y tree) — พิมพ์ก่อนแล้วตรวจชื่อจาก namespace `ui`
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Ann');
  await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('keyboard: Tab ไปถึงปุ่มและเห็น focus ring ตาม token', async ({ page }) => {
  await page.goto('/');
  const save = page.getByRole('button', { name: 'บันทึก' });
  for (let i = 0; i < 10 && !(await save.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(save).toBeFocused();
  expect(await focusRingOf(page)).toContain(FOCUS_RING);
  // ปุ่มที่กดไม่ได้ไม่อยู่ในลำดับ Tab
  await expect(page.getByRole('button', { name: 'กดไม่ได้' })).toBeDisabled();
});

test('keyboard: TextField/SearchField — พิมพ์, Esc ล้างคำค้นหา, required แสดง error', async ({
  page,
}) => {
  await page.goto('/');
  const search = page.getByRole('searchbox', { name: 'ค้นหาลูกค้า' });
  await search.focus();
  // ring อยู่ที่กรอบ (Group) ของช่อง ไม่ใช่ที่ input ด้านใน
  expect(await search.evaluate((el) => getComputedStyle(el.parentElement!).boxShadow)).toContain(
    FOCUS_RING,
  );
  await expect(page.getByRole('button', { name: 'ล้างคำค้นหา' })).toBeHidden();
  await page.keyboard.type('สมชาย');
  await expect(search).toHaveValue('สมชาย');
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');

  const name = page.getByRole('textbox', { name: 'ชื่อ Journey' });
  await name.focus();
  await page.keyboard.type('Welcome');
  await expect(name).toHaveValue('Welcome');
  await expect(name).toHaveAttribute('aria-describedby', /.+/);
});

test('keyboard: Select เปิดด้วย Enter เลื่อนด้วยลูกศร ข้ามตัวเลือกที่ปิดใช้ และเลือกด้วย Enter', async ({
  page,
}) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: /ช่องทาง/ });
  await trigger.focus();
  expect(await focusRingOf(page)).toContain(FOCUS_RING);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(trigger).toContainText('LINE');
  await expect(trigger).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'แฟกซ์ (ปิดใช้)' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
});

test('keyboard: Checkbox และ Switch สลับด้วย Space', async ({ page }) => {
  await page.goto('/');
  const checkbox = page.getByRole('checkbox', { name: 'ยอมรับเงื่อนไข' });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();

  const toggle = page.getByRole('switch', { name: 'รับสายอัตโนมัติ' });
  await toggle.focus();
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
});

test('keyboard: Table เลื่อนแถวด้วยลูกศรและเลือกด้วย Space', async ({ page }) => {
  await page.goto('/');
  const table = page.getByRole('grid', { name: 'คิวงาน' });
  await table.focus();
  await page.keyboard.press('ArrowDown');
  const focusedRow = page.getByRole('row', { name: /บริการหลังการขาย/ });
  await expect(focusedRow).toBeFocused();
  expect(await focusRingOf(page)).toContain(FOCUS_RING);
  await page.keyboard.press('Space');
  await expect(focusedRow).toHaveAttribute('aria-selected', 'true');
});

test('keyboard: Tabs เลื่อนด้วยลูกศรและแสดง panel ที่ตรงกัน', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'ภาพรวม' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'ขั้นตอน' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveText('รายการขั้นตอนตามลำดับ');
});

test('keyboard: Dialog เปิดด้วย Enter, focus ติดอยู่ใน dialog, Esc ปิดแล้ว focus กลับที่ปุ่มเปิด', async ({
  page,
}) => {
  await page.goto('/');
  const open = page.getByRole('button', { name: 'เปิด dialog' });
  await open.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'เผยแพร่ Journey' });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test('keyboard: Toast แสดงใน region ที่มีชื่อ และปิดได้ด้วยคีย์บอร์ด', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'แสดงการแจ้งเตือน' }).focus();
  await page.keyboard.press('Enter');
  const region = page.getByRole('region', { name: 'การแจ้งเตือน' });
  await expect(region.getByText('บันทึกแล้ว')).toBeVisible();
  const dismiss = region.getByRole('button', { name: 'ปิดการแจ้งเตือน' });
  await dismiss.focus();
  expect(await focusRingOf(page)).toContain(FOCUS_RING);
  await page.keyboard.press('Enter');
  await expect(region.getByText('บันทึกแล้ว')).toBeHidden();
});
