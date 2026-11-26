import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { homeNavigation } from './support/home-navigation.js';
import { th } from './support/catalog';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  'forbidden',
  'not-recorded',
]) {
  test(`disable account ${scenario}: confirm before sending and do not retry when the result is uncertain`, async ({
    page,
  }) => {
    if (scenario === 'poll') await page.clock.install();
    const user = {
      id: userId,
      displayName: 'Account To Disable',
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
        expect(body.reason).toBe('Test account closure');
        commandId = body.commandId;
        if (scenario === 'readiness-race' && posts === 1)
          return route.fulfill({ status: 503, json: { code: 'CAPABILITY_NOT_READY' } });
        if (scenario === 'forbidden')
          return route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } });
        // the response was lost before the server recorded the command: unknown until the original command is checked
        if (scenario === 'not-recorded') return route.abort('failed');
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
      // CONFIG_BUSY / a command that was not recorded: the server has no such command
      if (path === `commands/${commandId}` && !['busy', 'not-recorded'].includes(scenario))
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
      page
        .getByRole('button', {
          name: `${th('tenantPeople:directory.open')} Account To Disable`,
          exact: true,
        })
        .click();
    await open();
    let panel = page.getByRole('region', { name: th('tenantPeople:disable.title'), exact: true });
    if (scenario === 'not-ready') {
      await expect(
        panel.getByRole('button', { name: th('tenantPeople:disable.start'), exact: true }),
      ).toBeDisabled();
      expect(posts).toBe(0);
      return;
    }
    const refreshDisable = panel.getByRole('button', {
      name: th('tenantPeople:disable.refresh'),
      exact: true,
    });
    // no pending command yet: the check-result button is not shown
    await expect(
      panel.getByRole('button', { name: th('tenantPeople:disable.start'), exact: true }),
    ).toBeEnabled();
    await expect(refreshDisable).toHaveCount(0);
    const dialog = page.getByRole('alertdialog');
    const confirmDisable = async () => {
      await panel
        .getByRole('button', { name: th('tenantPeople:disable.start'), exact: true })
        .click();
      await dialog
        .getByRole('textbox', { name: th('tenantPeople:invitation.reason'), exact: true })
        .fill('Test account closure');
      await dialog
        .getByRole('button', { name: th('tenantPeople:disable.submit'), exact: true })
        .click();
    };
    await panel
      .getByRole('button', { name: th('tenantPeople:disable.start'), exact: true })
      .click();
    await expect(dialog).toBeVisible();
    const reason = dialog.getByRole('textbox', {
      name: th('tenantPeople:invitation.reason'),
      exact: true,
    });
    await reason.fill('Reason that gets cancelled');
    expect(posts).toBe(0);
    await dialog
      .getByRole('button', { name: th('tenantPeople:disable.cancel'), exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    // reopening must start from an empty reason field, so an old reason does not follow into the new confirmation
    await panel
      .getByRole('button', { name: th('tenantPeople:disable.start'), exact: true })
      .click();
    await expect(reason).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await confirmDisable();
    if (scenario === 'readiness-race') {
      await expect(panel.getByRole('alert')).toContainText(
        th('tenantPeople:disable.errors.NOT_ACCEPTED'),
      );
      await panel
        .getByRole('button', { name: th('tenantPeople:disable.refresh'), exact: true })
        .click();
      await confirmDisable();
    }
    if (scenario === 'forbidden') {
      await expect(dialog.getByRole('alert')).toContainText(
        th('tenantPeople:disable.errors.FORBIDDEN'),
      );
      // a 403 on the command does not replace the whole People page: the card and detail stay, no pending command
      await expect(panel).toBeVisible();
      await expect(page.getByText(th('tenantPeople:errors.FORBIDDEN'))).toHaveCount(0);
      await dialog
        .getByRole('button', { name: th('tenantPeople:disable.cancel'), exact: true })
        .click();
      await expect(
        panel.getByRole('button', { name: th('tenantPeople:disable.start'), exact: true }),
      ).toBeEnabled();
      await expect(refreshDisable).toHaveCount(0);
      expect(
        await page.evaluate(() =>
          Object.keys(sessionStorage).filter((key) => key.startsWith('dc:tenant-disable:')),
        ),
      ).toEqual([]);
      expect(posts).toBe(1);
      return;
    }
    if (scenario === 'not-recorded') {
      await expect(panel).toContainText(th('tenantPeople:disable.pending'));
      await expect(
        panel.getByRole('button', { name: th('tenantPeople:disable.start'), exact: true }),
      ).toBeDisabled();
      await refreshDisable.click();
      await expect(panel.getByRole('alert')).toContainText(
        th('tenantPeople:disable.errors.NOT_RECORDED'),
      );
      await expect(panel).not.toContainText(th('tenantPeople:disable.pending'));
      await expect(
        panel.getByRole('button', { name: th('tenantPeople:disable.start'), exact: true }),
      ).toBeEnabled();
      expect(
        await page.evaluate(() =>
          Object.keys(sessionStorage).filter((key) => key.startsWith('dc:tenant-disable:')),
        ),
      ).toEqual([]);
      expect(posts).toBe(1);
      return;
    }
    if (scenario === 'last-admin' || scenario === 'busy') {
      await expect(dialog.getByRole('alert')).toContainText(
        scenario === 'last-admin'
          ? th('tenantPeople:disable.errors.LAST_USABLE_ADMIN')
          : th('tenantPeople:disable.errors.CONFIG_BUSY'),
      );
      expect(posts).toBe(1);
      return;
    }
    if (scenario === 'lost-reload') {
      await expect(panel.getByRole('alert')).toBeVisible();
      await page.reload();
      await open();
      panel = page.getByRole('region', { name: th('tenantPeople:disable.title'), exact: true });
      await expect(panel).toContainText(th('tenantPeople:disable.states.ACTION_REQUIRED'));
      await expect(
        panel.getByRole('button', { name: th('tenantPeople:disable.start'), exact: true }),
      ).toBeDisabled();
      await expect(
        panel.getByRole('button', { name: th('tenantPeople:disable.refresh'), exact: true }),
      ).toBeVisible();
    }
    if (scenario === 'poll') {
      await expect(panel).toContainText(th('tenantPeople:disable.states.WAITING_EXTERNAL'));
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
    } else
      await panel
        .getByRole('button', { name: th('tenantPeople:disable.refresh'), exact: true })
        .click();
    await expect(panel).toContainText(th('tenantPeople:disable.states.SUCCEEDED'));
    // closed successfully: no pending command, so no check-result button or disable button remains overlapping the re-enable card
    await expect(panel.getByRole('button')).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: new RegExp(
          `^(${[
            th('tenantPeople:disable.refresh'),
            th('tenantPeople:enable.refresh'),
            th('tenantPeople:profile.refresh'),
            th('tenantPeople:refresh'),
          ]
            .map(escapeRegExp)
            .join('|')})`,
        ),
      }),
    ).toHaveCount(0);
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
      /disable@example|Test account closure|access_token|password/,
    );
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter((issue) => ['serious', 'critical'].includes(issue.impact ?? '')),
    ).toEqual([]);
  });
}

