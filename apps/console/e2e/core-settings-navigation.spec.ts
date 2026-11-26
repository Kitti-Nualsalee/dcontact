import { test, expect } from '@playwright/test';
import { coreLogin } from './core-settings-helpers.js';
import { th } from './support/catalog';
test('menu: organization↔team as an SPA with back/forward and dirty cancel', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await expect(
    page.getByRole('heading', { name: th('coreSettings:team.title'), exact: true }),
  ).toBeVisible();
  let loads = 0;
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) loads++;
  });
  await page
    .getByRole('link', {
      name: th('common:navigation.pages.coreSettings.organization'),
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
  ).toBeVisible();
  expect(loads).toBe(0);
  await page
    .getByRole('textbox', { name: th('coreSettings:name'), exact: true })
    .fill('Draft before section change');
  page.once('dialog', (d) => d.dismiss());
  await page
    .getByRole('link', { name: th('common:navigation.pages.coreSettings.teams'), exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
  ).toHaveValue('Draft before section change');
  page.once('dialog', (d) => d.accept());
  await page
    .getByRole('link', { name: th('common:navigation.pages.coreSettings.teams'), exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: th('coreSettings:team.title'), exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole('heading', { name: th('coreSettings:team.title'), exact: true }),
  ).toBeVisible();
});
test('menu: Team TH/EN changes the text on the same page and has production deep links', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await expect(
    page.getByRole('heading', { name: th('coreSettings:team.title'), exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create team', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Teams', exact: true })).toHaveAttribute(
    'href',
    /view=core-settings&page=teams/,
  );
  await expect(page.getByRole('link', { name: /Calendar/ })).toHaveCount(0);
  await page.getByRole('button', { name: th('ui:shell.languageNames.th'), exact: true }).click();
  await expect(
    page.getByRole('heading', { name: th('coreSettings:team.title'), exact: true }),
  ).toBeVisible();
});
test('menu: back during a create UNKNOWN, then cancel, must keep the original command URL', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page
    .getByRole('link', {
      name: th('common:navigation.pages.coreSettings.organization'),
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: th('common:navigation.pages.coreSettings.teams'), exact: true })
    .click();
  await page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }).click();
  await page
    .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
    .fill('Team cancel Back');
  await request.post('/__core_test/fault/lost-response');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.UNKNOWN'));
  const pendingUrl = page.url();
  page.once('dialog', (d) => d.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(pendingUrl);
  await page.getByRole('button', { name: th('coreSettings:checkResult') }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
});
test('menu: returning to the team list after create must clear the detail even if the route was the same before opening the dialog', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }).click();
  await page
    .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
    .fill('Team back to list after create');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  await page.getByRole('button', { name: th('coreSettings:team.close'), exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Team back to list after create', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: th('common:navigation.pages.coreSettings.teams'), exact: true })
    .click();
  await expect(page).toHaveURL((url) => !url.searchParams.has('team'));
  await expect(
    page.getByRole('heading', { name: 'Team back to list after create', exact: true }),
  ).toHaveCount(0);
});
test('menu: an older API metadata with no pages/areas uses the fallback to reach the real organization and teams', async ({
  page,
  request,
}) => {
  await request.post('/__core_test/navigation-legacy');
  try {
    await coreLogin(page, request);
    const fallback = page.getByRole('navigation', { name: th('coreSettings:title'), exact: true });
    await expect(
      fallback.getByRole('link', { name: th('coreSettings:profile'), exact: true }),
    ).toBeVisible();
    await fallback.getByRole('link', { name: th('coreSettings:profile'), exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
    ).toBeVisible();
    await fallback.getByRole('link', { name: th('coreSettings:team.title'), exact: true }).click();
    await expect(
      page.getByRole('heading', { name: th('coreSettings:team.title'), exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Core care', exact: true })).toBeVisible();
  } finally {
    await request.post('/__core_test/restore');
  }
});
