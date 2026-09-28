import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';

/**
 * E1.12 (#486): Workspace สองเบราว์เซอร์ (สอง context = storage/BroadcastChannel คนละชุด) กับ
 * work-session lease ของ server จำลองตัวเดียวที่ทั้งสองใช้ร่วมกัน — REST `/api/v1/me/work-session` และ
 * WS `/api/v1/workspace-session` ทำตามสัญญา E1.9 (409 HELD/BUSY/CHANGED, 4409, lease.revoked)
 *
 * หลักฐาน: รับงานได้ที่เดียว, takeover ที่ถูกปฏิเสธไม่ตัดสายและ WS ของที่เดิม, takeover สำเร็จแล้วที่เดิม
 * หยุดรับงานทันที (ถอน SIP) และ lease หลุดระหว่างมีสายไม่ตัดสาย (ADR-026 ข้อ 4)
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
  /** agent มีสาย/wrap-up ที่ server (interaction ACTIVE/WRAPUP) */
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

  /** สัญญาณไปที่ socket ที่ผูก lease นั้น (เหมือน `signalLease` ของ E1.9) */
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
          // tenant ที่บังคับ lease: ต้องแนบ lease ที่ active ไม่อย่างนั้นปิด 4409 (E1.9)
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
  agent: { id: 'agent-1000', displayName: 'สมชาย ใจดี', extension: '1000', state: 'RESERVED' },
  interaction: {
    id: 'interaction-offer-1',
    state: 'ASSIGNED',
    version: '17',
    caller: '081-234-5678',
    queue: { id: 'queue-service', name: 'บริการลูกค้า' },
    offerExpiresAt: '2026-09-28T10:00:20.000Z',
    answeredAt: null,
    endedAt: null,
  },
};

/** เบราว์เซอร์หนึ่งตัว (context ใหม่) — media stub เดียวกับ `fixtures.ts` */
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

const owner = (page: Page) => page.getByRole('status', { name: 'เจ้าของ Workspace' });
const phone = (page: Page) => page.getByRole('status', { name: 'สถานะ dphone' });
const sipSession = (page: Page) => page.evaluate(() => window.__dcontactDphone?.sipSessionId());
const heldLease = (page: Page) =>
  page.evaluate(() => window.__dcontactDphone?.workSessionLeaseId());

