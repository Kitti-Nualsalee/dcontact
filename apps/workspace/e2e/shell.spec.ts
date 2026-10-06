import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * D1.13 (#452): flag `ui.shell.v2` ของ Workspace — shell ตัดสินก่อน mount WorkspaceApp
 * และสลับภาษาใน shell ต้องไม่ remount WorkspaceApp (ADR-026: ห้ามตัดสาย/WS)
 */
test.use({ locale: 'th-TH' });

function navigation(shellV2: boolean) {
  return {
    groups: [
      { id: 'live', labelKey: 'navigation.groups.live' },
      { id: 'automation', labelKey: 'navigation.groups.automation' },
    ],
    apps: [
      {
        id: 'agent-workspace',
        groupId: 'live',
        labelKey: 'navigation.apps.agentWorkspace',
        hostApp: 'workspace',
        path: '/',
      },
      {
        id: 'journeys',
        groupId: 'automation',
        labelKey: 'navigation.apps.journeys',
        hostApp: 'console',
        path: '/?view=journeys',
      },
    ],
    pins: { appIds: ['agent-workspace', 'journeys'], source: 'TENANT', revision: 0 },
    limits: { maxPins: 15 },
    features: { shellV2 },
  };
}

async function mockApis(page: Page, shellV2: boolean) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation(shellV2) }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: {
          id: 'agent-1000',
          displayName: 'สมชาย ใจดี',
          extension: '1000',
          state: 'AVAILABLE',
        },
        interaction: null,
      },
    }),
  );
}

const rail = (page: Page) => page.getByRole('navigation', { name: /เมนูหลัก|Main navigation/ });

test('flag ปิด → Workspace เดิมไม่มี rail', async ({ page }) => {
  await mockApis(page, false);
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
});

test('flag เปิด → rail ไม่มี SubNav, Journeys เปิดแท็บใหม่ไป Console และ axe ของ shell ผ่าน', async ({
  page,
}) => {
  await mockApis(page, true);
  await page.goto('/?tenant=demo');
  await expect(rail(page)).toBeVisible();
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(2); // rail + breadcrumb (ไม่มี SubNav)
  const journeys = rail(page).getByRole('link', { name: /Journeys/ });
  await expect(journeys).toHaveAttribute(
    'href',
    'http://localhost:5174/?view=journeys&tenant=demo',
  );
  await expect(journeys).toHaveAttribute('target', '_blank');
  await expect(rail(page).getByRole('link', { name: 'กล่องงาน' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const axe = await new AxeBuilder({ page }).include('nav').include('header').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
});

test('flag เปิด → สลับภาษาไม่ reload และไม่ remount WorkspaceApp', async ({ page }) => {
  await mockApis(page, true);
  await page.goto('/?tenant=demo');
  const agentName = page.getByText('สมชาย ใจดี');
  await expect(agentName).toBeVisible();
  const before = await page.evaluate(() => performance.timeOrigin);
  // marker บน DOM node ของ WorkspaceApp — ถ้า remount node ใหม่จะไม่มี marker
  await agentName.evaluate(
    (el) => ((el as HTMLElement & { __d113?: string }).__d113 = 'same-node'),
  );

  await page.getByRole('button', { name: 'English' }).click();
  await expect(rail(page).getByRole('link', { name: 'Inbox' })).toBeVisible();
  await page.getByRole('button', { name: 'ไทย' }).click();
  await expect(rail(page).getByRole('link', { name: 'กล่องงาน' })).toBeVisible();

  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
  expect(await agentName.evaluate((el) => (el as HTMLElement & { __d113?: string }).__d113)).toBe(
    'same-node',
  );
});

/**
 * #588: เมนูผู้ใช้ — ผู้ใช้จำลองของ harness คือ "ผู้ทดสอบ เวิร์กสเปซ" (agent) และนับการออกใน `__signOuts`
 */
const userMenu = (page: Page) =>
  page.getByRole('button', { name: 'เมนูผู้ใช้ ผู้ทดสอบ เวิร์กสเปซ' });
const signOuts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __signOuts?: number }).__signOuts ?? 0);

