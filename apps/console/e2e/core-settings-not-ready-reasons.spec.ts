import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { coreLogin } from './core-settings-helpers.js';
import { th } from './support/catalog';

// default reasons seeded by migration 20261121100000_core_not_ready_reasons
const SEED = {
  shortBreak: 'พักสั้น', // allow-thai: seed reason from the migration
  lunch: 'พักเที่ยง', // allow-thai: seed reason from the migration
  meeting: 'ประชุม', // allow-thai: seed reason from the migration
  training: 'อบรม', // allow-thai: seed reason from the migration
  coaching: 'โค้ช/ประเมิน', // allow-thai: seed reason from the migration
  backOffice: 'งานหลังบ้าน', // allow-thai: seed reason from the migration
  personal: 'ธุระส่วนตัว', // allow-thai: seed reason from the migration
};

/**
 * #936 the Not Ready reasons page in Core Settings — real Console → Keycloak → API/RLS
 * `NOT_READY_REASONS_EVIDENCE_DIR=<dir>` = collect evidence screenshots for the PR
 */
async function evidence(page: Page, name: string) {
  const dir = process.env.NOT_READY_REASONS_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}
async function openReasons(page: Page) {
  await page
    .getByRole('link', {
      name: th('common:navigation.pages.coreSettings.notReadyReasons'),
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', { name: th('coreSettings:notReadyReasons.title'), level: 1 }),
  ).toBeVisible();
  await expect(list(page).getByRole('listitem')).toHaveCount(7);
}
/** the react-aria Switch hides the input — toggle by keyboard the way a user does */
async function toggle(page: Page, name: string) {
  await page.getByRole('switch', { name }).focus();
  await page.keyboard.press('Space');
}
const list = (page: Page) =>
  page.getByRole('list', { name: th('coreSettings:notReadyReasons.listTitle') });
const row = (page: Page, index: number) => list(page).getByRole('listitem').nth(index);
const thaiNames = (page: Page) =>
  list(page)
    .getByRole('textbox', { name: th('coreSettings:notReadyReasons.labelTh') })
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));

test('Admin: rename, reorder, disable, add and delete, then save once — reloading returns the same list', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await openReasons(page);
  expect(await thaiNames(page)).toEqual(Object.values(SEED));
  const save = page.getByRole('button', { name: th('coreSettings:save'), exact: true });
  await expect(save).toBeDisabled();

  await row(page, 1)
    .getByRole('textbox', { name: th('coreSettings:notReadyReasons.labelTh') })
    .fill('Lunch break');
  await page
    .getByRole('button', {
      name: th('coreSettings:notReadyReasons.moveUp', { reason: 'Lunch break' }),
    })
    .click();
  await expect(
    page.getByRole('button', {
      name: th('coreSettings:notReadyReasons.moveDown', { reason: 'Lunch break' }),
    }),
  ).toBeVisible();
  await toggle(page, th('coreSettings:notReadyReasons.activeFor', { reason: SEED.meeting }));
  await page
    .getByRole('button', {
      name: th('coreSettings:notReadyReasons.remove', { reason: SEED.personal }),
    })
    .click();
  await page.getByRole('button', { name: th('coreSettings:notReadyReasons.add') }).click();
  await expect(
    row(page, 6).getByRole('textbox', { name: th('coreSettings:notReadyReasons.labelTh') }),
  ).toBeFocused();
  await row(page, 6)
    .getByRole('textbox', { name: th('coreSettings:notReadyReasons.labelTh') })
    .fill('Quality review');
  await row(page, 6)
    .getByRole('textbox', { name: th('coreSettings:notReadyReasons.labelEn') })
    .fill('Quality check');

  const axe = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);

  await evidence(page, 'not-ready-reasons-draft');
  await save.click();
  await expect(page.getByRole('status')).toContainText(
    th('coreSettings:notReadyReasons.status.SAVED'),
  );
  await expect(save).toBeDisabled();

  await page.reload();
  await expect(list(page).getByRole('listitem')).toHaveCount(7);
  expect(await thaiNames(page)).toEqual([
    'Lunch break',
    SEED.shortBreak,
    SEED.meeting,
    SEED.training,
    SEED.coaching,
    SEED.backOffice,
    'Quality review',
  ]);
  await expect(
    page.getByRole('switch', {
      name: th('coreSettings:notReadyReasons.activeFor', { reason: SEED.meeting }),
    }),
  ).not.toBeChecked();
});

test('disabling every reason → cannot save and it says at least one must be enabled; a duplicate name → the server points at the row', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await openReasons(page);
  // an earlier round in this file already disabled some reasons — disable only those still enabled
  for (const name of await thaiNames(page))
    if (
      await page
        .getByRole('switch', {
          name: th('coreSettings:notReadyReasons.activeFor', { reason: name }),
        })
        .isChecked()
    )
      await toggle(page, th('coreSettings:notReadyReasons.activeFor', { reason: name }));
  await expect(
    page.getByRole('alert').filter({
      hasText: th('coreSettings:notReadyReasons.validation.notReadyReasonActiveRequired'),
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: th('coreSettings:save'), exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: th('coreSettings:cancel'), exact: true }).click();

  const [first] = await thaiNames(page);
  await row(page, 1)
    .getByRole('textbox', { name: th('coreSettings:notReadyReasons.labelTh') })
    .fill(first!);
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText(
    th('coreSettings:notReadyReasons.status.VALIDATION'),
  );
  await expect(row(page, 1)).toContainText(
    th('coreSettings:notReadyReasons.validation.notReadyReasonDuplicate'),
  );
});

test('EN: the page text changes with the language without dropping the draft', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await openReasons(page);
  await row(page, 0)
    .getByRole('textbox', { name: th('coreSettings:notReadyReasons.labelTh') })
    .fill('Short break 10 min');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Not Ready reasons', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Reasons' }).getByRole('textbox', { name: 'Thai name' }).first(),
  ).toHaveValue('Short break 10 min');
  await expect(page.getByRole('button', { name: 'Add reason' })).toBeVisible();
  await page.getByRole('button', { name: th('ui:shell.languageNames.th'), exact: true }).click();
});

test('a late reasons reply does not overwrite the draft typed after the list appeared', async ({
  page,
  request,
}) => {
  // React StrictMode (the dev server) runs the load effect twice — hold the first read so it
  // answers only after the draft is typed. A single read (production build) is released by the timeout.
  let held = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let late: Promise<unknown> | undefined;
  await page.route(/\/core-settings\/not-ready-reasons$/, async (route) => {
    if (route.request().method() !== 'GET' || held) return route.continue();
    held = true;
    late = page.waitForResponse((response) => response.request() === route.request());
    const response = await route.fetch();
    await Promise.race([released, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    await route.fulfill({ response });
  });
  await coreLogin(page, request);
  await openReasons(page);
  const first = row(page, 0).getByRole('textbox', {
    name: th('coreSettings:notReadyReasons.labelTh'),
  });
  await first.fill('Draft typed early');
  release();
  await late;
  // let React apply whatever the late reply would set
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100))),
  );
  await expect(first).toHaveValue('Draft typed early');
  await expect(
    page.getByRole('button', { name: th('coreSettings:save'), exact: true }),
  ).toBeEnabled();
});
