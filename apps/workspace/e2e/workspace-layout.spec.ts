import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Agent Workspace ใน shell (`ui.shell.v2`) ตามแบบ V3 (mockups/d-contact-agent-workspace-v3.html):
 * รายการงาน · งานปัจจุบัน (แถบสาย + แท็บ Voice) · แผงงาน (สรุปผล/รายละเอียด/เหตุการณ์/ความพร้อม) · แถบเครื่องมือ
 * ด้วยข้อมูล Voice จาก snapshot เท่านั้น — ไม่มีแผงลูกค้า placeholder (Cus360 C5 #795)
 * `D813_EVIDENCE_DIR=<dir>` = เก็บภาพหลักฐานสำหรับ PR
 */
test.use({ locale: 'th-TH', viewport: { width: 1440, height: 900 } });

type Interaction = Record<string, unknown> | null;

const navigation = {
  groups: [{ id: 'live', labelKey: 'navigation.groups.live' }],
  apps: [
    {
      id: 'agent-workspace',
      groupId: 'live',
      labelKey: 'navigation.apps.agentWorkspace',
      hostApp: 'workspace',
      path: '/',
    },
  ],
  areas: [
    {
      id: 'workspace',
      labelKey: 'navigation.areas.workspace',
      sections: [
        { id: 'work', labelKey: 'navigation.sections.work', items: [{ appId: 'agent-workspace' }] },
      ],
    },
  ],
  pins: { appIds: ['agent-workspace'], source: 'TENANT', revision: 0 },
  limits: { maxPins: 15 },
  features: { shellV2: true },
};

async function open(page: Page, interaction: Interaction, agentState = 'AVAILABLE') {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: {
          id: 'agent-1000',
          displayName: 'สมชาย ใจดี',
          extension: '1000',
          state: agentState,
        },
        interaction,
      },
    }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
}

const call = (overrides: Record<string, unknown>) => ({
  id: '3f0c6c55-9a3e-4a51-9f53-0d7d1d3b8a21',
  state: 'ACTIVE',
  direction: 'INBOUND',
  version: '7',
  caller: '081-234-5678',
  queue: { id: 'queue-service', name: 'บริการลูกค้า' },
  offerExpiresAt: null,
  answeredAt: new Date(Date.now() - 95_000).toISOString(),
  endedAt: null,
  ...overrides,
});

const work = (page: Page) => page.getByRole('region', { name: /^(งานของฉัน|My work)$/ });
const current = (page: Page) => page.getByRole('region', { name: /^(งานปัจจุบัน|Current work)$/ });
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: /^(แผงรายละเอียดงาน|Work detail panel)$/ });
const readiness = (page: Page) =>
  page.getByRole('region', { name: /^(ความพร้อมรับงาน|Readiness)$/ });

async function evidence(page: Page, name: string) {
  const dir = process.env.D813_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

async function expectNoSeriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
}

