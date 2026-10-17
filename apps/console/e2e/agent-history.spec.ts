import { expect, test } from '@playwright/test';
test.use({ locale: 'th-TH' });

const interactionId = '7a33ac96-d87d-4ca4-ab75-f27e40e943be';
const nextId = '7a33ac96-d87d-4ca4-ab75-f27e40e943bf';
const item = {
  interactionId,
  startedAt: '2026-10-17T07:00:00.000Z',
  endedAt: '2026-10-17T07:01:00.000Z',
  disposition: 'CUSTOMER_ASSISTED',
  recordedAt: '2026-10-17T07:02:00.000Z',
  recordedAtSource: 'SERVER_COMMIT',
  legacy: false,
};

test('Agent เปิดรายการ/โหลดเพิ่ม/detail plain text/deep link โดยไม่ขอ lease หรือ SIP', async ({
  page,
}) => {
  const forbidden: string[] = [];
  page.on('request', (request) => {
    if (/work-session|sip-credentials/.test(request.url())) forbidden.push(request.url());
  });
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname === '/api/v1/workspace-session')
      forbidden.push(socket.url());
  });
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/workspace/agent/history**', (route) => {
    const more = new URL(route.request().url()).searchParams.has('cursor');
    return route.fulfill({
      json: {
        items: [
          more
            ? { ...item, interactionId: nextId, legacy: true, recordedAtSource: 'LEGACY_FALLBACK' }
            : item,
        ],
        nextCursor: more ? null : 'synthetic-cursor',
      },
    });
  });
  await page.route('**/wrapup-result', (route) =>
    route.fulfill({
      json: {
        ...item,
        policyVersion: 1,
        state: 'COMPLETED',
        note: '<img src=x onerror=alert(1)> โน้ตสังเคราะห์',
      },
    }),
  );
  await page.goto('/?view=agent-history&tenant=demo');
  await expect(page.getByRole('heading', { name: 'ประวัติงานของฉัน' })).toBeVisible();
  await page.getByRole('button', { name: 'โหลดเพิ่ม', exact: true }).click();
  await expect(page.getByText(nextId, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `เปิดงาน ${interactionId}`, exact: true }).click();
  await expect(
    page.getByText('<img src=x onerror=alert(1)> โน้ตสังเคราะห์', { exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get('interaction')).toBe(interactionId);
  expect(page.url()).not.toContain('โน้ต');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText('<img src=x onerror=alert(1)> โน้ตสังเคราะห์', { exact: true }),
  ).toBeVisible();
  expect(forbidden).toEqual([]);
});

for (const [status, message] of [
  [401, 'session หมดอายุ'],
  [403, 'ไม่มีสิทธิ์ดูประวัติ'],
  [404, 'ไม่พบงานนี้'],
  [503, 'โหลดประวัติไม่สำเร็จ'],
] as const) {
  test(`history แยก ${status} และ retry กลับ empty ได้`, async ({ page }) => {
    let failed = true;
    await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
    await page.route('**/api/v1/workspace/agent/history**', (route) =>
      failed ? route.fulfill({ status }) : route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.goto('/?view=agent-history&tenant=demo');
    await expect(page.getByRole('alert')).toContainText(message);
    failed = false;
    await page.getByRole('button', { name: 'ลองอีกครั้ง', exact: true }).click();
    await expect(page.getByText('ยังไม่มีงาน Voice ที่ปิดแล้ว', { exact: true })).toBeVisible();
  });
}

test('identity เปลี่ยนล้าง detail cache และไม่รับคำตอบ note ของ identity เก่า', async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received = false;
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/wrapup-result', async (route) => {
    if (route.request().headers().authorization === 'Bearer e2e-first') {
      received = true;
      await held;
      await route.fulfill({
        json: { ...item, policyVersion: 1, note: 'private synthetic old identity note' },
      });
    } else await route.fulfill({ status: 404 });
  });
  await page.goto(
    `/?view=agent-history&tenant=demo&interaction=${interactionId}&identityHarness=1`,
  );
  await expect.poll(() => received).toBe(true);
  await page.getByRole('button', { name: 'Switch identity fixture', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('ไม่พบงานนี้');
  release?.();
  await expect(page.getByText('private synthetic old identity note', { exact: true })).toHaveCount(
    0,
  );
});

test('legacy detail แสดงว่าไม่มีโน้ตและเวลาอ้างอิง ไม่สร้างข้อความย้อนหลัง', async ({ page }) => {
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/wrapup-result', (route) =>
    route.fulfill({
      json: {
        ...item,
        note: null,
        legacy: true,
        policyVersion: null,
        recordedAtSource: 'LEGACY_EVENT',
      },
    }),
  );
  await page.goto(`/?view=agent-history&tenant=demo&interaction=${interactionId}`);
  await expect(page.getByText('งานเดิมก่อนระบบบันทึกโน้ต', { exact: true })).toBeVisible();
  await expect(
    page.getByText('งานเดิมไม่มีโน้ต ไม่ได้สร้างข้อความย้อนหลัง', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('เวลาอ้างอิงจากเหตุการณ์ปิดงานเดิม', { exact: true })).toBeVisible();
});
