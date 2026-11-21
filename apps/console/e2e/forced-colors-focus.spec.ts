import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { AuthoringMock, JOURNEY_ID, withShell } from './support/journey-authoring-mock';

/**
 * Focus indicator ใน forced-colors (Windows High Contrast)
 *
 * โหมดนี้เบราว์เซอร์ลบ box-shadow ทิ้ง ring จาก `--dc-focus-ring` จึงหายไป และ component ส่วนใหญ่
 * เขียน `outline: none` คู่กับ ring — `tokens.css` คืน outline ให้ใน `@media (forced-colors: active)`
 * ชุดนี้ตรวจว่า outline กลับมาจริงทั้ง control ของแอป, ui-react และ ring แบบ inset
 * และโหมดปกติยังเป็น ring เดิม (ไม่มี outline เพิ่ม)
 *
 * ตั้ง FORCED_COLORS_EVIDENCE_DIR เพื่อเก็บภาพหลักฐานของแต่ละ control ทั้งสองโหมด
 */

const BRAND_RING = 'rgb(15, 118, 110)';
const evidenceDir = process.env.FORCED_COLORS_EVIDENCE_DIR;

// ภาพหลักฐานใช้ 2x ให้เห็นเส้น 2px ชัด
test.use({
  locale: 'th-TH',
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: evidenceDir ? 2 : 1,
});

type Mode = 'normal' | 'forced';

/** โฟกัสด้วยคีย์บอร์ดจริง เพื่อให้ทั้ง :focus-visible และ data-focus-visible ของ react-aria ทำงาน */
async function focusByKeyboard(page: Page, target: Locator) {
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

async function focusStyle(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      boxShadow: style.boxShadow,
    };
  });
}

async function capture(page: Page, target: Locator, name: string, mode: Mode) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  const box = await target.boundingBox();
  if (!box) throw new Error(`ไม่พบตำแหน่งของ ${name}`);
  const pad = 32;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: join(evidenceDir, `${name}-${mode}.png`),
    clip: { x, y, width: box.width + pad * 2, height: box.height + pad * 2 },
    animations: 'disabled',
    caret: 'hide',
  });
}

async function expectFocusIndicator(
  page: Page,
  target: Locator,
  name: string,
  mode: Mode,
  inset: boolean,
) {
  await focusByKeyboard(page, target);
  await capture(page, target, name, mode);
  const style = await focusStyle(target);
  if (mode === 'forced') {
    expect.soft(style.outlineStyle, name).toBe('solid');
    expect.soft(style.outlineWidth, name).toBe('2px');
    expect.soft(style.outlineOffset, name).toBe(inset ? '-4px' : '2px');
  } else {
    expect.soft(style.outlineStyle, name).toBe('none');
    expect.soft(style.boxShadow, name).toContain(BRAND_RING);
    expect.soft(style.boxShadow.includes('inset'), name).toBe(inset);
  }
}

for (const mode of ['normal', 'forced'] as const) {
  test.describe(`focus indicator โหมด ${mode}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ forcedColors: mode === 'forced' ? 'active' : 'none' });
      await withShell(page, true);
    });

    test('ตัวกรองแบบปุ่มคู่ของ Journey (.j5-segmented ที่ตัด overflow) และปุ่มภาษาใน TopBar', async ({
      page,
    }) => {
      await new AuthoringMock().install(page);
      await page.goto('/?view=journeys');
      const filter = page.getByRole('group', { name: 'ตัวกรองรายการ' });
      await expect(filter).toBeVisible();

      const pressed = filter.getByRole('button', { name: 'ทั้งหมด' });
      await expectFocusIndicator(page, pressed, 'segmented-pressed', mode, true);
      const unpressed = filter.getByRole('button', { name: 'รอตรวจ' });
      await expectFocusIndicator(page, unpressed, 'segmented', mode, true);

      const language = page.getByRole('button', { name: 'English' });
      await expectFocusIndicator(page, language, 'topbar-language', mode, true);
    });

    test('ปุ่มทั่วไป (ui-react Button) และ input ในหน้าแก้ Journey', async ({ page }) => {
      await new AuthoringMock().install(page);
      await page.goto(`/?view=journeys&journey=${JOURNEY_ID}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const button = page.getByRole('button', { name: 'ตรวจฉบับร่างที่บันทึกแล้ว' });
      await expectFocusIndicator(page, button, 'button', mode, false);
      await expect(button).toHaveAttribute('data-focus-visible', 'true');

      const input = page.getByLabel('ชื่อ Journey');
      await expectFocusIndicator(page, input, 'input', mode, false);
    });
  });
}
