import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { homeNavigation } from './support/home-navigation.js';
import { th } from './support/catalog';
test.use({ locale: 'th-TH' });

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const unresolved of [false, true])
  test(`Admin list/detail does not create duplicates and does not overwrite a pending unknown: ${unresolved}`, async ({
    page,
  }) => {
    const userId = '10000000-0000-4000-8000-000000000101';
    const operationId = '10000000-0000-4000-8000-000000000102';
    const commandId = '10000000-0000-4000-8000-000000000103';
    const account = {
      id: userId,
      displayName: 'Original Tester',
      email: 'synthetic@example.test',
      username: 'synthetic@example.test',
      role: 'ADMIN',
      teamId: null,
      extensionRef: null,
      configRevision: 1,
      accountState: 'PENDING_ACTIVATION',
      provisioningState: 'PROVISIONED',
      activationState: 'PENDING',
      statusRevision: 7,
      operationId,
      commandId,
    };
    let mutations = 0,
      details = 0,
      operationReads = 0;
    await page.route('**/api/v1/me/navigation**', (route) =>
      route.fulfill({ json: homeNavigation(['admin'], true) }),
    );
    await page.route('**/api/v1/tenant-voice/**', (route) => {
      const path = new URL(route.request().url()).pathname.split('/tenant-voice/')[1];
      if (route.request().method() !== 'GET') {
        mutations++;
        return route.fulfill({ status: 500 });
      }
      if (path === 'capabilities')
        return route.fulfill({ json: { canWrite: true, peopleProvisioning: { ready: true } } });
      if (path === 'teams' || path === 'extension-pool')
        return route.fulfill({ json: { items: [] } });
      if (path === 'people/users')
        return route.fulfill({ json: { items: [account], nextCursor: null } });
      if (path === `people/users/${userId}`) {
        details++;
        return route.fulfill({ json: account });
      }
      if (path === `operations/${operationId}`) {
        operationReads++;
        return route.fulfill({ json: { operationId, userId, state: 'SUCCEEDED', ...account } });
      }
      return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    });
    if (unresolved)
      await page.addInitScript(() =>
        sessionStorage.setItem(
          'dc:tenant-people:pending:e2e-people',
          JSON.stringify({ commandId: '10000000-0000-4000-8000-000000000104' }),
        ),
      );
    await page.goto('/?view=tenant-people&tenant=demo');
    await expect(
      page.getByRole('heading', { name: th('tenantPeople:directory.title') }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: `${th('tenantPeople:directory.open')} Original Tester`,
        exact: true,
      })
      .click();
    const detail = page.getByRole('region', { name: th('tenantPeople:directory.detail') });
    await expect(detail).toContainText('synthetic@example.test');
    if (unresolved) {
      await expect(
        page.getByRole('button', { name: th('tenantPeople:directory.status'), exact: true }),
      ).toBeDisabled();
      expect(operationReads).toBe(0);
      expect(mutations).toBe(0);
      return;
    }
    await page
      .getByRole('button', { name: th('tenantPeople:directory.status'), exact: true })
      .click();
    await expect(
      page
        .getByText(new RegExp(`^${escapeRegExp(th('tenantPeople:banner.body.PROVISIONED'))}`))
        .first(),
    ).toBeVisible();
    expect(details).toBe(1);
    await page.reload();
    await expect(
      page.getByRole('button', {
        name: `${th('tenantPeople:directory.open')} Original Tester`,
        exact: true,
      }),
    ).toBeVisible();
    expect(operationReads).toBeGreaterThanOrEqual(1);
    expect(mutations).toBe(0);
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter((item) =>
        ['serious', 'critical'].includes(item.impact ?? ''),
      ),
    ).toEqual([]);
  });
