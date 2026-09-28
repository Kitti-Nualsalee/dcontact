import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * E1.11 (#485): Integrations › dphone embedding — API จำลองด้วย page.route (สิทธิ์จริงตรวจใน API integration)
 */
test.use({ locale: 'th-TH' });

type Origin = {
  id: string;
  origin: string;
  label: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  activeSessions: number;
};

async function mockApi(
  page: Page,
  state: { entitled: boolean; flagEnabled: boolean; origins: Origin[] },
) {
  const writes: { method: string; body: unknown }[] = [];
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({
      status: 200,
      json: {
        groups: [],
        apps: [],
        pins: { appIds: [], source: 'SYSTEM', revision: 0 },
        limits: { maxPins: 15 },
        features: { shellV2: false },
      },
    }),
  );
  await page.route('**/api/v1/tenant/embed-origins**', async (route) => {
    const request = route.request();
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    if (method === 'GET') return route.fulfill({ status: 200, json: { ...state, limit: 10 } });
    writes.push({ method, body });
    if (method === 'POST') {
      const created: Origin = {
        id: `00000000-0000-4000-8000-00000000000${state.origins.length + 1}`,
        origin: (body as { origin: string }).origin,
        label: (body as { label: string }).label,
        enabled: true,
        revision: 1,
        createdAt: '2026-09-28T00:00:00.000Z',
        updatedAt: '2026-09-28T00:00:00.000Z',
        activeSessions: 0,
      };
      state.origins.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    const id = new URL(request.url()).pathname.split('/').pop();
    const index = state.origins.findIndex((origin) => origin.id === id);
    if (method === 'DELETE') {
      state.origins.splice(index, 1);
      return route.fulfill({ status: 204, body: '' });
    }
    const current = state.origins[index]!;
    Object.assign(current, body, { revision: current.revision + 1 });
    return route.fulfill({ status: 200, json: current });
  });
  return writes;
}

const sample = (): Origin => ({
  id: '00000000-0000-4000-8000-0000000000aa',
  origin: 'https://crm.example.test',
  label: 'CRM ฝ่ายขาย',
  enabled: true,
  revision: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  activeSessions: 2,
});

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
}

test('ADMIN: ตรวจ origin ทันทีที่กรอก, เพิ่ม origin แบบ normalize และมี snippet', async ({
  page,
}) => {
  const writes = await mockApi(page, { entitled: true, flagEnabled: true, origins: [] });
  await page.goto('/?view=dphone-embedding&tenant=demo');
  await expect(
    page.getByRole('heading', { name: 'ฝัง dphone ในระบบอื่น', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('ยังไม่มี origin')).toBeVisible();

  const origin = page.getByRole('textbox', { name: 'Origin' });
  await origin.fill('https://*.example.test');
  await expect(page.getByText('ห้ามใช้ * หรือ wildcard')).toBeVisible();
  await expect(page.getByRole('button', { name: 'เพิ่ม origin' })).toBeDisabled();
  await origin.fill('HTTPS://Sales.Example.test:443/');
  await expect(page.getByText('จะบันทึกเป็น https://sales.example.test')).toBeVisible();
  await page.getByLabel('ชื่อที่ใช้เรียก').fill('CRM ภายใน');
  await page.getByRole('button', { name: 'เพิ่ม origin' }).click();
  await expect(
    page.getByRole('cell', { name: 'https://sales.example.test', exact: true }),
  ).toBeVisible();
  expect(writes[0]).toEqual({
    method: 'POST',
    body: { origin: 'https://sales.example.test', label: 'CRM ภายใน' },
  });
  await expect(page.locator('pre')).toContainText('/dphone/embed?tenant=demo');
  await expect(page.locator('pre')).toContainText('allow-popups');
  await axe(page);
});

test('ADMIN: ปิด/ลบต้องยืนยันพร้อมจำนวน session ที่ฝังอยู่ และส่ง expectedRevision', async ({
  page,
}) => {
  const writes = await mockApi(page, { entitled: true, flagEnabled: true, origins: [sample()] });
  await page.goto('/?view=dphone-embedding&tenant=demo');
  await page.getByRole('button', { name: 'ปิด https://crm.example.test' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('กำลังใช้งาน 2 รายการ');
  await axe(page);
  await dialog.getByRole('button', { name: 'ยืนยันปิด' }).click();
  await expect(page.getByRole('cell', { name: 'ปิด', exact: true })).toBeVisible();
  expect(writes[0]).toEqual({ method: 'PATCH', body: { expectedRevision: 1, enabled: false } });

  await page.getByRole('button', { name: 'ลบ https://crm.example.test' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ยืนยันลบ' }).click();
  await expect(page.getByText('ยังไม่มี origin')).toBeVisible();
  expect(writes[1]).toEqual({ method: 'DELETE', body: { expectedRevision: 2 } });
});

test('SUPERVISOR ดูได้อย่างเดียว; ไม่มี entitlement = หน้าล็อก; flag ปิด = แจ้ง', async ({
  page,
}) => {
  await mockApi(page, { entitled: true, flagEnabled: false, origins: [sample()] });
  await page.goto('/?view=dphone-embedding&tenant=demo&viewer=SUPERVISOR');
  await expect(page.getByText('บัญชีนี้ดูได้อย่างเดียว')).toBeVisible();
  await expect(page.getByText('ยังไม่ได้เปิดใช้การฝัง dphone')).toBeVisible();
  await expect(page.getByRole('button', { name: /ลบ|ปิด https/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Origin' })).toHaveCount(0);

  await page.unrouteAll();
  await mockApi(page, { entitled: false, flagEnabled: false, origins: [] });
  await page.goto('/?view=dphone-embedding&tenant=demo');
  await expect(
    page.getByRole('heading', { name: 'แพ็กเกจปัจจุบันยังไม่รวมการฝัง dphone' }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await axe(page);
});
