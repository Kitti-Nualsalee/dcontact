import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from './fixtures';
import type { Frame, Page } from '@playwright/test';

/**
 * E1.14/E1.15: harness ของ e2e dphone ที่ถูกฝัง — host ต่าง origin + shell `/dphone/embed` + Keycloak/API/WS จำลอง
 * E1.14 (#488): dphone ที่ถูกฝังในหน้า host ต่าง origin (Chromium จริง, iframe จริง)
 *
 * API/Keycloak/WS จำลองด้วย route (ตรวจของจริงใน API integration และ Keycloak boundary) — หลักฐานที่นี่คือ
 * ฝั่ง browser: origin lock, popup login, lease `embedded`, dphone component ของ D1.15 ใน iframe,
 * screen-pop/activity/click-to-call ผ่าน postMessage v1 และ token ไม่ออกนอก iframe
 */

const releases = fileURLToPath(
  new URL('../../../packages/dphone-embed/releases/', import.meta.url),
);

/** ไฟล์ launcher ของ `v1` (alias) หรือ `v1.0.0` จาก `packages/dphone-embed/releases` */
export function launcherRelease(requested: string): string {
  const index = JSON.parse(readFileSync(`${releases}index.json`, 'utf8')) as {
    aliases: Record<string, string>;
  };
  const version = /^v\d+$/.test(requested) ? index.aliases[requested] : requested.replace(/^v/, '');
  return readFileSync(`${releases}${version}/dphone-launcher.js`, 'utf8');
}

export const HOST = 'https://crm.example.test';
export const DPHONE = 'http://127.0.0.1:4173';
export const ISSUER = 'https://id.example.test/realms/dcontact';
export const ACCESS_TOKEN = `e2e-access-${randomUUID()}`;
export const REFRESH_TOKEN = `e2e-refresh-${randomUUID()}`;

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

export async function setup(
  page: Page,
  options: {
    screenPopLevel?: string;
    hostOrigin?: string;
    /** หน้า host อื่น (เช่น host อ้างอิงของ E1.15) — ต้องมี iframe ของ dphone */
    hostHtml?: (origin: string) => string;
    path?: string;
  } = {},
) {
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
      route.fulfill({ contentType: 'text/html', body: (options.hostHtml ?? hostPage)(origin) }),
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
  // E1.15: `<dphone-launcher>` จาก release ใน repo ผ่าน alias เหมือน `GET /embed/v1/...` ของ API
  await page.context().route(`${DPHONE}/embed/*/dphone-launcher.js`, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      headers: { 'access-control-allow-origin': '*' },
      body: launcherRelease(new URL(route.request().url()).pathname.split('/')[2]!),
    }),
  );
  await page.goto(`${origin}${options.path ?? '/crm'}`);
  const frame = page.frameLocator('iframe[title="dphone"]');
  return { server, frame, origin };
}

export const messages = (page: Page) =>
  page.evaluate(() => (window as unknown as { __messages: { type: string }[] }).__messages);
export const dphoneFrame = (page: Page): Frame =>
  page.frames().find((frame) => frame.url().startsWith(`${DPHONE}/dphone/embed`))!;

export async function signIn(page: Page, frame: ReturnType<Page['frameLocator']>) {
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    frame.getByRole('button', { name: 'เข้าสู่ระบบ' }).click(),
  ]);
  await popup.waitForEvent('close');
  await expect(frame.getByRole('status').first()).toHaveText('เข้าสู่ระบบแล้ว');
}
