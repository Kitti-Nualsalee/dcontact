import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #939: ปุ่มทดสอบอุปกรณ์มุมซ้ายล่างของ Workspace (shell) — ไม่บังคับ แผงลอยไม่ใช่ modal
 * ไมโครโฟนจำลองด้วย oscillator (มีเสียงต่อเนื่อง) หรือ gain 0 (เงียบ) แทน media stub กลางของ fixtures
 * เพราะการทดสอบไมค์ต้องอ่านระดับเสียงจาก stream จริง
 * `DEVICE_TEST_EVIDENCE_DIR=<dir>` = เก็บภาพหลักฐานสำหรับ PR
 */
test.use({ locale: 'th-TH', viewport: { width: 1440, height: 900 } });

const navigation = {
  groups: [{ id: 'live', labelKey: 'navigation.groups.live' }],
  apps: [
    {
      id: 'agent-workspace',
      groupId: 'live',
      labelKey: 'navigation.apps.agentWorkspace',
      hostApp: 'workspace',
      path: '/',
    },
  ],
  pins: { appIds: ['agent-workspace'], source: 'SYSTEM', revision: 0 },
  limits: { maxPins: 15 },
  features: { shellV2: true },
};

const offer = {
  id: 'interaction-offer-1',
  state: 'ASSIGNED',
  version: '17',
  caller: '081-234-5678',
  queue: { id: 'queue-service', name: 'บริการลูกค้า' },
  offerExpiresAt: '2026-09-06T10:00:20.000Z',
  answeredAt: null,
  endedAt: null,
};

type Mic = 'voice' | 'silent' | 'denied';

async function evidence(page: Page, name: string) {
  const dir = process.env.DEVICE_TEST_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

async function open(
  page: Page,
  { mic = 'voice', call = false }: { mic?: Mic; call?: boolean } = {},
) {
  await page.addInitScript((mode: Mic) => {
    const fallback = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        // ปุ่ม "ตรวจอุปกรณ์เสียง" ของแผงความพร้อมใช้ stub กลางเดิม — เฉพาะแผงทดสอบที่ต้องการ stream จริง
        if (!document.querySelector('.aw-devtest-panel')) return fallback(constraints);
        if (mode === 'denied') throw new DOMException('blocked', 'NotAllowedError');
        const context = new AudioContext();
        await context.resume();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = mode === 'voice' ? 0.5 : 0;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        return destination.stream;
      },
    });
  }, mic);
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: { id: 'agent-1000', displayName: 'สมชาย ใจดี', extension: '1000', state: 'OFFLINE' },
        interaction: call ? offer : null,
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/sip-credentials', (route) =>
    route.fulfill({
      status: 200,
      json: {
        leaseId: 'e2e-lease',
        extension: '1000',
        authorizationUsername: '1000',
        authorizationPassword: 'e2e-only',
        sipDomain: 'e2e.invalid',
        wssUrl: 'wss://e2e.invalid',
        telephonyNodeId: 'fs-e2e',
        iceServers: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
}

const trigger = (page: Page) => page.getByRole('button', { name: /^ทดสอบอุปกรณ์|^Test devices/ });
const panel = (page: Page) => page.getByRole('dialog', { name: /^(ทดสอบอุปกรณ์|Test devices)$/ });
const mic = (page: Page) => panel(page).getByRole('region', { name: /^(ไมโครโฟน|Microphone)$/ });
const speaker = (page: Page) =>
  panel(page).getByRole('region', { name: /^(ลำโพงหรือหูฟัง|Speaker or headset)$/ });

test('เปิดจากมุมซ้ายล่าง → ไมค์ผ่านเมื่อได้ยินเสียง, ลำโพงผ่านเมื่อตอบว่าได้ยิน, Esc ปิดและผลอยู่ที่ปุ่มหลัง reload', async ({
  page,
}) => {
  await open(page);
  await expect(trigger(page)).toContainText('ยังไม่เคยทดสอบ');

  // มุมซ้ายล่าง: ซ้ายกว่ารายการงาน และไม่ทับ dphone ที่อยู่ขวาล่าง
  const box = (await trigger(page).boundingBox())!;
  expect(box.x).toBeLessThan(200);
  expect(box.y + box.height).toBeGreaterThan(900 - 80);
  const dphone = await page.getByRole('region', { name: 'dphone' }).boundingBox();
  if (dphone) expect(box.x + box.width).toBeLessThan(dphone.x);

  await trigger(page).click();
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page)).toBeVisible();
  await expect(mic(page).getByText('ผ่าน', { exact: true })).toBeVisible();
  await expect(mic(page).getByRole('status')).toHaveText(/ได้ยินเสียงชัดเจน/);

  await speaker(page).getByRole('button', { name: 'เล่นเสียงทดสอบ' }).click();
  await expect(speaker(page).getByText('รอคำตอบ')).toBeVisible();
  await speaker(page).getByRole('button', { name: 'ได้ยิน', exact: true }).click();
  await expect(speaker(page).getByText('ผ่าน', { exact: true })).toBeVisible();

  const axe = await new AxeBuilder({ page }).include('.aw-devtest').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);

  await evidence(page, 'device-test-pass');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await evidence(page, 'device-test-button');
  await expect(trigger(page)).toContainText(/ผ่าน · วันนี้ \d\d:\d\d/);

  await page.reload();
  await expect(trigger(page)).toContainText(/ผ่าน · วันนี้/);
});

