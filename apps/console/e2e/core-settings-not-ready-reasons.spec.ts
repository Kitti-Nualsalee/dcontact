import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { coreLogin } from './core-settings-helpers.js';

/**
 * #936 the Not Ready reasons page in Core Settings — real Console → Keycloak → API/RLS
 * `NOT_READY_REASONS_EVIDENCE_DIR=<dir>` = collect evidence screenshots for the PR
 */
async function evidence(page: Page, name: string) {
  const dir = process.env.NOT_READY_REASONS_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}
async function openReasons(page: Page) {
  await page.getByRole('link', { name: 'เหตุผล Not Ready', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'เหตุผล Not Ready', level: 1 })).toBeVisible();
  await expect(list(page).getByRole('listitem')).toHaveCount(7);
}
/** the react-aria Switch hides the input — toggle by keyboard the way a user does */
async function toggle(page: Page, name: string) {
  await page.getByRole('switch', { name }).focus();
  await page.keyboard.press('Space');
}
const list = (page: Page) => page.getByRole('list', { name: 'รายการเหตุผล' });
const row = (page: Page, index: number) => list(page).getByRole('listitem').nth(index);
const thaiNames = (page: Page) =>
  list(page)
    .getByRole('textbox', { name: 'ชื่อภาษาไทย' })
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));

test('Admin: rename, reorder, disable, add and delete, then save once — reloading returns the same list', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await openReasons(page);
  expect(await thaiNames(page)).toEqual([
    'พักสั้น',
    'พักเที่ยง',
    'ประชุม',
    'อบรม',
    'โค้ช/ประเมิน',
    'งานหลังบ้าน',
    'ธุระส่วนตัว',
  ]);
  const save = page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true });
  await expect(save).toBeDisabled();

  await row(page, 1).getByRole('textbox', { name: 'ชื่อภาษาไทย' }).fill('พักกลางวัน');
  await page.getByRole('button', { name: 'เลื่อน พักกลางวัน ขึ้น' }).click();
  await expect(page.getByRole('button', { name: 'เลื่อน พักกลางวัน ลง' })).toBeVisible();
  await toggle(page, 'เปิดใช้เหตุผล ประชุม');
  await page.getByRole('button', { name: 'ลบ ธุระส่วนตัว' }).click();
  await page.getByRole('button', { name: 'เพิ่มเหตุผล' }).click();
  await expect(row(page, 6).getByRole('textbox', { name: 'ชื่อภาษาไทย' })).toBeFocused();
  await row(page, 6).getByRole('textbox', { name: 'ชื่อภาษาไทย' }).fill('ตรวจคุณภาพ');
  await row(page, 6).getByRole('textbox', { name: 'ชื่อภาษาอังกฤษ' }).fill('Quality check');

  const axe = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);

  await evidence(page, 'not-ready-reasons-draft');
  await save.click();
  await expect(page.getByRole('status')).toContainText('บันทึกรายการเหตุผลแล้ว');
  await expect(save).toBeDisabled();

  await page.reload();
  await expect(list(page).getByRole('listitem')).toHaveCount(7);
  expect(await thaiNames(page)).toEqual([
    'พักกลางวัน',
    'พักสั้น',
    'ประชุม',
    'อบรม',
    'โค้ช/ประเมิน',
    'งานหลังบ้าน',
    'ตรวจคุณภาพ',
  ]);
  await expect(page.getByRole('switch', { name: 'เปิดใช้เหตุผล ประชุม' })).not.toBeChecked();
});

test('disabling every reason → cannot save and it says at least one must be enabled; a duplicate name → the server points at the row', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await openReasons(page);
  // an earlier round in this file already disabled some reasons — disable only those still enabled
  for (const name of await thaiNames(page))
    if (await page.getByRole('switch', { name: `เปิดใช้เหตุผล ${name}` }).isChecked())
      await toggle(page, `เปิดใช้เหตุผล ${name}`);
  await expect(
    page.getByRole('alert').filter({ hasText: 'ต้องเปิดอย่างน้อยหนึ่งเหตุผล' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'ยกเลิกการแก้ไข', exact: true }).click();

  const [first] = await thaiNames(page);
  await row(page, 1).getByRole('textbox', { name: 'ชื่อภาษาไทย' }).fill(first!);
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('ตรวจข้อมูลที่ไฮไลต์');
  await expect(row(page, 1)).toContainText('ชื่อนี้ซ้ำกับเหตุผลอื่น');
});

test('EN: the page text changes with the language without dropping the draft', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await openReasons(page);
  await row(page, 0).getByRole('textbox', { name: 'ชื่อภาษาไทย' }).fill('พักสั้น 10 นาที');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Not Ready reasons', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Reasons' }).getByRole('textbox', { name: 'Thai name' }).first(),
  ).toHaveValue('พักสั้น 10 นาที');
  await expect(page.getByRole('button', { name: 'Add reason' })).toBeVisible();
  await page.getByRole('button', { name: 'ไทย', exact: true }).click();
});
