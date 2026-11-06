import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

test.beforeEach(async ({ request }) => {
  await request.get('/__c360_test/reset');
});

test('Admin สร้าง เปลี่ยนชื่อ และเลิกใช้แท็กผ่าน API/RLS จริง', async ({ page, request }) => {
  mkdirSync('../../output/playwright', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const config = (await (await request.get('/__c360_test/config')).json()) as { tenant: string };
  await page.goto(`/?view=customer-tags&tenant=${config.tenant}`);
  await expect(page.getByRole('heading', { name: 'จัดการแท็ก' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' })).toContainText('ลูกค้า');
  await expect(page.getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' })).toContainText(
    'จัดการแท็ก',
  );
  await page.getByRole('button', { name: 'สร้างแท็ก' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ชื่อแท็ก').fill('แท็กทดลอง M1');
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/customer-360/tags') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  expect((await response).status()).toBe(201);
  const row = page.getByRole('row').filter({ hasText: 'แท็กทดลอง M1' });
  await expect(row).toBeVisible();
  await page.screenshot({ path: '../../output/playwright/m1a-tags-1440.png' });
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('แท็กทดลอง M1');
  await row.getByRole('button', { name: 'เปลี่ยนชื่อ' }).click();
  await dialog.getByLabel('ชื่อแท็ก').fill('แท็กใหม่ M1');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  const renamed = page.getByRole('row').filter({ hasText: 'แท็กใหม่ M1' });
  await expect(renamed).toBeVisible();
  await renamed.getByRole('button', { name: 'เลิกใช้' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'ยืนยันการเลิกใช้แท็ก' });
  await expect(confirm).toContainText('แท็กใหม่ M1');
  await confirm.getByRole('button', { name: 'เลิกใช้' }).click();
  await expect(renamed).toContainText('เลิกใช้');
  await expect(renamed.getByRole('button', { name: 'เปลี่ยนชื่อ' })).toHaveCount(0);
});

test('ถอนสิทธิ์ปิดข้อมูลที่เปิดอยู่ และจอแคบใช้งานด้วยคีย์บอร์ดได้', async ({ page, request }) => {
  const config = (await (await request.get('/__c360_test/config')).json()) as { tenant: string };
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`/?view=customer-tags&tenant=${config.tenant}`);
  await expect(page.getByRole('heading', { name: 'จัดการแท็ก' })).toBeVisible();
  const create = page.getByRole('button', { name: 'สร้างแท็ก' });
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'ยกเลิก' }).click();
  await page.screenshot({ path: '../../output/playwright/m1a-tags-768.png' });
  await request.get('/__c360_test/actor/supervisor');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('ไม่สามารถเข้าถึงแท็ก');
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('revision conflict แสดงข้อมูลล่าสุดโดยเก็บร่างไว้ให้ตรวจ', async ({ page, request }) => {
  const config = (await (await request.get('/__c360_test/config')).json()) as { tenant: string };
  const create = await request.post('/api/v1/customer-360/tags', {
    data: { commandId: randomUUID(), name: 'ก่อนเปลี่ยน M1' },
  });
  const receipt = (await create.json()) as {
    command: { resourceRefs: { type: string; id: string }[] };
  };
  const tagId = receipt.command.resourceRefs.find((ref) => ref.type === 'TAG')!.id;
  await page.goto(`/?view=customer-tags&tenant=${config.tenant}`);
  await page
    .getByRole('row')
    .filter({ hasText: 'ก่อนเปลี่ยน M1' })
    .getByRole('button', { name: 'เปลี่ยนชื่อ' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ชื่อแท็ก').fill('ร่างของฉัน M1');
  const changed = await request.patch(`/api/v1/customer-360/tags/${tagId}`, {
    data: { commandId: randomUUID(), expectedRevision: '0', name: 'ผู้อื่นเปลี่ยน M1' },
  });
  expect(changed.status()).toBe(200);
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog).toContainText('ผู้อื่นเปลี่ยน M1');
  await expect(dialog.getByLabel('ชื่อแท็ก')).toHaveValue('ร่างของฉัน M1');
  await dialog.getByRole('button', { name: 'ลองใหม่' }).click();
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'ร่างของฉัน M1' })).toBeVisible();
});

test('ผลตอบกลับหายหลังกระทำสำเร็จ กู้ receipt แล้วไม่สร้างแท็กซ้ำ', async ({ page, request }) => {
  const config = (await (await request.get('/__c360_test/config')).json()) as { tenant: string };
  let dropped = false;
  await page.route('**/api/v1/customer-360/tags', async (route) => {
    if (!dropped && route.request().method() === 'POST') {
      dropped = true;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto(`/?view=customer-tags&tenant=${config.tenant}`);
  await page.getByRole('button', { name: 'สร้างแท็ก' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ชื่อแท็ก').fill('กู้ผล M1');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog.getByRole('button', { name: 'ตรวจผลการบันทึก' })).toBeVisible();
  await dialog.getByRole('button', { name: 'ตรวจผลการบันทึก' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'กู้ผล M1' })).toHaveCount(1);
});

test('รายการเกินหนึ่งหน้าโหลดต่อได้โดยไม่แสดงชื่อซ้ำ', async ({ page, request }) => {
  const config = (await (await request.get('/__c360_test/config')).json()) as { tenant: string };
  await request.get('/__c360_test/actor/operator');
  const response = await request.post('/api/v1/customer-360/operator/commands', {
    data: {
      commandId: randomUUID(),
      evidenceRef: 'ticket:BROWSER-M1',
      reasonCode: 'APPROVED_CUSTODIAN',
      command: {
        action: 'TAG_SEED',
        names: Array.from({ length: 52 }, (_, i) => `หน้า M1 ${String(i).padStart(2, '0')}`),
      },
    },
  });
  expect(response.status()).toBe(201);
  await request.get('/__c360_test/actor/admin');
  await page.goto(`/?view=customer-tags&tenant=${config.tenant}`);
  const more = page.getByRole('button', { name: 'โหลดเพิ่มเติม' });
  await expect(more).toBeVisible();
  await more.click();
  await expect(page.getByRole('row').filter({ hasText: 'หน้า M1 51' })).toHaveCount(1);
});

test('ผลรายการที่มาช้าหลังถอนสิทธิ์ไม่กลับมาแสดง', async ({ page, request }) => {
  const config = (await (await request.get('/__c360_test/config')).json()) as { tenant: string };
  await page.goto(`/?view=customer-tags&tenant=${config.tenant}`);
  await expect(page.getByRole('row').filter({ hasText: 'ลูกค้าสำคัญ' })).toBeVisible();
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route('**/api/v1/customer-360/tags?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('state') !== 'ACTIVE')
      return route.continue();
    const response = await route.fetch();
    arrived();
    await gate;
    try {
      await route.fulfill({ response });
    } catch {
      /* request เก่าอาจถูก abort เมื่อเปลี่ยน filter */
    }
  });
  await page.getByLabel('สถานะ').click();
  await page.getByRole('option', { name: 'ใช้งาน', exact: true }).click();
  await held;
  await request.get('/__c360_test/actor/supervisor');
  await page.getByLabel('สถานะ').click();
  await page.getByRole('option', { name: 'เลิกใช้', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('ไม่สามารถเข้าถึงแท็ก');
  release();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByText('ลูกค้าสำคัญ')).toHaveCount(0);
});
