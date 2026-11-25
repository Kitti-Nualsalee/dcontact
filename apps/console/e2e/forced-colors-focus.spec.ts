import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { AuthoringMock, JOURNEY_ID, withShell } from './support/journey-authoring-mock';

/**
 * Focus indicator in forced-colors (Windows High Contrast)
 *
 * in this mode the browser removes box-shadow, so the ring from `--dc-focus-ring` disappears, and most components
 * write `outline: none` together with the ring — `tokens.css` restores the outline in `@media (forced-colors: active)`
 * this suite checks that the outline really comes back for app controls, ui-react and the inset ring
 * and that the normal mode still uses the original ring (no extra outline)
 *
 * set FORCED_COLORS_EVIDENCE_DIR to collect evidence screenshots of every control in both modes
 */

const BRAND_RING = 'rgb(15, 118, 110)';
const evidenceDir = process.env.FORCED_COLORS_EVIDENCE_DIR;

// evidence screenshots use 2x so the 2px line is clear
test.use({
  locale: 'th-TH',
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: evidenceDir ? 2 : 1,
});

type Mode = 'normal' | 'forced';

/** focus by real keyboard so that both :focus-visible and react-aria's data-focus-visible work */
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
  if (!box) throw new Error(`Could not find the position of ${name}`);
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
  test.describe(`focus indicator in ${mode} mode`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ forcedColors: mode === 'forced' ? 'active' : 'none' });
      await withShell(page, true);
    });

    test('the Journey paired filter (.j5-segmented that clips overflow) and the language button in the TopBar', async ({
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
      const languagePressed = page.getByRole('button', { name: 'ไทย' });
      await expect(languagePressed).toHaveAttribute('aria-pressed', 'true');
      await expectFocusIndicator(page, languagePressed, 'topbar-language-pressed', mode, true);

      if (mode === 'forced') {
        // the pressed state must be distinguishable from a normal button (Highlight background) and the pressed button's outline must not blend into the background
        const look = (target: Locator) =>
          target.evaluate((element) => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, outline: style.outlineColor };
          });
        for (const [on, off] of [
          [pressed, unpressed],
          [languagePressed, language],
        ] as const) {
          const onLook = await look(on);
          expect.soft(onLook.background).not.toBe((await look(off)).background);
          await focusByKeyboard(page, on);
          expect.soft((await look(on)).outline).not.toBe(onLook.background);
        }
      }
    });

    test('the skip link moves focus to main with no frame around the whole page content', async ({
      page,
    }) => {
      await new AuthoringMock().install(page);
      await page.goto('/?view=journeys');
      await expect(page.getByRole('group', { name: 'ตัวกรองรายการ' })).toBeVisible();
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: 'ข้ามไปที่เนื้อหา' });
      await expect(skip).toBeFocused();
      await page.keyboard.press('Enter');
      const main = page.getByRole('main');
      await expect(main).toBeFocused();
      expect(await main.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none');
    });

    test('generic buttons (ui-react Button) and inputs in the Journey edit page', async ({
      page,
    }) => {
      await new AuthoringMock().install(page);
      await page.goto(`/?view=journeys&journey=${JOURNEY_ID}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const button = page.getByRole('button', { name: 'ตรวจฉบับร่างที่บันทึกแล้ว' });
      await expectFocusIndicator(page, button, 'button', mode, false);
      await expect(button).toHaveAttribute('data-focus-visible', 'true');

      const input = page.getByLabel('ชื่อ Journey');
      await expectFocusIndicator(page, input, 'input', mode, false);

      if (mode === 'forced') {
        // a selected node on the canvas is indicated by a colored background only; in this mode it must have a Highlight border thicker than other nodes
        const canvas = page.getByRole('group', { name: 'ผังขั้นตอนของ Journey' });
        const send = canvas.getByRole('button', { name: 'ส่งข้อความ' });
        await send.focus();
        await page.keyboard.press('Enter');
        await expect(send).toHaveAttribute('aria-pressed', 'true');
        const border = (target: Locator) =>
          target.evaluate((element) => {
            const style = getComputedStyle(element);
            return { width: style.borderTopWidth, color: style.borderTopColor };
          });
        await capture(page, send, 'canvas-node-selected', mode);
        const selected = await border(send);
        const other = await border(canvas.getByRole('button', { name: 'เริ่มเมื่อเกิด event' }));
        expect.soft(selected.width).toBe('4px');
        expect.soft(other.width).toBe('2px');
        expect.soft(selected.color).not.toBe(other.color);
      }
    });
  });
}
