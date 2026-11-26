import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { homeNavigation } from './support/home-navigation.js';
import { th } from './support/catalog';
test.use({ locale: 'th-TH' });

const TEAM = '10000000-0000-4000-8000-000000000501';
const USER_ID = '10000000-0000-4000-8000-000000000511';
const OPERATION_ID = '10000000-0000-4000-8000-000000000521';

type Scenario = 'success' | 'busy' | 'credentials' | 'unknown' | 'rejected' | 'forbidden';

async function mockPeople(
  page: Page,
  options: {
    disabled: boolean;
    ready?: boolean;
    respond: Scenario;
    /** an account from seed: no People lifecycle (the directory answers UNKNOWN) */
    unmanaged?: boolean;
    /** hold capabilities until the promise resolves */
    capabilities?: Promise<void>;
  },
) {
  let user: Record<string, unknown> = {
    id: USER_ID,
    displayName: 'Original Name',
    email: 'somying@example.test',
    username: 'somying@example.test',
    role: 'AGENT',
    teamId: TEAM,
    extensionRef: '1501',
    configRevision: 6,
    accountState: options.unmanaged ? 'UNKNOWN' : options.disabled ? 'DISABLED' : 'ACTIVE',
    provisioningState: options.unmanaged ? 'UNKNOWN' : 'PROVISIONED',
    activationState: options.unmanaged ? 'UNKNOWN' : 'ACTIVATED',
    isActive: !options.disabled,
    operationId: null,
    commandId: null,
    accountChange: null,
  };
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let operationState = 'QUEUED';
  await page.route('**/api/v1/me/navigation**', (route) =>
    route.fulfill({ json: homeNavigation(['admin'], true) }),
  );
  const lookups: string[] = [];
  let detailOpened = false;
  await page.route('**/api/v1/tenant-voice/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/tenant-voice/')[1];
    if (path?.startsWith('commands/')) lookups.push(path);
    // hold only the capabilities the detail page requests (after opening an account), not blocking the list page
    if (path === `people/users/${USER_ID}`) detailOpened = true;
    if (path === 'capabilities' && detailOpened) await options.capabilities;
    if (path === 'capabilities')
      return route.fulfill({
        json: {
          canWrite: true,
          peopleProvisioning: { ready: true },
          accountChange: { ready: options.ready ?? true, reasons: [] },
        },
      });
    if (path === 'teams')
      return route.fulfill({ json: { items: [{ id: TEAM, name: 'Sales Team', isActive: true }] } });
    if (path === 'extension-pool') return route.fulfill({ json: { items: [] } });
    if (path === 'people/users' && request.method() === 'GET')
      return route.fulfill({ json: { items: [user], nextCursor: null } });
    if (path === `people/users/${USER_ID}` && request.method() === 'GET')
      return route.fulfill({ json: user });
    if (path === `operations/${OPERATION_ID}`)
      return route.fulfill({
        json: {
          operationId: OPERATION_ID,
          userId: USER_ID,
          step: writes[0]?.path.endsWith('/enable') ? 'ENABLE_ACCOUNT' : 'UPDATE_PROFILE',
          state: operationState,
        },
      });
    const write = path?.match(/^people\/users\/[^/]+\/(profile|enable)$/);
    if (write) {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method: request.method(), path, body });
      if (options.respond === 'busy')
        return route.fulfill({ status: 409, json: { code: 'CONFIG_BUSY' } });
      if (options.respond === 'credentials')
        return route.fulfill({ status: 409, json: { code: 'CREDENTIALS_NOT_READY' } });
      if (options.respond === 'unknown') return route.fulfill({ status: 502, body: '' });
      // UAT 25 Nov 2026: the API connected to the DB as owner and PATCH answered 403 FORBIDDEN
      if (options.respond === 'forbidden')
        return route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } });
      const kind = write[1] === 'profile' ? 'UPDATE_PROFILE' : 'ENABLE_ACCOUNT';
      user = {
        ...user,
        accountChange: {
          operationId: OPERATION_ID,
          commandId: body.commandId,
          kind,
          state: 'QUEUED',
        },
      };
      // the worker finishes after accepting the command: the next check sees the real result
      operationState = options.respond === 'rejected' ? 'REJECTED' : 'SUCCEEDED';
      setTimeout(() => {
        if (options.respond === 'rejected') return;
        user =
          kind === 'UPDATE_PROFILE'
            ? { ...user, displayName: body.displayName, configRevision: 7 }
            : { ...user, isActive: true, accountState: 'ACTIVE', configRevision: 7 };
      }, 0);
      return route.fulfill({
        status: 202,
        json: {
          operationId: OPERATION_ID,
          userId: USER_ID,
          kind,
          status: 'ACCEPTED',
          location: `/api/v1/tenant-voice/operations/${OPERATION_ID}`,
        },
      });
    }
    return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });
  await page.goto('/?view=tenant-people&tenant=demo');
  await page
    .getByRole('button', {
      name: `${th('tenantPeople:directory.open')} Original Name`,
      exact: true,
    })
    .click();
  return Object.assign(writes, { lookups });
}

