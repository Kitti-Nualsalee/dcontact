import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import { th } from './catalog';

/**
 * E1.12 (#486): two Workspace browsers (two contexts = separate storage/BroadcastChannel) with
 * a single simulated server work-session lease that both share — REST `/api/v1/me/work-session` and
 * WS `/api/v1/workspace-session` follow the E1.9 contract (409 HELD/BUSY/CHANGED, 4409, lease.revoked)
 *
 * evidence: work can be taken in only one place, a rejected takeover does not cut the old place's call and WS, after a successful takeover the old place
 * stops taking work immediately (SIP withdrawn), and a lease lost during a call does not cut the call (ADR-026 item 4)
 */

interface Lease {
  leaseId: string;
  surface: 'workspace' | 'dphone';
  acquiredAt: string;
}

interface Connection {
  label: string;
  leaseId?: string;
  ws: WebSocketRoute;
  closedBy?: 'client' | 'server';
  messages: Record<string, unknown>[];
}

class LeaseServer {
  current?: Lease;
  /** the agent has a call/wrap-up on the server (interaction ACTIVE/WRAPUP) */
  busy = false;
  authRevoked = false;
  readonly connections: Connection[] = [];

  holder() {
    return this.current ? { ...this.current, hostOrigin: null, busy: this.busy } : null;
  }

  open(label: string) {
    return this.connections.filter((c) => c.label === label && !c.closedBy);
  }

  private issue(surface: Lease['surface']) {
    this.current = { leaseId: randomUUID(), surface, acquiredAt: new Date().toISOString() };
    return {
      ...this.current,
      hostOrigin: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlSeconds: 60,
      heartbeatSeconds: 20,
    };
  }

  /** signal to the socket bound to that lease (like E1.9's `signalLease`) */
  signal(leaseId: string, message: Record<string, unknown>) {
    for (const connection of this.connections) {
      if (connection.leaseId !== leaseId || connection.closedBy) continue;
      connection.leaseId = undefined;
      connection.ws.send(JSON.stringify(message));
    }
  }

  async attach(page: Page, label: string) {
    await page.route('**/api/v1/me/work-session**', async (route) => {
      const request = route.request();
      if (this.authRevoked) return route.fulfill({ status: 401, json: { code: 'UNAUTHORIZED' } });
      const takeover = request.url().endsWith('/takeover');
      const body = (request.postDataJSON() ?? {}) as {
        surface?: Lease['surface'];
        expectedLeaseId?: string;
      };
      if (request.method() === 'GET') {
        return route.fulfill({ json: { enforced: true, holder: this.holder() } });
      }
      if (request.method() === 'DELETE') {
        if (this.busy) return route.fulfill({ status: 409, json: { code: 'WORK_SESSION_BUSY' } });
        if (this.current?.leaseId === request.headers()['x-work-session-lease-id']) {
          this.current = undefined;
        }
        return route.fulfill({ status: 204 });
      }
      if (!takeover) {
        if (this.current) {
          return route.fulfill({
            status: 409,
            json: { code: 'WORK_SESSION_HELD', holder: this.holder() },
          });
        }
        return route.fulfill({ status: 201, json: this.issue(body.surface ?? 'workspace') });
      }
      if (!this.current || this.current.leaseId !== body.expectedLeaseId) {
        return route.fulfill({ status: 409, json: { code: 'WORK_SESSION_CHANGED' } });
      }
      if (this.busy) {
        return route.fulfill({
          status: 409,
          json: { code: 'WORK_SESSION_BUSY', holder: this.holder() },
        });
      }
      const previous = this.current.leaseId;
      const lease = this.issue(body.surface ?? 'workspace');
      this.signal(previous, { type: 'lease.revoked', leaseId: previous, reason: 'takeover' });
      return route.fulfill({ status: 201, json: lease });
    });

    await page.routeWebSocket('**/api/v1/workspace-session', (ws) => {
      const connection: Connection = { label, ws, messages: [] };
      this.connections.push(connection);
      ws.onClose(() => {
        connection.closedBy ??= 'client';
      });
      ws.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as { type: string; leaseId?: string };
        connection.messages.push(message);
        if (message.type === 'auth:connect') {
          // a tenant that enforces the lease: must attach an active lease, otherwise close 4409 (E1.9)
          if (!message.leaseId || message.leaseId !== this.current?.leaseId) {
            connection.closedBy = 'server';
            void ws.close({ code: 4409, reason: 'work session lease required' });
            return;
          }
          connection.leaseId = message.leaseId;
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
  }
}

const snapshot = {
  agent: { id: 'agent-1000', displayName: 'Somchai Jaidee', extension: '1000', state: 'RESERVED' },
  interaction: {
    id: 'interaction-offer-1',
    state: 'ASSIGNED',
    version: '17',
    caller: '081-234-5678',
    queue: { id: 'queue-service', name: 'Customer Service' },
    offerExpiresAt: '2026-09-28T10:00:20.000Z',
    answeredAt: null,
    endedAt: null,
  },
};

/** one browser (a new context) — the same media stub as `fixtures.ts` */
async function openAgent(browser: Browser, server: LeaseServer, label: string) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    class TestMediaTrack extends EventTarget {
      stop() {}
    }
    const track = new TestMediaTrack();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => ({ getTracks: () => [track] }),
    });
  });
  const page = await context.newPage();
  await server.attach(page, label);
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.goto('/?tenant=demo&live=1');
  return page;
}

