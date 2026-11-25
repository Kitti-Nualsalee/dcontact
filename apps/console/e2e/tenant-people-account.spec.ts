import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { homeNavigation } from './support/home-navigation.js';
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
    /** บัญชีจาก seed: ไม่มี lifecycle ของ People (directory ตอบ UNKNOWN) */
    unmanaged?: boolean;
    /** หน่วง capabilities จนกว่า promise จะ resolve */
    capabilities?: Promise<void>;
  },
) {
  let user: Record<string, unknown> = {
    id: USER_ID,
    displayName: 'สมหญิง เดิม',
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
    // หน่วงเฉพาะ capabilities ที่หน้ารายละเอียดขอ (หลังเปิดบัญชี) ไม่บล็อกหน้ารายการ
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
      return route.fulfill({ json: { items: [{ id: TEAM, name: 'ทีมขาย', isActive: true }] } });
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
      // UAT 25 พ.ย. 2569: API ต่อฐานด้วย owner แล้ว PATCH ตอบ 403 FORBIDDEN
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
      // worker ทำเสร็จหลังรับคำสั่ง: รอบตรวจถัดไปเห็นผลจริง
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
  await page.getByRole('button', { name: 'ดูบัญชี สมหญิง เดิม', exact: true }).click();
  return Object.assign(writes, { lookups });
}

async function fillRename(page: Page) {
  await page.getByRole('button', { name: 'แก้ชื่อที่แสดง…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'แก้ชื่อที่แสดงของ สมหญิง เดิม' });
  await dialog.getByRole('textbox', { name: /ชื่อที่แสดงใหม่/ }).fill('สมหญิง ใหม่');
  await dialog.getByRole('textbox', { name: /เหตุผล/ }).fill('ผู้ใช้แจ้งเปลี่ยนชื่อ');
  await dialog.getByRole('button', { name: 'บันทึกชื่อ', exact: true }).click();
  return dialog;
}

async function pendingKeys(page: Page) {
  return page.evaluate(() =>
    Object.keys(sessionStorage).filter((key) => key.startsWith('dc:tenant-account:')),
  );
}

async function axe(page: Page) {
  // สแกนหลัง animation เปิด Dialog จบ ไม่งั้นสีปุ่มยังโปร่งแสงอยู่
  await page.evaluate(() => Promise.all(document.getAnimations().map((item) => item.finished)));
  const result = await new AxeBuilder({ page })
    .include('[role="dialog"],[role="alertdialog"]')
    .analyze();
  expect(
    result.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? '')),
  ).toEqual([]);
}

for (const respond of ['success', 'busy', 'unknown'] as const)
  test(`แก้ชื่อที่แสดง ${respond}: ส่ง revision/ชื่อ/เหตุผลครั้งเดียว และแสดงชื่อใหม่หลังยืนยันผลเท่านั้น`, async ({
    page,
  }) => {
    const writes = await mockPeople(page, { disabled: false, respond });
    // บัญชีที่ใช้งานอยู่ไม่มีแผงเปิดบัญชีกลับ
    await expect(page.getByRole('region', { name: 'เปิดบัญชีกลับ' })).toHaveCount(0);
    await page.getByRole('button', { name: 'แก้ชื่อที่แสดง…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'แก้ชื่อที่แสดงของ สมหญิง เดิม' });
    const name = dialog.getByRole('textbox', { name: /ชื่อที่แสดงใหม่/ });
    await expect(name).toHaveValue('สมหญิง เดิม');
    const submit = dialog.getByRole('button', { name: 'บันทึกชื่อ', exact: true });
    await expect(submit).toBeDisabled();
    await name.fill('  สมหญิง   ใหม่ ');
    await dialog.getByRole('textbox', { name: /เหตุผล/ }).fill('ผู้ใช้แจ้งเปลี่ยนชื่อ');
    await axe(page);
    await submit.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      method: 'PATCH',
      body: { expectedRevision: 6, displayName: 'สมหญิง ใหม่', reason: 'ผู้ใช้แจ้งเปลี่ยนชื่อ' },
    });
    expect(Object.keys(writes[0]!.body).sort()).toEqual([
      'commandId',
      'displayName',
      'expectedRevision',
      'reason',
    ]);
    if (respond === 'busy') {
      await expect(dialog.getByRole('alert')).toContainText('มีงานหรือคำสั่งอื่นค้างอยู่');
      await expect(name).toHaveValue('  สมหญิง   ใหม่ ');
      expect(writes).toHaveLength(1);
      return;
    }
    await expect(dialog).toHaveCount(0);
    if (respond === 'unknown') {
      // ไม่รู้ว่ารับคำสั่งหรือยัง: แสดงคำสั่งค้างและปุ่มตรวจผล ไม่ส่งซ้ำ ชื่อเดิมยังอยู่
      await expect(page.getByText(/กำลังเปลี่ยนชื่อ/)).toBeVisible();
      await expect(page.getByRole('alert').filter({ hasText: 'ยังยืนยันผลไม่ได้' })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'แก้ชื่อที่แสดง…', exact: true }),
      ).toBeDisabled();
      await expect(page.getByRole('heading', { name: 'สมหญิง เดิม' })).toBeVisible();
      expect(writes).toHaveLength(1);
      return;
    }
    await page.getByRole('button', { name: 'ตรวจผลการแก้ชื่อ', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'เปลี่ยนชื่อที่แสดงแล้ว' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'สมหญิง ใหม่' })).toBeVisible();
    expect(writes).toHaveLength(1);
  });

