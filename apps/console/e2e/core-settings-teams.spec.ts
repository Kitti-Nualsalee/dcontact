import { test, expect } from '@playwright/test';
import { coreLogin } from './core-settings-helpers.js';
import { th } from './support/catalog';
test('team: Admin creates a team through the UI then reads it back from the real API', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await expect(
    page.getByRole('heading', { name: th('coreSettings:team.title'), exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }).click();
  await page
    .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
    .fill('Browser test team');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:team.name'), exact: true }),
  ).toHaveValue('Browser test team');
  await expect(page).toHaveURL(/team=[a-f0-9-]{36}/);
});
test('team: a lost create response then reload checks the original command and does not create a duplicate team', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }).click();
  await page
    .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
    .fill('Create recovery team');
  await request.post('/__core_test/fault/lost-response');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.UNKNOWN'));
  const refs = await page.evaluate(() =>
    Object.entries(sessionStorage).filter(([key]) => key.startsWith('dc:core-settings:command:')),
  );
  expect(refs).toHaveLength(1);
  expect(refs[0][1]).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(refs)).not.toContain('Create recovery team');
  page.once('dialog', (d) => d.accept());
  await page.reload();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  await expect(
    page.getByRole('heading', { name: 'Create recovery team', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create recovery team', exact: true })).toHaveCount(
    1,
  );
});
test('team: rename/no-op → confirm deactivate → an inactive team can still be renamed and keeps the same UUID', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }).click();
  const name = page.getByRole('textbox', { name: th('coreSettings:team.name'), exact: true });
  await name.fill('Team to close');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  const id = new URL(page.url()).searchParams.get('team');
  await name.fill(' Team to close ');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.NO_OP'));
  await page.getByRole('button', { name: th('coreSettings:team.close'), exact: true }).click();
  await page.getByRole('button', { name: th('coreSettings:team.deactivate'), exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Team to close');
  await page.getByRole('button', { name: th('coreSettings:team.cancel'), exact: true }).click();
  await expect(
    page.getByRole('button', { name: th('coreSettings:team.deactivate'), exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: th('coreSettings:team.deactivate'), exact: true }).click();
  await page.getByRole('button', { name: th('coreSettings:team.confirm'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  await expect(
    page.getByRole('button', { name: th('coreSettings:team.deactivate'), exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: th('coreSettings:team.rename'), exact: true }).click();
  await name.fill('Renamed closed team');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  expect(new URL(page.url()).searchParams.get('team')).toBe(id);
  await expect(page.getByRole('link', { name: 'Renamed closed team', exact: true })).toBeVisible();
});
test('team: a current reference rejects deactivate with the type and count', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('link', { name: 'Core care', exact: true }).click();
  await page.getByRole('button', { name: th('coreSettings:team.deactivate'), exact: true }).click();
  await page.getByRole('button', { name: th('coreSettings:team.confirm'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.TEAM_REFERENCED'));
  await expect(page.getByRole('status')).toContainText(
    `${th('coreSettings:team.blockers.USER_REFERENCE')}:`,
  );
  await expect(page.getByRole('button', { name: th('coreSettings:loadLatest') })).toBeVisible();
});
test('team: two Admins editing in a clash, the draft is not overwritten', async ({
  page,
  request,
  browser,
}) => {
  await coreLogin(page, request);
  await page.getByRole('link', { name: 'Core care', exact: true }).click();
  const otherContext = await browser.newContext({ locale: 'th-TH' });
  const other = await otherContext.newPage();
  try {
    await coreLogin(other, request, 'admin-two');
    await other.getByRole('link', { name: 'Core care', exact: true }).click();
    for (const p of [page, other])
      await p.getByRole('button', { name: th('coreSettings:team.rename'), exact: true }).click();
    await page
      .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
      .fill('Team edited by Admin one');
    await other
      .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
      .fill('Team draft by Admin two');
    await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
    await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
    await other.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
    await expect(other.getByRole('status')).toContainText(
      th('coreSettings:status.REVISION_CONFLICT'),
    );
    await expect(
      other.getByRole('textbox', { name: th('coreSettings:team.name'), exact: true }),
    ).toHaveValue('Team draft by Admin two');
    other.once('dialog', (d) => d.accept());
    await other.getByRole('button', { name: th('coreSettings:loadLatest') }).click();
    await other
      .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
      .fill('Core care');
    await other.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
    await expect(other.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  } finally {
    await otherContext.close();
  }
});
test('team: validation/duplicate keep the draft and keyboard Escape returns focus', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }).click();
  const name = page.getByRole('textbox', { name: th('coreSettings:team.name'), exact: true });
  await name.fill(' ');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByText(th('coreSettings:team.validation'))).toBeVisible();
  await name.fill('Core care');
  await name.press('Enter');
  await expect(page.getByRole('status')).toContainText(
    th('coreSettings:status.TEAM_NAME_CONFLICT'),
  );
  await expect(name).toHaveValue('Core care');
  page.once('dialog', (d) => d.dismiss());
  await name.press('Escape');
  await expect(name).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await name.press('Escape');
  await expect(
    page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }),
  ).toBeFocused();
});
test('team: Supervisor own team is read-only and a direct link to another team shows no data', async ({
  page,
  request,
}) => {
  const config = await coreLogin(page, request, 'supervisor');
  await expect(page.getByRole('link', { name: 'Core care', exact: true })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Core care', exact: true }).click();
  await expect(page.getByText(th('coreSettings:readOnly'))).toBeVisible();
  await expect(
    page.getByRole('button', { name: th('coreSettings:team.rename'), exact: true }),
  ).toHaveCount(0);
  await page.goto(
    `/?tenant=${config.tenant}&view=core-settings&page=teams&team=11111111-1111-4111-8111-111111111111`,
  );
  await expect(page.getByRole('status')).toContainText(
    th('coreSettings:status.RESOURCE_NOT_FOUND'),
  );
  await expect(page.getByRole('link', { name: 'Core care', exact: true })).toHaveCount(0);
});
test('team: narrow during a draft is readonly, widening rechecks and keeps the draft', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }).click();
  await page
    .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
    .fill('Narrow screen team draft');
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(page.getByText(th('coreSettings:draftKept'))).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:team.name'), exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:team.name'), exact: true }),
  ).toHaveValue('Narrow screen team draft');
  await expect(
    page.getByRole('button', { name: th('coreSettings:save'), exact: true }),
  ).toBeEnabled();
});
test('team: shrinking the screen during close-team confirmation must hide the mutation and not close the team', async ({
  page,
  request,
}) => {
  const config = await coreLogin(page, request);
  const history = await (await request.post('/__core_test/history')).json();
  await page.goto(`/?tenant=${config.tenant}&view=core-settings&page=teams&team=${history.id}`);
  await page.getByRole('button', { name: th('coreSettings:team.deactivate'), exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(
    page.getByRole('button', { name: th('coreSettings:team.confirm'), exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(
    page.getByRole('button', { name: th('coreSettings:team.deactivate'), exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
test('team: history-only can be closed, while an unresolved legacy blocks only closing the team', async ({
  page,
  request,
}) => {
  const config = await coreLogin(page, request);
  const history = await (await request.post('/__core_test/history')).json();
  await page.goto(`/?tenant=${config.tenant}&view=core-settings&page=teams&team=${history.id}`);
  await page.getByRole('button', { name: th('coreSettings:team.deactivate'), exact: true }).click();
  await page.getByRole('button', { name: th('coreSettings:team.confirm'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  await request.post('/__core_test/unresolved');
  try {
    await page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }).click();
    await page
      .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
      .fill('Team during Legacy check');
    await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
    await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
    await page.getByRole('button', { name: th('coreSettings:team.close'), exact: true }).click();
    await page
      .getByRole('button', { name: th('coreSettings:team.deactivate'), exact: true })
      .click();
    await page.getByRole('button', { name: th('coreSettings:team.confirm'), exact: true }).click();
    await expect(page.getByRole('status')).toContainText(
      th('coreSettings:status.TEAM_REFERENCE_UNRESOLVED'),
    );
    await expect(page.getByRole('status')).toContainText(
      `${th('coreSettings:team.blockers.UNRESOLVED_CURRENT_REFERENCE')}: 1`,
    );
  } finally {
    await request.post('/__core_test/resolve');
  }
});
test('team: busy from a real DB fence → reconcile and a late POST causes no delayed apply', async ({
  page,
  request,
}) => {
  const config = await coreLogin(page, request);
  const history = await (await request.post('/__core_test/history')).json();
  await page.goto(`/?tenant=${config.tenant}&view=core-settings&page=teams&team=${history.id}`);
  await request.post('/__core_test/fault/busy');
  await page.getByRole('button', { name: th('coreSettings:team.deactivate'), exact: true }).click();
  await page.getByRole('button', { name: th('coreSettings:team.confirm'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.CONFIG_BUSY'));
  await page.getByRole('button', { name: th('coreSettings:checkResult') }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.NOT_APPLIED'));
  await page.getByRole('button', { name: th('coreSettings:loadLatest') }).click();
  await page.getByRole('button', { name: th('coreSettings:team.rename'), exact: true }).click();
  await page
    .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
    .fill('Name that must not arrive late');
  await request.post('/__core_test/fault/late-request');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.UNKNOWN'));
  await page.getByRole('button', { name: th('coreSettings:checkResult') }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.NOT_APPLIED'));
  expect((await (await request.post('/__core_test/release')).json()).status).toBe(409);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: th('coreSettings:loadLatest') }).click();
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:team.name'), exact: true }),
  ).toHaveValue(history.name);
});
test('team: a missing readback does not report success until the original receipt is checked, and reauth keeps the draft', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('link', { name: 'Core care', exact: true }).click();
  await page.getByRole('button', { name: th('coreSettings:team.rename'), exact: true }).click();
  const name = page.getByRole('textbox', { name: th('coreSettings:team.name'), exact: true });
  await name.fill('Team awaiting readback');
  await request.post('/__core_test/fault/readback');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.UNKNOWN'));
  await page.getByRole('button', { name: th('coreSettings:checkResult') }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  await name.fill('Team draft before reauth');
  await request.post('/__core_test/fault/reauth');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.REAUTH'));
  await page.getByRole('button', { name: th('coreSettings:signIn'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.NOT_APPLIED'));
  await expect(name).toHaveValue('Team draft before reauth');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: th('coreSettings:loadLatest') }).click();
  await name.fill('Core care');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
});
test('team: revoking permission while a draft exists must hide the data and not use the old capability', async ({
  page,
  request,
}) => {
  await request.post('/__core_test/restore');
  await coreLogin(page, request);
  await page.getByRole('link', { name: 'Core care', exact: true }).click();
  await page.getByRole('button', { name: th('coreSettings:team.rename'), exact: true }).click();
  await page
    .getByRole('textbox', { name: th('coreSettings:team.name'), exact: true })
    .fill('Draft to clear on revoke');
  await request.post('/__core_test/revoke');
  try {
    await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
    await expect(page.getByRole('status')).toContainText(th('coreSettings:status.FORBIDDEN'));
    await expect(
      page.getByRole('textbox', { name: th('coreSettings:team.name'), exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Core care', exact: true })).toHaveCount(0);
  } finally {
    await request.post('/__core_test/restore');
  }
});
for (const alias of ['agent', 'compliance', 'unbound', 'disabled', 'foreign']) {
  test(`team: ${alias} has no Core access and shows no Team metadata`, async ({
    page,
    request,
  }) => {
    await coreLogin(page, request, alias);
    await expect(page.getByText(th('coreSettings:status.FORBIDDEN'))).toBeVisible();
    await expect(page.getByRole('link', { name: 'Core care', exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: th('coreSettings:team.create'), exact: true }),
    ).toHaveCount(0);
  });
}
