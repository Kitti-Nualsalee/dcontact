import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { homeNavigation } from './support/home-navigation.js';

test.use({ locale: 'th-TH' });
const userId = '10000000-0000-4000-8000-000000000713';
const operationId = '10000000-0000-4000-8000-000000000714';
for (const scenario of [
  'success',
  'lost-reload',
  'last-admin',
  'busy',
  'not-ready',
  'readiness-race',
  'poll',
]) {
  test(`ปิดบัญชี ${scenario}: ยืนยันก่อนส่งและไม่ retry เมื่อผลไม่ชัดเจน`, async ({ page }) => {
    if (scenario === 'poll') await page.clock.install();
    const user = {
      id: userId,
      displayName: 'ผู้ใช้ปิดบัญชีทดสอบ',
      email: 'disable@example.test',
      username: 'disable@example.test',
      role: 'AGENT',
      teamId: null,
      extensionRef: null,
      configRevision: 1,
      accountState: 'ACTIVE',
      provisioningState: 'PROVISIONED',
      activationState: 'ACTIVATED',
      isActive: true,
      operationId: null,
      commandId: null,
      deliveryState: 'UNKNOWN',
      invitationGeneration: null,
      invitationExpiresAt: null,
    };
    let posts = 0,
      commandId = '',
      checks = 0;
    await page.route('**/api/v1/me/navigation**', (route) =>
      route.fulfill({ json: homeNavigation(['admin'], true) }),
    );
    await page.route('**/api/v1/tenant-voice/**', async (route) => {
      const path = new URL(route.request().url()).pathname.split('/tenant-voice/')[1];
      if (path === 'capabilities')
        return route.fulfill({
          json: {
            canWrite: true,
            peopleProvisioning: { ready: true },
            invitation: { ready: false },
            disable: { ready: scenario !== 'not-ready' },
          },
        });
      if (path === 'teams' || path === 'extension-pool')
        return route.fulfill({ json: { items: [] } });
      if (path === 'people/users')
        return route.fulfill({ json: { items: [user], nextCursor: null } });
      if (path === `people/users/${userId}`) return route.fulfill({ json: user });
      if (path === `people/users/${userId}/disable` && route.request().method() === 'POST') {
        posts++;
        const body = route.request().postDataJSON();
        expect(Object.keys(body).sort()).toEqual([
          'commandId',
          'expectedRevision',
          'reason',
          'reasonCode',
        ]);
        expect(body.expectedRevision).toBe(1);
        expect(body.reason).toBe('จบทดสอบบัญชี');
        commandId = body.commandId;
        if (scenario === 'readiness-race' && posts === 1)
          return route.fulfill({ status: 503, json: { code: 'CAPABILITY_NOT_READY' } });
        if (scenario === 'last-admin' || scenario === 'busy')
          return route.fulfill({
            status: 409,
            json: { code: scenario === 'last-admin' ? 'LAST_USABLE_ADMIN' : 'CONFIG_BUSY' },
          });
        user.isActive = false;
        user.configRevision = 2;
        user.accountState = 'DISABLING';
        if (scenario === 'lost-reload') return route.abort('failed');
        return route.fulfill({
          status: 202,
          json: { operationId, userId, status: 'ACCEPTED', accountState: 'DISABLING' },
        });
      }
      if (path === `commands/${commandId}`)
        return route.fulfill({ json: { result: { operationId, userId } } });
      if (path === `operations/${operationId}`) {
        checks++;
        const state = scenario === 'lost-reload' && checks === 1 ? 'ACTION_REQUIRED' : 'SUCCEEDED';
        user.accountState = state === 'SUCCEEDED' ? 'DISABLED' : 'ATTENTION_REQUIRED';
        return route.fulfill({ json: { operationId, userId, step: 'DISABLE_ACCOUNT', state } });
      }
      return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    });
    await page.goto('/?view=tenant-people&tenant=demo');
    const open = () =>
      page.getByRole('button', { name: 'ดูบัญชี ผู้ใช้ปิดบัญชีทดสอบ', exact: true }).click();
    await open();
    let panel = page.getByRole('region', { name: 'ปิดบัญชี', exact: true });
    if (scenario === 'not-ready') {
      await expect(
        panel.getByRole('button', { name: 'เตรียมปิดบัญชี', exact: true }),
      ).toBeDisabled();
      expect(posts).toBe(0);
      return;
    }
    await panel
      .getByRole('textbox', { name: 'เหตุผล (1–500 ตัวอักษร)', exact: true })
      .fill('จบทดสอบบัญชี');
    await panel.getByRole('button', { name: 'เตรียมปิดบัญชี', exact: true }).click();
    expect(posts).toBe(0);
    await panel.getByRole('button', { name: 'ยืนยันปิดบัญชี', exact: true }).click();
    if (scenario === 'readiness-race') {
      await expect(panel.getByRole('alert')).toContainText('ยังไม่ได้รับคำสั่ง');
      await panel.getByRole('button', { name: 'ตรวจผลคำสั่งเดิม', exact: true }).click();
      await panel.getByRole('button', { name: 'เตรียมปิดบัญชี', exact: true }).click();
      await panel.getByRole('button', { name: 'ยืนยันปิดบัญชี', exact: true }).click();
    }
    if (scenario === 'last-admin' || scenario === 'busy') {
      await expect(panel.getByRole('alert')).toContainText(
        scenario === 'last-admin' ? 'คนสุดท้าย' : 'มีงานค้าง',
      );
      expect(posts).toBe(1);
      return;
    }
    if (scenario === 'lost-reload') {
      await expect(panel.getByRole('alert')).toBeVisible();
      await page.reload();
      await open();
      panel = page.getByRole('region', { name: 'ปิดบัญชี', exact: true });
      await expect(panel).toContainText('ผลยังไม่ชัดเจน');
      await expect(
        panel.getByRole('button', { name: 'เตรียมปิดบัญชี', exact: true }),
      ).toBeDisabled();
    }
    if (scenario === 'poll') {
      await expect(panel).toContainText('รอยืนยัน identity');
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.clock.fastForward(15_000);
      expect(checks).toBe(0);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    } else await panel.getByRole('button', { name: 'ตรวจผลคำสั่งเดิม', exact: true }).click();
    await expect(panel).toContainText('ปิดบัญชีและ session สำเร็จแล้ว');
    expect(posts).toBe(scenario === 'readiness-race' ? 2 : 1);
    if (scenario === 'poll') {
      expect(checks).toBe(1);
      await page.clock.fastForward(15_000);
      expect(checks).toBe(1);
    }
    const stored = await page.evaluate(() =>
      Object.entries(sessionStorage).filter(([key]) => key.startsWith('dc:tenant-disable:')),
    );
    expect(JSON.stringify(stored)).not.toMatch(
      /disable@example|จบทดสอบบัญชี|access_token|password/,
    );
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter((issue) => ['serious', 'critical'].includes(issue.impact ?? '')),
    ).toEqual([]);
  });
}