for (const respond of ['success', 'credentials', 'unknown', 'rejected'] as const)
  test(`เปิดบัญชีกลับ ${respond}: ยืนยันใน alertdialog พร้อมเหตุผล บัญชียังปิดจนกว่าผลจะยืนยัน`, async ({
    page,
  }) => {
    const writes = await mockPeople(page, { disabled: true, respond });
    await expect(page.getByRole('button', { name: 'แก้ชื่อที่แสดง…', exact: true })).toBeDisabled();
    const panel = page.getByRole('region', { name: 'เปิดบัญชีกลับ' });
    await expect(panel).toContainText('รหัสยืนยันตัวตน (TOTP) เดิม');
    await panel.getByRole('button', { name: 'เปิดบัญชีกลับ…', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'เปิดบัญชี สมหญิง เดิม กลับ?' });
    await expect(dialog).toContainText('ทีมขาย');
    await expect(dialog).toContainText('1501');
    const submit = dialog.getByRole('button', { name: 'ยืนยันเปิดบัญชีกลับ', exact: true });
    await expect(submit).toBeDisabled();
    await dialog.getByRole('textbox', { name: /เหตุผล/ }).fill('กลับมาทำงานหลังลาคลอด');
    await axe(page);
    await submit.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      method: 'POST',
      body: { expectedRevision: 6, reason: 'กลับมาทำงานหลังลาคลอด' },
    });
    expect(Object.keys(writes[0]!.body).sort()).toEqual([
      'commandId',
      'expectedRevision',
      'reason',
    ]);
    if (respond === 'credentials') {
      await expect(dialog.getByRole('alert')).toContainText(
        'ยังตั้งรหัสผ่านหรือรหัสยืนยันตัวตน (TOTP) ไม่ครบ',
      );
      expect(writes).toHaveLength(1);
      return;
    }
    await expect(dialog).toHaveCount(0);
    if (respond === 'unknown') {
      await expect(panel).toContainText('ห้ามส่งคำสั่งซ้ำ');
      await expect(panel.getByRole('alert')).toContainText('ยังยืนยันผลไม่ได้');
      await expect(
        panel.getByRole('button', { name: 'เปิดบัญชีกลับ…', exact: true }),
      ).toBeDisabled();
      expect(writes).toHaveLength(1);
      return;
    }
    await panel.getByRole('button', { name: 'ตรวจผลการเปิดบัญชีกลับ', exact: true }).click();
    if (respond === 'rejected') {
      await expect(panel.getByRole('status')).toContainText('บัญชียังปิดอยู่');
      await expect(
        panel.getByRole('button', { name: 'เปิดบัญชีกลับ…', exact: true }),
      ).toBeEnabled();
      return;
    }
    await expect(panel.getByRole('status')).toContainText('เปิดบัญชีกลับแล้ว');
    await expect(page.getByRole('region', { name: 'รายละเอียดบัญชี' })).toContainText('ใช้งานได้');
    expect(writes).toHaveLength(1);
  });

test('ยังไม่พร้อม: ปุ่มแก้ชื่อและเปิดบัญชีกลับกดไม่ได้', async ({ page }) => {
  const writes = await mockPeople(page, { disabled: true, ready: false, respond: 'success' });
  await expect(
    page
      .getByRole('region', { name: 'เปิดบัญชีกลับ' })
      .getByRole('button', { name: 'เปิดบัญชีกลับ…' }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'แก้ชื่อที่แสดง…', exact: true })).toBeDisabled();
  expect(writes).toHaveLength(0);
});

