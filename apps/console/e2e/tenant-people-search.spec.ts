import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { homeNavigation } from './support/home-navigation.js';
test.use({ locale: 'th-TH' });

const TEAM_ID = '10000000-0000-4000-8000-000000000301';
const account = (index: number, name: string, role = 'AGENT') => ({
  id: `10000000-0000-4000-8000-0000000002${String(index).padStart(2, '0')}`,
  displayName: name,
  email: `user${index}@example.test`,
  username: `user${index}@example.test`,
  role,
  teamId: TEAM_ID,
  extensionRef: role === 'AGENT' ? `10${String(index).padStart(2, '0')}` : null,
  configRevision: 1,
  accountState: 'ACTIVE',
  provisioningState: 'PROVISIONED',
  activationState: 'ACTIVATED',
  isActive: true,
  operationId: null,
  commandId: null,
});

test('ค้นหาและกรองฝั่ง server: คำค้นอยู่ใน body ไม่อยู่ใน URL และรอหยุดพิมพ์ก่อนส่ง', async ({
  page,
}) => {
  const everyone = [
    account(1, 'สมชาย ใจดี'),
    account(2, 'สมหญิง รักงาน', 'SUPERVISOR'),
    account(3, 'Admin หลัก', 'ADMIN'),
  ];
  const searches: Record<string, unknown>[] = [];
  const urls: string[] = [];
  await page.route('**/api/v1/me/navigation**', (route) =>
    route.fulfill({ json: homeNavigation(['admin'], true) }),
  );
  await page.route('**/api/v1/tenant-voice/**', (route) => {
    const request = route.request();
    urls.push(request.url());
    const path = new URL(request.url()).pathname.split('/tenant-voice/')[1];
    if (path === 'capabilities')
      return route.fulfill({ json: { canWrite: true, peopleProvisioning: { ready: true } } });
    if (path === 'teams')
      return route.fulfill({ json: { items: [{ id: TEAM_ID, name: 'ทีมขาย', isActive: true }] } });
    if (path === 'extension-pool') return route.fulfill({ json: { items: [] } });
    if (path === 'people/users' && request.method() === 'GET')
      return route.fulfill({ json: { items: everyone, nextCursor: null } });
    if (path === 'people/users/search' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      searches.push(body);
      const q = typeof body.q === 'string' ? body.q.toLowerCase() : '';
      const items = everyone.filter(
        (user) =>
          (!q ||
            user.displayName.toLowerCase().includes(q) ||
            user.email.includes(q) ||
            (user.extensionRef ?? '').includes(q)) &&
          (!body.role || user.role === body.role) &&
          (!body.state || user.accountState === body.state),
      );
      return route.fulfill({ json: { items, nextCursor: null } });
    }
    return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });

  await page.goto('/?view=tenant-people&tenant=demo');
  await expect(page.getByRole('button', { name: 'ดูบัญชี Admin หลัก', exact: true })).toBeVisible();
  await expect(page.getByText('3 บัญชี', { exact: true })).toBeVisible();

  const search = page.getByRole('searchbox', { name: 'ค้นหา' });
  await search.pressSequentially('สมห', { delay: 30 });
  await expect(page.getByText('พบ 1 บัญชี', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'ดูบัญชี สมหญิง รักงาน', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'ดูบัญชี สมชาย ใจดี', exact: true })).toHaveCount(
    0,
  );
  // พิมพ์ต่อเนื่องส่งครั้งเดียวด้วยคำค้นสุดท้าย และไม่มีคำค้นใน URL
  expect(searches).toEqual([{ limit: 20, q: 'สมห' }]);
  expect(urls.some((url) => decodeURIComponent(url).includes('สมห'))).toBe(false);

  await page.getByRole('button', { name: /บทบาท/ }).click();
  await page.getByRole('option', { name: 'Admin', exact: true }).click();
  await expect(page.getByText('ไม่พบบัญชีที่ตรงกับคำค้นหรือตัวกรอง')).toBeVisible();
  expect(searches.at(-1)).toEqual({ limit: 20, q: 'สมห', role: 'ADMIN' });

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? '')),
  ).toEqual([]);

  await page.getByRole('button', { name: 'ล้างตัวกรอง', exact: true }).first().click();
  await expect(page.getByText('3 บัญชี', { exact: true })).toBeVisible();
  await expect(search).toHaveValue('');
});
