import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #813: Agent Workspace ใน shell (`ui.shell.v2`) เป็นสามคอลัมน์ตามดีไซน์ A · Workspace
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

test('ไม่มีงาน → สามคอลัมน์เรียงซ้ายไปขวา มี empty state และไม่มีแผงลูกค้า', async ({ page }) => {
  await open(page, null);
  await expect(work(page)).toContainText('ยังไม่มีงานในมือ');
  await expect(current(page)).toContainText('ไม่มีสายที่กำลังทำ');
  await expect(readiness(page).getByRole('heading', { name: 'เตรียมอุปกรณ์เสียง' })).toBeVisible();
  await expect(page.getByRole('region', { name: /ลูกค้า|Customer/ })).toHaveCount(0);

  const [left, middle, right] = await Promise.all(
    [work(page), current(page), readiness(page)].map((region) => region.boundingBox()),
  );
  expect(left!.x).toBeLessThan(middle!.x);
  expect(middle!.x).toBeLessThan(right!.x);
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-th-idle');
});

test('ระหว่างสาย → งานอยู่ในรายการและหัวงาน, เวลาในสายเดิน, ไทม์ไลน์แสดงการรับสาย', async ({
  page,
}) => {
  await open(page, call({}), 'BUSY');
  await expect(work(page).getByRole('listitem')).toContainText('081-234-5678');
  await expect(work(page).getByRole('listitem')).toContainText('กำลังสนทนา · บริการลูกค้า');
  await expect(current(page)).toContainText('สายเข้า · บริการลูกค้า · ควบคุมสายที่ dphone');
  const timer = current(page).getByRole('timer');
  await expect(timer).toHaveText(/เวลาในสาย 0[1-9]:\d\d/);
  const first = await timer.textContent();
  await expect(timer).not.toHaveText(first!);

  await expect(current(page).getByRole('tab', { name: 'ภาพรวม' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(current(page).getByRole('listitem').filter({ hasText: 'รับสาย' })).toBeVisible();
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-th-call');
});

test('WRAPUP → เลือกแท็บสรุปผลหลังสายให้เอง และสลับกลับภาพรวมได้', async ({ page }) => {
  await open(
    page,
    call({ state: 'WRAPUP', endedAt: new Date(Date.now() - 5_000).toISOString() }),
    'ACW',
  );
  const tab = current(page).getByRole('tab', { name: 'สรุปผลหลังสาย' });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(current(page).getByRole('heading', { name: 'สรุปผลหลังสาย' })).toBeVisible();
  await expect(current(page).getByRole('timer')).toHaveText(/เวลาในสาย 01:3\d/);
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-th-wrapup');

  await current(page).getByRole('tab', { name: 'ภาพรวม' }).click();
  await expect(current(page).getByRole('listitem').filter({ hasText: 'สายจบ' })).toBeVisible();
  await current(page).getByRole('tab', { name: 'ล่าสุด' }).click();
  await expect(current(page)).toContainText('ยังไม่มีผลสรุปที่บันทึกในรอบนี้');
});

test('EN → ข้อความของสามคอลัมน์เปลี่ยนตามภาษาโดยไม่ reload', async ({ page }) => {
  await open(page, call({}), 'BUSY');
  const before = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(work(page).getByRole('heading', { name: 'My work' })).toBeVisible();
  await expect(current(page)).toContainText('Inbound · บริการลูกค้า · Call controls in dphone');
  await expect(current(page).getByRole('timer')).toHaveText(/Call time \d\d:\d\d/);
  await expect(readiness(page).getByRole('heading', { name: 'Readiness' })).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-en-call');
});

test('จอแคบกว่า 1280px → เรียงเป็นคอลัมน์เดียว', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await open(page, call({}), 'BUSY');
  const [left, middle, right] = await Promise.all(
    [work(page), current(page), readiness(page)].map((region) => region.boundingBox()),
  );
  expect(middle!.x).toBe(left!.x);
  expect(right!.x).toBe(left!.x);
  expect(left!.y).toBeLessThan(middle!.y);
  expect(middle!.y).toBeLessThan(right!.y);
});
