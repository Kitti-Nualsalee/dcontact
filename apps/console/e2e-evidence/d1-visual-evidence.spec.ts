import { expect, test } from '@playwright/test';
import { AuthoringMock, JOURNEY_ID, withShell } from '../e2e/support/journey-authoring-mock';

/**
 * D1.16 (#455): visual evidence for the Phase Contract (#428) — Console screenshots as evidence, not a regular test
 * lives in the `d1-visual-evidence` project, which runs only on demand, so it is not part of the `chromium` suite that CI/J5 runs
 * and does not need to skip itself (the J5 negative scan forbids test.skip)
 *
 *   D1_VISUAL_EVIDENCE_DIR=<dir> pnpm --filter @d-contact/console exec playwright test --project=d1-visual-evidence
 */
test.use({ locale: 'th-TH', viewport: { width: 1440, height: 900 } });

test('D1.16 visual evidence: Journeys TH/EN in the shell and the App launcher', async ({
  page,
}) => {
  const dir = process.env.D1_VISUAL_EVIDENCE_DIR;
  if (!dir)
    throw new Error('Set D1_VISUAL_EVIDENCE_DIR to say where the evidence screenshots are stored');
  const mock = new AuthoringMock();
  await withShell(page, true);
  await mock.install(page);
  await page.goto('/?view=journeys&tenant=demo');
  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toBeVisible();
  await page.screenshot({ path: `${dir}/console-journeys-th.png` });
  await page.getByRole('button', { name: 'แอปทั้งหมด' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: `${dir}/app-launcher-th.png` });
  await page.keyboard.press('Escape');
  // e2e has no Keycloak to store the locale — reloading the page returns to Thai, so switch language on the open page
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Journeys you can see' })).toBeVisible();
  await page.screenshot({ path: `${dir}/console-journeys-en.png` });

  await page.goto(`/?view=journeys&tenant=demo&journey=${JOURNEY_ID}`);
  await expect(page.getByRole('button', { name: 'บันทึกฉบับร่าง' })).toBeVisible();
  await page.screenshot({ path: `${dir}/console-journey-editor-th.png` });
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
  await page.screenshot({ path: `${dir}/console-journey-editor-en.png` });
});
