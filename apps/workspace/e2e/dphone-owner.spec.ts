import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { ACCESS_TOKEN, REFRESH_TOKEN, dphoneFrame, messages, setup } from './embed-harness';

async function activeOwner(page: Page, nested = false) {
  const fixture = await setup(page, { ownerWindow: true });
  const { server } = fixture;
  let frame = fixture.frame;
  if (nested) {
    await page.context().route('https://crm.example.test/outer', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<iframe id="wrapper" src="https://crm.example.test/wrapper" allow="microphone; autoplay"></iframe>',
      }),
    );
    await page.goto('https://crm.example.test/outer');
    frame = page.frameLocator('#wrapper').frameLocator('#dphone');
  }
  const [owner] = await Promise.all([
    page.waitForEvent('popup'),
    frame.getByRole('button', { name: 'เปิดหน้าต่าง dphone' }).click(),
  ]);
  await expect(owner.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  const [login] = await Promise.all([
    owner.waitForEvent('popup'),
    owner.getByRole('button', { name: 'เข้าสู่ระบบ' }).click(),
  ]);
  await expect.poll(() => login.isClosed()).toBe(true);
  await expect(owner.getByRole('status').first()).toHaveText('เข้าสู่ระบบแล้ว');
  await owner.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  const phone = owner.getByRole('region', { name: 'dphone' });
  await phone.getByRole('button', { name: 'รับสาย' }).click();
  await expect(phone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  return { server, frame, owner, phone };
}

test('the owner keeps the call and the original lease when the CRM reloads, then can send wrap-up/activity back', async ({
  page,
  context,
}) => {
  const { server, frame, owner, phone } = await activeOwner(page);
  const session = await owner.evaluate(() => window.__dcontactDphone?.sipSessionId());
  const timeOrigin = await owner.evaluate(() => performance.timeOrigin);
  const leases = server.leaseBodies.length;
  const checks = server.ownerPolicyChecks;
  server.state = 'ACTIVE';
  await page.reload();
  await expect(frame.getByRole('status')).toHaveText(
    'dphone เปิดอยู่ สายยังคงอยู่เมื่อรีโหลดหน้า CRM นี้',
  );
  await expect.poll(() => server.ownerPolicyChecks).toBeGreaterThan(checks);
  expect(await owner.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(session);
  expect(await owner.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  expect(server.leaseBodies).toHaveLength(leases);
  expect(await dphoneFrame(page).evaluate(() => window.__dphoneEmbed?.auth)).toBeNull();
  await expect(phone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  const hostSurface = await page.evaluate(() =>
    JSON.stringify({
      html: document.documentElement.outerHTML,
      messages: (window as unknown as { __messages: unknown[] }).__messages,
      storage: { ...sessionStorage },
    }),
  );
  expect(hostSurface).not.toContain(ACCESS_TOKEN);
  expect(hostSurface).not.toContain(REFRESH_TOKEN);
  server.state = 'WRAPUP';
  await phone.getByRole('button', { name: 'วางสาย' }).click();
  await owner.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' }).click();
  await owner.getByRole('button', { name: 'บันทึกผล' }).click();
  await expect
    .poll(async () =>
      (await messages(page)).filter((message) => message.type === 'dphone.activity'),
    )
    .toHaveLength(1);
  expect(server.wrapups).toBe(1);
  await expect
    .poll(() =>
      owner.evaluate(() =>
        sessionStorage.getItem('dphone.embed.activity.demo.https://crm.example.test'),
      ),
    )
    .toBeNull();
  await owner.close();
  expect(context.pages()).toContain(page);
});

test('the owner starts no auth or lease when the server rejects a fresh policy', async ({
  page,
}) => {
  const { server, frame } = await setup(page, { ownerWindow: true });
  server.ownerAllowed = false;
  const [owner] = await Promise.all([
    page.waitForEvent('popup'),
    frame.getByRole('button', { name: 'เปิดหน้าต่าง dphone' }).click(),
  ]);
  await expect.poll(() => server.ownerPolicyChecks).toBeGreaterThan(0);
  expect(server.leaseBodies).toHaveLength(0);
  await expect(owner.getByRole('button', { name: 'เข้าสู่ระบบ' })).toHaveCount(0);
  await owner.close();
});

test('a policy slower than the probe causes no overlapping attach that leaves the runtime unable to start', async ({
  page,
}) => {
  const { frame } = await setup(page, { ownerWindow: true });
  let checks = 0;
  await page.context().route('**/dphone/embed/owner-policy**', async (route) => {
    checks += 1;
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await route.fulfill({ json: { allowed: true } });
  });
  const [owner] = await Promise.all([
    page.waitForEvent('popup'),
    frame.getByRole('button', { name: 'เปิดหน้าต่าง dphone' }).click(),
  ]);
  await expect(owner.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  expect(checks).toBe(1);
  await owner.close();
});

test('an iframe reload within the same WindowProxy with no detach must re-check the policy', async ({
  page,
}) => {
  const { server, frame, owner } = await activeOwner(page);
  const session = await owner.evaluate(() => window.__dcontactDphone?.sipSessionId());
  const checks = server.ownerPolicyChecks;
  await dphoneFrame(page).evaluate(() => {
    window.addEventListener('pagehide', (event) => event.stopImmediatePropagation(), {
      capture: true,
    });
    location.reload();
  });
  await expect.poll(() => server.ownerPolicyChecks).toBeGreaterThan(checks);
  await expect(frame.getByRole('status')).toContainText('dphone เปิดอยู่');
  expect(await owner.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(session);
  await owner.close();
});

test('after the outer CRM that is already nested reloads, the new controller can connect to the original owner', async ({
  page,
}) => {
  const { server, frame, owner, phone } = await activeOwner(page, true);
  const session = await owner.evaluate(() => window.__dcontactDphone?.sipSessionId());
  const leases = server.leaseBodies.length;
  await page.reload();
  await expect(frame.getByRole('status')).toContainText('dphone เปิดอยู่');
  expect(await owner.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(session);
  expect(server.leaseBodies).toHaveLength(leases);
  await expect(phone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  await owner.close();
});

test('repeated reloads while waiting for the policy must not let an old result overwrite the new document', async ({
  page,
}) => {
  const { frame, owner } = await activeOwner(page);
  const session = await owner.evaluate(() => window.__dcontactDphone?.sipSessionId());
  let capture!: (route: Route) => void;
  const pending = new Promise<Route>((resolve) => {
    capture = resolve;
  });
  let delay = true;
  await page.context().route('**/dphone/embed/owner-policy**', async (route) => {
    if (delay) {
      delay = false;
      capture(route);
      return;
    }
    await route.fulfill({ json: { allowed: true } });
  });
  await page.reload();
  const delayed = await pending;
  await page.reload();
  await delayed.fulfill({ json: { allowed: true } });
  await expect(frame.getByRole('status')).toContainText('dphone เปิดอยู่');
  expect(await owner.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(session);
  await owner.close();
});

test('after a rejected reattach the owner keeps talking, but the CRM cannot send commands', async ({
  page,
}) => {
  const { server, frame, owner, phone } = await activeOwner(page);
  const session = await owner.evaluate(() => window.__dcontactDphone?.sipSessionId());
  const checks = server.ownerPolicyChecks;
  server.ownerAllowed = false;
  await page.reload();
  await expect.poll(() => server.ownerPolicyChecks).toBeGreaterThan(checks);
  await expect(frame.getByRole('status')).not.toContainText('dphone เปิดอยู่');
  expect(await owner.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(session);
  await expect(phone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  await page.evaluate(() =>
    (window as unknown as { __send(message: unknown): void }).__send({
      v: 1,
      type: 'dphone.call',
      requestId: 'denied',
      number: '1102',
    }),
  );
  await expect
    .poll(() => messages(page))
    .toContainEqual(
      expect.objectContaining({
        type: 'dphone.call.result',
        requestId: 'denied',
        status: 'unavailable',
      }),
    );
  expect(server.clickToCalls).toHaveLength(0);
  server.ownerAllowed = true;
  await expect(frame.getByRole('status')).toContainText('dphone เปิดอยู่');
  expect(await owner.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(session);
  await owner.close();
});

test('a repeated attach after a rejected policy: recovery must be able to reconnect without the call changing', async ({
  page,
}) => {
  const { server, frame, owner } = await activeOwner(page);
  const session = await owner.evaluate(() => window.__dcontactDphone?.sipSessionId());
  server.ownerAllowed = false;
  const checks = server.ownerPolicyChecks;
  await owner.evaluate(() =>
    window.opener.postMessage({ channel: 'dphone.owner.v1', kind: 'probe' }, location.origin),
  );
  await expect.poll(() => server.ownerPolicyChecks).toBeGreaterThan(checks);
  await expect(frame.getByRole('status')).toContainText('การเชื่อมต่อ dphone ขาดหาย');
  server.ownerAllowed = true;
  await expect(frame.getByRole('status')).toContainText('dphone เปิดอยู่');
  expect(await owner.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(session);
  await owner.close();
});

test('revoking the origin closes the controller but the owner keeps the original SIP session', async ({
  page,
}) => {
  const { server, frame, owner, phone } = await activeOwner(page);
  const session = await owner.evaluate(() => window.__dcontactDphone?.sipSessionId());
  server.sendWorkspaceEvent?.({ type: 'embed.origin.revoked', origin: 'https://crm.example.test' });
  await expect(frame.getByRole('status')).toContainText('สิทธิ์ฝัง dphone ของ CRM นี้ถูกนำออก');
  await expect(phone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  expect(await owner.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(session);
  await owner.close();
});

test('a blocked popup shows the reason and does not request a lease', async ({ page }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const { server, frame } = await setup(page, { ownerWindow: true });
  await frame.getByRole('button', { name: 'เปิดหน้าต่าง dphone' }).click();
  await expect(frame.getByRole('status')).toContainText('กรุณาอนุญาตป๊อปอัป');
  expect(server.leaseBodies).toHaveLength(0);
});

test('the owner does not use the iframe original refresh token, and after closing the controller reports disconnected', async ({
  page,
}) => {
  const { server, frame } = await setup(page, { ownerWindow: true });
  await dphoneFrame(page).evaluate(() =>
    sessionStorage.setItem('dphone.embed.refresh.demo', 'legacy-iframe-refresh'),
  );
  const [owner] = await Promise.all([
    page.waitForEvent('popup'),
    frame.getByRole('button', { name: 'เปิดหน้าต่าง dphone' }).click(),
  ]);
  await expect(owner.getByRole('status').first()).toHaveText('ยังไม่ได้เข้าสู่ระบบ');
  expect(server.leaseBodies).toHaveLength(0);
  await expect(frame.getByRole('status')).toContainText('dphone เปิดอยู่');
  await owner.close();
  await expect(frame.getByRole('status')).toContainText('การเชื่อมต่อ dphone ขาดหาย');
});