const owner = (page: Page) => page.getByRole('status', { name: th('workspace:status.owner') });
const phone = (page: Page) => page.getByRole('status', { name: th('workspace:status.dphone') });
const sipSession = (page: Page) => page.evaluate(() => window.__dcontactDphone?.sipSessionId());
const heldLease = (page: Page) =>
  page.evaluate(() => window.__dcontactDphone?.workSessionLeaseId());

test('two browsers: work can be taken in only one place, a rejected takeover does not cut call/WS, and after a successful takeover the old place stops taking work immediately', async ({
  browser,
}) => {
  const server = new LeaseServer();

  // A: gets the lease first → WS connects with leaseId → registers SIP, then calls can arrive
  const a = await openAgent(browser, server, 'A');
  await expect(owner(a)).toHaveText(th('workspace:lease.chip.held'));
  await expect.poll(() => server.open('A').length).toBe(1);
  const leaseA = server.current!.leaseId;
  await expect
    .poll(() => server.open('A')[0]?.messages[0])
    .toMatchObject({ type: 'auth:connect', leaseId: leaseA });
  expect(await heldLease(a)).toBe(leaseA);
  await a.getByRole('button', { name: th('workspace:media.check') }).click();
  await expect(phone(a)).toHaveText(th('dphone:phase.RINGING'));

  // B: a holder exists → view only, no WS and no SIP register, and sees the holder (surface + start time)
  const b = await openAgent(browser, server, 'B');
  await expect(b.getByRole('heading', { name: th('workspace:lease.heldTitle') })).toBeVisible();
  const holderFacts = b.getByLabel(th('workspace:lease.holderLabel'));
  await expect(holderFacts).toContainText('Agent Workspace');
  await expect(holderFacts).toContainText(/\d{2}:\d{2}/);
  await expect(owner(b)).toHaveText(th('workspace:lease.chip.standby'));
  await expect(b.getByRole('button', { name: th('workspace:media.check') })).toBeDisabled();
  await expect(b.getByRole('button', { name: th('workspace:availability.open') })).toBeDisabled();
  await expect(phone(b)).toHaveText(th('dphone:phase.OFFLINE'));
  expect(server.connections.filter((c) => c.label === 'B')).toHaveLength(0);
  expect(server.current?.leaseId).toBe(leaseA);

  // A answers — the server sees the agent has work
  await a.getByRole('button', { name: th('dphone:accept'), exact: true }).click();
  await expect(phone(a)).toHaveText(th('dphone:phase.ACTIVE'));
  server.busy = true;
  const callBefore = await sipSession(a);
  expect(callBefore).toMatch(/[0-9a-f-]{36}/);

  // B still sees the data before the call starts → press move, must confirm first → server rejects (has work)
  await b.getByRole('button', { name: th('workspace:lease.move') }).click();
  const confirm = b.getByRole('alertdialog', { name: th('workspace:lease.confirmTitle') });
  await expect(confirm).toContainText('Agent Workspace');
  await confirm.getByRole('button', { name: th('workspace:lease.confirm') }).click();
  await expect(
    b.getByRole('alert').filter({ hasText: th('workspace:lease.rejected.busy') }),
  ).toBeVisible();
  await expect(b.getByRole('button', { name: th('workspace:lease.move') })).toBeDisabled();
  await expect(owner(b)).toHaveText(th('workspace:lease.chip.standby'));

  // a rejected takeover does not touch the old place: the original call, SIP session, WS still open, lease
  await expect(phone(a)).toHaveText(th('dphone:phase.ACTIVE'));
  await expect(owner(a)).toHaveText(th('workspace:lease.chip.held'));
  expect(await sipSession(a)).toBe(callBefore);
  expect(server.open('A')).toHaveLength(1);
  expect(server.connections.filter((c) => c.label === 'A')).toHaveLength(1);
  expect(server.current?.leaseId).toBe(leaseA);
  expect(await heldLease(a)).toBe(leaseA);

  // A hangs up → idle; B re-checks and can move
  await a.getByRole('button', { name: th('dphone:hangup') }).click();
  await expect(phone(a)).toHaveText(th('dphone:phase.READY'));
  server.busy = false;
  await b.getByRole('button', { name: th('workspace:lease.refresh') }).click();
  await expect(b.getByRole('button', { name: th('workspace:lease.move') })).toBeEnabled();
  await b.getByRole('button', { name: th('workspace:lease.move') }).click();
  await b
    .getByRole('alertdialog', { name: th('workspace:lease.confirmTitle') })
    .getByRole('button', { name: th('workspace:lease.confirm') })
    .click();

  // B becomes the work point: a new WS attaches the new lease, then SIP can register
  await expect(owner(b)).toHaveText(th('workspace:lease.chip.held'));
  const leaseB = server.current!.leaseId;
  expect(leaseB).not.toBe(leaseA);
  await expect.poll(() => server.open('B').length).toBe(1);
  await expect
    .poll(() => server.open('B')[0]?.messages[0])
    .toMatchObject({ type: 'auth:connect', leaseId: leaseB });

  // A stops taking work immediately on receiving lease.revoked: SIP withdrawn, WS closed, take-work button disabled, and sees where the work moved
  await expect(owner(a)).toHaveText(th('workspace:lease.chip.standby'));
  await expect(phone(a)).toHaveText(th('dphone:phase.OFFLINE'));
  await expect(a.getByText(th('workspace:lease.loss.takeover'))).toBeVisible();
  await expect(a.getByRole('button', { name: th('workspace:media.check') })).toBeDisabled();
  await expect(a.getByRole('button', { name: th('workspace:availability.open') })).toBeDisabled();
  await expect.poll(() => server.open('A').length).toBe(0);
  expect(await heldLease(a)).toBeUndefined();

  await b.getByRole('button', { name: th('workspace:media.check') }).click();
  await expect(phone(b)).toHaveText(th('dphone:phase.RINGING'));

  await a.context().close();
  await b.context().close();
});