async function fillRename(page: Page) {
  await page.getByRole('button', { name: th('tenantPeople:profile.start'), exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: th('tenantPeople:profile.title', { name: 'Original Name' }),
  });
  await dialog.getByRole('textbox', { name: th('tenantPeople:profile.newName') }).fill('New Name');
  await dialog
    .getByRole('textbox', { name: th('tenantPeople:invitation.reason') })
    .fill('User requested a name change');
  await dialog
    .getByRole('button', { name: th('tenantPeople:profile.submit'), exact: true })
    .click();
  return dialog;
}

async function pendingKeys(page: Page) {
  return page.evaluate(() =>
    Object.keys(sessionStorage).filter((key) => key.startsWith('dc:tenant-account:')),
  );
}

async function axe(page: Page) {
  // scan after the Dialog-open animation ends, otherwise the button color is still translucent
  await page.evaluate(() => Promise.all(document.getAnimations().map((item) => item.finished)));
  const result = await new AxeBuilder({ page })
    .include('[role="dialog"],[role="alertdialog"]')
    .analyze();
  expect(
    result.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? '')),
  ).toEqual([]);
}

for (const respond of ['success', 'busy', 'unknown'] as const)
  test(`edit display name ${respond}: sends revision/name/reason once, and shows the new name only after the result is confirmed`, async ({
    page,
  }) => {
    const writes = await mockPeople(page, { disabled: false, respond });
    // an active account has no re-enable panel
    await expect(page.getByRole('region', { name: th('tenantPeople:enable.title') })).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: th('tenantPeople:profile.start'), exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: th('tenantPeople:profile.title', { name: 'Original Name' }),
    });
    const name = dialog.getByRole('textbox', { name: th('tenantPeople:profile.newName') });
    await expect(name).toHaveValue('Original Name');
    const submit = dialog.getByRole('button', {
      name: th('tenantPeople:profile.submit'),
      exact: true,
    });
    await expect(submit).toBeDisabled();
    await name.fill('  New   Name ');
    await dialog
      .getByRole('textbox', { name: th('tenantPeople:invitation.reason') })
      .fill('User requested a name change');
    await axe(page);
    await submit.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      method: 'PATCH',
      body: {
        expectedRevision: 6,
        displayName: 'New Name',
        reason: 'User requested a name change',
      },
    });
    expect(Object.keys(writes[0]!.body).sort()).toEqual([
      'commandId',
      'displayName',
      'expectedRevision',
      'reason',
    ]);
    if (respond === 'busy') {
      await expect(dialog.getByRole('alert')).toContainText(
        th('tenantPeople:accountChange.errors.CONFIG_BUSY'),
      );
      await expect(name).toHaveValue('  New   Name ');
      expect(writes).toHaveLength(1);
      return;
    }
    await expect(dialog).toHaveCount(0);
    if (respond === 'unknown') {
      // not known whether the command was accepted: show the pending command and the check-result button, do not resend, the old name stays
      await expect(page.getByText(th('tenantPeople:profile.pending'))).toBeVisible();
      await expect(
        page.getByRole('alert').filter({ hasText: th('tenantPeople:accountChange.errors.FAILED') }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: th('tenantPeople:profile.start'), exact: true }),
      ).toBeDisabled();
      await expect(page.getByRole('heading', { name: 'Original Name' })).toBeVisible();
      expect(writes).toHaveLength(1);
      return;
    }
    await page
      .getByRole('button', { name: th('tenantPeople:profile.refresh'), exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: th('tenantPeople:profile.states.SUCCEEDED') }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'New Name' })).toBeVisible();
    expect(writes).toHaveLength(1);
  });