test('account already disabled: the disable card shrinks to one line with no button', async ({
  page,
}) => {
  const user = {
    id: userId,
    displayName: 'Already Disabled User',
    email: 'disabled@example.test',
    username: 'disabled@example.test',
    role: 'AGENT',
    teamId: null,
    extensionRef: null,
    configRevision: 3,
    accountState: 'DISABLED',
    provisioningState: 'PROVISIONED',
    activationState: 'ACTIVATED',
    isActive: false,
    operationId: null,
    commandId: null,
    disableOperationId: operationId,
    disableCommandId: '10000000-0000-4000-8000-000000000715',
    deliveryState: 'UNKNOWN',
    invitationGeneration: null,
    invitationExpiresAt: null,
  };
  let checks = 0;
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
          disable: { ready: true },
          accountChange: { ready: true },
        },
      });
    if (path === 'teams' || path === 'extension-pool')
      return route.fulfill({ json: { items: [] } });
    if (path === 'people/users')
      return route.fulfill({ json: { items: [user], nextCursor: null } });
    if (path === `people/users/${userId}`) return route.fulfill({ json: user });
    if (path?.startsWith('operations/')) checks++;
    return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });
  await page.goto('/?view=tenant-people&tenant=demo');
  await page
    .getByRole('button', {
      name: `${th('tenantPeople:directory.open')} Already Disabled User`,
      exact: true,
    })
    .click();
  const panel = page.getByRole('region', { name: th('tenantPeople:disable.title'), exact: true });
  await expect(panel).toContainText(th('tenantPeople:disable.closed'));
  await expect(panel).not.toContainText(th('tenantPeople:disable.states.SUCCEEDED'));
  await expect(panel).not.toContainText(th('tenantPeople:disable.notEligible'));
  await expect(panel.getByRole('button')).toHaveCount(0);
  await expect(panel.getByRole('status')).toHaveCount(0);
  const enable = page.getByRole('region', { name: th('tenantPeople:enable.title') });
  await expect(enable).toBeVisible();
  expect(checks).toBe(0);
  // wait until the re-enable button changes from checking readiness to pressable and the color transition ends before the contrast scan
  await expect(
    enable.getByRole('button', { name: th('tenantPeople:enable.start'), exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => Promise.all(document.getAnimations().map((item) => item.finished)));
  await page.waitForTimeout(300);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter((issue) => ['serious', 'critical'].includes(issue.impact ?? '')),
  ).toEqual([]);
});
