import { expect, test } from '@playwright/test';

test('Agent เปิดรับสายได้หลัง browser ยืนยัน media readiness เท่านั้น', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Agent Workspace' })).toBeVisible();
  await expect(page.getByText('ยังไม่พร้อมรับสาย', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'เปิดรับสาย' })).toBeDisabled();

  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();

  await expect(page.getByRole('status', { name: 'ความพร้อมของอุปกรณ์เสียง' })).toHaveText(
    'อุปกรณ์เสียงพร้อม',
  );
  await expect(page.getByRole('button', { name: 'เปิดรับสาย' })).toBeEnabled();

  await page.getByRole('button', { name: 'เปิดรับสาย' }).click();

  await expect(page.getByText('พร้อมรับสาย', { exact: true })).toBeVisible();
});
