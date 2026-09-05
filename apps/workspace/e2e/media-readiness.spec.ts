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

test('Agent ถูกถอนจาก AVAILABLE เมื่อ media track จบระหว่างรอรับสาย', async ({ page }) => {
  await page.addInitScript(() => {
    class TestMediaTrack extends EventTarget {
      stop() {}
    }

    const track = new TestMediaTrack();
    Object.defineProperty(window, '__dContactTestMediaTrack', { value: track });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => ({ getTracks: () => [track] }),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  await page.getByRole('button', { name: 'เปิดรับสาย' }).click();
  await expect(page.getByText('พร้อมรับสาย', { exact: true })).toBeVisible();

  await page.evaluate(() => {
    const track = (window as Window & { __dContactTestMediaTrack: EventTarget })
      .__dContactTestMediaTrack;
    track.dispatchEvent(new Event('ended'));
  });

  await expect(page.getByRole('alert')).toHaveText(
    'ไมโครโฟนหยุดทำงาน ระบบปิดรับสายใหม่แล้ว โปรดตรวจอุปกรณ์เสียงอีกครั้ง',
  );
  await expect(page.getByRole('button', { name: 'เปิดรับสาย' })).toBeDisabled();
  await expect(page.getByText('ยังไม่พร้อมรับสาย', { exact: true })).toBeVisible();
});
