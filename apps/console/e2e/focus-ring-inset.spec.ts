import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { AuthoringMock, withShell } from './support/journey-authoring-mock';
import { th } from './support/catalog';

/**
 * inner ring (`--dc-focus-ring-inset`) of a control inside a container that clips overflow
 *
 * originally written as `inset var(--dc-focus-ring)`, which put inset on the first layer only (white), so the brand-colored layer stayed outside
 * and was clipped by `overflow: hidden`, making focus invisible; this suite checks that both layers are inset (colored at the edge, white inside,
 * so it is also visible on a brand-colored button) and collects screenshots when FOCUS_RING_EVIDENCE_DIR is set
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
  // focus by real keyboard so :focus-visible works
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    const box = await target.boundingBox();
    if (!box) throw new Error(`Could not find the position of ${name}`);
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

test('the Journey paired buttons and the language button in the TopBar show an inner ring that overflow does not clip', async ({
  page,
}) => {
  await withShell(page, true);
  await new AuthoringMock().install(page);
  await page.goto('/?view=journeys');
  const filter = page.getByRole('group', { name: th('journeys:list.filterLabel') });
  await expect(filter).toBeVisible();

  await expectInsetRing(
    page,
    filter.getByRole('button', { name: th('journeys:list.filterAll') }),
    'segmented-pressed',
  );
  await expectInsetRing(
    page,
    filter.getByRole('button', { name: th('journeys:list.filterPending') }),
    'segmented',
  );
  await expectInsetRing(page, page.getByRole('button', { name: 'English' }), 'topbar-language');
});
