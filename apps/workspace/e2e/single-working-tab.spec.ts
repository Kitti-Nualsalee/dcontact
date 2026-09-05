import { expect, test } from '@playwright/test';

test('Agent มี working tab เดียวและย้าย ownership ได้โดยไม่เปิดรับงานสองแท็บ', async ({
  context,
}) => {
  const first = await context.newPage();
  await first.goto('/');
  await expect(first.getByRole('status', { name: 'เจ้าของ Workspace' })).toHaveText('แท็บทำงาน');

  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('status', { name: 'เจ้าของ Workspace' })).toHaveText(
    'แท็บดูอย่างเดียว',
  );
  await expect(second.getByRole('button', { name: 'เปิดรับสาย' })).toBeDisabled();

  await second.getByRole('button', { name: 'ย้ายงานมาที่แท็บนี้' }).click();

  await expect(second.getByRole('status', { name: 'เจ้าของ Workspace' })).toHaveText('แท็บทำงาน');
  await expect(first.getByRole('status', { name: 'เจ้าของ Workspace' })).toHaveText(
    'แท็บดูอย่างเดียว',
  );
});
