import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { homeNavigation } from './support/home-navigation.js';

test.use({ locale: 'th-TH' });
const userId = '10000000-0000-4000-8000-000000000201';
const createOperation = '10000000-0000-4000-8000-000000000202';
const invitationOperation = '10000000-0000-4000-8000-000000000203';
const originalCommand = '10000000-0000-4000-8000-000000000204';
for (const scenario of [
  'sent',
  'expired',
  'ambiguous',
  'dispatching',
  'lost-reload',
  'limited',
  'activated',
  'supervisor',
  'intent',
]) {
  test(`คำเชิญ ${scenario}: แยกสามสถานะและไม่ blind retry`, async ({ page }) => {
    const user = {
      id: userId,
      displayName: 'ผู้ใช้คำเชิญ',
      email: 'invitation@example.test',
      username: 'invitation@example.test',
      role: 'SUPERVISOR',
      teamId: null,
      extensionRef: null,
      configRevision: 3,
      accountState: scenario === 'activated' ? 'ACTIVE' : 'PENDING_ACTIVATION',
      provisioningState: 'PROVISIONED',
      activationState: scenario === 'activated' ? 'ACTIVATED' : 'PENDING',
      isActive: scenario === 'activated',
      operationId: createOperation,
      commandId: originalCommand,
      deliveryState:
        scenario === 'expired'
          ? 'EXPIRED'
          : scenario === 'ambiguous'
            ? 'AMBIGUOUS'
            : scenario === 'dispatching'
              ? 'DISPATCHING'
              : scenario === 'intent'
                ? 'INTENT'
                : 'SENT',
      invitationGeneration: 2,
      invitationExpiresAt: '2026-10-24T00:00:00.000Z',
    };
    let posts = 0,
      commands = 0;
    let commandId: string | undefined;
    await page.route('**/api/v1/me/navigation**', (route) =>
      route.fulfill({
        json: homeNavigation(scenario === 'supervisor' ? ['supervisor'] : ['admin'], true),
      }),
    );
    await page.route('**/api/v1/tenant-voice/**', async (route) => {
      const path = new URL(route.request().url()).pathname.split('/tenant-voice/')[1];
      if (path === 'capabilities')
        return route.fulfill({
          json: {
            canWrite: scenario !== 'supervisor',
            peopleProvisioning: { ready: true },
            invitation: { ready: scenario !== 'supervisor' },
          },
        });
      if (path === 'teams' || path === 'extension-pool')
        return route.fulfill({ json: { items: [] } });
      if (path === 'people/users')
        return route.fulfill({ json: { items: [user], nextCursor: null } });
      if (path === `people/users/${userId}`) return route.fulfill({ json: user });
      if (route.request().method() === 'POST') {
        posts++;
        const body = route.request().postDataJSON();
        expect(Object.keys(body).sort()).toEqual([
          'commandId',
          'expectedRevision',
          'reason',
          'reasonCode',
        ]);
        expect(body.expectedRevision).toBe(3);
        expect(body.reason).toBe('ตรวจคำเชิญทดสอบ');
        commandId = body.commandId;
        expect(path).toBe(
          `people/users/${userId}/${['ambiguous', 'dispatching'].includes(scenario) ? 'reconcile' : 'invitation/resend'}`,
        );
        if (scenario === 'limited')
          return route.fulfill({ status: 429, json: { code: 'INVITATION_RESEND_LIMIT' } });
        user.deliveryState = 'SENT';
        user.invitationGeneration = 3;
        if (scenario === 'lost-reload') return route.abort('failed');
        return route.fulfill({ status: 202, json: { operationId: invitationOperation, userId } });
      }
      if (path.startsWith('commands/')) {
        commands++;
        expect(path).toBe(`commands/${commandId}`);
        return route.fulfill({ json: { result: { operationId: invitationOperation, userId } } });
      }
      if (path === `operations/${invitationOperation}`)
        return route.fulfill({
          json: { operationId: invitationOperation, userId, state: 'SUCCEEDED' },
        });
      return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    });
    await page.goto('/?view=tenant-people&tenant=demo');
    await page.getByRole('button', { name: 'ดูบัญชี ผู้ใช้คำเชิญ', exact: true }).click();
    let invitation = page.getByRole('region', { name: 'คำเชิญและการเปิดใช้งาน', exact: true });
    await expect(invitation).toContainText('จัดเตรียมแล้ว');
    if (['activated', 'supervisor', 'intent'].includes(scenario)) {
      await expect(
        invitation.getByRole('button', { name: 'ส่งคำเชิญรุ่นใหม่', exact: true }),
      ).toHaveCount(0);
      if (scenario === 'activated') await expect(invitation).toContainText('เปิดใช้งานแล้ว');
      expect(posts).toBe(0);
      return;
    }
    await invitation
      .getByRole('textbox', { name: 'เหตุผล (1–500 ตัวอักษร)', exact: true })
      .fill('ตรวจคำเชิญทดสอบ');
    if (['ambiguous', 'dispatching'].includes(scenario))
      await expect(
        invitation.getByRole('button', { name: 'ส่งคำเชิญรุ่นใหม่', exact: true }),
      ).toBeDisabled();
    await invitation
      .getByRole('button', {
        name: ['ambiguous', 'dispatching'].includes(scenario)
          ? 'ตรวจหลักฐานการส่ง'
          : 'ส่งคำเชิญรุ่นใหม่',
        exact: true,
      })
      .click();
    if (scenario === 'limited') {
      await expect(invitation.getByRole('alert')).toContainText('ครบโควตา');
      expect(posts).toBe(1);
      return;
    }
    if (scenario === 'lost-reload') {
      await expect(invitation.getByRole('alert')).toBeVisible();
      await page.reload();
      await page.getByRole('button', { name: 'ดูบัญชี ผู้ใช้คำเชิญ', exact: true }).click();
      invitation = page.getByRole('region', { name: 'คำเชิญและการเปิดใช้งาน', exact: true });
      await expect.poll(() => commands).toBe(1);
    } else
      await invitation.getByRole('button', { name: 'ตรวจสถานะคำเชิญเดิม', exact: true }).click();
    await expect(invitation).toContainText('ส่งแล้ว');
    await expect(invitation).toContainText('รอผู้ใช้เปิดใช้งาน');
    await expect(invitation.getByText('3', { exact: true })).toBeVisible();
    expect(posts).toBe(1);
    const stored = await page.evaluate(() =>
      Object.entries(sessionStorage).filter(([key]) => key.startsWith('dc:tenant-invitation:')),
    );
    expect(JSON.stringify(stored)).not.toMatch(
      /password|action-token|invitation@example|ตรวจคำเชิญทดสอบ/,
    );
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter((issue) =>
        ['serious', 'critical'].includes(issue.impact ?? ''),
      ),
    ).toEqual([]);
  });
}
