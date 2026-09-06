import { expect, test } from '@playwright/test';

test('Agent ส่ง disposition จาก WRAPUP และรอ authoritative snapshot', async ({ page }) => {
  let completed = false;
  let requestBody: Record<string, unknown> | undefined;
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        agent: {
          id: 'agent-1000',
          displayName: 'สมชาย ใจดี',
          extension: '1000',
          state: completed ? 'AVAILABLE' : 'ACW',
        },
        interaction: completed
          ? null
          : {
              id: '9a8a5477-aa53-4254-ae68-a21ab64cc2bb',
              state: 'WRAPUP',
              version: '19',
              caller: '081-234-5678',
              queue: { id: 'queue-service', name: 'บริการลูกค้า' },
              offerExpiresAt: null,
              answeredAt: '2026-09-06T10:00:00.000Z',
              endedAt: '2026-09-06T10:03:00.000Z',
            },
      }),
    }),
  );
  await page.route('**/wrapup', async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 100));
    completed = true;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        interactionId: '9a8a5477-aa53-4254-ae68-a21ab64cc2bb',
        state: 'COMPLETED',
        disposition: 'CUSTOMER_ASSISTED',
      }),
    });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'สรุปผลหลังสาย' })).toBeVisible();
  await page.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' }).click();
  await page.getByRole('button', { name: 'ส่ง disposition' }).click();
  await expect(page.getByText('กำลังรอ server ยืนยัน')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'สรุปผลหลังสาย' })).toHaveCount(0);
  expect(requestBody).toMatchObject({ disposition: 'CUSTOMER_ASSISTED' });
  expect(requestBody?.commandId).toEqual(expect.any(String));
});
