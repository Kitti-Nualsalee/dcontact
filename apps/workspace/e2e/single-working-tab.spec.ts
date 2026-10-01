import { expect, test } from './fixtures.js';

/**
 * #583: ทุก tenant บังคับ work-session lease — สองแท็บใน origin เดียวกัน แท็บแรก (leader) ได้ lease และเป็นจุดรับงาน
 * แท็บที่สองเห็นว่ามีผู้ถืออยู่จึงดูได้อย่างเดียว ไม่เปิดรับงานซ้อน (เดิมทดสอบ leader election แบบไม่มี lease)
 */
test('Agent มีจุดรับงานเดียว: แท็บที่สองใน origin เดียวกันดูได้อย่างเดียวและเปิดรับสายไม่ได้', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'เจ้าของ Workspace' })).toHaveText('จุดรับงาน');

  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('status', { name: 'เจ้าของ Workspace' })).toHaveText(
    'ดูอย่างเดียว',
  );
  await expect(second.getByRole('button', { name: 'เปิดรับสาย' })).toBeDisabled();
  await expect(page.getByRole('status', { name: 'เจ้าของ Workspace' })).toHaveText('จุดรับงาน');
});
