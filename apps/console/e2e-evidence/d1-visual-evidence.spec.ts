import { expect, test } from '@playwright/test';
import { AuthoringMock, JOURNEY_ID, withShell } from '../e2e/support/journey-authoring-mock';

/**
 * D1.16 (#455): visual evidence ของ Phase Contract (#428) — ภาพหน้าจอ Console สำหรับหลักฐาน ไม่ใช่ test ปกติ
 * อยู่ใน project `d1-visual-evidence` ที่รันเมื่อสั่งเท่านั้น จึงไม่อยู่ในชุด `chromium` ที่ CI/J5 รัน
 * และไม่ต้อง skip ตัวเอง (J5 negative scan ห้าม test.skip)
 *
 *   D1_VISUAL_EVIDENCE_DIR=<dir> pnpm --filter @d-contact/console exec playwright test --project=d1-visual-evidence
 */
test.use({ locale: 'th-TH', viewport: { width: 1440, height: 900 } });

test('D1.16 visual evidence: Journeys TH/EN ใน shell และ App launcher', async ({ page }) => {
  const dir = process.env.D1_VISUAL_EVIDENCE_DIR;
  if (!dir) throw new Error('ตั้ง D1_VISUAL_EVIDENCE_DIR เพื่อบอกว่าจะเก็บภาพหลักฐานไว้ที่ไหน');
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
  // e2e ไม่มี Keycloak เก็บ locale — โหลดหน้าใหม่แล้วกลับเป็นไทย จึงสลับภาษาบนหน้าที่เปิดอยู่
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
