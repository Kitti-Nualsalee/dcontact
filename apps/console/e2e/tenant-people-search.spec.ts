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

test('server-side search and filter: the query is in the body, not the URL, and waits for typing to stop before sending', async ({
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
  // continuous typing sends once with the last query, and no query in the URL
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

test('the result of an old, slowly answering query is dropped, and load more sends the original filter with the cursor', async ({
  page,
}) => {
  const agents = Array.from({ length: 25 }, (_, index) =>
    account(index + 10, `Agent ${index + 10}`),
  );
  const searches: Record<string, unknown>[] = [];
  let releaseSlow: (() => void) | undefined;
  await page.route('**/api/v1/me/navigation**', (route) =>
    route.fulfill({ json: homeNavigation(['admin'], true) }),
  );
  await page.route('**/api/v1/tenant-voice/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/tenant-voice/')[1];
    if (path === 'capabilities')
      return route.fulfill({ json: { canWrite: true, peopleProvisioning: { ready: true } } });
    if (path === 'teams')
      return route.fulfill({ json: { items: [{ id: TEAM_ID, name: 'ทีมขาย', isActive: true }] } });
    if (path === 'extension-pool') return route.fulfill({ json: { items: [] } });
    if (path === 'people/users' && request.method() === 'GET')
      return route.fulfill({ json: { items: agents.slice(0, 20), nextCursor: 'all-page-2' } });
    if (path === 'people/users/search') {
      const body = request.postDataJSON() as Record<string, unknown>;
      searches.push(body);
      if (body.q === 'slow') {
        // the first query answers slower than the next query
        await new Promise<void>((resolve) => (releaseSlow = resolve));
        return route.fulfill({
          json: { items: [account(90, 'ผลเก่าที่ต้องทิ้ง')], nextCursor: null },
        });
      }
      if (body.cursor === 'agent-page-2')
        return route.fulfill({ json: { items: agents.slice(20), nextCursor: null } });
      return route.fulfill({ json: { items: agents.slice(0, 20), nextCursor: 'agent-page-2' } });
    }
    return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });

  await page.goto('/?view=tenant-people&tenant=demo');
  await expect(page.getByText('แสดง 20 บัญชีแรก มีบัญชีเพิ่มเติม')).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'ค้นหา' });
  await search.fill('slow');
  await expect.poll(() => searches.length).toBe(1);
  await search.fill('agent');
  await expect.poll(() => searches.length).toBe(2);
  await expect(page.getByText('แสดง 20 บัญชีแรก มีบัญชีเพิ่มเติม')).toBeVisible();
  releaseSlow!();
  await expect(page.getByRole('button', { name: 'ดูบัญชี ผลเก่าที่ต้องทิ้ง' })).toHaveCount(0);

  await page.getByRole('button', { name: 'ดูบัญชีเพิ่มเติม', exact: true }).click();
  await expect(page.getByText('พบ 25 บัญชี', { exact: true })).toBeVisible();
  expect(searches.at(-1)).toEqual({ limit: 20, cursor: 'agent-page-2', q: 'agent' });

  await page.getByRole('button', { name: /สถานะ/ }).click();
  await page.getByRole('option', { name: 'จัดเตรียมไม่สำเร็จ', exact: true }).click();
  await expect.poll(() => searches.at(-1)).toEqual({ limit: 20, q: 'agent', status: 'REJECTED' });
});
