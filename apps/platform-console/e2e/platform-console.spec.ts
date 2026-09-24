import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * A1.7 (#412): Platform Console end-to-end กับ Platform API ที่ mock บน origin เดียวกัน
 *
 * mock ทำตาม contract ของ #388/#411 (202 + Idempotency-Key, expectedRevision, preview แบบ async,
 * error envelope) และเป็น authority ของสถานะ/plan — ข้อมูลทั้งหมดเป็นค่าสังเคราะห์
 */

const DIGEST = 'a'.repeat(64);
const PREVIEW_DIGEST = 'b'.repeat(64);
const EMAIL = 'owner@nova.example.test';

type Status = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'ACTION_REQUIRED';

interface MockRequest {
  requestId: string;
  tenantId: string;
  status: Status;
  revision: number;
  displayName: string;
  slug: string;
  primaryDomain: string;
  plan: { code: string; version: number };
  failing: boolean;
  polls: number;
  email: string;
}

class MockPlatformApi {
  requests = new Map<string, MockRequest>();
  keys = new Map<string, string>();
  commands = new Map<
    string,
    {
      requestId: string;
      kind: string;
      polls: number;
      state: string;
      result: Record<string, unknown> | null;
      errorCode: string | null;
    }
  >();
  history: Record<string, unknown>[] = [];
  posts: { path: string; key: string | null; body: unknown }[] = [];
  bumpRevisionBeforeExecute = false;
  /** worker ของ mock เดินต่อเมื่อเทสต์ปล่อย — ไม่ผูกกับจำนวนครั้งที่ UI poll */
  hold = false;
  sequence = 0;

  constructor(readonly role: 'platform_operator' | 'platform_auditor' = 'platform_operator') {}

  id(prefix: number) {
    this.sequence += 1;
    return `${prefix.toString(16).padStart(8, '0')}-0000-4000-8000-${this.sequence.toString(16).padStart(12, '0')}`;
  }

  view(request: MockRequest) {
    const order = [
      'TENANT_RECORD',
      'KEYCLOAK_ORGANIZATION',
      'PLAN_BOOTSTRAP',
      'FIRST_ADMIN',
      'INVITATION',
      'READINESS',
    ];
    const done =
      request.status === 'SUCCEEDED'
        ? 6
        : request.status === 'RUNNING'
          ? 3
          : request.status === 'ACTION_REQUIRED'
            ? 1
            : 1;
    return {
      requestId: request.requestId,
      tenantId: request.tenantId,
      status: request.status,
      revision: request.revision,
      failureCode: request.status === 'ACTION_REQUIRED' ? 'KEYCLOAK_ORGANIZATION_CONFLICT' : null,
      displayName: request.displayName,
      slug: request.slug,
      primaryDomain: request.primaryDomain,
      locale: 'th-TH',
      timezone: 'Asia/Bangkok',
      plan: request.plan,
      bootstrapTemplateVersion: 'baseline-v1',
      firstAdmin: { emailMasked: 'o***@nova.example.test', displayName: 'Narin' },
      acceptedAt: '2026-09-24T03:00:00.000Z',
      deadlineAt: '2026-09-24T03:30:00.000Z',
      terminalAt: null,
      steps: order.map((stepKey, index) => ({
        stepKey,
        state:
          index < done
            ? 'SUCCEEDED'
            : request.status === 'ACTION_REQUIRED' && index === done
              ? 'ACTION_REQUIRED'
              : request.status === 'RUNNING' && index === done
                ? 'RUNNING'
                : 'PENDING',
        attempt: index <= done ? 1 : 0,
        errorCode:
          request.status === 'ACTION_REQUIRED' && index === done
            ? 'KEYCLOAK_ORGANIZATION_CONFLICT'
            : null,
        nextAttemptAt: null,
        finishedAt: index < done ? '2026-09-24T03:01:00.000Z' : null,
      })),
      invitation:
        request.status === 'SUCCEEDED'
          ? {
              generation: 1,
              delivery: 'SENT',
              sentAt: '2026-09-24T03:02:00.000Z',
              expiresAt: '2026-09-27T03:02:00.000Z',
              expired: false,
              resendsInLastHour: 3,
            }
          : null,
      commands: [],
    };
  }

  envelope(status: number, code: string, extra: Record<string, unknown> = {}) {
    return {
      status,
      code,
      title: code,
      correlationId: 'corr-mock',
      retryable: status >= 500 || status === 429,
      ...extra,
    };
  }