test('flag ปิด → ไม่มีเมนูผู้ใช้ และปุ่มออกจากระบบเดิมอยู่ที่แถบสถานะ', async ({ page }) => {
  await mockApis(page, false);
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await expect(userMenu(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible();
});

test('flag เปิด → เมนูผู้ใช้แสดงชื่อ/องค์กร/บทบาท, ไม่มีปุ่มออกซ้ำ และไม่มีสายก็ออกได้ทันที', async ({
  page,
}) => {
  await mockApis(page, true);
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  // ปุ่มเดิมในแถบสถานะถูกซ่อน — ออกจากระบบที่เมนูผู้ใช้ที่เดียว
  await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toHaveCount(0);
  await userMenu(page).click();
  await expect(page.getByRole('menu')).toHaveAccessibleName(
    /ผู้ทดสอบ เวิร์กสเปซ.*workspace-e2e@demo\.example.*องค์กร demo.*เอเจนต์/,
  );
  // AC5 (#598): "บัญชีของฉัน" เปิด Console ในแท็บใหม่ — Workspace ไม่ remount ระหว่างมีสาย (ADR-026)
  const account = page.getByRole('menuitem', { name: 'บัญชีของฉัน' });
  await expect(account).toHaveAttribute('href', 'http://localhost:5174/?tenant=demo&view=account');
  await expect(account).toHaveAttribute('target', '_blank');
  await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await signOuts(page)).toBe(1);
});

test('flag เปิด → มี wrap-up ที่ยังไม่บันทึก ต้องยืนยันก่อนออก และยกเลิกแล้ว wrap-up ยังอยู่', async ({
  page,
}) => {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation(true) }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: { id: 'agent-1000', displayName: 'สมชาย ใจดี', extension: '1000', state: 'ACW' },
        interaction: {
          id: '9a8a5477-aa53-4254-ae68-a21ab64cc2bb',
          state: 'WRAPUP',
          version: '19',
          caller: '081-234-5678',
          queue: { id: 'queue-service', name: 'บริการลูกค้า' },
          offerExpiresAt: null,
          answeredAt: '2026-09-06T10:00:00.000Z',
          endedAt: '2026-09-06T10:03:00.000Z',
        },
      },
    }),
  );
  await page.goto('/?tenant=demo');
  const wrapup = page.getByRole('heading', { name: 'สรุปผลหลังสาย' });
  await expect(wrapup).toBeVisible();

  await userMenu(page).click();
  await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'ออกจากระบบทั้งที่ยังมีงานค้าง?' });
  await expect(dialog).toContainText('wrap-up ที่ยังไม่บันทึกจะหายไป');
  await dialog.getByRole('button', { name: 'ยกเลิก' }).click();
  await expect(dialog).toBeHidden();
  await expect(wrapup).toBeVisible();
  expect(await signOuts(page)).toBe(0);
});

test('#588: มีสายถูก offer มา (ASSIGNED) แม้ dphone ยังไม่ดัง ต้องยืนยันก่อนออก', async ({
  page,
}) => {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation(true) }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: {
          id: 'agent-1000',
          displayName: 'สมชาย ใจดี',
          extension: '1000',
          state: 'RESERVED',
        },
        interaction: {
          id: 'interaction-offer-2',
          state: 'ASSIGNED',
          version: '3',
          caller: '081-234-5678',
          queue: { id: 'queue-service', name: 'บริการลูกค้า' },
          offerExpiresAt: '2099-01-01T00:00:20.000Z',
          answeredAt: null,
          endedAt: null,
        },
      },
    }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await userMenu(page).click();
  await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click();
  await expect(
    page.getByRole('alertdialog', { name: 'ออกจากระบบทั้งที่ยังมีงานค้าง?' }),
  ).toBeVisible();
  expect(await signOuts(page)).toBe(0);
});
