import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * D1.15 (#454): dphone widget ใน Agent Workspace (flag ui.shell.v2 เปิด) บน transport จำลอง
 *
 * หลักฐานที่ตรวจทุกขั้น: SIP session ID (window.__dcontactDphone) และ performance.timeOrigin ไม่เปลี่ยน
 * ระหว่างย่อ/ขยาย/แยกหน้าต่าง/ดึงกลับ/สลับภาษา — สายจริงบน dev stack อยู่ใน acceptance ของ D1.16
 */
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
  pins: { appIds: ['agent-workspace'], source: 'SYSTEM', revision: 0 },
  limits: { maxPins: 15 },
  features: { shellV2: true },
};

const snapshot = {
  agent: { id: 'agent-1000', displayName: 'สมชาย ใจดี', extension: '1000', state: 'RESERVED' },
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
};

async function openWithCall(page: Page) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({ status: 200, json: snapshot }),
  );
  await page.route('**/api/v1/workspace/agent/sip-credentials', (route) =>
    route.fulfill({
      status: 200,
      json: {
        leaseId: 'e2e-lease',
        extension: '1000',
        authorizationUsername: '1000',
        authorizationPassword: 'e2e-only',
        sipDomain: 'e2e.invalid',
        wssUrl: 'wss://e2e.invalid',
        telephonyNodeId: 'fs-e2e',
        iceServers: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    }),
  );
  await page.goto('/?tenant=demo');
  const dphone = page.getByRole('region', { name: 'dphone' });
  await expect(dphone).toBeVisible();
  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('มีสายเรียกเข้า');
  await expect(dphone.getByText('081-234-5678')).toBeVisible();
  await dphone.getByRole('button', { name: 'รับสาย' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  return dphone;
}

const evidence = (page: Page) =>
  page.evaluate(() => ({
    sip: window.__dcontactDphone?.sipSessionId(),
    timeOrigin: performance.timeOrigin,
    navigations: performance.getEntriesByType('navigation').length,
  }));

test('flag เปิด: dphone ลอยแทนแผงควบคุมสาย และแผงสายเรียกเข้าเดิมไม่ซ้ำ', async ({ page }) => {
  const dphone = await openWithCall(page);
  await expect(page.getByRole('heading', { name: 'สายเรียกเข้า' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'ควบคุมสาย' })).toHaveCount(0);
  await expect(dphone.getByRole('button', { name: 'วางสาย' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'สถานะ dphone' })).toHaveText('กำลังสนทนา');
});

test('ย่อ/ขยาย 3 ขนาด และสลับภาษา: SIP session เดิม ไม่ reload และ DTMF ใช้ได้ในขนาดขยาย', async ({
  page,
}) => {
  const dphone = await openWithCall(page);
  const before = await evidence(page);
  expect(before.sip).toMatch(/[0-9a-f-]{36}/);

  await dphone.getByRole('button', { name: 'ย่อเป็นแถบ' }).click();
  await expect(dphone.getByRole('button', { name: 'ปิดไมค์' })).toHaveCount(0);
  await expect(dphone.getByRole('button', { name: 'วางสาย' })).toBeVisible();

  await dphone.getByRole('button', { name: 'ขยายพร้อมแป้นกด' }).click();
  await dphone.getByRole('button', { name: 'ส่ง DTMF 5' }).click();
  await dphone.getByRole('button', { name: 'ปิดไมค์' }).click();
  await expect(dphone.getByRole('button', { name: 'เปิดไมค์' })).toBeVisible();

  await page.getByRole('button', { name: 'English' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('On a call');
  await expect(dphone.getByRole('button', { name: 'Unmute' })).toBeVisible();
  await page.getByRole('button', { name: 'ไทย' }).click();

  await dphone.getByRole('button', { name: 'กะทัดรัด' }).click();
  await expect(dphone.getByRole('button', { name: 'ส่ง DTMF 5' })).toHaveCount(0);
  expect(await evidence(page)).toEqual(before);
});

test('แยกหน้าต่าง /dphone แล้วสั่งพักสายจากหน้าต่างแยก — session อยู่ที่ working tab และดึงกลับได้', async ({
  page,
  context,
}) => {
  const dphone = await openWithCall(page);
  const before = await evidence(page);

  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    dphone.getByRole('button', { name: 'แยก dphone เป็นหน้าต่าง' }).click(),
  ]);
  await expect(page.getByText('dphone เปิดอยู่ในหน้าต่างแยก')).toBeVisible();
  expect(new URL(popup.url()).pathname).toBe('/dphone');
  expect(new URL(popup.url()).searchParams.get('tenant')).toBe('demo');
  expect(new URL(popup.url()).searchParams.get('remote')).toMatch(/^[0-9a-f-]{36}$/);

  const remote = popup.getByRole('region', { name: 'dphone' });
  await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  await expect(remote.getByText('081-234-5678')).toBeVisible();
  await remote.getByRole('button', { name: 'พักสาย' }).click();
  await expect(page.getByRole('status', { name: 'สถานะ dphone' })).toHaveText('พักสาย');
  await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText('พักสาย');

  // สลับภาษาที่ Workspace → หน้าต่างแยกเปลี่ยนตาม
  await page.getByRole('button', { name: 'English' }).click();
  await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText('On hold');
  await page.getByRole('button', { name: 'ไทย' }).click();

  const axe = await new AxeBuilder({ page: popup }).analyze();
  expect(
    axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id),
  ).toEqual([]);

  const closed = popup.waitForEvent('close');
  await page.getByRole('button', { name: 'กลับมาที่ Workspace' }).click();
  await closed;
  await expect(
    page.getByRole('region', { name: 'dphone' }).getByRole('button', { name: 'กลับเข้าสาย' }),
  ).toBeVisible();
  expect(await evidence(page)).toEqual(before);
});

test('ปิดหน้าต่างแยกเอง → widget กลับมาที่ Workspace โดยสายยังอยู่', async ({ page, context }) => {
  const dphone = await openWithCall(page);
  const before = await evidence(page);
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    dphone.getByRole('button', { name: 'แยก dphone เป็นหน้าต่าง' }).click(),
  ]);
  await expect(popup.getByRole('region', { name: 'dphone' })).toBeVisible();
  await popup.close();
  await expect(
    page.getByRole('region', { name: 'dphone' }).getByRole('button', { name: 'วางสาย' }),
  ).toBeVisible();
  expect(await evidence(page)).toEqual(before);
});

