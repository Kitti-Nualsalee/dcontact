import { expect, test } from '@playwright/test';

test('Workspace แสดง incoming offer จาก authoritative Agent snapshot', async ({ page }) => {
  await page.route('**/api/v1/workspace/agent/snapshot', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer e2e-access-token');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        agent: {
          id: 'agent-1000',
          displayName: 'สมชาย ใจดี',
          extension: '1000',
          state: 'RESERVED',
        },
        interaction: {
          id: 'interaction-offer-1',
          state: 'ASSIGNED',
          version: '17',
          caller: '081-234-5678',
          queue: { id: 'queue-service', name: 'บริการลูกค้า' },
          offerExpiresAt: '2026-09-06T10:00:20.000Z',
          answeredAt: null,
          endedAt: null,
        },
      }),
    });
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'สายเรียกเข้า' })).toBeVisible();
  await expect(page.getByText('081-234-5678')).toBeVisible();
  await expect(page.getByText('บริการลูกค้า')).toBeVisible();
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await expect(page.getByText('Interaction v17')).toBeVisible();
});