test('สองเบราว์เซอร์: รับงานได้ที่เดียว, takeover ที่ถูกปฏิเสธไม่ตัดสาย/WS, takeover สำเร็จแล้วที่เดิมหยุดรับงานทันที', async ({
  browser,
}) => {
  const server = new LeaseServer();

  // A: ได้ lease ก่อน → WS ต่อพร้อม leaseId → register SIP แล้วสายเข้าได้
  const a = await openAgent(browser, server, 'A');
  await expect(owner(a)).toHaveText('จุดรับงาน');
  await expect.poll(() => server.open('A').length).toBe(1);
  const leaseA = server.current!.leaseId;
  await expect
    .poll(() => server.open('A')[0]?.messages[0])
    .toMatchObject({ type: 'auth:connect', leaseId: leaseA });
  expect(await heldLease(a)).toBe(leaseA);
  await a.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  await expect(phone(a)).toHaveText('มีสายเรียกเข้า');

  // B: มีผู้ถืออยู่ → ดูได้อย่างเดียว ไม่ต่อ WS ไม่ register SIP และเห็นผู้ถือ (surface + เวลาเริ่ม)
  const b = await openAgent(browser, server, 'B');
  await expect(b.getByRole('heading', { name: 'คุณกำลังรับงานอยู่ที่อื่น' })).toBeVisible();
  const holderFacts = b.getByLabel('จุดรับงานปัจจุบัน');
  await expect(holderFacts).toContainText('Agent Workspace');
  await expect(holderFacts).toContainText(/\d{2}:\d{2}/);
  await expect(owner(b)).toHaveText('ดูอย่างเดียว');
  await expect(b.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' })).toBeDisabled();
  await expect(b.getByRole('button', { name: 'เปิดรับสาย' })).toBeDisabled();
  await expect(phone(b)).toHaveText('โทรศัพท์ยังไม่พร้อม');
  expect(server.connections.filter((c) => c.label === 'B')).toHaveLength(0);
  expect(server.current?.leaseId).toBe(leaseA);

  // A รับสาย — server เห็นว่า agent มีงาน
  await a.getByRole('button', { name: 'รับสาย', exact: true }).click();
  await expect(phone(a)).toHaveText('กำลังสนทนา');
  server.busy = true;
  const callBefore = await sipSession(a);
  expect(callBefore).toMatch(/[0-9a-f-]{36}/);

  // B ยังเห็นข้อมูลก่อนสายเริ่ม → กดย้าย, ต้องยืนยันก่อน → server ปฏิเสธ (มีงาน)
  await b.getByRole('button', { name: 'ย้ายมาที่นี่' }).click();
  const confirm = b.getByRole('alertdialog', { name: 'ย้ายงานมาที่นี่?' });
  await expect(confirm).toContainText('Agent Workspace');
  await confirm.getByRole('button', { name: 'ยืนยันย้าย' }).click();
  await expect(b.getByRole('alert').filter({ hasText: 'ย้ายไม่สำเร็จ' })).toContainText(
    'มีงานค้างที่จุดรับงานเดิม',
  );
  await expect(b.getByRole('button', { name: 'ย้ายมาที่นี่' })).toBeDisabled();
  await expect(owner(b)).toHaveText('ดูอย่างเดียว');

  // takeover ที่ถูกปฏิเสธไม่แตะที่เดิม: สายเดิม, SIP session เดิม, WS เดิมยังเปิด, lease เดิม
  await expect(phone(a)).toHaveText('กำลังสนทนา');
  await expect(owner(a)).toHaveText('จุดรับงาน');
  expect(await sipSession(a)).toBe(callBefore);
  expect(server.open('A')).toHaveLength(1);
  expect(server.connections.filter((c) => c.label === 'A')).toHaveLength(1);
  expect(server.current?.leaseId).toBe(leaseA);
  expect(await heldLease(a)).toBe(leaseA);

  // A วางสาย → ว่าง; B ตรวจใหม่แล้วย้ายได้
  await a.getByRole('button', { name: 'วางสาย' }).click();
  await expect(phone(a)).toHaveText('โทรศัพท์พร้อม');
  server.busy = false;
  await b.getByRole('button', { name: 'ตรวจอีกครั้ง' }).click();
  await expect(b.getByRole('button', { name: 'ย้ายมาที่นี่' })).toBeEnabled();
  await b.getByRole('button', { name: 'ย้ายมาที่นี่' }).click();
  await b
    .getByRole('alertdialog', { name: 'ย้ายงานมาที่นี่?' })
    .getByRole('button', { name: 'ยืนยันย้าย' })
    .click();

  // B เป็นจุดรับงาน: WS ใหม่แนบ lease ใหม่ แล้ว register SIP ได้
  await expect(owner(b)).toHaveText('จุดรับงาน');
  const leaseB = server.current!.leaseId;
  expect(leaseB).not.toBe(leaseA);
  await expect.poll(() => server.open('B').length).toBe(1);
  await expect
    .poll(() => server.open('B')[0]?.messages[0])
    .toMatchObject({ type: 'auth:connect', leaseId: leaseB });

  // A หยุดรับงานทันทีเมื่อได้ lease.revoked: ถอน SIP, ปิด WS, ปุ่มรับงานปิด และเห็นว่างานย้ายไปไหน
  await expect(owner(a)).toHaveText('ดูอย่างเดียว');
  await expect(phone(a)).toHaveText('โทรศัพท์ยังไม่พร้อม');
  await expect(a.getByText('งานถูกย้ายไปที่อื่นแล้ว ที่นี่หยุดรับงานใหม่')).toBeVisible();
  await expect(a.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' })).toBeDisabled();
  await expect(a.getByRole('button', { name: 'เปิดรับสาย' })).toBeDisabled();
  await expect.poll(() => server.open('A').length).toBe(0);
  expect(await heldLease(a)).toBeUndefined();

  await b.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  await expect(phone(b)).toHaveText('มีสายเรียกเข้า');

  await a.context().close();
  await b.context().close();
});

test('lease ถูกเพิกถอนระหว่างมีสาย: หยุดรับงานใหม่แต่สายและ WS อยู่ต่อจนวางสาย แล้วจึงถอน SIP', async ({
  browser,
}) => {
  const server = new LeaseServer();
  const a = await openAgent(browser, server, 'A');
  await expect(owner(a)).toHaveText('จุดรับงาน');
  await a.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  await a.getByRole('button', { name: 'รับสาย', exact: true }).click();
  await expect(phone(a)).toHaveText('กำลังสนทนา');
  const call = await sipSession(a);
  await expect.poll(() => server.open('A').length).toBe(1);

  // token ถูกเพิกถอน (E1.9 ส่ง lease.revoked แม้มีงาน แต่คง lease ไว้จนงานจบ)
  server.busy = true;
  server.authRevoked = true;
  server.signal(server.current!.leaseId, {
    type: 'lease.revoked',
    leaseId: server.current!.leaseId,
    reason: 'auth_revoked',
  });

  await expect(owner(a)).toHaveText('ดูอย่างเดียว');
  await expect(a.getByText('ที่นี่หยุดรับงานใหม่แล้ว')).toBeVisible();
  await expect(phone(a)).toHaveText('กำลังสนทนา');
  expect(await sipSession(a)).toBe(call);
  expect(server.open('A')).toHaveLength(1);
  await expect(a.getByRole('button', { name: 'วางสาย' })).toBeEnabled();

  await a.getByRole('button', { name: 'วางสาย' }).click();
  server.busy = false;
  // งานจบ → ถอน SIP และปิด WS; ไม่มี lease ให้ขอใหม่ด้วย token เดิม
  await expect(phone(a)).toHaveText('โทรศัพท์ยังไม่พร้อม');
  await expect.poll(() => server.open('A').length).toBe(0);
  await expect(a.getByRole('heading', { name: 'ตรวจจุดรับงานไม่สำเร็จ' })).toBeVisible();

  await a.context().close();
});
