import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { homeNavigation } from './support/home-navigation.js';
import { th } from './support/catalog';
test.use({ locale: 'th-TH' });

const TEAM_A = '10000000-0000-4000-8000-000000000401';
const TEAM_B = '10000000-0000-4000-8000-000000000402';
const USER_ID = '10000000-0000-4000-8000-000000000411';

for (const scenario of ['success', 'busy', 'session', 'unknown', 'disabled'] as const)
  test(`move team ${scenario}: confirm in a Dialog, send revision/reason, and do not resend when rejected`, async ({
    page,
  }) => {
    let user = {
      id: USER_ID,
      displayName: 'Team Mover Agent',
      email: 'move@example.test',
      username: 'move@example.test',
      role: 'AGENT',
      teamId: TEAM_A,
      extensionRef: '1301',
      configRevision: 4,
      accountState: scenario === 'disabled' ? 'DISABLED' : 'ACTIVE',
      provisioningState: 'PROVISIONED',
      activationState: 'ACTIVATED',
      isActive: scenario !== 'disabled',
      operationId: null,
      commandId: null,
    };
    const patches: Record<string, unknown>[] = [];
    let details = 0;
    await page.route('**/api/v1/me/navigation**', (route) =>
      route.fulfill({ json: homeNavigation(['admin'], true) }),
    );
    await page.route('**/api/v1/tenant-voice/**', (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.split('/tenant-voice/')[1];
      if (path === 'capabilities')
        return route.fulfill({ json: { canWrite: true, peopleProvisioning: { ready: true } } });
      if (path === 'teams')
        return route.fulfill({
          json: {
            items: [
              { id: TEAM_A, name: 'Sales Team', isActive: true },
              { id: TEAM_B, name: 'Service Team', isActive: true },
            ],
          },
        });
      if (path === 'extension-pool') return route.fulfill({ json: { items: [] } });
      if (path === 'people/users' && request.method() === 'GET')
        return route.fulfill({ json: { items: [user], nextCursor: null } });
      if (path === `people/users/${USER_ID}` && request.method() === 'GET') {
        details++;
        return route.fulfill({ json: user });
      }
      if (path === `people/users/${USER_ID}/team` && request.method() === 'PATCH') {
        const body = request.postDataJSON() as Record<string, unknown>;
        patches.push(body);
        if (scenario === 'busy')
          return route.fulfill({ status: 409, json: { code: 'CONFIG_BUSY' } });
        if (scenario === 'session')
          return route.fulfill({ status: 409, json: { code: 'AGENT_SESSION_ACTIVE' } });
        if (scenario === 'unknown') return route.fulfill({ status: 502, body: '' });
        user = { ...user, teamId: TEAM_B, configRevision: 5 };
        return route.fulfill({
          json: { userId: USER_ID, teamId: TEAM_B, configRevision: 5, removedSkills: 1 },
        });
      }
      return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    });

    await page.goto('/?view=tenant-people&tenant=demo');
    await page
      .getByRole('button', {
        name: `${th('tenantPeople:directory.open')} Team Mover Agent`,
        exact: true,
      })
      .click();
    const start = page.getByRole('button', {
      name: th('tenantPeople:teamChange.start'),
      exact: true,
    });
    if (scenario === 'disabled') {
      await expect(start).toBeDisabled();
      await expect(page.getByText(th('tenantPeople:teamChange.notMovable'))).toBeVisible();
      expect(patches).toEqual([]);
      return;
    }
    await start.click();
    const dialog = page.getByRole('dialog', {
      name: th('tenantPeople:teamChange.title', { name: 'Team Mover Agent' }),
    });
    await expect(dialog).toContainText(
      th('tenantPeople:teamChange.bodyAgent', { team: 'Sales Team' }),
    );
    const submit = dialog.getByRole('button', {
      name: th('tenantPeople:teamChange.submit'),
      exact: true,
    });
    await expect(submit).toBeDisabled();
    await dialog.getByRole('button', { name: th('tenantPeople:teamChange.newTeam') }).click();
    // the current team is not among the options
    await expect(page.getByRole('option', { name: 'Sales Team', exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: 'Service Team', exact: true }).click();
    await dialog
      .getByRole('textbox', { name: th('tenantPeople:invitation.reason') })
      .fill('Move to service work');
    const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(
      accessibility.violations.filter((item) =>
        ['serious', 'critical'].includes(item.impact ?? ''),
      ),
    ).toEqual([]);
    await submit.click();
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      expectedRevision: 4,
      teamId: TEAM_B,
      reason: 'Move to service work',
    });
    if (scenario === 'unknown') {
      // unknown result: close the Dialog, read the real detail, and do not resend by itself
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole('status').filter({ hasText: th('tenantPeople:teamChange.errors.UNKNOWN') }),
      ).toBeVisible();
      await expect.poll(() => details).toBeGreaterThanOrEqual(2);
      expect(patches).toHaveLength(1);
      return;
    }
    if (scenario === 'session') {
      await expect(dialog.getByRole('alert')).toContainText(
        th('tenantPeople:teamChange.errors.AGENT_SESSION_ACTIVE'),
      );
      expect(patches).toHaveLength(1);
      return;
    }
    if (scenario === 'busy') {
      await expect(dialog.getByRole('alert')).toContainText(
        th('tenantPeople:teamChange.errors.CONFIG_BUSY'),
      );
      await expect(
        dialog.getByRole('textbox', { name: th('tenantPeople:invitation.reason') }),
      ).toHaveValue('Move to service work');
      expect(patches).toHaveLength(1);
      return;
    }
    await expect(dialog).toHaveCount(0);
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: th('tenantPeople:teamChange.done', { team: 'Service Team' }) }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: th('tenantPeople:directory.detail') }),
    ).toContainText('Service Team');
  });