test('ไม่มีงาน → รายการ · งานปัจจุบัน · แผงงานเรียงซ้ายไปขวา และแผงงานเปิดที่ความพร้อม', async ({
  page,
}) => {
  await open(page, null);
  await expect(work(page)).toContainText('ยังไม่มีงานในมือ');
  await expect(current(page)).toContainText('ไม่มีสายที่กำลังทำ');
  await expect(inspector(page).getByRole('tab', { name: 'ความพร้อม' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(readiness(page).getByRole('heading', { name: 'เตรียมอุปกรณ์เสียง' })).toBeVisible();
  await expect(page.getByRole('region', { name: /ลูกค้า|Customer/ })).toHaveCount(0);

  const [left, middle, right] = await Promise.all(
    [work(page), current(page), inspector(page)].map((region) => region.boundingBox()),
  );
  expect(left!.x).toBeLessThan(middle!.x);
  expect(middle!.x).toBeLessThan(right!.x);
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-th-idle');
});

test('ระหว่างสาย → งานอยู่ในรายการและแถบสาย, เวลาในสายเดิน, เหตุการณ์แสดงการรับสาย', async ({
  page,
}) => {
  await open(page, call({}), 'BUSY');
  await expect(work(page).getByRole('listitem')).toContainText('081-234-5678');
  await expect(work(page).getByRole('listitem')).toContainText('กำลังสนทนา · บริการลูกค้า');
  await expect(work(page).getByRole('tab', { name: 'เปิดอยู่ (1)' })).toBeVisible();
  await expect(current(page)).toContainText('สายเข้า · บริการลูกค้า · ควบคุมสายที่ dphone');
  const timer = current(page).getByRole('timer');
  await expect(timer).toHaveText(/เวลาในสาย 0[1-9]:\d\d/);
  const first = await timer.textContent();
  await expect(timer).not.toHaveText(first!);

  // ไม่มีความสามารถ Cus360 ใน snapshot → มีเฉพาะแท็บ Voice ไม่มีแท็บลูกค้าว่าง
  await expect(current(page).getByRole('tab', { name: 'Voice' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(current(page).getByRole('tab', { name: 'Customer 360' })).toHaveCount(0);
  // เปิดหน้าใหม่ระหว่างสาย อุปกรณ์เสียงยังไม่ได้ตรวจ → แผงงานเปิดที่ความพร้อมให้ตรวจก่อน
  await expect(inspector(page).getByRole('tab', { name: 'ความพร้อม' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await inspector(page).getByRole('tab', { name: 'รายละเอียด' }).click();
  await expect(inspector(page).getByRole('heading', { name: 'สถานะปัจจุบัน' })).toBeVisible();
  await inspector(page).getByRole('tab', { name: 'เหตุการณ์' }).click();
  await expect(inspector(page).getByRole('listitem').filter({ hasText: 'รับสาย' })).toBeVisible();
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-th-call');
});

test('WRAPUP → แผงงานเปิดแท็บสรุปผลให้เอง และสลับไปดูเหตุการณ์ได้', async ({ page }) => {
  await open(
    page,
    call({ state: 'WRAPUP', endedAt: new Date(Date.now() - 5_000).toISOString() }),
    'ACW',
  );
  const tab = inspector(page).getByRole('tab', { name: 'สรุปผล' });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(inspector(page).getByRole('heading', { name: 'สรุปผลหลังสาย' })).toBeVisible();
  await expect(current(page).getByRole('timer')).toHaveText(/เวลาในสาย 01:3\d/);
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-th-wrapup');

  await inspector(page).getByRole('tab', { name: 'เหตุการณ์' }).click();
  await expect(inspector(page).getByRole('listitem').filter({ hasText: 'สายจบ' })).toBeVisible();
  await work(page).getByRole('tab', { name: 'ปิดแล้ว (0)' }).click();
  await expect(work(page)).toContainText('ยังไม่มีงานที่ปิดในรอบนี้');
});

test('EN → ข้อความของทุกแผงเปลี่ยนตามภาษาโดยไม่ reload', async ({ page }) => {
  await open(page, call({}), 'BUSY');
  const before = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(work(page).getByRole('heading', { name: 'My work' })).toBeVisible();
  await expect(current(page)).toContainText('Inbound · บริการลูกค้า · Call controls in dphone');
  await expect(current(page).getByRole('timer')).toHaveText(/Call time \d\d:\d\d/);
  await inspector(page).getByRole('tab', { name: 'Readiness' }).click();
  await expect(
    readiness(page).getByRole('heading', { name: 'Prepare audio device' }),
  ).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-en-call');
});

test('ปิด/เปิดแผงงานจากแถบเครื่องมือ และปรับความกว้างรายการด้วยคีย์บอร์ด', async ({ page }) => {
  await open(page, call({}), 'BUSY');
  const tools = page.getByRole('toolbar', { name: 'เครื่องมือด้านขวา' });
  await tools.getByRole('button', { name: 'ปิดแผงรายละเอียด' }).click();
  await expect(inspector(page)).toHaveCount(0);
  await tools.getByRole('button', { name: 'เหตุการณ์' }).click();
  await expect(inspector(page).getByRole('tab', { name: 'เหตุการณ์' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const separator = page.getByRole('separator', { name: 'ปรับความกว้างรายการงาน' });
  const before = (await work(page).boundingBox())!.width;
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '276');
  expect((await work(page).boundingBox())!.width).toBeGreaterThan(before);
  await separator.dblclick();
  await expect(separator).toHaveAttribute('aria-valuenow', '260');
});

test('จอแคบกว่า 1200px → เรียงแผงจากบนลงล่าง', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await open(page, call({}), 'BUSY');
  const [left, middle, right] = await Promise.all(
    [work(page), current(page), inspector(page)].map((region) => region.boundingBox()),
  );
  expect(middle!.x).toBe(left!.x);
  expect(right!.x).toBe(left!.x);
  expect(left!.y).toBeLessThan(middle!.y);
  expect(middle!.y).toBeLessThan(right!.y);
  await expect(page.getByRole('separator')).toHaveCount(0);
});
