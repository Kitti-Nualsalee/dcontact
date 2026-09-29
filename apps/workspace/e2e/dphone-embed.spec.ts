import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import type { Frame, Page } from '@playwright/test';

/**
 * E1.14 (#488): dphone ที่ถูกฝังในหน้า host ต่าง origin (Chromium จริง, iframe จริง)
 *
 * API/Keycloak/WS จำลองด้วย route (ตรวจของจริงใน API integration และ Keycloak boundary) — หลักฐานที่นี่คือ
 * ฝั่ง browser: origin lock, popup login, lease `embedded`, dphone component ของ D1.15 ใน iframe,
 * screen-pop/activity/click-to-call ผ่าน postMessage v1 และ token ไม่ออกนอก iframe
 */
const HOST = 'https://crm.example.test';
const DPHONE = 'http://127.0.0.1:4173';
const ISSUER = 'https://id.example.test/realms/dcontact';
const ACCESS_TOKEN = `e2e-access-${randomUUID()}`;
const REFRESH_TOKEN = `e2e-refresh-${randomUUID()}`;

const hostPage = (origin: string) => `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><title>CRM</title></head>
<body>
<h1>CRM ทดสอบ</h1>
<iframe id="dphone" title="dphone" src="${DPHONE}/dphone/embed?tenant=demo"
  allow="microphone; autoplay" style="width:380px;height:720px;border:0"></iframe>
<script>
  window.__messages = [];
  window.addEventListener('message', (event) => {
    if (event.origin !== '${DPHONE}') return;
    window.__messages.push(event.data);
    if (event.data && event.data.type === 'dphone.activity') {
      document.getElementById('dphone').contentWindow.postMessage(
        { v: 1, type: 'dphone.activity.ack', interactionId: event.data.interactionId }, '${DPHONE}');
    }
  });
  window.__send = (message) =>
    document.getElementById('dphone').contentWindow.postMessage(message, '${DPHONE}');
</script>
<p data-origin="${origin}"></p>
</body></html>`;

const shell = (screenPopLevel: string) => `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><title>dphone</title>
<script type="application/json" id="dphone-embed-config">${JSON.stringify({
  v: 1,
  tenant: 'demo',
  allowedHostOrigins: [HOST],
  auth: { issuer: ISSUER, clientId: 'dphone-embedded' },
  screenPopLevels: { [HOST]: screenPopLevel },
})}</script>
<script type="module" src="/src/embed/main.ts"></script>
</head><body><div id="dphone-embed-root"></div></body></html>`;

// หน้า callback เดียวกับ `/dphone/auth/callback` ของ API (ส่ง code/state ให้ opener บน origin เดียวกัน)
const callbackPage = `<!doctype html><html><head><script>
  const params = new URLSearchParams(location.search);
  window.opener.postMessage({ type: 'dphone.auth.callback', code: params.get('code'),
    state: params.get('state'), error: null }, location.origin);
  window.close();
</script></head><body></body></html>`;

const interaction = (state: 'ASSIGNED' | 'ACTIVE' | 'WRAPUP') => ({
  id: 'interaction-embed-1',
  state,
  version: state === 'ASSIGNED' ? '1' : state === 'ACTIVE' ? '2' : '3',
  caller: '081-234-5678',
  queue: { id: 'queue-service', name: 'บริการลูกค้า' },
  offerExpiresAt: '2099-01-01T00:00:20.000Z',
  answeredAt: state === 'ASSIGNED' ? null : '2026-09-28T10:00:00.000Z',
  endedAt: state === 'WRAPUP' ? '2026-09-28T10:02:00.000Z' : null,
});