test('ไมค์ถูกปฏิเสธ → บอกวิธีเปิดสิทธิ์ และลำโพงไม่ได้ยิน → ปุ่มขึ้นว่ามีข้อควรตรวจ', async ({
  page,
}) => {
  await open(page, { mic: 'denied' });
  await trigger(page).click();
  await expect(mic(page).getByRole('alert')).toContainText('ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน');
  await expect(mic(page).getByRole('button', { name: 'ลองอีกครั้ง' })).toBeVisible();

  await speaker(page).getByRole('button', { name: 'เล่นเสียงทดสอบ' }).click();
  await speaker(page).getByRole('button', { name: 'ไม่ได้ยิน' }).click();
  await expect(speaker(page).getByRole('alert')).toContainText('ไม่ได้ยินเสียงทดสอบ');
  await evidence(page, 'device-test-denied');

  // ปิดด้วยการกดปุ่มเดิม
  await trigger(page).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(trigger(page)).toContainText(/มีข้อควรตรวจ · วันนี้/);
});

test('ไม่ได้ยินเสียงจากไมค์ 8 วินาที → แนะนำให้ตรวจปุ่มปิดเสียง', async ({ page }) => {
  await open(page, { mic: 'silent' });
  await trigger(page).click();
  await expect(mic(page).getByText('กำลังฟัง')).toBeVisible();
  await expect(mic(page).getByText('ไม่ได้ยินเสียง', { exact: true })).toBeVisible({
    timeout: 12_000,
  });
  await expect(mic(page).getByRole('status')).toHaveText(/ตรวจปุ่มปิดเสียง/);
});

test('ระหว่างมีสาย → ปุ่มกดไม่ได้และบอกว่าทดสอบได้หลังจบสาย', async ({ page }) => {
  await open(page, { call: true });
  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  const dphone = page.getByRole('region', { name: 'dphone' });
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('มีสายเรียกเข้า');
  await expect(trigger(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(trigger(page)).toContainText('ทดสอบได้หลังจบสาย');
  await trigger(page).click({ force: true });
  await expect(panel(page)).toHaveCount(0);
});

test('EN → ข้อความของปุ่มและแผงเปลี่ยนตามภาษา', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(trigger(page)).toContainText('Not tested yet');
  await trigger(page).click();
  await expect(mic(page).getByText('Passed', { exact: true })).toBeVisible();
  await expect(speaker(page).getByRole('button', { name: 'Play test sound' })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Close' }).click();
  await expect(panel(page)).toHaveCount(0);
});
