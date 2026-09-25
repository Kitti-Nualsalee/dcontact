import { expect, test } from '@playwright/test';

/**
 * D1.11 (#450): สลับภาษาต้องไม่ reload — ตรวจด้วย `performance` ของหน้าเดิมและ marker ใน `window`
 * ที่จะหายไปทันทีถ้ามีการโหลดหน้าใหม่ (Phase Contract: ห้าม waive)
 */
test.use({ locale: 'th-TH', timezoneId: 'America/New_York' });

test('สลับ TH → EN → TH ทันทีโดยไม่ reload และ formatter เปลี่ยนตามภาษา', async ({ page }) => {
  await page.goto('/?view=i18n');
  await expect(page.getByTestId('language-label')).toHaveText('ภาษา');
  await expect(page.locator('html')).toHaveAttribute('lang', 'th');
  // ไม่มีผู้ใช้/tenant → timezone ของระบบ ไม่ใช่เวลาเครื่อง (browser ตั้งเป็น New York)
  await expect(page.getByTestId('time-zone')).toHaveText('Asia/Bangkok');
  await expect(page.getByTestId('sample-date')).toHaveText('12 ก.ย. 2569 16:40');

  const before = await page.evaluate(() => {
    (window as unknown as { __d111Marker: string }).__d111Marker = 'same-document';
    return {
      timeOrigin: performance.timeOrigin,
      navigations: performance.getEntriesByType('navigation').length,
    };
  });
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByTestId('language-label')).toHaveText('Language');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('sample-date')).toHaveText('12 Sep 2026 16:40');
  await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'ไทย' }).click();
  await expect(page.getByTestId('language-label')).toHaveText('ภาษา');

  const after = await page.evaluate(() => ({
    marker: (window as unknown as { __d111Marker?: string }).__d111Marker,
    timeOrigin: performance.timeOrigin,
    navigations: performance.getEntriesByType('navigation').length,
  }));
  expect(after).toEqual({ ...before, marker: 'same-document' });
  // bundle ทั้งสองภาษาโหลดตั้งแต่เริ่ม — สลับภาษาแล้วไม่มี request ใหม่เลย
  expect(requests).toEqual([]);
});

test('ภาษา browser เป็นขั้นที่สามของลำดับ — browser อังกฤษได้ EN เมื่อไม่มีค่าผู้ใช้/tenant', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5174/?view=i18n');
  await expect(page.getByTestId('language-label')).toHaveText('Language');
  await context.close();
});
