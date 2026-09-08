import { expect, test } from '@playwright/test';

test('Supervisor เห็น Team pulse และ mutation สำเร็จหลัง authoritative snapshot เท่านั้น', async ({
  page,
}) => {
  let agentState: 'AVAILABLE' | 'BREAK' = 'AVAILABLE';
  let queueActive = false;
  let agentCommand: Record<string, unknown> | undefined;
  let queueCommand: Record<string, unknown> | undefined;
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
            state: agentState,
          },
        ],
        queues: [{ id: 'queue-1', name: 'บริการลูกค้า', teamId: 'team-a', isActive: queueActive }],
        interactions: [
          { id: 'interaction-active', state: 'ACTIVE', agentId: 'agent-1', queueId: 'queue-1' },
          { id: 'interaction-wrapup', state: 'WRAPUP', agentId: 'agent-1', queueId: 'queue-1' },
        ],
        audit: [],
      }),
    });
  });
  await page.route('**/api/v1/workspace/supervisor/agents/agent-2/state', async (route) => {
    agentCommand = route.request().postDataJSON() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 100));
    agentState = 'BREAK';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agentId: 'agent-2', state: 'BREAK', reason: 'พักตามตาราง' }),
    });
  });
  await page.route('**/api/v1/workspace/supervisor/queues/queue-1/availability', async (route) => {
    queueCommand = route.request().postDataJSON() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 100));
    queueActive = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'queue-1', isActive: true }),
    });
  });

  await page.goto('/?view=supervisor');

  await expect(page.getByRole('heading', { name: 'Supervisor Workspace' })).toBeVisible();
  const risks = page.getByRole('list', { name: 'ความเสี่ยงที่ต้องจัดการ' }).getByRole('listitem');
  await expect(risks.first()).toContainText('Queue ปิดใช้งาน');
  await expect(risks.first()).toContainText('บริการลูกค้า');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await expect(page.getByText('สุดา รวดเร็ว')).toBeVisible();
  await expect(page.getByText('ลำดับข้อมูล 41')).toBeVisible();
  await expect(
    page.getByRole('article').filter({ hasText: 'Live interactions' }).getByRole('strong'),
  ).toHaveText('2');

  await page.getByRole('button', { name: 'เปลี่ยนสถานะ สุดา รวดเร็ว' }).click();
  await page.getByLabel('สถานะใหม่').selectOption('BREAK');
  await page.getByLabel('เหตุผล').fill('พักตามตาราง');
  await page.getByRole('button', { name: 'ยืนยันเปลี่ยนสถานะ' }).click();
  await expect(page.getByText('กำลังรอ server ยืนยัน')).toBeVisible();
  await expect(page.getByText('server ยืนยันสถานะล่าสุดแล้ว')).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'สุดา รวดเร็ว' }).getByText('BREAK'),
  ).toBeVisible();
  expect(agentCommand).toMatchObject({ state: 'BREAK', reason: 'พักตามตาราง' });
  expect(agentCommand?.commandId).toEqual(expect.any(String));

  await page.getByRole('button', { name: 'เปิด Queue บริการลูกค้า' }).click();
  await page.getByLabel('เหตุผล').fill('เปิดรองรับสายเพิ่ม');
  await page.getByRole('button', { name: 'ยืนยันเปิด Queue' }).click();
  await expect(page.getByText('กำลังรอ server ยืนยัน')).toBeVisible();
  await expect(page.getByText('server ยืนยันสถานะล่าสุดแล้ว')).toBeVisible();
  expect(queueCommand).toMatchObject({ isActive: true, reason: 'เปิดรองรับสายเพิ่ม' });
  expect(queueCommand?.commandId).toEqual(expect.any(String));
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
