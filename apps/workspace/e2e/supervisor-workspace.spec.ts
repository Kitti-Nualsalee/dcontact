import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

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
  // #604: Select ของ React Aria — เปิดด้วยปุ่มแล้วเลือกจาก listbox
  await page.getByRole('button', { name: /สถานะใหม่/ }).click();
  await page.getByRole('option', { name: 'พัก' }).click();
  await page.getByLabel('เหตุผล').fill('พักตามตาราง');
  await page.getByRole('button', { name: 'ยืนยันเปลี่ยนสถานะ' }).click();
  await expect(page.getByText('กำลังรอ server ยืนยัน')).toBeVisible();
  await expect(page.getByText('server ยืนยันสถานะล่าสุดแล้ว')).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'สุดา รวดเร็ว' }).getByText('พัก'),
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

/**
 * #604: Supervisor ใน shell ใหม่ — rail ชุดเดียว, axe, keyboard ของ dialog ยืนยัน และสลับภาษาไม่ reload
 */
const snapshot = {
  sequence: 7,
  agents: [
    {
      id: 'agent-2',
      displayName: 'สุดา รวดเร็ว',
      extension: '1001',
      teamId: 'team-a',
      state: 'AVAILABLE',
    },
  ],
  queues: [{ id: 'queue-1', name: 'บริการลูกค้า', teamId: 'team-a', isActive: true }],
  interactions: [],
  audit: [],
};

async function openInShell(page: Page, shellV2 = true) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({
      status: 200,
      json: {
        groups: [{ id: 'live', labelKey: 'navigation.groups.live' }],
        apps: [
          {
            id: 'agent-workspace',
            groupId: 'live',
            labelKey: 'navigation.apps.agentWorkspace',
            hostApp: 'workspace',
            path: '/',
          },
          {
            id: 'supervisor-workspace',
            groupId: 'live',
            labelKey: 'navigation.apps.supervisorWorkspace',
            hostApp: 'workspace',
            path: '/?view=supervisor',
          },
        ],
        pins: {
          appIds: ['agent-workspace', 'supervisor-workspace'],
          source: 'SYSTEM',
          revision: 0,
        },
        limits: { maxPins: 15 },
        features: { shellV2 },
      },
    }),
  );
  await page.route('**/api/v1/workspace/supervisor/snapshot', (route) =>
    route.fulfill({ status: 200, json: snapshot }),
  );
  await page.goto('/?view=supervisor&tenant=demo');
  await expect(page.getByRole('heading', { name: 'Supervisor Workspace' })).toBeVisible();
}

async function seriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`);
}

test('#604 flag เปิด: rail ของ shell ชุดเดียว ไม่มี rail/แถบบน/ปุ่มออกจากระบบเดิม', async ({
  page,
}) => {
  await openInShell(page);
  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'พื้นที่หลัก' })).toHaveCount(0);
  await expect(page.getByText('Supervisor live control')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toHaveCount(0);
  await expect(page.getByText('ลำดับข้อมูล 7')).toBeVisible();
});

test('#604 flag ปิด: คง rail และแถบบนเดิม', async ({ page }) => {
  await openInShell(page, false);
  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'พื้นที่หลัก' })).toBeVisible();
  await expect(page.getByText('Supervisor live control')).toBeVisible();
});

for (const locale of ['th-TH', 'en-GB'] as const) {
  test.describe(`axe (${locale})`, () => {
    test.use({ locale });
    test(`#604 axe 0 serious/critical ทั้งหน้าและตอนเปิด dialog ยืนยัน (${locale})`, async ({
      page,
    }) => {
      await openInShell(page);
      expect(await seriousViolations(page)).toEqual([]);
      await page.getByRole('button', { name: /สุดา รวดเร็ว/ }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
  });
}

test('#604 keyboard: Esc ปิด dialog แล้ว focus กลับปุ่มที่เปิด และไม่ส่งคำสั่ง', async ({
  page,
}) => {
  let commands = 0;
  await page.route('**/api/v1/workspace/supervisor/queues/**', (route) => {
    commands += 1;
    return route.fulfill({ status: 200, json: {} });
  });
  await openInShell(page);
  const trigger = page.getByRole('button', { name: 'ปิด Queue บริการลูกค้า' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'ปิด Queue บริการลูกค้า' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'ยืนยันปิด Queue' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(commands).toBe(0);
});

test('#604 สลับ TH/EN ใน shell ไม่ reload และข้อความ Supervisor เปลี่ยนตาม', async ({ page }) => {
  await openInShell(page);
  const before = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByText('Agents in scope')).toBeVisible();
  await expect(page.getByText('Available', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ไทย' }).click();
  await expect(page.getByText('Agents ใน scope')).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
});
