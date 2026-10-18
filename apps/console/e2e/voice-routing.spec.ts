import { expect, test, type Page } from '@playwright/test';
import { homeNavigation } from './support/home-navigation.js';
const id = '7a33ac96-d87d-4ca4-ab75-f27e40e943be',
  teamId = '7a33ac96-d87d-4ca4-ab75-f27e40e943bf';
const capabilities = {
  version: 1,
  canWrite: true,
  configuration: { ready: true, reasons: [] },
  managedRouting: { ready: false, reasons: ['CAPABILITY_NOT_READY'] },
  policyRevision: 1,
  sourceKind: 'UAT_EXPLICIT',
  limits: { voiceQueues: { used: 0, limit: 10 }, skills: { used: 0, limit: 10 } },
};
const item = (name: string, kind: string) => ({
  id,
  name,
  teamId,
  voiceConfigVersion: 1,
  legacy: false,
  ...(kind === 'queues'
    ? {
        isActive: false,
        configRevision: 1,
        policy: { offerTimeoutSec: 20, maxTotalPreanswerSec: 60, terminalAction: 'HANGUP' },
      }
    : { code: 'LANG_TH', revision: 1 }),
});
test.use({ locale: 'th-TH' });
for (const section of ['queues', 'skills'])
  test(`production auth root เปิด Voice ${section} โดยไม่บังคับ Interaction context`, async ({
    page,
  }) => {
    await page.goto(`/?view=voice-routing&section=${section}&tenant=demo&authRootHarness=1`);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'ไม่พบ Interaction context', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('main')).toContainText(/Identity Provider|เข้าสู่ระบบ|Voice/);
  });

async function harness(
  page: Page,
  options: {
    readOnly?: boolean;
    notReady?: boolean;
    lostResponse?: boolean;
    timeoutResponse?: boolean;
    status?: number;
    shellV2?: boolean;
    legacyPages?: boolean;
  } = {},
) {
  let stored: ReturnType<typeof item> | undefined;
  const commands: string[] = [];
  let detailReads = 0;
  await page.route('**/api/v1/me/navigation**', (route) => {
    const nav = homeNavigation(['admin'], options.shellV2 ?? true);
    if (options.legacyPages)
      for (const area of nav.areas)
        for (const section of area.sections) for (const item of section.items) delete item.pages;
    return route.fulfill({ json: nav });
  });
  await page.route('**/api/v1/tenant-voice/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.split('/tenant-voice/')[1];
    if (options.status)
      return route.fulfill({
        status: options.status,
        json: { code: options.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' },
      });
    if (path === 'capabilities')
      return route.fulfill({
        json: {
          ...capabilities,
          canWrite: !options.readOnly,
          configuration: options.notReady
            ? { ready: false, reasons: ['RESOURCE_POLICY_NOT_READY'] }
            : capabilities.configuration,
        },
      });
    if (path === 'teams')
      return route.fulfill({ json: { items: [{ id: teamId, name: 'ทีม UAT' }] } });
    if (path.startsWith('commands/'))
      return stored
        ? route.fulfill({ json: { state: 'SUCCEEDED', result: stored } })
        : route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    const kind = path.split('/')[0];
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      commands.push(body.commandId);
      stored = item(body.name, kind);
      if (options.lostResponse) return route.abort('failed');
      if (options.timeoutResponse) return route.fulfill({ status: 408, json: { code: 'FAILED' } });
      return route.fulfill({ status: 201, json: stored });
    }
    if (path.includes('/')) {
      detailReads++;
      return stored
        ? route.fulfill({ json: stored })
        : route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    }
    return route.fulfill({ json: { items: stored ? [stored] : [], nextCursor: null } });
  });
  return { commands, reads: () => detailReads };
}
async function fill(page: Page, name: string, skill = false) {
  await page.getByRole('textbox', { name: 'ชื่อ', exact: true }).fill(name);
  if (skill) await page.getByRole('textbox', { name: 'รหัสทักษะ', exact: true }).fill('LANG_TH');
  await page.getByRole('button', { name: 'เลือกทีม ทีม', exact: true }).click();
  await page.getByRole('option', { name: 'ทีม UAT' }).click();
}
for (const kind of ['queues', 'skills'])
  test(`${kind}: create→readback→reload และไม่ใช้ lease/SIP/WS`, async ({ page }) => {
    const data = await harness(page);
    const forbidden: string[] = [];
    page.on('request', (r) => {
      if (/work-session|sip-credentials/.test(r.url())) forbidden.push(r.url());
    });
    page.on('websocket', (s) => {
      if (s.url().includes('workspace-session')) forbidden.push(s.url());
    });
    await page.goto(`/?view=voice-routing&section=${kind}&tenant=demo`);
    await expect(page.getByText('ยังไม่มีรายการในขอบเขตของคุณ', { exact: true })).toBeVisible();
    await fill(page, kind === 'queues' ? 'คิวทดสอบ Voice' : 'ทักษะภาษา', kind === 'skills');
    await page.getByRole('button', { name: 'สร้างรายการ', exact: true }).click();
    await expect(page.getByText('บันทึกและอ่านผลจาก server แล้ว', { exact: true })).toBeVisible();
    expect(data.reads()).toBeGreaterThan(0);
    expect(data.commands).toHaveLength(1);
    expect(page.url()).toContain(`resource=${id}`);
    await page.reload();
    await expect(
      page.getByRole('heading', {
        name: kind === 'queues' ? 'คิวทดสอบ Voice' : 'ทักษะภาษา',
        exact: true,
      }),
    ).toBeVisible();
    expect(forbidden).toEqual([]);
    await page.screenshot({ path: `/tmp/dcontact-b1-${kind}-th.png`, fullPage: true });
  });