test('lease revoked during a call: stops taking new work but the call and WS stay until hang up, then SIP is withdrawn', async ({
  browser,
}) => {
  const server = new LeaseServer();
  const a = await openAgent(browser, server, 'A');
  await expect(owner(a)).toHaveText(th('workspace:lease.chip.held'));
  await a.getByRole('button', { name: th('workspace:media.check') }).click();
  await a.getByRole('button', { name: th('dphone:accept'), exact: true }).click();
  await expect(phone(a)).toHaveText(th('dphone:phase.ACTIVE'));
  const call = await sipSession(a);
  await expect.poll(() => server.open('A').length).toBe(1);

  // the token is revoked (E1.9 sends lease.revoked even with work, but keeps the lease until the work ends)
  server.busy = true;
  server.authRevoked = true;
  server.signal(server.current!.leaseId, {
    type: 'lease.revoked',
    leaseId: server.current!.leaseId,
    reason: 'auth_revoked',
  });

  await expect(owner(a)).toHaveText(th('workspace:lease.chip.standby'));
  await expect(a.getByText(th('workspace:lease.inHand'))).toBeVisible();
  await expect(phone(a)).toHaveText(th('dphone:phase.ACTIVE'));
  expect(await sipSession(a)).toBe(call);
  expect(server.open('A')).toHaveLength(1);
  await expect(a.getByRole('button', { name: th('dphone:hangup') })).toBeEnabled();

  await a.getByRole('button', { name: th('dphone:hangup') }).click();
  server.busy = false;
  // work ends → SIP withdrawn and WS closed; no lease to request again with the same token
  await expect(phone(a)).toHaveText(th('dphone:phase.OFFLINE'));
  await expect.poll(() => server.open('A').length).toBe(0);
  await expect(a.getByRole('heading', { name: th('workspace:lease.errorTitle') })).toBeVisible();

  await a.context().close();
});
