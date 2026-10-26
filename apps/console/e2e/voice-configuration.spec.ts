import { expect, test, type Page } from '@playwright/test';
import { homeNavigation } from './support/home-navigation.js';

const queueId = '7a33ac96-d87d-4ca4-ab75-f27e40e943be';
const teamId = '7a33ac96-d87d-4ca4-ab75-f27e40e943bf';
const userId = '7a33ac96-d87d-4ca4-ab75-f27e40e943b1';
const skillId = '7a33ac96-d87d-4ca4-ab75-f27e40e943b2';
const destinationId = '7a33ac96-d87d-4ca4-ab75-f27e40e943b3';
test.use({ locale: 'en-US' });
async function harness(
  page: Page,
  options: {
    readOnly?: boolean;
    lost?: boolean;
    conflict?: boolean;
    ready?: boolean;
    active?: boolean;
    requiredSkills?: boolean;
    teardown?: 'PENDING' | 'CONFIRMED' | 'ACTION_REQUIRED';
  } = {},
) {
  const writes: Record<string, unknown>[] = [];
  const reads: string[] = [];
  let revision = 4;
  let items: { skillId: string; level?: number; minLevel?: number }[] =
    (options.requiredSkills ?? options.ready) ? [{ skillId, minLevel: 2 }] : [];
  let bindingActive = !!options.active;
  const queue = {
    id: queueId,
    name: 'Voice queue',
    teamId,
    legacy: false,
    voiceConfigVersion: 1,
    configRevision: 3,
    isActive: !!options.active,
  };
  await page.route('**/api/v1/me/navigation**', (route) =>
    route.fulfill({ json: homeNavigation(['admin'], false) }),
  );
  await page.route('**/api/v1/tenant-voice/**', async (route) => {
    const path = new URL(route.request().url()).pathname.split('/tenant-voice/')[1];
    if (['PUT', 'PATCH'].includes(route.request().method())) {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (options.conflict)
        return route.fulfill({ status: 409, json: { code: 'REVISION_CONFLICT' } });
      revision++;
      if (path === `queues/${queueId}`) {
        queue.isActive = body.isActive;
        queue.configRevision = revision;
      }
      if (path.endsWith('/binding')) bindingActive = body.isActive;
      items = body.items ?? [];
      if (options.lost) return route.abort('failed');
      return route.fulfill({ json: { configRevision: revision, items } });
    }
    reads.push(path);
    if (path === 'capabilities')
      return route.fulfill({
        json: {
          version: 1,
          canWrite: !options.readOnly,
          configuration: { ready: true, reasons: [] },
          managedRouting: {
            ready: !!options.ready,
            reasons: options.ready ? [] : ['CAPABILITY_NOT_READY'],
          },
          limits: null,
        },
      });
    if (path === 'teams') return route.fulfill({ json: { items: [{ id: teamId, name: 'Team' }] } });
    if (path === 'skills')
      return route.fulfill({
        json: {
          items: [{ id: skillId, name: 'Thai language', teamId, legacy: false }],
          nextCursor: null,
        },
      });
    if (path === 'queues') return route.fulfill({ json: { items: [queue], nextCursor: null } });
    if (path === `queues/${queueId}`) return route.fulfill({ json: queue });
    if (path === `queues/${queueId}/runtime`)
      return route.fulfill({
        json: {
          queueId,
          configRevision: revision,
          ready: !!options.ready,
          reasons: options.ready ? [] : ['RUNTIME_HEARTBEAT_STALE'],
          policy: {
            version: 1,
            offerTimeoutSec: 20,
            maxTotalPreanswerSec: 60,
            terminalAction: 'HANGUP',
          },
          terminal: {
            reason: 'PREANSWER_DEADLINE_EXCEEDED',
            occurredAt: '2026-10-24T00:00:00Z',
            teardownState: options.teardown ?? 'PENDING',
          },
          evaluatedAt: '2026-10-24T00:01:00Z',
        },
      });
    if (path === 'people/roster')
      return route.fulfill({
        json: {
          items: [
            {
              id: userId,
              displayName: 'Pending Agent',
              role: 'AGENT',
              teamId,
              configRevision: 4,
              state: 'PENDING_ACTIVATION',
            },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith('/skills') || path.endsWith('/required-skills'))
      return route.fulfill({ json: { configRevision: revision, items } });
    if (path === 'destinations')
      return route.fulfill({
        json: {
          items: [
            {
              id: destinationId,
              destination: '1000',
              queueId,
              entryMode: 'DIRECT_QUEUE',
              isActive: bindingActive,
              configRevision: revision,
              voiceConfigVersion: 1,
            },
          ],
          nextCursor: null,
        },
      });
    if (path === 'eligibility')
      return route.fulfill({
        json: {
          queueId,
          configRevision: revision,
          evaluatedAt: '2026-10-22T00:00:00Z',
          candidates: [
            {
              userId,
              displayName: 'Pending Agent',
              eligible: false,
              available: false,
              reasons: ['INACTIVE_AGENT'],
            },
          ],
          warnings: ['NO_ELIGIBLE_AVAILABLE_AGENT'],
        },
      });
    if (path.startsWith('commands/'))
      return route.fulfill({
        json: { state: 'SUCCEEDED', result: { configRevision: revision, items } },
      });
    return route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } });
  });
  return { writes, reads };
}
async function select(page: Page, label: string, option: string) {
  await page
    .getByRole('button', { name: new RegExp(`${label}$`) })
    .and(page.locator('[aria-haspopup="listbox"]'))
    .click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
test('pending Agent skills ใช้ configRevision และกู้ command หลัง response หาย/reload', async ({
  page,
}) => {
  const data = await harness(page, { lost: true });
  await page.goto('/?view=tenant-people&section=agent-skills&tenant=demo');
  await select(page, 'Agent', 'Pending Agent');
  await expect(page.getByText(/Skills can be prepared before activation/)).toBeVisible();
  await select(page, 'Thai language', 'Level 3');
  await page
    .getByRole('textbox', { name: 'Reason (1–500 characters)' })
    .fill('Prepare pending Agent');
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Check original command', exact: true }),
  ).toBeVisible();
  expect(data.writes[0]).toMatchObject({ expectedRevision: 4, items: [{ skillId, level: 3 }] });
  await page.reload();
  await page.getByRole('button', { name: 'Check original command', exact: true }).click();
  await expect(
    page.getByText('Saved and read back from the server', { exact: true }),
  ).toBeVisible();
  expect(data.writes).toHaveLength(1);
  expect(
    data.reads.filter((path) => path === `people/users/${userId}/skills`).length,
  ).toBeGreaterThan(1);
  expect(data.reads).not.toContain('people/users');
  await expect(page.getByRole('region', { name: 'Queue eligibility' })).toContainText(
    'Voice queue',
  );
});
test('Supervisor อ่าน roster โดยไม่เรียก sensitive people APIs หรือแสดง save', async ({ page }) => {
  const data = await harness(page, { readOnly: true });
  await page.goto('/?view=voice-routing&section=agent-skills&tenant=demo');
  await select(page, 'Agent', 'Pending Agent');
  await expect(page.getByText('Read only for Supervisor', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save configuration', exact: true })).toHaveCount(
    0,
  );
  expect(data.reads.some((path) => path === 'people/users' || path === 'extension-pool')).toBe(
    false,
  );
  expect(data.writes).toEqual([]);
});
test('queue requirements แสดง eligibility warning และ conflict ต้อง reload', async ({ page }) => {
  const data = await harness(page, { conflict: true });
  await page.goto(`/?view=voice-routing&resource=${queueId}&tenant=demo`);
  await expect(
    page.getByText('No eligible available Agent. Valid configuration can still be saved.', {
      exact: true,
    }),
  ).toBeVisible();
  await select(page, 'Thai language', 'Level 2');
  await page.getByRole('textbox', { name: 'Reason (1–500 characters)' }).fill('Queue requirements');
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Configuration changed');
  await expect(
    page.getByRole('button', { name: 'Save configuration', exact: true }),
  ).toBeDisabled();
  expect(data.writes[0]).toMatchObject({ expectedRevision: 4, items: [{ skillId, minLevel: 2 }] });
});
test('destination binding บันทึก inactive และอ่านผลกลับ', async ({ page }) => {
  const data = await harness(page);
  await page.goto('/?view=voice-routing&section=destinations&tenant=demo');
  await select(page, 'Reserved destination', '1000');
  await expect(
    page.getByText('Managed routing is not ready for activation', {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Reason (1–500 characters)' })
    .fill('Prepare destination');
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(
    page.getByText('Saved and read back from the server', { exact: true }),
  ).toBeVisible();
  expect(data.writes[0]).toMatchObject({ queueId, isActive: false, expectedRevision: 4 });
  expect(data.reads.filter((path) => path === 'destinations').length).toBeGreaterThan(1);
});
for (const code of ['RESOURCE_POLICY_NOT_READY', 'CAPABILITY_NOT_READY', 'FAILED'])
  test(`mutation 503 ${code}: definitive rejection ปลด pending แต่ unknown ต้องกู้คำสั่งเดิม`, async ({
    page,
  }) => {
    const data = await harness(page);
    let ready = false;
    const rejected: Record<string, unknown>[] = [];
    await page.route(
      `**/api/v1/tenant-voice/destinations/${destinationId}/binding`,
      async (route) => {
        if (ready) return route.fallback();
        rejected.push(route.request().postDataJSON());
        return route.fulfill({ status: 503, json: { code } });
      },
    );
    await page.goto('/?view=voice-routing&section=destinations&tenant=demo');
    await select(page, 'Reserved destination', '1000');
    await page
      .getByRole('textbox', { name: 'Reason (1–500 characters)' })
      .fill('Prepare destination');
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    const stored = () =>
      page.evaluate(() =>
        Object.keys(sessionStorage).filter((key) => key.startsWith('dc:voice-config:')),
      );
    if (code === 'FAILED') {
      expect(await stored()).toHaveLength(1);
      await page.reload();
      await expect(
        page.getByRole('button', { name: 'Check original command', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Save configuration', exact: true }),
      ).toBeDisabled();
      expect(data.writes).toHaveLength(0);
      return;
    }
    expect(await stored()).toEqual([]);
    await expect(
      page.getByRole('button', { name: 'Check original command', exact: true }),
    ).toHaveCount(0);
    ready = true;
    await page.reload();
    await select(page, 'Reserved destination', '1000');
    await page.getByRole('textbox', { name: 'Reason (1–500 characters)' }).fill('Policy ready');
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await expect(
      page.getByText('Saved and read back from the server', { exact: true }),
    ).toBeVisible();
    expect(data.writes).toHaveLength(1);
    expect(data.writes[0].commandId).not.toBe(rejected[0].commandId);
    expect(data.writes[0].expectedRevision).toBe(rejected[0].expectedRevision);
    expect(data.reads.some((path) => path.startsWith('commands/'))).toBe(false);
    expect(await stored()).toEqual([]);
  });
test.describe('Thai B4', () => {
  test.use({ locale: 'th-TH' });
  test('ปลายทางแสดง loading/error และ retry ภาษาไทย', async ({ page }) => {
    await harness(page);
    let fail = true;
    await page.route('**/api/v1/tenant-voice/destinations?**', async (route) => {
      if (fail) return route.fulfill({ status: 503, json: { code: 'CAPABILITY_NOT_READY' } });
      return route.fallback();
    });
    await page.goto('/?view=voice-routing&section=destinations&tenant=demo');
    await expect(page.getByRole('alert')).toContainText('ความสามารถนี้ยังไม่พร้อมใช้งาน');
    fail = false;
    await page.getByRole('button', { name: 'ลองอีกครั้ง', exact: true }).click();
    await select(page, 'ปลายทางที่จองไว้', '1000');
    await expect(page.getByRole('heading', { name: 'ปลายทาง', exact: true })).toBeVisible();
    await expect(
      page.getByText('Managed routing ยังไม่พร้อมเปิดใช้งาน', {
        exact: true,
      }),
    ).toBeVisible();
  });
});

test('B5 เปิดคิวพร้อม warning อ่านสถานะจริงและ terminal reason จาก server', async ({ page }) => {
  const data = await harness(page, { ready: true });
  await page.goto(`/?view=voice-routing&resource=${queueId}&tenant=demo`);
  await expect(page.getByText(/Fixed policy: offer 20 seconds/)).toBeVisible();
  await expect(page.getByText(/Total pre-answer time expired/)).toBeVisible();
  await expect(
    page.getByText('Waiting for confirmation that caller and Agent legs have ended'),
  ).toBeVisible();
  await expect(page.getByText(/No eligible available Agent\./)).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Reason (1–500 characters)' })
    .fill('Enable managed queue');
  await page.getByRole('button', { name: 'Activate queue', exact: true }).click();
  await expect(
    page.getByText('Saved and read back from the server', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deactivate queue', exact: true })).toBeVisible();
  expect(data.writes[0]).toMatchObject({
    expectedRevision: 3,
    isActive: true,
    reasonCode: 'ADMIN_CONFIGURATION',
  });
  expect(data.writes[0].commandId).toMatch(/^[0-9a-f-]{36}$/);
  expect(data.reads.filter((path) => path === `queues/${queueId}`).length).toBeGreaterThan(1);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Deactivate queue', exact: true })).toBeVisible();
});

test('B5 readiness ปิด gate เปิดคิวและ binding แต่ยังปิดคิวได้', async ({ page }) => {
  const data = await harness(page, { active: true });
  await page.goto(`/?view=voice-routing&resource=${queueId}&tenant=demo`);
  await page.getByRole('textbox', { name: 'Reason (1–500 characters)' }).fill('Stop route');
  await page.getByRole('button', { name: 'Deactivate queue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Activate queue', exact: true })).toBeDisabled();
  expect(data.writes[0]).toMatchObject({ isActive: false });
  await page.goto('/?view=voice-routing&section=destinations&tenant=demo');
  await select(page, 'Reserved destination', '1000');
  await select(page, 'Binding status', 'Inactive');
  await page.getByRole('textbox', { name: 'Reason (1–500 characters)' }).fill('Stop destination');
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(
    page.getByText('Saved and read back from the server', { exact: true }),
  ).toBeVisible();
  expect(data.writes[1]).toMatchObject({ isActive: false, queueId });
});

test('B5 เปิด binding ด้วย boolean และ readback', async ({ page }) => {
  const data = await harness(page, { ready: true, active: true });
  await page.goto('/?view=voice-routing&section=destinations&tenant=demo');
  await select(page, 'Reserved destination', '1000');
  await select(page, 'Binding status', 'Inactive');
  await select(page, 'Binding status', 'Active');
  await page.getByRole('textbox', { name: 'Reason (1–500 characters)' }).fill('Enable destination');
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(
    page.getByText('Saved and read back from the server', { exact: true }),
  ).toBeVisible();
  expect(data.writes[0]).toMatchObject({ isActive: true, queueId, expectedRevision: 4 });
});

for (const failure of ['conflict', 'lost'] as const) {
  test(`B5 activation ${failure} ไม่ส่งซ้ำและกู้/โหลด revision ใหม่`, async ({ page }) => {
    const data = await harness(page, { ready: true, [failure]: true });
    await page.goto(`/?view=voice-routing&resource=${queueId}&tenant=demo`);
    await page.getByRole('textbox', { name: 'Reason (1–500 characters)' }).fill('Enable queue');
    await page.getByRole('button', { name: 'Activate queue', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate queue', exact: true })).toBeDisabled();
    if (failure === 'lost') {
      await page.reload();
      await page.getByRole('button', { name: 'Check original command', exact: true }).click();
      await expect(
        page.getByText('Saved and read back from the server', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Deactivate queue', exact: true }),
      ).toBeVisible();
      expect(data.reads.some((path) => path.startsWith('commands/'))).toBe(true);
    } else {
      await page
        .getByRole('region', { name: 'Queue required skills', exact: true })
        .getByRole('button', { name: 'Retry', exact: true })
        .click();
      await expect(page.getByRole('button', { name: 'Activate queue', exact: true })).toBeEnabled();
    }
    expect(data.writes).toHaveLength(1);
  });
}

test('B5 Supervisor อ่าน runtime ได้แต่ไม่มี activation controls', async ({ page }) => {
  const data = await harness(page, { ready: true, readOnly: true });
  await page.goto(`/?view=voice-routing&resource=${queueId}&tenant=demo`);
  await expect(page.getByText(/Total pre-answer time expired/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Activate|Deactivate) queue$/ })).toHaveCount(0);
  expect(data.writes).toEqual([]);
});

test('B5 readiness gate ใช้ server capability แม้มี skills แล้ว', async ({ page }) => {
  const data = await harness(page, { requiredSkills: true });
  await page.goto(`/?view=voice-routing&resource=${queueId}&tenant=demo`);
  await page.getByRole('textbox', { name: 'Reason (1–500 characters)' }).fill('Enable route');
  await expect(page.getByRole('button', { name: 'Activate queue', exact: true })).toBeDisabled();
  await page.goto('/?view=voice-routing&section=destinations&tenant=demo');
  await select(page, 'Reserved destination', '1000');
  await page
    .getByRole('button', { name: /Binding status$/ })
    .and(page.locator('[aria-haspopup="listbox"]'))
    .click();
  await expect(page.getByRole('option', { name: 'Active', exact: true })).toHaveCount(0);
  expect(data.writes).toEqual([]);
});

test('B5 runtime พร้อมแต่ไม่มี required skills ยังเปิดคิวไม่ได้', async ({ page }) => {
  const data = await harness(page, { ready: true, requiredSkills: false });
  await page.goto(`/?view=voice-routing&resource=${queueId}&tenant=demo`);
  await page.getByRole('textbox', { name: 'Reason (1–500 characters)' }).fill('Enable route');
  await expect(
    page.getByText('Save at least one required skill before activating this queue.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activate queue', exact: true })).toBeDisabled();
  expect(data.writes).toEqual([]);
});

test('B5 runtime อ่านไม่ได้ไม่แสดง terminal reason ที่ browser เดาเอง', async ({ page }) => {
  await harness(page, { ready: true });
  await page.route('**/api/v1/tenant-voice/queues/*/runtime', (route) =>
    route.fulfill({ status: 503, json: { code: 'CAPABILITY_NOT_READY' } }),
  );
  await page.goto(`/?view=voice-routing&resource=${queueId}&tenant=demo`);
  await expect(
    page.getByText('Runtime status is unavailable. Retry to read the server status.'),
  ).toBeVisible();
  await expect(page.getByText(/Total pre-answer time expired/)).toHaveCount(0);
});

test('B5 ผล teardown ไม่ชัดเจนไม่แสดงว่ายืนยันการตัดสายสำเร็จ', async ({ page }) => {
  await harness(page, { ready: true, teardown: 'ACTION_REQUIRED' });
  await page.goto(`/?view=voice-routing&resource=${queueId}&tenant=demo`);
  await expect(
    page.getByText('Teardown outcome is unknown. An operator must reconcile it before retrying.'),
  ).toBeVisible();
  await expect(page.getByText('Caller and Agent leg teardown is confirmed')).toHaveCount(0);
});

test.describe('Thai B5', () => {
  test.use({ locale: 'th-TH' });
  test('เปิดคิวพร้อม fixed policy และเหตุผลจาก server ภาษาไทย', async ({ page }) => {
    const data = await harness(page, { ready: true });
    await page.goto(`/?view=voice-routing&resource=${queueId}&tenant=demo`);
    await expect(page.getByText(/นโยบายคงที่: เสนอให้ Agent คนละ 20 วินาที/)).toBeVisible();
    await expect(
      page.getByText(/เหตุผลสิ้นสุดล่าสุดจาก server: หมดเวลารวมก่อน Agent รับสาย/),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'เหตุผล (1–500 ตัวอักษร)' }).fill('เปิดเส้นทางรับสาย');
    await page.getByRole('button', { name: 'เปิดใช้งานคิว', exact: true }).click();
    await expect(page.getByRole('button', { name: 'ปิดใช้งานคิว', exact: true })).toBeVisible();
    expect(data.writes[0]).toMatchObject({ isActive: true, reason: 'เปิดเส้นทางรับสาย' });
  });
});