  async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers,
        body: JSON.stringify(body),
      });
    if (request.headers().authorization !== 'Bearer e2e-access-token')
      return json(401, this.envelope(401, 'UNAUTHENTICATED'));
    const mutate = this.role === 'platform_operator';

    if (path === '/api/v1/session') {
      return json(200, {
        subject: 'sub-e2e',
        roles: [this.role],
        capabilities: mutate
          ? ['CONTROL_PLANE_READ', 'PROVISIONING_MUTATE']
          : ['CONTROL_PLANE_READ'],
        expiresAt: '2026-09-24T04:00:00.000Z',
      });
    }
    if (path === '/api/v1/catalog') {
      return json(200, {
        plans: [
          { code: 'growth', version: 3, entitlements: { agent_seats: 25 } },
          { code: 'starter', version: 1, entitlements: { agent_seats: 5 } },
        ],
        templates: [
          {
            version: 'baseline-v1',
            contentDigest: DIGEST,
            publishedAt: '2026-09-20T00:00:00.000Z',
          },
        ],
      });
    }
    if (method !== 'GET' && !mutate) return json(403, this.envelope(403, 'FORBIDDEN'));

    if (path === '/api/v1/tenants') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const items = [...this.requests.values()]
        .filter(
          (entry) =>
            !query ||
            entry.displayName.toLowerCase().includes(query) ||
            entry.slug.includes(query) ||
            entry.requestId === query ||
            entry.email === query,
        )
        .map((entry) => ({
          tenantId: entry.tenantId,
          name: entry.displayName,
          slug: entry.slug,
          primaryDomain: entry.primaryDomain,
          lifecycleStatus: entry.status === 'SUCCEEDED' ? 'ACTIVE' : 'PROVISIONING',
          legacy: false,
          request: {
            requestId: entry.requestId,
            status: entry.status,
            revision: entry.revision,
            updatedAt: '2026-09-24T03:05:00.000Z',
          },
          createdAt: '2026-09-24T03:00:00.000Z',
        }));
      return json(200, { items, nextCursor: null });
    }
    if (path === '/api/v1/provisioning-requests' && method === 'POST') {
      const key = request.headers()['idempotency-key'] ?? null;
      const body = request.postDataJSON() as Record<string, any>;
      this.posts.push({ path, key, body });
      if (!key)
        return json(
          400,
          this.envelope(400, 'VALIDATION_FAILED', { fieldErrors: { idempotencyKey: 'REQUIRED' } }),
        );
      if (body.slug === 'taken') return json(409, this.envelope(409, 'TENANT_SLUG_CONFLICT'));
      const existing = this.keys.get(key);
      if (existing)
        return json(202, { replayed: true, request: this.view(this.requests.get(existing)!) });
      const entry: MockRequest = {
        requestId: this.id(1),
        tenantId: this.id(2),
        status: 'PENDING',
        revision: 1,
        displayName: body.displayName,
        slug: body.slug,
        primaryDomain: body.primaryDomain,
        // plan version มาจาก catalog ฝั่ง server ตอนรับคำขอ — ไม่ใช่ค่าที่ browser เห็นก่อนหน้า
        plan: { code: body.planCode, version: 7 },
        failing: body.slug === 'failing',
        polls: 0,
        email: body.firstAdmin.email,
      };
      this.requests.set(entry.requestId, entry);
      this.keys.set(key, entry.requestId);
      this.history.push(this.event(entry, 'REQUEST_ACCEPTED', 'PLATFORM_OPERATOR'));
      return json(
        202,
        { replayed: false, request: this.view(entry) },
        { location: `/api/v1/provisioning-requests/${entry.requestId}` },
      );
    }
    const requestMatch = /^\/api\/v1\/provisioning-requests\/([^/]+)(\/.*)?$/.exec(path);
    if (requestMatch) {
      const entry = this.requests.get(requestMatch[1]!);
      if (!entry) return json(404, this.envelope(404, 'NOT_FOUND'));
      const rest = requestMatch[2] ?? '';
      if (!rest && method === 'GET') {
        // สถานะเดินเองตาม worker: PENDING → RUNNING → SUCCEEDED (หรือหยุดที่ ACTION_REQUIRED)
        entry.polls += 1;
        if (this.hold) return json(200, this.view(entry));
        if (entry.status === 'PENDING' && entry.polls >= 2) {
          entry.status = entry.failing ? 'ACTION_REQUIRED' : 'RUNNING';
          entry.revision += 1;
          this.history.push(this.event(entry, 'STATE_CHANGED', 'SYSTEM'));
        } else if (entry.status === 'RUNNING' && entry.polls >= 4) {
          entry.status = 'SUCCEEDED';
          entry.revision += 1;
          this.history.push(this.event(entry, 'STEP_SUCCEEDED', 'SYSTEM'));
        }
        return json(200, this.view(entry));
      }
      const preview = /^\/actions\/([a-z-]+)\/previews$/.exec(rest);
      if (preview && method === 'POST') {
        const commandId = this.id(3);
        this.commands.set(commandId, {
          requestId: entry.requestId,
          kind: 'PREVIEW',
          polls: 0,
          state: 'QUEUED',
          result: null,
          errorCode: null,
        });
        return json(202, this.command(commandId));
      }
      const previewResult = /^\/actions\/previews\/([^/]+)$/.exec(rest);
      const commandResult = /^\/commands\/([^/]+)$/.exec(rest);
      const commandId = previewResult?.[1] ?? commandResult?.[1];
      if (commandId && method === 'GET') {
        const command = this.commands.get(commandId);
        if (!command || command.requestId !== entry.requestId)
          return json(404, this.envelope(404, 'NOT_FOUND'));
        command.polls += 1;
        if (command.polls >= 1 && command.state === 'QUEUED') {
          command.state = 'SUCCEEDED';
          if (command.kind === 'PREVIEW') {
            command.result = {
              previewDigest: PREVIEW_DIGEST,
              allowed: true,
              blockedBy: null,
              finding: 'FOUND',
              revision: entry.revision,
            };
          } else {
            entry.status = 'RUNNING';
            entry.polls = 2;
            entry.revision += 1;
            command.result = { status: 'RUNNING', revision: entry.revision };
            this.history.push(
              this.event(entry, 'RECONCILE', 'PLATFORM_OPERATOR', {
                reasonCode: 'OPERATOR_VERIFIED',
                comment: 'ตรวจแล้ว',
              }),
            );
          }
        }
        return json(200, this.command(commandId));
      }
      const action = /^\/actions\/([a-z-]+)$/.exec(rest);
      if (action && method === 'POST') {
        const key = request.headers()['idempotency-key'] ?? null;
        const body = request.postDataJSON() as Record<string, any>;
        this.posts.push({ path, key, body });
        if (!key) return json(400, this.envelope(400, 'VALIDATION_FAILED'));
        if (action[1] === 'resend-invitation') {
          return json(
            429,
            this.envelope(429, 'INVITATION_RESEND_LIMITED', { requestId: entry.requestId }),
            { 'retry-after': '1800' },
          );
        }
        if (this.bumpRevisionBeforeExecute) {
          this.bumpRevisionBeforeExecute = false;
          entry.revision += 1;
        }
        if (body.expectedRevision !== entry.revision) {
          return json(409, this.envelope(409, 'REVISION_CONFLICT', { requestId: entry.requestId }));
        }
        if (body.previewDigest !== PREVIEW_DIGEST)
          return json(409, this.envelope(409, 'PREVIEW_STALE'));
        const id = this.id(4);
        this.commands.set(id, {
          requestId: entry.requestId,
          kind: 'EXECUTE',
          polls: 0,
          state: 'QUEUED',
          result: null,
          errorCode: null,
        });
        return json(202, { command: this.command(id), request: this.view(entry) });
      }
    }
    const historyMatch = /^\/api\/v1\/tenants\/([^/]+)\/action-history$/.exec(path);
    if (historyMatch) {
      return json(200, {
        items: this.history
          .filter((item) => item.tenantId === historyMatch[1])
          .map(({ tenantId: _t, ...rest }) => rest),
        nextCursor: null,
      });
    }
    return json(404, this.envelope(404, 'NOT_FOUND'));
  }

  command(id: string) {
    const command = this.commands.get(id)!;
    return {
      commandId: id,
      requestId: command.requestId,
      kind: command.kind,
      action: 'RECONCILE',
      state: command.state,
      errorCode: command.errorCode,
      result: command.result,
      createdAt: '2026-09-24T03:10:00.000Z',
      finishedAt: command.state === 'SUCCEEDED' ? '2026-09-24T03:10:01.000Z' : null,
    };
  }

  event(
    entry: MockRequest,
    action: string,
    kind: 'SYSTEM' | 'PLATFORM_OPERATOR',
    extra: Record<string, unknown> = {},
  ) {
    return {
      id: this.id(5),
      tenantId: entry.tenantId,
      requestId: entry.requestId,
      action,
      outcome: 'SUCCEEDED',
      actor: {
        kind,
        subject: kind === 'SYSTEM' ? 'provisioning-worker:e2e' : 'sub-e2e',
        role: kind === 'SYSTEM' ? null : 'platform_operator',
      },
      stepKey: null,
      attempt: null,
      beforeState: null,
      afterState: entry.status,
      reasonCode: null,
      comment: null,
      errorCode: null,
      correlationId: 'corr-e2e',
      occurredAt: `2026-09-24T03:0${this.history.length % 10}:00.000Z`,
      ...extra,
    };
  }
}