async function setup(page: Page, options: { screenPopLevel?: string; hostOrigin?: string } = {}) {
  const origin = options.hostOrigin ?? HOST;
  const server = {
    lease: undefined as string | undefined,
    leaseBodies: [] as Record<string, unknown>[],
    screenPops: [] as { headers: Record<string, string>; body: unknown }[],
    clickToCalls: [] as { headers: Record<string, string>; body: unknown }[],
    wrapups: 0,
    state: 'ASSIGNED' as 'ASSIGNED' | 'ACTIVE' | 'WRAPUP' | 'NONE',
    authorization: new Set<string>(),
  };

  await page
    .context()
    .route(`${origin}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: hostPage(origin) }),
    );
  await page
    .context()
    .route(`${DPHONE}/dphone/embed**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: shell(options.screenPopLevel ?? 'ids') }),
    );
  await page
    .context()
    .route(`${DPHONE}/dphone/auth/callback**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: callbackPage }),
    );
  await page.context().route(`${ISSUER}/protocol/openid-connect/auth**`, (route) => {
    const url = new URL(route.request().url());
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('code', 'e2e-code');
    redirect.searchParams.set('state', url.searchParams.get('state')!);
    // หน้า login จำลอง: navigate ใหม่ไปที่ callback (request ที่เกิดจาก 302 ไม่ผ่าน route ของ Playwright)
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><script>location.replace(${JSON.stringify(redirect.toString())})</script>`,
    });
  });
  await page.context().route(`${ISSUER}/protocol/openid-connect/token`, (route) =>
    route.fulfill({
      json: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 300 },
      headers: { 'access-control-allow-origin': DPHONE },
    }),
  );
  await page.context().route(`${DPHONE}/api/v1/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = request.headers();
    if (headers.authorization) server.authorization.add(headers.authorization);
    if (path === '/api/v1/me/work-session') {
      if (request.method() === 'GET') {
        return route.fulfill({ json: { enforced: true, holder: null } });
      }
      if (request.method() === 'POST') {
        server.leaseBodies.push(request.postDataJSON());
        server.lease = randomUUID();
        return route.fulfill({
          status: 201,
          json: {
            leaseId: server.lease,
            surface: 'embedded',
            hostOrigin: HOST,
            acquiredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            ttlSeconds: 60,
            heartbeatSeconds: 20,
          },
        });
      }
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/v1/workspace/agent/snapshot') {
      return route.fulfill({
        json: {
          agent: {
            id: 'agent-1000',
            displayName: 'สมชาย ใจดี',
            extension: '1000',
            state: 'RESERVED',
          },
          interaction: server.state === 'NONE' ? null : interaction(server.state),
        },
      });
    }
    if (path === '/api/v1/workspace/agent/sip-credentials') {
      return route.fulfill({
        json: {
          leaseId: 'e2e-sip',
          extension: '1000',
          authorizationUsername: '1000',
          authorizationPassword: 'e2e-only',
          sipDomain: 'e2e.invalid',
          wssUrl: 'wss://e2e.invalid',
          telephonyNodeId: 'fs-e2e',
          iceServers: [],
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      });
    }
    if (path === '/api/v1/workspace/agent/screen-pop') {
      const body = request.postDataJSON() as { requestId: string; interactionId: string };
      server.screenPops.push({ headers, body });
      return route.fulfill({
        json: {
          status: 'sent',
          hostOrigin: HOST,
          message: {
            v: 1,
            type: 'dphone.screenpop',
            requestId: body.requestId,
            level: 'ids',
            interactionId: body.interactionId,
            policyVersion: 'e1.screen-pop.disclosure/v1',
            decisionId: 'dec-pop',
            direction: 'INBOUND',
            callState: 'RINGING',
          },
        },
      });
    }
    if (path === '/api/v1/workspace/agent/click-to-call') {
      const body = request.postDataJSON() as { requestId: string };
      server.clickToCalls.push({ headers, body });
      return route.fulfill({
        json: {
          status: 'result',
          hostOrigin: HOST,
          message: {
            v: 1,
            type: 'dphone.call.result',
            requestId: body.requestId,
            status: 'blocked',
            blocked: true,
            reasonCode: 'QUIET_HOURS',
            decisionId: 'dec-call',
          },
        },
      });
    }
    if (path.endsWith('/wrapup')) {
      server.wrapups += 1;
      server.state = 'NONE';
      return route.fulfill({ status: 202, json: {} });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.routeWebSocket('**/api/v1/workspace-session', (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; leaseId?: string };
      if (message.type === 'auth:connect') {
        ws.send(
          JSON.stringify({
            type: 'workspace.session',
            session: { routingEnabled: true, availability: 'AVAILABLE' },
            leaseId: message.leaseId,
          }),
        );
      }
    });
  });
  await page.goto(`${origin}/crm`);
  const frame = page.frameLocator('#dphone');
  return { server, frame, origin };
}

const messages = (page: Page) =>
  page.evaluate(() => (window as unknown as { __messages: { type: string }[] }).__messages);
const dphoneFrame = (page: Page): Frame =>
  page.frames().find((frame) => frame.url().startsWith(`${DPHONE}/dphone/embed`))!;

async function signIn(page: Page, frame: ReturnType<Page['frameLocator']>) {
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    frame.getByRole('button', { name: 'เข้าสู่ระบบ' }).click(),
  ]);
  await expect(frame.getByRole('status').first()).toHaveText('เข้าสู่ระบบแล้ว');
  await expect.poll(() => popup.isClosed()).toBe(true);
}

test('origin ไม่อยู่ใน allowlist → dphone ไม่เริ่มทำงานและไม่ส่งข้อความหา host', async ({
  page,
}) => {
  const { frame } = await setup(page, { hostOrigin: 'https://evil.example.test' });
  await expect
    .poll(() => dphoneFrame(page)?.evaluate(() => document.documentElement.dataset.embedState))
    .toBe('blocked');
  await expect(frame.getByRole('button', { name: 'เข้าสู่ระบบ' })).toHaveCount(0);
  expect(await messages(page)).toEqual([]);
});

test('ฝังบน host: ready → popup login → lease embedded → สายเข้า screen-pop → รับสาย → wrap-up → activity + ack; token ไม่ออกนอก iframe', async ({
  page,
}) => {
  const { server, frame } = await setup(page);
  await expect
    .poll(() => messages(page))
    .toContainEqual({
      v: 1,
      type: 'dphone.ready',
      capabilities: { screenPop: true, clickToCall: true, activity: true },
      screenPopLevel: 'ids',
    });

  await signIn(page, frame);
  await expect
    .poll(() => server.leaseBodies)
    .toContainEqual({ surface: 'embedded', hostOrigin: HOST });

  // dphone ของ D1.15 ใน iframe — ตรวจอุปกรณ์เสียงแล้วสายที่ assign มาดังขึ้น
  await frame.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  const dphone = frame.getByRole('region', { name: 'dphone' });
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('มีสายเรียกเข้า');
  await expect
    .poll(async () => (await messages(page)).filter((m) => m.type === 'dphone.screenpop'))
    .toHaveLength(1);
  expect(server.screenPops[0]!.headers['x-work-session-lease-id']).toBe(server.lease);

  await dphone.getByRole('button', { name: 'รับสาย' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  const sipBefore = await dphoneFrame(page).evaluate(() => window.__dcontactDphone?.sipSessionId());

  // จบสาย → WRAPUP → บันทึก → activity ถึง host แล้ว host ack
  server.state = 'WRAPUP';
  await dphone.getByRole('button', { name: 'วางสาย' }).click();
  await frame.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' }).click();
  await frame.getByRole('button', { name: 'ส่ง disposition' }).click();
  await expect
    .poll(async () => (await messages(page)).filter((m) => m.type === 'dphone.activity'))
    .toHaveLength(1);
  const [activity] = (await messages(page)).filter((m) => m.type === 'dphone.activity');
  expect(activity).toMatchObject({
    v: 1,
    interactionId: 'interaction-embed-1',
    disposition: 'CUSTOMER_ASSISTED',
  });
  expect(sipBefore).toMatch(/[0-9a-f-]{36}/);
  // ack แล้วคิวว่าง (sessionStorage ของ iframe ไม่มีรายการค้าง)
  await expect
    .poll(() =>
      dphoneFrame(page).evaluate(() => sessionStorage.getItem('dphone.embed.activity.demo')),
    )
    .toBeNull();

  // token ไม่ปรากฏใน host: postMessage, DOM, URL และ storage ของ host
  const hostSurface = await page.evaluate(() =>
    JSON.stringify({
      messages: (window as unknown as { __messages: unknown[] }).__messages,
      html: document.documentElement.outerHTML,
      url: location.href,
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(hostSurface.includes(ACCESS_TOKEN)).toBe(false);
  expect(hostSurface.includes(REFRESH_TOKEN)).toBe(false);
  expect(server.authorization).toEqual(new Set([`Bearer ${ACCESS_TOKEN}`]));
});

test('click-to-call: host กรอกเบอร์ได้อย่างเดียว; agent กดโทร → ผลของ Governance ถึง host; ข้อความผิด origin/version ถูกจัดการ', async ({
  page,
}) => {
  const { server, frame } = await setup(page);
  await signIn(page, frame);
  await expect.poll(() => server.lease).toBeTruthy();
  await expect
    .poll(() => messages(page))
    .toContainEqual(expect.objectContaining({ type: 'dphone.screenpop' }));

  // host ขอโทรพร้อม field ที่พยายามสั่งโทรเอง → ได้แค่ prefilled ไม่มีการเรียก server
  await page.evaluate(() =>
    (window as unknown as { __send(m: unknown): void }).__send({
      v: 1,
      type: 'dphone.call',
      requestId: 'host-req-1',
      number: '081-234-5678',
      autoDial: true,
    }),
  );
  await expect
    .poll(() => messages(page))
    .toContainEqual({
      v: 1,
      type: 'dphone.call.result',
      requestId: 'host-req-1',
      status: 'prefilled',
      blocked: false,
    });
  expect(server.clickToCalls).toHaveLength(0);
  const prompt = frame.getByRole('region', { name: 'โทรออกจากระบบที่ฝัง' });
  await expect(prompt.getByText('081-234-5678')).toBeVisible();

  await prompt.getByRole('button', { name: 'โทร', exact: true }).click();
  await expect
    .poll(() => messages(page))
    .toContainEqual(
      expect.objectContaining({
        requestId: 'host-req-1',
        status: 'blocked',
        reasonCode: 'QUIET_HOURS',
      }),
    );
  expect(server.clickToCalls[0]!.headers['x-work-session-lease-id']).toBe(server.lease);
  await expect(prompt.getByText('โทรออกไม่ได้ตามกติกาการติดต่อลูกค้า')).toBeVisible();

  // v ที่ไม่รองรับ → unsupported_version
  await page.evaluate(() =>
    (window as unknown as { __send(m: unknown): void }).__send({
      v: 2,
      type: 'dphone.call',
      requestId: 'host-req-2',
      number: '0812345678',
    }),
  );
  await expect
    .poll(() => messages(page))
    .toContainEqual({
      v: 1,
      type: 'dphone.error',
      code: 'unsupported_version',
      supportedVersions: [1],
      requestId: 'host-req-2',
    });
});

test('refresh token ใช้ไม่ได้ระหว่างสาย (revoke/reuse) → ขึ้นแถบให้ login ใหม่ แต่สายและ SIP session เดิมไม่หลุด; axe ไม่มี serious/critical', async ({
  page,
}) => {
  const { frame } = await setup(page);
  await signIn(page, frame);
  await frame.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  const dphone = frame.getByRole('region', { name: 'dphone' });
  await dphone.getByRole('button', { name: 'รับสาย' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  const embed = dphoneFrame(page);
  const sipBefore = await embed.evaluate(() => window.__dcontactDphone?.sipSessionId());

  // Keycloak ปฏิเสธ refresh token (admin revoke / reuse / session cap) แล้วสั่ง refresh ทันที
  await page.context().unroute(`${ISSUER}/protocol/openid-connect/token`);
  await page.context().route(`${ISSUER}/protocol/openid-connect/token`, (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'invalid_grant' },
      headers: { 'access-control-allow-origin': DPHONE },
    }),
  );
  await embed.evaluate(() => window.__dphoneEmbed?.auth?.refresh());
  await expect(frame.getByText('การเข้าสู่ระบบหมดอายุ สายที่คุยอยู่ยังไม่หลุด')).toBeVisible();
  await expect(frame.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  expect(await embed.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(sipBefore);

  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id),
  ).toEqual([]);
});