for (const outcome of ['lost response', 'HTTP 408'])
  test(`${outcome} + reload → command lookup เดิม → readback โดยไม่ส่ง create ใหม่`, async ({
    page,
  }) => {
    const data = await harness(
      page,
      outcome === 'lost response' ? { lostResponse: true } : { timeoutResponse: true },
    );
    await page.goto('/?view=voice-routing&tenant=demo');
    await fill(page, 'คิวกู้ผล');
    await page.getByRole('button', { name: 'สร้างรายการ', exact: true }).click();
    await expect(
      page.getByText('ยังยืนยันผลไม่ได้ ตรวจคำสั่งเดิมก่อนสร้างรายการใหม่', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'สร้างรายการ', exact: true })).toBeDisabled();
    const remembered = await page.evaluate(() =>
      Object.entries(sessionStorage)
        .filter(([key]) => key.startsWith('dc:voice-catalog:pending:'))
        .map(([, value]) => value),
    );
    expect(remembered).toEqual(data.commands);
    await page.reload();
    await expect(
      page.getByText('ยังยืนยันผลไม่ได้ ตรวจคำสั่งเดิมก่อนสร้างรายการใหม่', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'สร้างรายการ', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'ตรวจผลคำสั่งเดิม', exact: true }).click();
    await expect(page.getByText('บันทึกและอ่านผลจาก server แล้ว', { exact: true })).toBeVisible();
    expect(data.commands).toHaveLength(1);
    expect(data.reads()).toBeGreaterThan(0);
  });
test('Supervisor อ่านอย่างเดียว และ missing policy กัน create พร้อมบอกเหตุผล', async ({ page }) => {
  await harness(page, { readOnly: true });
  await page.goto('/?view=voice-routing&tenant=demo');
  await expect(page.getByText('อ่านอย่างเดียวสำหรับ Supervisor', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'สร้างรายการ', exact: true })).toHaveCount(0);
  await page.unroute('**/api/v1/tenant-voice/**');
  await harness(page, { notReady: true });
  await page.reload();
  await expect(
    page.getByText('ยังไม่มีนโยบายทรัพยากรที่ operator อนุมัติ', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'สร้างรายการ', exact: true })).toBeDisabled();
});
for (const status of [401, 403])
  test(`HTTP ${status} แสดงสถานะสิทธิ์และไม่เปิด create`, async ({ page }) => {
    await harness(page, { status });
    await page.goto('/?view=voice-routing&tenant=demo');
    await expect(page.getByRole('alert')).toContainText(
      status === 401 ? 'session หมดอายุ' : 'ไม่มีสิทธิ์',
    );
    await expect(page.getByRole('button', { name: 'สร้างรายการ', exact: true })).toHaveCount(0);
  });
test.describe('English', () => {
  test.use({ locale: 'en-US' });
  test('แสดง catalog และ policy ภาษาอังกฤษ', async ({ page }) => {
    await harness(page);
    await page.goto('/?view=voice-routing&tenant=demo');
    await expect(
      page.getByRole('heading', { name: 'Voice configuration', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Using 0 of 10 items', { exact: true })).toBeVisible();
    await page.screenshot({ path: '/tmp/dcontact-b1-queues-en.png', fullPage: true });
  });
});

for (const mode of ['shell', 'shell-off', 'legacy-pages'] as const)
  test(`${mode}: สลับคิว/skill ไฮไลต์ตรงหน้าและย้อนกลับโดยไม่ reload`, async ({ page }) => {
    await harness(page, { shellV2: mode !== 'shell-off', legacyPages: mode === 'legacy-pages' });
    await page.goto('/?view=voice-routing&section=queues&tenant=demo');
    await expect(page.getByRole('heading', { name: 'คิว Voice', exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { catalogNavigationProbe: string }).catalogNavigationProbe =
        'same-document';
    });
    if (mode === 'shell') {
      await expect(page.locator('a[aria-current="page"]', { hasText: 'คิว Voice' })).toBeVisible();
      await page.getByRole('link', { name: 'ทักษะ', exact: true }).click();
      await expect(page.locator('a[aria-current="page"]', { hasText: 'ทักษะ' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'คิวและทักษะ' })).toHaveCount(0);
    } else {
      const nav = page.getByRole('navigation', { name: 'คิวและทักษะ' });
      await nav.getByRole('button', { name: 'ทักษะ', exact: true }).click();
      await expect(nav.getByRole('button', { name: 'ทักษะ', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
    await expect(page.getByRole('heading', { name: 'ทักษะ', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'รหัสทักษะ', exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { catalogNavigationProbe: string }).catalogNavigationProbe,
      ),
    ).toBe('same-document');
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'คิว Voice', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'รหัสทักษะ', exact: true })).toHaveCount(0);
  });