test('/dphone เปิดตรงโดยไม่มี Workspace → บอกเหตุผลชัดเจน ไม่สร้าง session', async ({ page }) => {
  await page.goto('/dphone');
  await expect(page.getByRole('status')).toHaveText(/ไม่พบ Workspace ที่ทำงานอยู่/, {
    timeout: 6_000,
  });
  expect(await page.evaluate(() => window.__dcontactDphone)).toBeUndefined();
});

for (const language of ['th', 'en'] as const) {
  test(`axe (${language}): Agent Workspace ใน shell พร้อม dphone ทุกขนาด ไม่มี serious/critical`, async ({
    page,
  }) => {
    const dphone = await openWithCall(page);
    if (language === 'en') await page.getByRole('button', { name: 'English' }).click();
    const labels = {
      th: { bar: 'ย่อเป็นแถบ', compact: 'กะทัดรัด', expanded: 'ขยายพร้อมแป้นกด' },
      en: { bar: 'Minimize to bar', compact: 'Compact', expanded: 'Expand with keypad' },
    }[language];
    for (const size of ['bar', 'compact', 'expanded'] as const) {
      await dphone.getByRole('button', { name: labels[size] }).click();
      const result = await new AxeBuilder({ page }).analyze();
      expect(
        result.violations
          .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
          .map((v) => `${size}: ${v.id} ${v.nodes[0]?.target}`),
      ).toEqual([]);
    }
  });
}

test('หน้าต่าง /dphone ที่เปิดเอง (bookmark) ระหว่างมีสาย ไม่ทำให้ปุ่มคุมสายใน Workspace หายและสั่งสายไม่ได้', async ({
  page,
  context,
}) => {
  const dphone = await openWithCall(page);
  const before = await evidence(page);
  for (const path of ['/dphone', '/dphone?remote=not-ours']) {
    const stray = await context.newPage();
    await stray.goto(path);
    await expect(stray.getByRole('status')).toHaveText(/ไม่พบ Workspace ที่ทำงานอยู่/, {
      timeout: 6_000,
    });
    await expect(dphone.getByRole('button', { name: 'วางสาย' })).toBeVisible();
    await expect(page.getByText('dphone เปิดอยู่ในหน้าต่างแยก')).toHaveCount(0);
    await stray.close();
  }
  await expect(page.getByRole('status', { name: 'สถานะ dphone' })).toHaveText('กำลังสนทนา');
  expect(await evidence(page)).toEqual(before);
});
