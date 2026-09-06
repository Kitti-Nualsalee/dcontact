import { expect, test } from '@playwright/test';

test('Supervisor เห็น Team pulse แบบ risk-first จาก scoped snapshot', async ({ page }) => {
  await page.route('**/api/v1/workspace/supervisor/snapshot', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer e2e-access-token');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sequence: 41,
        agents: [
          {
            id: 'agent-1',
            displayName: 'สมชาย ใจดี',
            extension: '1000',
            teamId: 'team-a',
            state: 'BUSY',
          },
          {
            id: 'agent-2',
            displayName: 'สุดา รวดเร็ว',
            extension: '1001',
            teamId: 'team-a',
            state: 'ACW',
          },
        ],
        queues: [{ id: 'queue-1', name: 'บริการลูกค้า', teamId: 'team-a', isActive: false }],
        interactions: [
          { id: 'interaction-active', state: 'ACTIVE' },
          { id: 'interaction-wrapup', state: 'WRAPUP' },
        ],
        audit: [],
      }),
    });
  });

  await page.goto('/?view=supervisor');

  await expect(page.getByRole('heading', { name: 'Supervisor Workspace' })).toBeVisible();
  const risks = page.getByRole('list', { name: 'ความเสี่ยงที่ต้องจัดการ' }).getByRole('listitem');
  await expect(risks.first()).toContainText('Queue ปิดใช้งาน');
  await expect(page.getByText('บริการลูกค้า')).toBeVisible();
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await expect(page.getByText('สุดา รวดเร็ว')).toBeVisible();
  await expect(page.getByText('ลำดับข้อมูล 41')).toBeVisible();
  await expect(
    page.getByRole('article').filter({ hasText: 'Live interactions' }).getByRole('strong'),
  ).toHaveText('2');
});

test('Supervisor จอแคบเป็น read-only และไม่มี mutation controls', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.route('**/api/v1/workspace/supervisor/snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sequence: 1, agents: [], queues: [], interactions: [], audit: [] }),
    }),
  );

  await page.goto('/?view=supervisor');

  await expect(page.getByText('โหมดจอแคบ: ดูข้อมูลอย่างเดียว')).toBeVisible();
  await expect(page.getByRole('button', { name: /เปลี่ยนสถานะ|เปิด Queue|ปิด Queue/ })).toHaveCount(
    0,
  );
});
