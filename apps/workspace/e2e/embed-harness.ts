import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from './fixtures';
import type { Frame, Page } from '@playwright/test';
import { th } from './catalog';

/**
 * E1.14/E1.15: e2e harness of the embedded dphone — a host on another origin + the `/dphone/embed` shell + simulated Keycloak/API/WS
 * E1.14 (#488): the dphone embedded in a host page on another origin (real Chromium, real iframe)
 *
 * API/Keycloak/WS are simulated with routes (the real ones are checked in API integration and the Keycloak boundary) — the evidence here is on
 * the browser side: origin lock, popup login, lease `embedded`, the D1.15 dphone component in the iframe,
 * screen-pop/activity/click-to-call through postMessage v1, and the token never leaving the iframe
 */

const releases = fileURLToPath(
  new URL('../../../packages/dphone-embed/releases/', import.meta.url),
);

/** the launcher file of `v1` (alias) or `v1.0.0` from `packages/dphone-embed/releases` */
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
<h1>CRM test</h1>
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

const shell = (screenPopLevel: string, ownerWindow = false) => `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><title>dphone</title>
<script type="application/json" id="dphone-embed-config">${JSON.stringify({
  v: 1,
  ownerWindow,
  tenant: 'demo',
  allowedHostOrigins: [HOST],
  auth: { issuer: ISSUER, clientId: 'dphone-embedded' },
  screenPopLevels: { [HOST]: screenPopLevel },
})}</script>
<script type="module" src="/src/embed/main.ts"></script>
</head><body><div id="dphone-embed-root"></div></body></html>`;

// the same callback page as the API's `/dphone/auth/callback` (sends code/state to the opener on the same origin)
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
  queue: { id: 'queue-service', name: 'Customer Service' },
  offerExpiresAt: '2099-01-01T00:00:20.000Z',
  answeredAt: state === 'ASSIGNED' ? null : '2026-09-28T10:00:00.000Z',
  endedAt: state === 'WRAPUP' ? '2026-09-28T10:02:00.000Z' : null,
});

export async function setup(
  page: Page,
  options: {
    ownerWindow?: boolean;
    screenPopLevel?: string;
    hostOrigin?: string;
    /** another host page (e.g. the E1.15 reference host) — must contain the dphone iframe */
    hostHtml?: (origin: string) => string;
    path?: string;
  } = {},
) {
  const origin = options.hostOrigin ?? HOST;
  const server = {
    ownerAllowed: true,
    ownerPolicyChecks: 0,
    lease: undefined as string | undefined,
    leaseBodies: [] as Record<string, unknown>[],
    screenPops: [] as { headers: Record<string, string>; body: unknown }[],
    clickToCalls: [] as { headers: Record<string, string>; body: unknown }[],
    wrapups: 0,
    state: 'ASSIGNED' as 'ASSIGNED' | 'ACTIVE' | 'WRAPUP' | 'NONE',
    authorization: new Set<string>(),
    sendWorkspaceEvent: undefined as ((event: unknown) => void) | undefined,
  };

  await page
    .context()
    .route(`${origin}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: (options.hostHtml ?? hostPage)(origin) }),
    );
  await page.context().route(`${DPHONE}/dphone/embed**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: shell(options.screenPopLevel ?? 'ids', options.ownerWindow),
    }),
  );
  await page.context().route(`${DPHONE}/dphone/embed/owner-policy**`, (route) => {
    server.ownerPolicyChecks += 1;
    return route.fulfill({ json: { allowed: server.ownerAllowed } });
  });
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
    // simulated login page: navigate again to the callback (a request that comes from a 302 does not go through Playwright's route)
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
    if (path === '/api/v1/workspace/agent/availability') {
      const accepted =
        headers['x-work-session-lease-id'] === server.lease &&
        request.postDataJSON()?.state === 'AVAILABLE';
      return route.fulfill({
        status: accepted ? 200 : 403,
        json: accepted ? { state: 'AVAILABLE' } : { code: 'WORK_SESSION_CHANGED' },
      });
    }
    if (path === '/api/v1/workspace/agent/snapshot') {
      return route.fulfill({
        json: {
          agent: {
            id: 'agent-1000',
            displayName: 'Somchai Jaidee',
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
  await page.context().routeWebSocket('**/api/v1/workspace-session', (ws) => {
    server.sendWorkspaceEvent = (event) => ws.send(JSON.stringify(event));
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
  // E1.15: `<dphone-launcher>` from the release in the repo through the alias, like the API's `GET /embed/v1/...`
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
    frame.getByRole('button', { name: th('dphone:embedAuth.signIn') }).click(),
  ]);
  await expect(frame.getByRole('status').first()).toHaveText(
    th('dphone:embedAuth.status.signed-in'),
  );
  await expect.poll(() => popup.isClosed()).toBe(true);
}