for (const respond of ['success', 'credentials', 'unknown', 'rejected'] as const)
  test(`re-enable account ${respond}: confirm in an alertdialog with a reason, the account stays disabled until the result is confirmed`, async ({
    page,
  }) => {
    const writes = await mockPeople(page, { disabled: true, respond });
    await expect(
      page.getByRole('button', { name: th('tenantPeople:profile.start'), exact: true }),
    ).toBeDisabled();
    const panel = page.getByRole('region', { name: th('tenantPeople:enable.title') });
    await expect(panel).toContainText(th('tenantPeople:enable.help'));
    await panel.getByRole('button', { name: th('tenantPeople:enable.start'), exact: true }).click();
    const dialog = page.getByRole('alertdialog', {
      name: th('tenantPeople:enable.dialogTitle', { name: 'Original Name' }),
    });
    await expect(dialog).toContainText('Sales Team');
    await expect(dialog).toContainText('1501');
    const submit = dialog.getByRole('button', {
      name: th('tenantPeople:enable.submit'),
      exact: true,
    });
    await expect(submit).toBeDisabled();
    await dialog
      .getByRole('textbox', { name: th('tenantPeople:invitation.reason') })
      .fill('Back from leave');
    await axe(page);
    await submit.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      method: 'POST',
      body: { expectedRevision: 6, reason: 'Back from leave' },
    });
    expect(Object.keys(writes[0]!.body).sort()).toEqual([
      'commandId',
      'expectedRevision',
      'reason',
    ]);
    if (respond === 'credentials') {
      await expect(dialog.getByRole('alert')).toContainText(
        th('tenantPeople:accountChange.errors.CREDENTIALS_NOT_READY'),
      );
      expect(writes).toHaveLength(1);
      return;
    }
    await expect(dialog).toHaveCount(0);
    if (respond === 'unknown') {
      await expect(panel).toContainText(th('tenantPeople:enable.pending'));
      await expect(panel.getByRole('alert')).toContainText(
        th('tenantPeople:accountChange.errors.FAILED'),
      );
      await expect(
        panel.getByRole('button', { name: th('tenantPeople:enable.start'), exact: true }),
      ).toBeDisabled();
      expect(writes).toHaveLength(1);
      return;
    }
    await panel
      .getByRole('button', { name: th('tenantPeople:enable.refresh'), exact: true })
      .click();
    if (respond === 'rejected') {
      await expect(panel.getByRole('status')).toContainText(
        th('tenantPeople:enable.states.REJECTED'),
      );
      await expect(
        panel.getByRole('button', { name: th('tenantPeople:enable.start'), exact: true }),
      ).toBeEnabled();
      return;
    }
    await expect(panel.getByRole('status')).toContainText(
      th('tenantPeople:enable.states.SUCCEEDED'),
    );
    await expect(
      page.getByRole('region', { name: th('tenantPeople:directory.detail') }),
    ).toContainText(th('tenantPeople:status.ACTIVE'));
    expect(writes).toHaveLength(1);
  });

test('not ready: the edit-name and re-enable buttons cannot be pressed', async ({ page }) => {
  const writes = await mockPeople(page, { disabled: true, ready: false, respond: 'success' });
  await expect(
    page
      .getByRole('region', { name: th('tenantPeople:enable.title') })
      .getByRole('button', { name: th('tenantPeople:enable.start') }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: th('tenantPeople:profile.start'), exact: true }),
  ).toBeDisabled();
  expect(writes).toHaveLength(0);
});

