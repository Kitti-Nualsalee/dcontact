import { test, expect } from '@playwright/test';
import { coreLogin } from './core-settings-helpers.js';
test('เมนู: องค์กร↔ทีมแบบ SPA พร้อม back/forward และ dirty cancel', async ({ page, request }) => {
  await coreLogin(page, request);
  await expect(page.getByRole('heading', { name: 'ทีม', exact: true })).toBeVisible();
  let loads = 0;
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) loads++;
  });
  await page.getByRole('link', { name: 'ข้อมูลองค์กร', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })).toBeVisible();
  expect(loads).toBe(0);
  await page
    .getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })
    .fill('ร่างก่อนเปลี่ยนหมวด');
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('link', { name: 'ทีม', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })).toHaveValue(
    'ร่างก่อนเปลี่ยนหมวด',
  );
  page.once('dialog', (d) => d.accept());
  await page.getByRole('link', { name: 'ทีม', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ทีม', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'ทีม', exact: true })).toBeVisible();
});
test('เมนู: Team TH/EN เปลี่ยนข้อความในหน้าเดิมและมี production deep links', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await expect(page.getByRole('heading', { name: 'ทีม', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create team', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Teams', exact: true })).toHaveAttribute(
    'href',
    /view=core-settings&page=teams/,
  );
  await expect(page.getByRole('link', { name: /Calendar/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'ไทย', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ทีม', exact: true })).toBeVisible();
});
test('เมนู: back ระหว่าง create UNKNOWN แล้วยกเลิก ต้องคง URL ของ command เดิม', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('link', { name: 'ข้อมูลองค์กร', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'ทีม', exact: true }).click();
  await page.getByRole('button', { name: 'สร้างทีม', exact: true }).click();
  await page.getByRole('textbox', { name: 'ชื่อทีม', exact: true }).fill('ทีมยกเลิก Back');
  await request.post('/__core_test/fault/lost-response');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ยังยืนยันผลบันทึกไม่ได้');
  const pendingUrl = page.url();
  page.once('dialog', (d) => d.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(pendingUrl);
  await page.getByRole('button', { name: 'ตรวจผลบันทึกอีกครั้ง' }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
});
test('เมนู: กลับรายการทีมหลัง create ต้องล้าง detail แม้ route เดิมก่อนเปิด dialog', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('button', { name: 'สร้างทีม', exact: true }).click();
  await page.getByRole('textbox', { name: 'ชื่อทีม', exact: true }).fill('ทีมกลับรายการหลังสร้าง');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  await page.getByRole('button', { name: 'ปิดหน้าต่าง', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'ทีมกลับรายการหลังสร้าง', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'ทีม', exact: true }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has('team'));
  await expect(
    page.getByRole('heading', { name: 'ทีมกลับรายการหลังสร้าง', exact: true }),
  ).toHaveCount(0);
});
test('เมนู: API metadata รุ่นก่อนที่ไม่มี pages/areas ใช้ fallback เข้าองค์กรและทีมจริง', async ({
  page,
  request,
}) => {
  await request.post('/__core_test/navigation-legacy');
  try {
    await coreLogin(page, request);
    const fallback = page.getByRole('navigation', { name: 'ตั้งค่าองค์กร', exact: true });
    await expect(fallback.getByRole('link', { name: 'ข้อมูลองค์กร', exact: true })).toBeVisible();
    await fallback.getByRole('link', { name: 'ข้อมูลองค์กร', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: 'ชื่อแสดงขององค์กร', exact: true }),
    ).toBeVisible();
    await fallback.getByRole('link', { name: 'ทีม', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ทีม', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Core care', exact: true })).toBeVisible();
  } finally {
    await request.post('/__core_test/restore');
  }
});