async function open(page: Page, api: MockPlatformApi, path = '/') {
  await page.route('**/api/v1/**', (route) => api.handle(route));
  // request ออกนอก origin = ห้าม (ไม่มี telemetry/third party)
  const outside: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:5181' && !url.protocol.startsWith('data'))
      outside.push(url.origin);
  });
  await page.goto(path);
  return outside;
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`),
  ).toEqual([]);
}

async function fillValidForm(page: Page, slug = 'nova-care') {
  await page.getByLabel('ชื่อลูกค้า / องค์กร').fill('Nova Care Thailand');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Primary domain').fill('nova.example.test');
  await page.getByLabel('Plan').selectOption('growth');
  await page.getByLabel('ชื่อ First admin').fill('Narin');
  await page.getByLabel('อีเมล First admin').fill(EMAIL);
}

test('happy path: create → review → track จน ACTIVE → search → timeline (a11y ผ่านทุกหน้า)', async ({
  page,
}) => {
  const api = new MockPlatformApi();
  api.hold = true;
  const outside = await open(page, api);
  await expect(page.getByRole('heading', { name: 'Tenants', level: 1 })).toBeVisible();
  await expect(page.getByText('ไม่พบ tenant')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'สร้าง tenant' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  // เปลี่ยนหน้าแล้วโฟกัสย้ายไปหัวข้อ
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  // validation: error summary ได้โฟกัสและลิงก์ไปช่องที่ผิด
  await page.getByRole('button', { name: 'ตรวจสอบข้อมูล →' }).click();
  const summary = page.getByRole('alert').filter({ hasText: 'ข้อมูลบางช่องต้องแก้ไข' });
  await expect(summary).toBeFocused();
  await expectAccessible(page);
  await summary.getByRole('link', { name: /Slug/ }).click();
  await expect(page.getByLabel('Slug')).toBeFocused();
  await expect(page.getByLabel('Slug')).toHaveAttribute('aria-invalid', 'true');

  await fillValidForm(page);
  await page.getByRole('button', { name: 'ตรวจสอบข้อมูล →' }).click();
  await expect(page.getByRole('heading', { name: /ตรวจสอบก่อน provision/ })).toBeFocused();
  const confirm = page.getByRole('button', { name: 'ยืนยันและเริ่ม provision' });
  await expect(confirm).toBeDisabled();
  await expectAccessible(page);
  await page.getByLabel(/ฉันตรวจสอบ identity/).check();
  await confirm.click();

  // สถานะมาจาก API: PENDING → RUNNING → SUCCEEDED; ไม่บอกว่าสำเร็จก่อนเวลา
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByText('รับคำขอแล้ว — worker จะเริ่มอัตโนมัติ')).toBeVisible();
  await expect(page.getByText('พร้อมส่งมอบให้ลูกค้า')).toHaveCount(0);
  api.hold = false;
  await expect(page.getByRole('heading', { name: 'พร้อมส่งมอบให้ลูกค้า' })).toBeVisible({
    timeout: 10_000,
  });
  // plan ที่แสดงคือค่าที่ server pin (v7) ไม่ใช่ตัวเลือกใน catalog (v3)
  await expect(page.getByText('growth v7')).toBeVisible();
  await expect(page.getByText('o***@nova.example.test')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'เหตุการณ์ล่าสุดก่อน' }).getByText('Platform Operator'),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'เหตุการณ์ล่าสุดก่อน' }).getByText('System').first(),
  ).toBeVisible();
  await expectAccessible(page);

  // idempotency: ส่งครั้งเดียวด้วย key และไม่มี tenant/status จาก browser
  const created = api.posts.filter((post) => post.path === '/api/v1/provisioning-requests');
  expect(created).toHaveLength(1);
  expect(created[0]!.key).toMatch(/^create-/);
  expect(Object.keys(created[0]!.body as object)).not.toContain('tenantId');

  // search ด้วยอีเมล: คำค้นไม่ลง URL
  await page.getByRole('button', { name: 'Tenants' }).click();
  await page.getByLabel('ค้นหา tenant').fill(EMAIL);
  await page.getByLabel('ค้นหา tenant').press('Enter');
  await expect(page.getByRole('row', { name: /Nova Care Thailand/ })).toBeVisible();
  expect(page.url()).not.toContain('owner');
  await page.getByRole('button', { name: 'เปิดรายละเอียด Nova Care Thailand' }).click();
  await expect(page.getByRole('heading', { name: 'Action history' })).toBeVisible();

  // ไม่มี token/อีเมลใน storage และไม่มี request ออกนอก origin
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain('e2e-access-token');
  expect(storage).not.toContain(EMAIL);
  expect(outside).toEqual([]);
});

test('conflict: slug ที่ถูกจองแล้วพากลับฟอร์มพร้อม error ที่ช่อง slug', async ({ page }) => {
  const api = new MockPlatformApi();
  await open(page, api, '/new');
  await fillValidForm(page, 'taken');
  await page.getByRole('button', { name: 'ตรวจสอบข้อมูล →' }).click();
  await page.getByLabel(/ฉันตรวจสอบ identity/).check();
  await page.getByRole('button', { name: 'ยืนยันและเริ่ม provision' }).click();
  const summary = page.getByRole('alert').filter({ hasText: 'ข้อมูลบางช่องต้องแก้ไข' });
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('slug นี้ถูกใช้หรือถูกจองแล้ว');
  await expect(page.getByLabel('Slug')).toHaveAttribute('aria-invalid', 'true');
});

test('ACTION_REQUIRED: Reconcile แนะนำก่อน, preview async, stale revision → preview ใหม่ แล้วสำเร็จ', async ({
  page,
}) => {
  const api = new MockPlatformApi();
  await open(page, api, '/new');
  await fillValidForm(page, 'failing');
  await page.getByRole('button', { name: 'ตรวจสอบข้อมูล →' }).click();
  await page.getByLabel(/ฉันตรวจสอบ identity/).check();
  await page.getByRole('button', { name: 'ยืนยันและเริ่ม provision' }).click();
  await expect(page.getByRole('heading', { name: 'ต้องการการตัดสินใจ' })).toBeVisible({
    timeout: 10_000,
  });
  const options = page.getByRole('region', { name: 'Recovery' }).getByRole('button');
  await expect(options.first()).toHaveText('Reconcile & resume (แนะนำ)');
  await expect(options.nth(3)).toHaveText('Mark FAILED_FINAL');
  await expectAccessible(page);

  await options.first().click();
  const panel = page.getByRole('region', { name: /Reconcile & resume/ });
  await expect(panel.getByRole('heading', { name: /ยืนยัน/ })).toBeFocused();
  // ต้องมีเหตุผล: ช่องว่าง = error ที่ช่อง comment
  await panel.getByRole('button', { name: 'ยืนยัน Reconcile & resume' }).click();
  await expect(panel.getByText('ต้องระบุเหตุผลเพิ่มเติม')).toBeVisible();
  await panel.getByLabel(/รายละเอียด/).fill('ตรวจแล้วว่า Organization เป็นของเรา');

  // คนอื่นขยับ revision ก่อน → 409 แล้ว preview ใหม่ได้
  api.bumpRevisionBeforeExecute = true;
  await panel.getByRole('button', { name: 'ยืนยัน Reconcile & resume' }).click();
  await expect(panel.getByRole('alert')).toContainText('ข้อมูลถูกเปลี่ยนโดยคนอื่นหรือระบบ');
  await panel.getByRole('button', { name: 'โหลดสถานะล่าสุดแล้ว preview ใหม่' }).click();
  await panel.getByLabel(/รายละเอียด/).fill('ตรวจอีกครั้งหลังโหลดใหม่');
  await panel.getByRole('button', { name: 'ยืนยัน Reconcile & resume' }).click();
  await expect(panel.getByText('Reconcile & resume สำเร็จ')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'พร้อมส่งมอบให้ลูกค้า' })).toBeVisible({
    timeout: 10_000,
  });

  const actions = api.posts.filter((post) => post.path.endsWith('/actions/reconcile'));
  expect(actions).toHaveLength(2);
  // ลองใหม่หลัง preview ใหม่ = key ใหม่ พร้อม revision ล่าสุด
  expect(actions[0]!.key).not.toBe(actions[1]!.key);
  expect((actions[1]!.body as { previewDigest: string }).previewDigest).toBe(PREVIEW_DIGEST);
});

test('resend เกิน cap: แสดงเวลาที่ลองใหม่ได้จาก Retry-After', async ({ page }) => {
  const api = new MockPlatformApi();
  await open(page, api, '/new');
  await fillValidForm(page);
  await page.getByRole('button', { name: 'ตรวจสอบข้อมูล →' }).click();
  await page.getByLabel(/ฉันตรวจสอบ identity/).check();
  await page.getByRole('button', { name: 'ยืนยันและเริ่ม provision' }).click();
  await expect(page.getByRole('heading', { name: 'พร้อมส่งมอบให้ลูกค้า' })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'ส่งคำเชิญอีกครั้ง' }).click();
  const panel = page.getByRole('region', { name: 'ส่งคำเชิญอีกครั้ง' });
  await panel.getByLabel(/เหตุผล/).fill('ผู้รับแจ้งว่าไม่ได้รับอีเมล');
  await panel.getByRole('button', { name: 'ส่งคำเชิญอีกครั้ง' }).click();
  await expect(panel.getByRole('alert')).toContainText('ส่งคำเชิญซ้ำเกิน 3 ครั้งต่อชั่วโมงแล้ว');
  await expect(panel.getByRole('alert')).toContainText('30 นาที');
});

test('auditor: อ่านได้อย่างเดียว — ไม่มีปุ่มสร้าง/recovery และหน้า /new ถูกปฏิเสธ', async ({
  page,
}) => {
  const operator = new MockPlatformApi();
  const auditor = new MockPlatformApi('platform_auditor');
  // สร้างข้อมูลด้วย operator mock แล้วให้ auditor อ่านชุดเดียวกัน
  auditor.requests = operator.requests;
  auditor.history = operator.history;
  const entry = {
    requestId: '00000001-0000-4000-8000-00000000abcd',
    tenantId: '00000002-0000-4000-8000-00000000abcd',
    status: 'ACTION_REQUIRED' as const,
    revision: 3,
    displayName: 'Metro Retail Lab',
    slug: 'metro-retail',
    primaryDomain: 'metro.example.test',
    plan: { code: 'starter', version: 1 },
    failing: true,
    polls: 5,
    email: 'ops@metro.example.test',
  };
  auditor.requests.set(entry.requestId, entry);
  await open(page, auditor);
  await expect(page.getByText('Platform Auditor (อ่านอย่างเดียว)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'สร้าง tenant' })).toHaveCount(0);
  await page.getByRole('button', { name: 'เปิดรายละเอียด Metro Retail Lab' }).click();
  await expect(page.getByRole('heading', { name: 'ต้องการการตัดสินใจ' })).toBeVisible();
  await expect(page.getByText('Platform Auditor ดูได้อย่างเดียว')).toBeVisible();
  await expect(page.getByRole('button', { name: /Reconcile/ })).toHaveCount(0);
  await expectAccessible(page);
  await page.goto('/new');
  await expect(page.getByText('Platform Auditor สร้าง tenant ไม่ได้')).toBeVisible();
});

test('keyboard: skip link และค้นหาด้วยคีย์บอร์ดล้วน; request ที่ไม่มีได้หน้า generic', async ({
  page,
}) => {
  const api = new MockPlatformApi();
  await open(page, api);
  await expect(page.getByRole('heading', { name: 'Tenants', level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'ข้ามไปเนื้อหาหลัก' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByLabel('ค้นหา tenant').focus();
  await page.keyboard.type('ไม่มีอยู่จริง');
  await page.keyboard.press('Enter');
  await expect(page.getByText('ไม่พบ tenant')).toBeVisible();
  await page.goto('/requests/00000009-0000-4000-8000-000000000009');
  await expect(page.getByRole('heading', { name: 'ไม่พบคำขอ' })).toBeVisible();
  await expectAccessible(page);
});