test('แก้ชื่อได้ 403: แสดง error ใน Dialog หน้ารายละเอียดยังอยู่ ไม่ค้างคำสั่ง และลองใหม่ได้', async ({
  page,
}) => {
  const writes = await mockPeople(page, { disabled: false, respond: 'forbidden' });
  const dialog = await fillRename(page);
  await expect(dialog.getByRole('alert')).toContainText('คุณไม่มีสิทธิ์ทำรายการนี้กับบัญชีนี้');
  // ไม่แทนทั้งหน้าด้วย FORBIDDEN: รายละเอียดบัญชียังอยู่หลัง Dialog
  await expect(page.getByRole('region', { name: 'รายละเอียดบัญชี' })).toBeVisible();
  await expect(page.getByText(/ไม่มีสิทธิ์จัดการบัญชี/)).toHaveCount(0);
  expect(await pendingKeys(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'ยกเลิก', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/กำลังเปลี่ยนชื่อ/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ตรวจผลการแก้ชื่อ' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'แก้ชื่อที่แสดง…', exact: true })).toBeEnabled();
  expect(writes).toHaveLength(1);
  expect(writes.lookups).toEqual([]);
});

test('คำสั่งค้างแต่ server ไม่พบคำสั่ง (404): ล้างคำสั่งค้าง แจ้งผล และเปิดให้แก้ชื่อใหม่', async ({
  page,
}) => {
  const writes = await mockPeople(page, { disabled: false, respond: 'unknown' });
  const dialog = await fillRename(page);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/กำลังเปลี่ยนชื่อ/)).toBeVisible();
  expect(await pendingKeys(page)).toHaveLength(1);
  // ผลไม่ชัดเจน: ตรวจคำสั่งเดิม server ตอบ 404 = ไม่ได้บันทึกคำสั่งนี้
  await page.getByRole('button', { name: 'ตรวจผลการแก้ชื่อ', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('ไม่พบคำสั่งเดิมในระบบ');
  await expect(page.getByText(/กำลังเปลี่ยนชื่อ/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ตรวจผลการแก้ชื่อ' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'แก้ชื่อที่แสดง…', exact: true })).toBeEnabled();
  expect(await pendingKeys(page)).toEqual([]);
  expect(writes.lookups).toHaveLength(1);
  // ไม่ poll ต่อหลังล้างคำสั่งค้าง
  await page.waitForTimeout(5_500);
  expect(writes.lookups).toHaveLength(1);
  expect(writes).toHaveLength(1);
});

test('บัญชีจาก seed ที่ People แก้ไม่ได้: ปุ่มแก้ชื่อกดไม่ได้พร้อมคำอธิบาย ก่อนกรอกอะไร', async ({
  page,
}) => {
  const writes = await mockPeople(page, { disabled: false, unmanaged: true, respond: 'success' });
  await expect(page.getByRole('region', { name: 'รายละเอียดบัญชี' })).toContainText(
    'บัญชีนี้ไม่ได้สร้างหรือเปิดใช้งานผ่านหน้า People',
  );
  await expect(page.getByRole('button', { name: 'แก้ชื่อที่แสดง…', exact: true })).toBeDisabled();
  await expect(page.getByText(/บริการยืนยันตัวตนยังไม่พร้อม/)).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test('ระหว่างโหลด capabilities: แสดงกำลังตรวจความพร้อม ไม่ใช่ “ยังไม่พร้อม”', async ({ page }) => {
  let release!: () => void;
  const capabilities = new Promise<void>((resolve) => (release = resolve));
  await mockPeople(page, { disabled: false, respond: 'success', capabilities });
  const detail = page.getByRole('region', { name: 'รายละเอียดบัญชี' });
  await expect(
    detail.getByRole('status').filter({ hasText: 'กำลังตรวจความพร้อม' }).first(),
  ).toBeVisible();
  await expect(page.getByText(/บริการยืนยันตัวตนยังไม่พร้อม/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'แก้ชื่อที่แสดง…', exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('button', { name: 'แก้ชื่อที่แสดง…', exact: true })).toBeEnabled();
  await expect(page.getByText(/กำลังตรวจความพร้อม/)).toHaveCount(0);
});
