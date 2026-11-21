import { expect, test } from '@playwright/test';
import { homeNavigation } from './support/home-navigation.js';
test.use({ locale: 'th-TH' });

const interactionId = '7a33ac96-d87d-4ca4-ab75-f27e40e943be';
const nextId = '7a33ac96-d87d-4ca4-ab75-f27e40e943bf';
const emptySummary = {
  period: {
    key: '7d',
    from: '2026-11-15T17:00:00.000Z',
    to: '2026-11-22T17:00:00.000Z',
    timeZone: 'Asia/Bangkok',
  },
  completed: 0,
  talk: { averageSeconds: null, measuredCount: 0 },
  byDisposition: [],
};
const isSummary = (url: string) => new URL(url).pathname.endsWith('/history/summary');
const item = {
  interactionId,
  startedAt: '2026-10-17T07:00:00.000Z',
  endedAt: '2026-10-17T07:01:00.000Z',
  disposition: 'CUSTOMER_ASSISTED',
  recordedAt: '2026-10-17T07:02:00.000Z',
  recordedAtSource: 'SERVER_COMMIT',
  legacy: false,
};

test('production auth root เปิด history deep link โดยไม่บังคับ Interaction context', async ({
  page,
}) => {
  await page.goto('/?view=agent-history&tenant=demo&authRootHarness=1');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'ไม่พบ Interaction context', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('main')).toContainText(/Identity Provider|เข้าสู่ระบบ|ประวัติงาน/);
});

test('auth surface เปลี่ยน identity โหลด navigation ใหม่และทิ้งเมนูบัญชีเดิม', async ({ page }) => {
  const identities: string[] = [];
  await page.route('**/api/v1/me/navigation', (route) => {
    const identity = route.request().headers().authorization;
    identities.push(identity);
    return route.fulfill({
      json: homeNavigation(identity === 'Bearer e2e-first' ? ['agent'] : ['compliance']),
    });
  });
  await page.route('**/api/v1/workspace/agent/history**', (route) =>
    route.fulfill({
      json: isSummary(route.request().url()) ? emptySummary : { items: [], nextCursor: null },
    }),
  );
  await page.goto('/?view=agent-history&tenant=demo&identityHarness=1');
  await expect(page.locator('a[data-area="history"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Switch identity fixture', exact: true }).click();
  await expect.poll(() => identities.includes('Bearer e2e-second')).toBe(true);
  await expect(page.locator('a[data-area="history"]')).toHaveCount(0);
  await expect(page.locator('a[data-area="governance"]')).toHaveCount(1);
});

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
    if (isSummary(route.request().url()))
      return route.fulfill({
        json: {
          ...emptySummary,
          completed: 2,
          byDisposition: [{ disposition: 'CUSTOMER_ASSISTED', count: 2 }],
        },
      });
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
      failed
        ? route.fulfill({ status })
        : route.fulfill({
            json: isSummary(route.request().url()) ? emptySummary : { items: [], nextCursor: null },
          }),
    );
    await page.goto('/?view=agent-history&tenant=demo');
    await expect(page.getByRole('alert')).toContainText(message);
    failed = false;
    await page.getByRole('button', { name: 'ลองอีกครั้ง', exact: true }).click();
    await expect(
      page.getByText('ไม่มีงาน Voice ที่จบในช่วงเวลานี้', { exact: true }),
    ).toBeVisible();
  });
}

test('สรุปงานตามช่วงเวลา กดผลบันทึกแล้วรายการใช้ช่วงเวลาเดียวกับสรุป และ reload คงตัวกรอง', async ({
  page,
}) => {
  const summaries: string[] = [];
  const lists: URLSearchParams[] = [];
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/workspace/agent/history**', (route) => {
    const url = new URL(route.request().url());
    if (isSummary(url.href)) {
      const period = url.searchParams.get('period') ?? '';
      summaries.push(period);
      return route.fulfill({
        json:
          period === 'today'
            ? {
                ...emptySummary,
                period: { ...emptySummary.period, key: 'today', from: '2026-11-21T17:00:00.000Z' },
              }
            : {
                ...emptySummary,
                completed: 3,
                talk: { averageSeconds: 150, measuredCount: 2 },
                byDisposition: [
                  { disposition: 'CUSTOMER_ASSISTED', count: 2 },
                  { disposition: 'FOLLOW_UP_REQUIRED', count: 1 },
                ],
              },
      });
    }
    lists.push(url.searchParams);
    const disposition = url.searchParams.get('disposition');
    if (url.searchParams.get('from') === '2026-11-21T17:00:00.000Z')
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({
      json: {
        items:
          disposition === 'FOLLOW_UP_REQUIRED'
            ? [{ ...item, interactionId: nextId, disposition }]
            : [item, { ...item, interactionId: nextId, disposition: 'FOLLOW_UP_REQUIRED' }],
        nextCursor: null,
      },
    });
  });
  await page.goto('/?view=agent-history&tenant=demo');
  const summary = page.getByRole('region', { name: 'สรุปงาน' });
  await expect(summary).toContainText('16 พ.ย. 2569 – 22 พ.ย. 2569 · เวลาอินโดจีน');
  await expect(summary).toContainText('2:30');
  await expect(summary).toContainText('จาก 2 งานที่มีเวลารับและวางสาย');
  await expect(page.getByRole('button', { name: '7 วัน', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.getByRole('heading', { name: 'รายการงาน · 7 วัน · ทุกผลบันทึก · 3 งาน' }),
  ).toBeVisible();
  expect(lists.at(-1)?.get('from')).toBe('2026-11-15T17:00:00.000Z');
  expect(lists.at(-1)?.get('to')).toBe('2026-11-22T17:00:00.000Z');
  expect(lists.at(-1)?.has('disposition')).toBe(false);

  const followUp = summary.getByRole('button', { name: /ต้องติดตามต่อ/ });
  await followUp.click();
  await expect(followUp).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('heading', { name: 'รายการงาน · 7 วัน · ต้องติดตามต่อ · 1 งาน' }),
  ).toBeVisible();
  await expect(page.getByText(interactionId, { exact: true })).toHaveCount(0);
  await expect(page.getByText(nextId, { exact: true })).toBeVisible();
  expect(lists.at(-1)?.get('disposition')).toBe('FOLLOW_UP_REQUIRED');
  expect(lists.at(-1)?.get('from')).toBe('2026-11-15T17:00:00.000Z');
  expect(new URL(page.url()).searchParams.get('disposition')).toBe('FOLLOW_UP_REQUIRED');

  await page.reload();
  await expect(summary.getByRole('button', { name: /ต้องติดตามต่อ/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(lists.at(-1)?.get('disposition')).toBe('FOLLOW_UP_REQUIRED');

  await summary.getByRole('button', { name: 'แสดงงานที่จบทั้งหมด 3 งาน' }).click();
  await expect(
    page.getByRole('heading', { name: 'รายการงาน · 7 วัน · ทุกผลบันทึก · 3 งาน' }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has('disposition')).toBe(false);

  await page.getByRole('button', { name: 'วันนี้', exact: true }).click();
  await expect(summary).toContainText('22 พ.ย. 2569 · เวลาอินโดจีน');
  await expect(page.getByText('ไม่มีงาน Voice ที่จบในช่วงเวลานี้', { exact: true })).toBeVisible();
  expect(summaries.at(-1)).toBe('today');
  expect(new URL(page.url()).searchParams.get('period')).toBe('today');
});

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
