import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { totp } from '../../../scripts/keycloak-platform-login.mjs';
import { PLATFORM_DEV_USERS } from '../../../scripts/keycloak-platform-setup.mjs';

/**
 * A1.8 (#413) UAT journey ของ #393 §7 ที่ครบ failure → reconcile → resume → handoff ผ่าน UI จริง
 *
 * fault injection: หยุด Keycloak ก่อนยืนยันคำขอ → worker retry จนครบแล้วส่งให้ operator (ACTION_REQUIRED)
 * → เปิด Keycloak คืน → Reconcile (อ่านของจริง ไม่มีอะไรให้ adopt) → Retry current step → ACTIVE + ส่งมอบ
 * รันเฉพาะเมื่อ `A1_UAT_KEYCLOAK_OUTAGE=1` เพราะหยุด container ของ dev จริง
 */
const COMPOSE = ['compose', '-f', '../../infra/docker/docker-compose.dev.yml'];
const operator = PLATFORM_DEV_USERS.find((user) => user.role === 'platform_operator')!;
const run = randomUUID().slice(0, 6);

test.skip(process.env.A1_UAT_KEYCLOAK_OUTAGE !== '1', 'ต้องตั้ง A1_UAT_KEYCLOAK_OUTAGE=1');

async function keycloakReady() {
  for (let round = 0; round < 90; round += 1) {
    const response = await fetch('http://localhost:8081/realms/dcontact').catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Keycloak ไม่กลับมาใน 3 นาที');
}

async function recover(page: Page, title: string, comment: string) {
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).click();
  const panel = page.getByRole('region', { name: new RegExp(title) });
  await panel.getByLabel('รายละเอียด (บันทึกใน Action history)').fill(comment);
  await panel.getByRole('button', { name: `ยืนยัน ${title}` }).click();
  await expect(panel.getByText(`${title} สำเร็จ`)).toBeVisible({ timeout: 60_000 });
  return panel;
}

test('UAT: failure → reconcile → resume → handoff ระหว่าง Keycloak ล่ม', async ({ page }) => {
  test.setTimeout(600_000);
  test.info().annotations.push({ type: 'fault', description: 'docker compose stop keycloak' });

  await page.goto('/');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.locator('#username').fill(operator.username);
  await page.locator('#password').fill(operator.password);
  await page.locator('#kc-login').click();
  const window = Math.floor(Date.now() / 30_000);
  await page.waitForTimeout((window + 1) * 30_000 - Date.now() + 500);
  await page.locator('#otp').fill(totp(operator.totpSecret));
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'Tenants', level: 1 })).toBeVisible();

  // create → review
  const slug = `uat-${run}-outage`;
  await page.getByRole('button', { name: 'สร้าง tenant' }).first().click();
  await page.getByLabel('ชื่อลูกค้า / องค์กร').fill(`UAT ${slug}`);
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Primary domain').fill(`${slug}.uat.example.test`);
  await page.getByLabel('Plan').selectOption({ index: 1 });
  await page.getByLabel('ชื่อ First admin').fill('UAT Admin');
  await page.getByLabel('อีเมล First admin').fill(`uat-${run}-outage@uat.example.test`);
  await page.getByRole('button', { name: 'ตรวจสอบข้อมูล →' }).click();
  await page.getByLabel(/ฉันตรวจสอบ identity/).check();

  // failure: dependency ล่มหลังรับคำขอ (API ยังรับได้เพราะ verify token ด้วย JWKS ที่ cache ไว้)
  execFileSync('docker', [...COMPOSE, 'stop', 'keycloak'], { stdio: 'ignore' });
  try {
    await page.getByRole('button', { name: 'ยืนยันและเริ่ม provision' }).click();
    await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'ต้องการการตัดสินใจ' })).toBeVisible({
      timeout: 300_000,
    });
  } finally {
    execFileSync('docker', [...COMPOSE, 'start', 'keycloak'], { stdio: 'ignore' });
    await keycloakReady();
  }

  // reconcile หลัง dependency กลับมา: อ่านของจริงแล้วไม่มีอะไรให้ adopt — ไม่เดา ไม่สร้างซ้ำ
  const reconcile = await recover(
    page,
    'Reconcile & resume',
    'Keycloak กลับมาแล้ว ตรวจว่ามี Organization ค้างไหม',
  );
  await expect(reconcile.getByText('สถานะคำขอ: ACTION_REQUIRED')).toBeVisible();
  await reconcile.getByRole('button', { name: 'ปิด' }).click();

  // resume: reconcile พิสูจน์แล้วว่า resource ไม่มี — retry step ต่อ
  await recover(page, 'Retry current step', 'Reconcile ยืนยันแล้วว่าไม่มี resource ค้าง');
  await expect(page.getByRole('heading', { name: 'พร้อมส่งมอบให้ลูกค้า' })).toBeVisible({
    timeout: 180_000,
  });
  await expect(page.getByText('ส่งถึงผู้ให้บริการอีเมลแล้ว')).toBeVisible();

  // search + Action history มีทั้งการตัดสินใจของ operator และงานของ System
  await page.getByRole('button', { name: 'Tenants' }).click();
  await page.getByLabel('ค้นหา tenant').fill(slug);
  await page.getByLabel('ค้นหา tenant').press('Enter');
  await expect(page.getByRole('row', { name: new RegExp(`UAT ${slug}`) })).toContainText('ACTIVE');
  await page.getByRole('button', { name: `เปิดรายละเอียด UAT ${slug}` }).click();
  const timeline = page.getByRole('list', { name: 'เหตุการณ์ล่าสุดก่อน' });
  await expect(timeline.getByText('Reconcile').first()).toBeVisible();
  await expect(timeline.getByText('Retry step').first()).toBeVisible();
  await expect(timeline.getByText('System').first()).toBeVisible();
  console.log(JSON.stringify({ run, slug }));
});
