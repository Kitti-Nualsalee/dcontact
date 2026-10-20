import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { homeNavigation } from './support/home-navigation.js';

const operationId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const teamId = '10000000-0000-4000-8000-000000000003';
test.use({ locale: 'th-TH' });

for (const scenario of ['normal', 'lost-response', 'lost-reload', 'validation', 'agent'])
  test(`create/status ${scenario}: บัญชี provision แล้วต้องยังรอ activation และ reload อ่าน operation เดิม`, async ({
    page,
  }) => {
    let creates = 0,
      reads = 0;
    const lostResponse = scenario === 'lost-response' || scenario === 'lost-reload';
    const forbidden: string[] = [];
    page.on('request', (request) => {
      if (/work-session|sip-credentials/.test(request.url())) forbidden.push(request.url());
    });
    page.on('websocket', (socket) => {
      if (/workspace-session|sip-ws/.test(socket.url())) forbidden.push(socket.url());
    });
    const commands: string[] = [];
    await page.route('**/api/v1/me/navigation**', (route) =>
      route.fulfill({ json: homeNavigation(['admin'], true) }),
    );
    await page.route('**/api/v1/tenant-voice/**', async (route) => {
      const path = new URL(route.request().url()).pathname.split('/tenant-voice/')[1];
      if (path === 'capabilities')
        return route.fulfill({
          json: { canWrite: true, peopleProvisioning: { ready: true, reasons: [] } },
        });
      if (path === 'teams')
        return route.fulfill({ json: { items: [{ id: teamId, name: 'ทีมทดสอบ' }] } });
      if (path === 'extension-pool')
        return route.fulfill({ json: { items: [{ ref: '1104' }], poolRevision: 1 } });
      if (path.startsWith('commands/'))
        return route.fulfill({
          json: { state: 'SUCCEEDED', result: { operationId, userId, status: 'ACCEPTED' } },
        });
      if (path === 'people/users' && route.request().method() === 'POST') {
        creates++;
        const body = route.request().postDataJSON();
        commands.push(body.commandId);
        if (scenario === 'validation' && creates === 1)
          return route.fulfill({
            status: 400,
            json: { code: 'VALIDATION_FAILED', field: 'email' },
          });
        expect(Object.keys(body).sort()).toEqual([
          'commandId',
          'displayName',
          'email',
          ...(scenario === 'agent' ? ['extensionRef'] : []),
          'role',
          'teamId',
        ]);
        expect(body.role).toBe(scenario === 'agent' ? 'AGENT' : 'ADMIN');
        if (scenario === 'agent') expect(body.extensionRef).toBe('1104');
        if (lostResponse) return route.abort('failed');
        return route.fulfill({
          status: 202,
          json: {
            status: 'ACCEPTED',
            operationId,
            userId,
            location: `/api/v1/tenant-voice/operations/${operationId}`,
          },
        });
      }
      if (path === `operations/${operationId}`) {
        reads++;
        return route.fulfill({
          json: {
            operationId,
            userId,
            state: 'SUCCEEDED',
            step: 'VERIFY_PROVISIONED',
            revision: 7,
            accountState: 'PENDING_ACTIVATION',
            activationState: 'PENDING',
            provisioningState: 'PROVISIONED',
            errorCode: null,
          },
        });
      }
      return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    });
    await page.goto('/?view=tenant-people&tenant=demo');
    await expect(page.getByRole('heading', { name: 'บัญชีผู้ใช้', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'ชื่อที่แสดง', exact: true }).fill('ผู้ทดสอบ');
    await page.getByRole('textbox', { name: 'อีเมล', exact: true }).fill('synthetic@example.test');
    if (scenario === 'agent') {
      await page
        .getByRole('button', { name: 'เลือกหมายเลขภายใน หมายเลขภายใน', exact: true })
        .click();
      await page.getByRole('option', { name: '1104', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Agent บทบาท', exact: true }).click();
      await page.getByRole('option', { name: 'Admin', exact: true }).click();
    }
    await page.getByRole('button', { name: 'เลือกทีม ทีม', exact: true }).click();
    await page.getByRole('option', { name: 'ทีมทดสอบ', exact: true }).click();
    await page.getByRole('button', { name: 'สร้างบัญชี', exact: true }).click();
    if (scenario === 'validation') {
      await expect(page.getByRole('alert')).toContainText(
        'ตรวจชื่อ อีเมล บทบาท ทีม และหมายเลขภายใน แล้วส่งใหม่ได้',
      );
      await page
        .getByRole('textbox', { name: 'อีเมล', exact: true })
        .fill('corrected@example.test');
      await page.getByRole('button', { name: 'สร้างบัญชี', exact: true }).click();
      expect(commands[0]).not.toBe(commands[1]);
    }
    if (lostResponse) {
      await expect(page.getByRole('button', { name: 'สร้างบัญชี', exact: true })).toBeDisabled();
      if (scenario === 'lost-reload') {
        await expect.poll(() => creates).toBe(1);
        await page.reload();
      } else await page.getByRole('button', { name: 'ตรวจผลคำสั่งเดิม', exact: true }).click();
    }
    await expect(
      page.getByText('จัดเตรียมบัญชีแล้ว — ยังรอผู้ใช้เปิดใช้งาน', { exact: true }),
    ).toBeVisible();
    const storage = await page.evaluate(() => JSON.stringify(sessionStorage));
    expect(storage).not.toContain('synthetic@example.test');
    expect(storage).not.toContain('e2e-access-token');
    await page.reload();
    await expect(
      page.getByText('จัดเตรียมบัญชีแล้ว — ยังรอผู้ใช้เปิดใช้งาน', { exact: true }),
    ).toBeVisible();
    expect(creates).toBe(scenario === 'validation' ? 2 : 1);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(forbidden).toEqual([]);
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (item) => item.impact === 'serious' || item.impact === 'critical',
      ),
    ).toEqual([]);
  });

test('capability ไม่พร้อมต้องไม่ส่ง mutation หรือเปิด extension pool', async ({ page }) => {
  const unexpected: string[] = [];
  await page.route('**/api/v1/me/navigation**', (route) =>
    route.fulfill({ json: homeNavigation(['admin'], true) }),
  );
  await page.route('**/api/v1/tenant-voice/**', (route) => {
    const path = new URL(route.request().url()).pathname.split('/tenant-voice/')[1];
    if (path === 'capabilities')
      return route.fulfill({
        json: {
          canWrite: true,
          peopleProvisioning: { ready: false, reasons: ['CAPABILITY_NOT_READY'] },
        },
      });
    if (path === 'teams') return route.fulfill({ json: { items: [] } });
    unexpected.push(path);
    return route.fulfill({ status: 503 });
  });
  await page.goto('/?view=tenant-people&tenant=demo');
  await expect(
    page.getByText('ยังไม่พร้อมจัดเตรียมบัญชี หรือคุณไม่มีสิทธิ์สร้างบัญชี', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'สร้างบัญชี', exact: true })).toBeDisabled();
  expect(unexpected).toEqual([]);
});

test('production auth root เปิด People โดยไม่ขอ Interaction context', async ({ page }) => {
  await page.goto('/?view=tenant-people&tenant=demo&authRootHarness=1');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'ไม่พบ Interaction context', exact: true }),
  ).toHaveCount(0);
});
