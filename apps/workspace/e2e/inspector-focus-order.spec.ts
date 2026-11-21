import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * ลำดับคีย์บอร์ดของแผงงานด้านขวาตาม docs/ui-principles.md ข้อ 2 (ลำดับ Tab ตามลำดับการอ่าน)
 * แผงงาน: หัวแผง → แถบแท็บ (Tab ครั้งเดียว) → เนื้อหาแท็บ
 * แถบเครื่องมือด้านขวา: Tab เข้าได้จุดเดียวแล้ว Tab ถัดไปออกจากแถบ ปุ่มภายในใช้ลูกศรขึ้น/ลง Home/End
 */
test.use({ locale: 'th-TH', viewport: { width: 1440, height: 900 } });

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

async function openWrapup(page: Page) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: { id: 'agent-1000', displayName: 'สมชาย ใจดี', extension: '1000', state: 'ACW' },
        interaction: {
          id: '3f0c6c55-9a3e-4a51-9f53-0d7d1d3b8a21',
          state: 'WRAPUP',
          direction: 'INBOUND',
          version: '7',
          caller: '081-234-5678',
          queue: { id: 'queue-service', name: 'บริการลูกค้า' },
          offerExpiresAt: null,
          answeredAt: new Date(Date.now() - 95_000).toISOString(),
          endedAt: new Date(Date.now() - 5_000).toISOString(),
        },
      },
    }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
}

const inspector = (page: Page) => page.getByRole('complementary', { name: 'แผงรายละเอียดงาน' });
const tools = (page: Page) => page.getByRole('toolbar', { name: 'เครื่องมือด้านขวา' });

/** ส่วนของหน้าที่ focus อยู่ตอนนี้ */
function focusedZone(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'outside';
    if (el.closest('.aw-v3-inspector-head')) return 'head';
    if (el.closest('.aw-v3-inspector [role="tablist"]')) return 'tabs';
    if (el.closest('.aw-v3-inspector [role="tabpanel"]')) return 'panel';
    if (el.closest('[role="toolbar"]')) return 'toolbar';
    return 'outside';
  });
}

test('Tab ในแผงงาน: หัวแผง → แถบแท็บ → เนื้อหา แล้วข้ามแถบเครื่องมือด้วย Tab ครั้งเดียว', async ({
  page,
}) => {
  await openWrapup(page);
  await expect(inspector(page).getByRole('tab', { name: 'สรุปผล' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await inspector(page).getByRole('button', { name: 'ปิดแผงรายละเอียด' }).focus();
  const zones = [await focusedZone(page)];
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    const zone = await focusedZone(page);
    zones.push(zone);
    if (zone === 'outside') break;
  }
  // ยุบจุดที่อยู่ในส่วนเดียวกันติดกัน แต่นับจำนวนจุดในแถบแท็บและแถบเครื่องมือ
  const order = zones.filter((zone, i) => zone !== zones[i - 1]);
  expect(order).toEqual(['head', 'tabs', 'panel', 'toolbar', 'outside']);
  expect(zones.filter((zone) => zone === 'tabs')).toHaveLength(1);
  expect(zones.filter((zone) => zone === 'toolbar')).toHaveLength(1);

  // Shift+Tab ย้อนกลับเข้าแถบเครื่องมือจุดเดียว แล้วกลับเข้าเนื้อหาแท็บ
  await page.keyboard.press('Shift+Tab');
  expect(await focusedZone(page)).toBe('toolbar');
  await page.keyboard.press('Shift+Tab');
  expect(await focusedZone(page)).toBe('panel');
});

test('แถบเครื่องมือด้านขวา: จุดที่ Tab เข้าคือแท็บที่เปิดอยู่ ลูกศรย้ายในแถบ และ Enter สลับแท็บ', async ({
  page,
}) => {
  await openWrapup(page);
  const bar = tools(page);
  const wrapup = bar.getByRole('button', { name: 'สรุปผล' });
  const events = bar.getByRole('button', { name: 'เหตุการณ์' });
  const readiness = bar.getByRole('button', { name: 'ความพร้อม' });
  const toggle = bar.getByRole('button', { name: 'ปิดแผงรายละเอียด' });

  // roving tabindex: มีปุ่มเดียวใน Tab order และเป็นแท็บที่เปิดอยู่
  await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);
  await expect(wrapup).toHaveAttribute('tabindex', '0');

  // ปุ่มเรียง: เปิด/ปิดแผง, สรุปผล, ... (แท็บอื่นเพิ่มได้ตามความสามารถ เช่น เคส), เหตุการณ์, ความพร้อม
  await expect(bar.getByRole('button').nth(1)).toHaveAccessibleName('สรุปผล');
  await wrapup.focus();
  await page.keyboard.press('ArrowDown');
  await expect(bar.getByRole('button').nth(2)).toBeFocused();
  await page.keyboard.press('End');
  await expect(readiness).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(readiness).toBeFocused();
  await page.keyboard.press('Home');
  await expect(toggle).toBeFocused();

  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await expect(events).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(inspector(page).getByRole('tab', { name: 'เหตุการณ์' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(events).toHaveAttribute('aria-pressed', 'true');
  await expect(events).toBeFocused();
  await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);

  // ปิดแผงด้วยปุ่มแรกแล้ว focus ยังอยู่ในแถบ เปิดกลับได้ด้วยปุ่มเดิม
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(inspector(page)).toHaveCount(0);
  const reopen = bar.getByRole('button', { name: 'เปิดแผงรายละเอียด' });
  await expect(reopen).toBeFocused();
  await page.keyboard.press('Space');
  await expect(inspector(page)).toBeVisible();
});