test('edit name gets 403: show the error in the Dialog, the detail page stays, no pending command, and can retry', async ({
  page,
}) => {
  const writes = await mockPeople(page, { disabled: false, respond: 'forbidden' });
  const dialog = await fillRename(page);
  await expect(dialog.getByRole('alert')).toContainText(
    th('tenantPeople:accountChange.errors.FORBIDDEN'),
  );
  // do not replace the whole page with FORBIDDEN: the account detail stays behind the Dialog
  await expect(
    page.getByRole('region', { name: th('tenantPeople:directory.detail') }),
  ).toBeVisible();
  await expect(page.getByText(th('tenantPeople:errors.FORBIDDEN'))).toHaveCount(0);
  expect(await pendingKeys(page)).toEqual([]);
  await dialog
    .getByRole('button', { name: th('tenantPeople:accountChange.cancel'), exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(th('tenantPeople:profile.pending'))).toHaveCount(0);
  await expect(page.getByRole('button', { name: th('tenantPeople:profile.refresh') })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: th('tenantPeople:profile.start'), exact: true }),
  ).toBeEnabled();
  expect(writes).toHaveLength(1);
  expect(writes.lookups).toEqual([]);
});

test('a pending command but the server cannot find it (404): clear the pending command, report, and allow editing the name again', async ({
  page,
}) => {
  const writes = await mockPeople(page, { disabled: false, respond: 'unknown' });
  const dialog = await fillRename(page);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(th('tenantPeople:profile.pending'))).toBeVisible();
  expect(await pendingKeys(page)).toHaveLength(1);
  // uncertain result: check the original command, the server answers 404 = this command was not recorded
  await page.getByRole('button', { name: th('tenantPeople:profile.refresh'), exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    th('tenantPeople:accountChange.errors.NOT_RECORDED'),
  );
  await expect(page.getByText(th('tenantPeople:profile.pending'))).toHaveCount(0);
  await expect(page.getByRole('button', { name: th('tenantPeople:profile.refresh') })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: th('tenantPeople:profile.start'), exact: true }),
  ).toBeEnabled();
  expect(await pendingKeys(page)).toEqual([]);
  expect(writes.lookups).toHaveLength(1);
  // no more polling after clearing the pending command
  await page.waitForTimeout(5_500);
  expect(writes.lookups).toHaveLength(1);
  expect(writes).toHaveLength(1);
});

test('an account from seed that People cannot edit: the edit-name and disable buttons cannot be pressed, with an explanation, before entering anything', async ({
  page,
}) => {
  const writes = await mockPeople(page, { disabled: false, unmanaged: true, respond: 'success' });
  await expect(
    page.getByRole('region', { name: th('tenantPeople:directory.detail') }),
  ).toContainText(th('tenantPeople:profile.notManaged'));
  await expect(
    page.getByRole('button', { name: th('tenantPeople:profile.start'), exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(th('tenantPeople:accountChange.notReady'))).toHaveCount(0);
  // disabling the account cannot be done through People either
  const disable = page.getByRole('region', { name: th('tenantPeople:disable.title'), exact: true });
  await expect(disable).toContainText(th('tenantPeople:disable.notManaged'));
  await expect(
    disable.getByRole('button', { name: th('tenantPeople:disable.start'), exact: true }),
  ).toBeDisabled();
  await expect(disable).not.toContainText(th('tenantPeople:disable.notEligible'));
  expect(writes).toHaveLength(0);
});

test('while loading capabilities: shows checking readiness, not "not ready"', async ({ page }) => {
  let release!: () => void;
  const capabilities = new Promise<void>((resolve) => (release = resolve));
  await mockPeople(page, { disabled: false, respond: 'success', capabilities });
  const detail = page.getByRole('region', { name: th('tenantPeople:directory.detail') });
  await expect(
    detail
      .getByRole('status')
      .filter({ hasText: th('tenantPeople:accountChange.checking') })
      .first(),
  ).toBeVisible();
  await expect(page.getByText(th('tenantPeople:accountChange.notReady'))).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: th('tenantPeople:profile.start'), exact: true }),
  ).toBeDisabled();
  release();
  await expect(
    page.getByRole('button', { name: th('tenantPeople:profile.start'), exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(th('tenantPeople:accountChange.checking'))).toHaveCount(0);
});
