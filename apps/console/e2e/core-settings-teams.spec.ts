import { test, expect } from '@playwright/test';
import { coreLogin } from './core-settings-helpers.js';
test('team: Admin creates a team through the UI then reads it back from the real API', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await expect(page.getByRole('heading', { name: 'ทีม', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'สร้างทีม', exact: true }).click();
  await page.getByRole('textbox', { name: 'ชื่อทีม', exact: true }).fill('ทีมทดสอบ Browser');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  await expect(page.getByRole('textbox', { name: 'ชื่อทีม', exact: true })).toHaveValue(
    'ทีมทดสอบ Browser',
  );
  await expect(page).toHaveURL(/team=[a-f0-9-]{36}/);
});
test('team: a lost create response then reload checks the original command and does not create a duplicate team', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('button', { name: 'สร้างทีม', exact: true }).click();
  await page.getByRole('textbox', { name: 'ชื่อทีม', exact: true }).fill('ทีมกู้ผล Create');
  await request.post('/__core_test/fault/lost-response');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ยังยืนยันผลบันทึกไม่ได้');
  const refs = await page.evaluate(() =>
    Object.entries(sessionStorage).filter(([key]) => key.startsWith('dc:core-settings:command:')),
  );
  expect(refs).toHaveLength(1);
  expect(refs[0][1]).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(refs)).not.toContain('ทีมกู้ผล Create');
  page.once('dialog', (d) => d.accept());
  await page.reload();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  await expect(page.getByRole('heading', { name: 'ทีมกู้ผล Create', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ทีมกู้ผล Create', exact: true })).toHaveCount(1);
});
test('team: rename/no-op → confirm deactivate → an inactive team can still be renamed and keeps the same UUID', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('button', { name: 'สร้างทีม', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'ชื่อทีม', exact: true });
  await name.fill('ทีมทดสอบปิด');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  const id = new URL(page.url()).searchParams.get('team');
  await name.fill(' ทีมทดสอบปิด ');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ข้อมูลเหมือนเดิม');
  await page.getByRole('button', { name: 'ปิดหน้าต่าง', exact: true }).click();
  await page.getByRole('button', { name: 'ปิดทีม', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('ทีมทดสอบปิด');
  await page.getByRole('button', { name: 'ยกเลิก', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ปิดทีม', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'ปิดทีม', exact: true }).click();
  await page.getByRole('button', { name: 'ยืนยันปิดทีม', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  await expect(page.getByRole('button', { name: 'ปิดทีม', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'เปลี่ยนชื่อทีม', exact: true }).click();
  await name.fill('ทีมปิดเปลี่ยนชื่อแล้ว');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  expect(new URL(page.url()).searchParams.get('team')).toBe(id);
  await expect(
    page.getByRole('link', { name: 'ทีมปิดเปลี่ยนชื่อแล้ว', exact: true }),
  ).toBeVisible();
});
test('team: a current reference rejects deactivate with the type and count', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('link', { name: 'Core care', exact: true }).click();
  await page.getByRole('button', { name: 'ปิดทีม', exact: true }).click();
  await page.getByRole('button', { name: 'ยืนยันปิดทีม', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ยังปิดทีมไม่ได้');
  await expect(page.getByRole('status')).toContainText('บัญชีผู้ใช้:');
  await expect(page.getByRole('button', { name: 'โหลดค่าล่าสุดและเริ่มแก้ใหม่' })).toBeVisible();
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
      await p.getByRole('button', { name: 'เปลี่ยนชื่อทีม', exact: true }).click();
    await page.getByRole('textbox', { name: 'ชื่อทีม', exact: true }).fill('Admin หนึ่งแก้ทีม');
    await other.getByRole('textbox', { name: 'ชื่อทีม', exact: true }).fill('ร่างทีม Admin สอง');
    await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
    await other.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
    await expect(other.getByRole('status')).toContainText('ข้อมูลถูกแก้ไขแล้ว');
    await expect(other.getByRole('textbox', { name: 'ชื่อทีม', exact: true })).toHaveValue(
      'ร่างทีม Admin สอง',
    );
    other.once('dialog', (d) => d.accept());
    await other.getByRole('button', { name: 'โหลดค่าล่าสุดและเริ่มแก้ใหม่' }).click();
    await other.getByRole('textbox', { name: 'ชื่อทีม', exact: true }).fill('Core care');
    await other.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
    await expect(other.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  } finally {
    await otherContext.close();
  }
});
test('team: validation/duplicate keep the draft and keyboard Escape returns focus', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('button', { name: 'สร้างทีม', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'ชื่อทีม', exact: true });
  await name.fill(' ');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByText('กรอกชื่อ 1–80 ตัวอักษร โดยไม่ใช้อักขระควบคุม')).toBeVisible();
  await name.fill('Core care');
  await name.press('Enter');
  await expect(page.getByRole('status')).toContainText('ชื่อทีมนี้มีอยู่แล้ว');
  await expect(name).toHaveValue('Core care');
  page.once('dialog', (d) => d.dismiss());
  await name.press('Escape');
  await expect(name).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await name.press('Escape');
  await expect(page.getByRole('button', { name: 'สร้างทีม', exact: true })).toBeFocused();
});
test('team: Supervisor own team is read-only and a direct link to another team shows no data', async ({
  page,
  request,
}) => {
  const config = await coreLogin(page, request, 'supervisor');
  await expect(page.getByRole('link', { name: 'Core care', exact: true })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'สร้างทีม', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Core care', exact: true }).click();
  await expect(page.getByText('คุณมีสิทธิ์ดูข้อมูลเท่านั้น')).toBeVisible();
  await expect(page.getByRole('button', { name: 'เปลี่ยนชื่อทีม', exact: true })).toHaveCount(0);
  await page.goto(
    `/?tenant=${config.tenant}&view=core-settings&page=teams&team=11111111-1111-4111-8111-111111111111`,
  );
  await expect(page.getByRole('status')).toContainText('ไม่พบทีม');
  await expect(page.getByRole('link', { name: 'Core care', exact: true })).toHaveCount(0);
});
test('team: narrow during a draft is readonly, widening rechecks and keeps the draft', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('button', { name: 'สร้างทีม', exact: true }).click();
  await page.getByRole('textbox', { name: 'ชื่อทีม', exact: true }).fill('ร่างทีมจอแคบ');
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(
    page.getByText('ร่างยังอยู่ในหน้านี้ เมื่อขยายจอจะตรวจข้อมูลและสิทธิ์ล่าสุดก่อนแก้ต่อ'),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'ชื่อทีม', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('textbox', { name: 'ชื่อทีม', exact: true })).toHaveValue(
    'ร่างทีมจอแคบ',
  );
  await expect(
    page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }),
  ).toBeEnabled();
});
test('team: shrinking the screen during close-team confirmation must hide the mutation and not close the team', async ({
  page,
  request,
}) => {
  const config = await coreLogin(page, request);
  const history = await (await request.post('/__core_test/history')).json();
  await page.goto(`/?tenant=${config.tenant}&view=core-settings&page=teams&team=${history.id}`);
  await page.getByRole('button', { name: 'ปิดทีม', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(page.getByRole('button', { name: 'ยืนยันปิดทีม', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('button', { name: 'ปิดทีม', exact: true })).toBeEnabled();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
test('team: history-only can be closed, while an unresolved legacy blocks only closing the team', async ({
  page,
  request,
}) => {
  const config = await coreLogin(page, request);
  const history = await (await request.post('/__core_test/history')).json();
  await page.goto(`/?tenant=${config.tenant}&view=core-settings&page=teams&team=${history.id}`);
  await page.getByRole('button', { name: 'ปิดทีม', exact: true }).click();
  await page.getByRole('button', { name: 'ยืนยันปิดทีม', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  await request.post('/__core_test/unresolved');
  try {
    await page.getByRole('button', { name: 'สร้างทีม', exact: true }).click();
    await page.getByRole('textbox', { name: 'ชื่อทีม', exact: true }).fill('ทีมขณะตรวจ Legacy');
    await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
    await page.getByRole('button', { name: 'ปิดหน้าต่าง', exact: true }).click();
    await page.getByRole('button', { name: 'ปิดทีม', exact: true }).click();
    await page.getByRole('button', { name: 'ยืนยันปิดทีม', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('มีงานค้างที่ยังระบุทีมไม่ได้');
    await expect(page.getByRole('status')).toContainText('งานค้างที่ยังระบุทีมไม่ได้: 1');
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
  await page.getByRole('button', { name: 'ปิดทีม', exact: true }).click();
  await page.getByRole('button', { name: 'ยืนยันปิดทีม', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ระบบกำลังบันทึกข้อมูลที่เกี่ยวข้อง');
  await page.getByRole('button', { name: 'ตรวจผลบันทึกอีกครั้ง' }).click();
  await expect(page.getByRole('status')).toContainText('คำสั่งนี้ไม่ได้เปลี่ยนข้อมูล');
  await page.getByRole('button', { name: 'โหลดค่าล่าสุดและเริ่มแก้ใหม่' }).click();
  await page.getByRole('button', { name: 'เปลี่ยนชื่อทีม', exact: true }).click();
  await page.getByRole('textbox', { name: 'ชื่อทีม', exact: true }).fill('ชื่อที่ห้ามมาถึงทีหลัง');
  await request.post('/__core_test/fault/late-request');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ยังยืนยันผลบันทึกไม่ได้');
  await page.getByRole('button', { name: 'ตรวจผลบันทึกอีกครั้ง' }).click();
  await expect(page.getByRole('status')).toContainText('คำสั่งนี้ไม่ได้เปลี่ยนข้อมูล');
  expect((await (await request.post('/__core_test/release')).json()).status).toBe(409);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'โหลดค่าล่าสุดและเริ่มแก้ใหม่' }).click();
  await expect(page.getByRole('textbox', { name: 'ชื่อทีม', exact: true })).toHaveValue(
    history.name,
  );
});
test('team: a missing readback does not report success until the original receipt is checked, and reauth keeps the draft', async ({
  page,
  request,
}) => {
  await coreLogin(page, request);
  await page.getByRole('link', { name: 'Core care', exact: true }).click();
  await page.getByRole('button', { name: 'เปลี่ยนชื่อทีม', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'ชื่อทีม', exact: true });
  await name.fill('ทีมรออ่านกลับ');
  await request.post('/__core_test/fault/readback');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ยังยืนยันผลบันทึกไม่ได้');
  await page.getByRole('button', { name: 'ตรวจผลบันทึกอีกครั้ง' }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
  await name.fill('ร่างทีมก่อน reauth');
  await request.post('/__core_test/fault/reauth');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('session หมดอายุ');
  await page.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('คำสั่งนี้ไม่ได้เปลี่ยนข้อมูล');
  await expect(name).toHaveValue('ร่างทีมก่อน reauth');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'โหลดค่าล่าสุดและเริ่มแก้ใหม่' }).click();
  await name.fill('Core care');
  await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกและตรวจข้อมูลเรียบร้อยแล้ว');
});
test('team: revoking permission while a draft exists must hide the data and not use the old capability', async ({
  page,
  request,
}) => {
  await request.post('/__core_test/restore');
  await coreLogin(page, request);
  await page.getByRole('link', { name: 'Core care', exact: true }).click();
  await page.getByRole('button', { name: 'เปลี่ยนชื่อทีม', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'ชื่อทีม', exact: true })
    .fill('ร่างที่ต้องล้างเมื่อถอนสิทธิ์');
  await request.post('/__core_test/revoke');
  try {
    await page.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('ไม่สามารถเข้าถึง');
    await expect(page.getByRole('textbox', { name: 'ชื่อทีม', exact: true })).toHaveCount(0);
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
    await expect(
      page.getByText('ไม่สามารถเข้าถึงการตั้งค่าองค์กรด้วยสิทธิ์ปัจจุบัน'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Core care', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'สร้างทีม', exact: true })).toHaveCount(0);
  });
}
