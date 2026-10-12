import { expect, test } from './fixtures';

test('เปิดรับสายรอ server acknowledgement และกันกดซ้ำ', async ({ page }) => {
  let requests = 0;
  let confirm!: () => void;
  const confirmation = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  await page.route('**/api/v1/workspace/agent/availability', async (route) => {
    requests += 1;
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ state: 'AVAILABLE' });
    expect(route.request().headers()['x-work-session-lease-id']).toMatch(/^e2e-work-session-/);
    await confirmation;
    await route.fulfill({ json: { state: 'AVAILABLE' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  await expect(page.getByRole('status', { name: 'สถานะ dphone' })).toHaveText('โทรศัพท์พร้อม');
  await page.getByRole('button', { name: 'เปิดรับสาย' }).click();
  await expect.poll(() => requests, { timeout: 2000 }).toBe(1);
  await expect(page.getByText('พร้อมรับสาย', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'กำลังยืนยันกับ server…' })).toBeDisabled();
  confirm();
  await expect(page.getByText('พร้อมรับสาย', { exact: true })).toBeVisible();
  expect(requests).toBe(1);
});

test('server ปฏิเสธ availability ยัง OFFLINE และแจ้ง failure', async ({ page }) => {
  await page.route('**/api/v1/workspace/agent/availability', (route) =>
    route.fulfill({ status: 403, json: { code: 'WORK_SESSION_CHANGED' } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  await expect(page.getByRole('status', { name: 'สถานะ dphone' })).toHaveText('โทรศัพท์พร้อม');
  await page.getByRole('button', { name: 'เปิดรับสาย' }).click();
  await expect(
    page.getByText('ยืนยันการเปิดรับสายกับ server ไม่สำเร็จ ระบบยังไม่เปิดรับสาย'),
  ).toBeVisible();
  await expect(page.getByText('พร้อมรับสาย', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'เปิดรับสาย' })).toBeEnabled();
});

test('ไมค์หยุดระหว่างรอ acknowledgement ห้ามแสดง AVAILABLE จากผลที่มาช้า', async ({ page }) => {
  let requested = false;
  let confirm!: () => void;
  const confirmation = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  await page.route('**/api/v1/workspace/agent/availability', async (route) => {
    requested = true;
    await confirmation;
    await route.fulfill({ json: { state: 'AVAILABLE' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  await expect(page.getByRole('status', { name: 'สถานะ dphone' })).toHaveText('โทรศัพท์พร้อม');
  await page.getByRole('button', { name: 'เปิดรับสาย' }).click();
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(() => {
    const testWindow = window as Window & { __dContactTestMediaTrack: EventTarget };
    testWindow.__dContactTestMediaTrack.dispatchEvent(new Event('ended'));
  });
  confirm();
  await expect(page.getByText('กำลังยืนยันกับ server…')).toHaveCount(0);
  await expect(page.getByText('พร้อมรับสาย', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'เปิดรับสาย' })).toBeDisabled();
});
