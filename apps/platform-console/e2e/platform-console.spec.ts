import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './platform-test.js';
import commonTh from '../src/i18n/locales/th/common.json' with { type: 'json' };
import commonEn from '../src/i18n/locales/en/common.json' with { type: 'json' };

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

  constructor(
    readonly role: 'platform_operator' | 'platform_auditor' = 'platform_operator',
    /** A1.8: สิ่งที่ API ตอบใน session.mutations สำหรับ operator */
    readonly rollout: 'ALLOWED' | 'DISABLED' | 'NOT_ALLOWLISTED' = 'ALLOWED',
  ) {}

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
    const mutate = this.role === 'platform_operator' && this.rollout === 'ALLOWED';

    if (path === '/api/v1/session') {
      return json(200, {
        subject: 'sub-e2e',
        roles: [this.role],
        capabilities: mutate
          ? ['CONTROL_PLANE_READ', 'PROVISIONING_MUTATE']
          : ['CONTROL_PLANE_READ'],
        mutations: this.role === 'platform_operator' ? this.rollout : 'NOT_GRANTED',
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

function seedRequest(api: MockPlatformApi, status: Status = 'ACTION_REQUIRED') {
  const entry: MockRequest = {
    requestId: '00000001-0000-4000-8000-00000000cafe',
    tenantId: '00000002-0000-4000-8000-00000000cafe',
    status,
    revision: 3,
    displayName: 'Synthetic Customer',
    slug: 'synthetic-customer',
    primaryDomain: 'synthetic.example.test',
    plan: { code: 'growth', version: 7 },
    failing: status === 'ACTION_REQUIRED',
    polls: 5,
    email: 'operator@synthetic.example.test',
  };
  api.requests.set(entry.requestId, entry);
  api.history.push(api.event(entry, 'REQUEST_ACCEPTED', 'SYSTEM'));
  return entry;
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
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))),
  );
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([]);
}

async function choose(page: Page, label: string, option: string) {
  const trigger = page.getByRole('button', { name: new RegExp(label) });
  await trigger.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function confirmReview(page: Page, label = commonTh.wizard.confirm) {
  const checkbox = page.getByRole('checkbox', { name: label });
  await checkbox.focus();
  await checkbox.press('Space');
  await expect(checkbox).toBeChecked();
}

async function fillValidForm(page: Page, slug = 'nova-care', copy = commonTh) {
  await page.getByLabel(copy.fields.displayName).fill('Nova Care Thailand');
  await page.getByLabel(copy.fields.slug, { exact: true }).fill(slug);
  await page.getByLabel(copy.fields.primaryDomain).fill('nova.example.test');
  await choose(page, copy.fields.planCode, 'growth (v3)');
  await page.getByLabel(copy.fields.firstAdminDisplayName).fill('Narin');
  await page.getByLabel(copy.fields.firstAdminEmail).fill(EMAIL);
}

for (const language of ['th', 'en'] as const) {
  test.describe(`Guided onboarding ${language}`, () => {
    test.use({ locale: language === 'th' ? 'th-TH' : 'en-GB' });
    const copy = language === 'th' ? commonTh : commonEn;
    test('happy path: create → review → track จน ACTIVE → search → timeline (a11y ผ่านทุกหน้า)', async ({
      page,
    }, testInfo) => {
      const api = new MockPlatformApi();
      api.hold = true;
      const outside = await open(page, api);
      await expect(
        page.getByRole('heading', { name: copy.navigation.tenants, level: 1 }),
      ).toBeVisible();
      await expect(page.getByText(copy.list.empty)).toBeVisible();
      await expectAccessible(page);

      await page.getByRole('button', { name: copy.navigation.create }).first().click();
      await expect(page).toHaveURL(/\/new$/);
      // เปลี่ยนหน้าแล้วโฟกัสย้ายไปหัวข้อ
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      // validation: error summary ได้โฟกัสและลิงก์ไปช่องที่ผิด
      await page.getByRole('button', { name: copy.wizard.review }).click();
      const summary = page
        .getByRole('alert')
        .filter({ hasText: copy.validation.summary.split(' (')[0] });
      await expect(summary).toBeFocused();
      await expectAccessible(page);
      await summary.getByRole('link', { name: /Slug/ }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Slug')).toBeFocused();
      await expect(page.getByLabel('Slug')).toHaveAttribute('aria-invalid', 'true');

      await fillValidForm(page, 'nova-care', copy);
      await page.getByRole('button', { name: copy.wizard.review }).click();
      await expect(page.getByRole('heading', { name: copy.wizard.titleReview })).toBeFocused();
      const confirm = page.getByRole('button', { name: copy.wizard.submit });
      await expect(confirm).toBeDisabled();
      await expectAccessible(page);
      await confirmReview(page, copy.wizard.confirm);
      await confirm.click();

      // สถานะมาจาก API: PENDING → RUNNING → SUCCEEDED; ไม่บอกว่าสำเร็จก่อนเวลา
      await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
      await expect(page.getByText(copy.request.pending)).toBeVisible();
      await expect(page.getByText(copy.request.ready)).toHaveCount(0);
      api.hold = false;
      await expect(page.getByRole('heading', { name: copy.request.ready })).toBeVisible({
        timeout: 10_000,
      });
      // plan ที่แสดงคือค่าที่ server pin (v7) ไม่ใช่ตัวเลือกใน catalog (v3)
      await expect(page.getByText('growth v7')).toBeVisible();
      await expect(page.getByText('o***@nova.example.test')).toBeVisible();
      await expect(
        page.getByRole('list', { name: copy.history.order }).getByText('Platform Operator'),
      ).toBeVisible();
      await expect(
        page.getByRole('list', { name: copy.history.order }).getByText('System').first(),
      ).toBeVisible();
      await expectAccessible(page);

      await page.screenshot({
        path: testInfo.outputPath(`handoff-${language}.png`),
        fullPage: true,
      });

      // idempotency: ส่งครั้งเดียวด้วย key และไม่มี tenant/status จาก browser
      const created = api.posts.filter((post) => post.path === '/api/v1/provisioning-requests');
      expect(created).toHaveLength(1);
      expect(created[0]!.key).toMatch(/^create-/);
      expect(Object.keys(created[0]!.body as object)).not.toContain('tenantId');

      // search ด้วยอีเมล: คำค้นไม่ลง URL
      await page.getByRole('button', { name: copy.navigation.tenants }).click();
      await page.getByLabel(copy.list.searchLabel).fill(EMAIL);
      await page.getByLabel(copy.list.searchLabel).press('Enter');
      await expect(page.getByRole('row', { name: /Nova Care Thailand/ })).toBeVisible();
      expect(page.url()).not.toContain('owner');
      await page
        .getByRole('button', {
          name: copy.list.openDetails.replace('{{name}}', 'Nova Care Thailand'),
        })
        .click();
      await expect(page.getByRole('heading', { name: copy.history.title })).toBeVisible();

      // ไม่มี token/อีเมลใน storage และไม่มี request ออกนอก origin
      const storage = await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      );
      expect(storage).not.toContain('e2e-access-token');
      expect(storage).not.toContain(EMAIL);
      expect(outside).toEqual([]);
    });

    test('conflict: slug ที่ถูกจองแล้วพากลับฟอร์มพร้อม error ที่ช่อง slug', async ({ page }) => {
      const api = new MockPlatformApi();
      await open(page, api, '/new');
      await fillValidForm(page, 'taken', copy);
      await page.getByRole('button', { name: copy.wizard.review }).click();
      await confirmReview(page, copy.wizard.confirm);
      await page.getByRole('button', { name: copy.wizard.submit }).click();
      const summary = page
        .getByRole('alert')
        .filter({ hasText: copy.validation.summary.split(' (')[0] });
      await expect(summary).toBeFocused();
      await expect(summary).toContainText(copy.errors.TENANT_SLUG_CONFLICT);
      await expect(page.getByLabel('Slug')).toHaveAttribute('aria-invalid', 'true');
    });

    test('ACTION_REQUIRED: Reconcile แนะนำก่อน, preview async, stale revision → preview ใหม่ แล้วสำเร็จ', async ({
      page,
    }) => {
      const api = new MockPlatformApi();
      await open(page, api, '/new');
      await fillValidForm(page, 'failing', copy);
      await page.getByRole('button', { name: copy.wizard.review }).click();
      await confirmReview(page, copy.wizard.confirm);
      await page.getByRole('button', { name: copy.wizard.submit }).click();
      await expect(page.getByRole('heading', { name: copy.statuses.ACTION_REQUIRED })).toBeVisible({
        timeout: 10_000,
      });
      const options = page.getByRole('region', { name: 'Recovery' }).getByRole('button');
      await expect(options.first()).toHaveText(
        copy.recovery.actions.RECONCILE.title + copy.recovery.recommended,
      );
      await expect(options.nth(3)).toHaveText('Mark FAILED_FINAL');
      await expectAccessible(page);

      await options.first().click();
      const panel = page.getByRole('region', { name: /Reconcile & resume/ });
      await expect(
        panel.getByRole('heading', { name: new RegExp(copy.recovery.confirming) }),
      ).toBeFocused();
      // ต้องมีเหตุผล: ช่องว่าง = error ที่ช่อง comment
      await panel
        .getByRole('button', {
          name: copy.recovery.confirm.replace('{{action}}', copy.recovery.actions.RECONCILE.title),
        })
        .click();
      await expect(panel.getByText(copy.validation.comment)).toBeVisible();
      await panel.getByLabel(copy.recovery.comment).fill('ตรวจแล้วว่า Organization เป็นของเรา');

      // คนอื่นขยับ revision ก่อน → 409 แล้ว preview ใหม่ได้
      api.bumpRevisionBeforeExecute = true;
      await panel
        .getByRole('button', {
          name: copy.recovery.confirm.replace('{{action}}', copy.recovery.actions.RECONCILE.title),
        })
        .click();
      await expect(panel.getByRole('alert')).toContainText(copy.errors.REVISION_CONFLICT);
      await panel.getByRole('button', { name: copy.recovery.reloadPreview }).click();
      await panel.getByLabel(copy.recovery.comment).fill('ตรวจอีกครั้งหลังโหลดใหม่');
      await panel
        .getByRole('button', {
          name: copy.recovery.confirm.replace('{{action}}', copy.recovery.actions.RECONCILE.title),
        })
        .click();
      await expect(
        panel.getByText(
          copy.recovery.succeeded.replace('{{action}}', copy.recovery.actions.RECONCILE.title),
        ),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: copy.request.ready })).toBeVisible({
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
      await fillValidForm(page, 'nova-care', copy);
      await page.getByRole('button', { name: copy.wizard.review }).click();
      await confirmReview(page, copy.wizard.confirm);
      await page.getByRole('button', { name: copy.wizard.submit }).click();
      await expect(page.getByRole('heading', { name: copy.request.ready })).toBeVisible({
        timeout: 10_000,
      });
      await page.getByRole('button', { name: copy.invitation.resend }).click();
      const panel = page.getByRole('region', { name: copy.invitation.resend });
      await panel.getByLabel(copy.invitation.comment).fill('ผู้รับแจ้งว่าไม่ได้รับอีเมล');
      await panel.getByRole('button', { name: copy.invitation.resend }).click();
      await expect(panel.getByRole('alert')).toContainText(copy.errors.INVITATION_RESEND_LIMITED);
      await expect(panel.getByRole('alert')).toContainText(
        copy.invitation.retryAfter.replace('{{count}}', '30'),
      );
      await expectAccessible(page);
      await panel.getByRole('button', { name: copy.common.close }).focus();
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(page.getByRole('button', { name: copy.invitation.resend })).toBeFocused();
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
      await expect(page.getByText(copy.identity.auditor)).toBeVisible();
      await expect(page.getByRole('button', { name: copy.navigation.create })).toHaveCount(0);
      await page
        .getByRole('button', {
          name: copy.list.openDetails.replace('{{name}}', 'Metro Retail Lab'),
        })
        .click();
      await expect(
        page.getByRole('heading', { name: copy.statuses.ACTION_REQUIRED }),
      ).toBeVisible();
      await expect(page.getByText(copy.readOnly.auditorDecision)).toBeVisible();
      await expect(page.getByRole('button', { name: /Reconcile/ })).toHaveCount(0);
      await expectAccessible(page);
      await page.goto('/new');
      await expect(page.getByText(copy.readOnly.auditorCreate)).toBeVisible();
    });

    test('A1.8 rollback: operator เห็นประกาศปิดชั่วคราว, ไม่มีปุ่มสร้าง/recovery แต่ยังดูสถานะได้', async ({
      page,
    }) => {
      const api = new MockPlatformApi('platform_operator', 'DISABLED');
      api.requests.set('00000001-0000-4000-8000-00000000beef', {
        requestId: '00000001-0000-4000-8000-00000000beef',
        tenantId: '00000002-0000-4000-8000-00000000beef',
        status: 'ACTION_REQUIRED' as const,
        revision: 3,
        displayName: 'Harbor Freight Lab',
        slug: 'harbor-freight',
        primaryDomain: 'harbor.example.test',
        plan: { code: 'starter', version: 1 },
        failing: true,
        polls: 5,
        email: 'ops@harbor.example.test',
      });
      await open(page, api);
      await expect(
        page.getByRole('status').filter({ hasText: copy.readOnly.disabledBanner }),
      ).toBeVisible();
      await expect(page.getByText(copy.identity.disabled)).toBeVisible();
      await expect(page.getByRole('button', { name: copy.navigation.create })).toHaveCount(0);
      await page
        .getByRole('button', {
          name: copy.list.openDetails.replace('{{name}}', 'Harbor Freight Lab'),
        })
        .click();
      await expect(
        page.getByRole('heading', { name: copy.statuses.ACTION_REQUIRED }),
      ).toBeVisible();
      await expect(page.getByText(copy.readOnly.disabledDecision)).toBeVisible();
      await expect(page.getByRole('button', { name: /Reconcile/ })).toHaveCount(0);
      await expectAccessible(page);
      await page.goto('/new');
      await expect(page.getByText(copy.readOnly.disabledCreate)).toBeVisible();
    });

    test('keyboard: skip link และค้นหาด้วยคีย์บอร์ดล้วน; request ที่ไม่มีได้หน้า generic', async ({
      page,
    }) => {
      const api = new MockPlatformApi();
      await open(page, api);
      await expect(
        page.getByRole('heading', { name: copy.navigation.tenants, level: 1 }),
      ).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: copy.navigation.skip })).toBeFocused();
      await page.keyboard.press('Enter');
      await page.getByLabel(copy.list.searchLabel).focus();
      await page.keyboard.type('ไม่มีอยู่จริง');
      await page.keyboard.press('Enter');
      await expect(page.getByText(copy.list.empty)).toBeVisible();
      await page.goto('/requests/00000009-0000-4000-8000-000000000009');
      await expect(page.getByRole('heading', { name: copy.request.notFound })).toBeVisible();
      await expectAccessible(page);
    });
  });
}

test('สลับภาษากลาง draft/review/progress คง DOM และ payload เดิมโดยไม่ส่งคำสั่งซ้ำ', async ({
  page,
}, testInfo) => {
  const api = new MockPlatformApi();
  api.hold = true;
  let sessions = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/session') sessions += 1;
  });
  await open(page, api, '/new');
  await fillValidForm(page);
  await choose(page, 'Locale', 'English (en-US)');
  await choose(page, 'Timezone', 'UTC');
  const input = await page.getByLabel('Slug', { exact: true }).elementHandle();
  const sessionCount = sessions;
  await page.getByRole('button', { name: 'เปลี่ยนเป็นภาษาอังกฤษ' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(
    page.getByRole('navigation').getByRole('button', { name: 'Create tenant' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Slug', { exact: true })).toHaveValue('nova-care');
  expect(await input!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.getByRole('button', { name: /Locale/ })).toContainText('English (en-US)');
  await expect(page.getByRole('button', { name: /Timezone/ })).toContainText('UTC');
  expect(api.posts).toHaveLength(0);
  expect(sessions).toBe(sessionCount);
  await expectAccessible(page);
  await page.screenshot({ path: testInfo.outputPath('platform-draft-en.png'), fullPage: true });

  await page.getByRole('button', { name: commonEn.wizard.review }).click();
  const confirmation = page.getByRole('checkbox');
  await confirmation.focus();
  await confirmation.press('Space');
  const review = await page.getByRole('heading', { level: 1 }).elementHandle();
  await page.getByRole('button', { name: 'Switch to Thai' }).click();
  expect(await review!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(confirmation).toBeChecked();
  await page.getByRole('button', { name: 'ยืนยันและเริ่ม provision' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const requestUrl = page.url();
  const progress = await page.getByRole('heading', { level: 1 }).elementHandle();
  await page.getByRole('button', { name: 'เปลี่ยนเป็นภาษาอังกฤษ' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(page.url()).toBe(requestUrl);
  expect(await progress!.evaluate((node) => node.isConnected)).toBe(true);
  const posts = api.posts.filter((post) => post.path === '/api/v1/provisioning-requests');
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toMatchObject({ locale: 'en-US', timezone: 'UTC' });
  expect(api.posts).toHaveLength(1);
  expect(sessions).toBe(sessionCount);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  expect(page.url()).toBe(requestUrl);
  expect(api.posts).toHaveLength(1);
});

test('storage ของ preference ใช้ไม่ได้ยังสลับภาษาใน memory ได้', async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === 'dcontact.platform.locale') throw new DOMException('Denied', 'SecurityError');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'dcontact.platform.locale') throw new DOMException('Full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  await open(page, new MockPlatformApi());
  await page.getByRole('button', { name: 'เปลี่ยนเป็นภาษาอังกฤษ' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to Thai' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'th');
});

for (const mode of ['auditor', 'DISABLED', 'NOT_ALLOWLISTED'] as const) {
  test(`header EN คง capability ของ ${mode}`, async ({ page }) => {
    const api =
      mode === 'auditor'
        ? new MockPlatformApi('platform_auditor')
        : new MockPlatformApi('platform_operator', mode);
    await open(page, api);
    await page.getByRole('button', { name: 'เปลี่ยนเป็นภาษาอังกฤษ' }).click();
    const copy =
      mode === 'auditor'
        ? 'Platform Auditor (read only)'
        : mode === 'DISABLED'
          ? 'Platform Operator (mutations disabled)'
          : 'Platform Operator (outside canary)';
    await expect(page.getByRole('banner').getByText(copy)).toBeVisible();
    await expect(
      page.getByRole('navigation').getByRole('button', { name: 'Create tenant' }),
    ).toHaveCount(0);
    await expectAccessible(page);
    expect(api.posts).toHaveLength(0);
  });
}

test.describe('browser ภาษาอังกฤษ', () => {
  test.use({ locale: 'en-GB' });
  test('ไม่มี preference ใช้ browser และสลับด้วย keyboard โดยคง focus', async ({ page }) => {
    await open(page, new MockPlatformApi());
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    const toggle = page.getByRole('button', { name: 'Switch to Thai' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'เปลี่ยนเป็นภาษาอังกฤษ' })).toBeFocused();
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
  });
});

for (const language of ['th', 'en'] as const) {
  test.describe(`Migration invariants ${language}`, () => {
    test.use({ locale: language === 'th' ? 'th-TH' : 'en-GB' });
    const copy = language === 'th' ? commonTh : commonEn;
    const other = language === 'th' ? commonEn : commonTh;

    test('recovery เปลี่ยนภาษาคง preview/revision/comment/reason และ Escape คืน focus', async ({
      page,
    }, testInfo) => {
      const api = new MockPlatformApi();
      const entry = seedRequest(api);
      let previews = 0;
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/previews'))
          previews += 1;
      });
      await open(page, api, `/requests/${entry.requestId}`);
      const trigger = page
        .getByRole('region', { name: copy.recovery.title })
        .getByRole('button')
        .first();
      await trigger.focus();
      await page.keyboard.press('Enter');
      let panel = page.getByRole('region', { name: /Reconcile & resume/ });
      await expect(panel.getByRole('heading')).toContainText(copy.recovery.confirming);
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(panel).toHaveCount(0);
      await page.keyboard.press('Enter');
      panel = page.getByRole('region', { name: /Reconcile & resume/ });
      await expect(panel.getByRole('heading')).toContainText(copy.recovery.confirming);
      await panel
        .getByRole('button', {
          name: copy.recovery.confirm.replace('{{action}}', 'Reconcile & resume'),
        })
        .click();
      await expect(panel.getByText(copy.validation.comment)).toBeVisible();
      const textarea = panel.getByLabel(copy.recovery.comment);
      const element = await textarea.elementHandle();
      const previewCount = previews;
      const url = page.url();
      await page.getByRole('button', { name: copy.language.switch }).click();
      await expect(page.getByRole('button', { name: other.language.switch })).toBeFocused();
      await expect(panel.getByText(other.validation.comment)).toBeVisible();
      expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
      await panel.getByLabel(other.recovery.comment).fill('ข้อความผู้ใช้ — keep this text');
      await choose(page, other.request.reason, other.reasons.CUSTOMER_REQUEST);
      expect(previews).toBe(previewCount);
      expect(api.posts).toHaveLength(0);
      expect(page.url()).toBe(url);
      await expectAccessible(page);
      await page.screenshot({
        path: testInfo.outputPath(`recovery-switch-${language}.png`),
        fullPage: true,
      });
      const confirm = panel.getByRole('button', {
        name: other.recovery.confirm.replace('{{action}}', 'Reconcile & resume'),
      });
      await confirm.focus();
      await page.keyboard.press('Enter');
      await expect(
        panel.getByText(other.recovery.succeeded.replace('{{action}}', 'Reconcile & resume')),
      ).toBeVisible();
      const commands = api.posts.filter((post) => post.path.endsWith('/actions/reconcile'));
      expect(commands).toHaveLength(1);
      expect(commands[0]!.body).toMatchObject({
        expectedRevision: 3,
        previewDigest: PREVIEW_DIGEST,
        reasonCode: 'CUSTOMER_REQUEST',
        comment: 'ข้อความผู้ใช้ — keep this text',
      });
      expect(commands[0]!.key).toMatch(/^reconcile-/);
      expect(previews).toBe(previewCount);
      await panel.getByRole('button', { name: other.common.close }).click();
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    });

    test('unknown error ไม่แสดง raw title และ validation เปลี่ยนภาษาจาก key เดิม', async ({
      page,
    }) => {
      const api = new MockPlatformApi();
      await open(page, api, '/new');
      await page.getByRole('button', { name: copy.wizard.review }).click();
      const summary = page
        .getByRole('alert')
        .filter({ hasText: copy.validation.summary.split(' (')[0] });
      await expect(summary).toBeFocused();
      await page.getByRole('button', { name: copy.language.switch }).click();
      await expect(page.getByRole('button', { name: other.language.switch })).toBeFocused();
      await expect(page.getByRole('alert')).toContainText(other.validation.displayName);
      await fillValidForm(page, 'generic-error', other);
      await page.getByRole('button', { name: other.wizard.review }).click();
      await confirmReview(page, other.wizard.confirm);
      const submitted: { key: string | undefined; body: unknown }[] = [];
      await page.route('**/api/v1/provisioning-requests', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        submitted.push({
          key: route.request().headers()['idempotency-key'],
          body: route.request().postDataJSON(),
        });
        await route.fulfill({
          status: 500,
          json: {
            status: 500,
            code: 'constructor',
            title: 'RAW_SERVER_SECRET synthetic@example.test',
            correlationId: 'synthetic-reference',
            retryable: true,
          },
        });
      });
      await page.getByRole('button', { name: other.wizard.submit }).click();
      await expect(page.getByRole('alert')).toContainText(other.errors.generic);
      await expect(page.getByRole('alert')).toContainText('synthetic-reference');
      await expect(page.locator('body')).not.toContainText('RAW_SERVER_SECRET');
      await expect(page.locator('body')).not.toContainText('synthetic@example.test');
      await page.getByRole('button', { name: other.language.switch }).click();
      await page.getByRole('button', { name: copy.common.retry }).click();
      await expect.poll(() => submitted.length).toBe(2);
      expect(submitted[0]!.key).toMatch(/^create-/);
      expect(submitted[1]).toEqual(submitted[0]);
      expect(page.url()).not.toContain('generic-error');
      expect(
        await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
      ).not.toContain(EMAIL);
      await expectAccessible(page);
    });

    test('unknown state/step/action ใช้ fallback และเวลาเปลี่ยนภาษาโดย instant คงเดิม', async ({
      page,
    }) => {
      const api = new MockPlatformApi();
      const entry = seedRequest(api);
      const original = api.view.bind(api);
      api.view = (request) =>
        ({
          ...original(request),
          status: 'UNRECOGNIZED',
          timezone: 'UTC',
          steps: [
            {
              stepKey: 'NEW_STEP',
              state: 'UNRECOGNIZED',
              attempt: 1,
              errorCode: null,
              nextAttemptAt: null,
              finishedAt: null,
            },
          ],
          invitation: {
            generation: 2,
            delivery: 'NEW_DELIVERY',
            expiresAt: '2026-10-23T03:00:00.000Z',
            expired: false,
            resendsInLastHour: 0,
          },
        }) as unknown as ReturnType<MockPlatformApi['view']>;
      api.history = [
        api.event(entry, 'NEW_ACTION', 'SYSTEM', {
          stepKey: 'NEW_STEP',
          outcome: 'NEW_OUTCOME',
          actor: { kind: 'NEW_ACTOR', subject: 'synthetic', role: null },
          comment: 'ข้อความผู้ใช้ keep this',
        }),
      ];
      let reads = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === `/api/v1/provisioning-requests/${entry.requestId}`)
          reads += 1;
      });
      await open(page, api, `/requests/${entry.requestId}`);
      await expect(page.getByText(copy.statuses.unknown).first()).toBeVisible();
      await expect(page.getByText(copy.steps.unknown.title).first()).toBeVisible();
      await expect(page.getByText(copy.actions.unknown)).toBeVisible();
      await expect(page.getByText(copy.actors.unknown)).toBeVisible();
      await expect(page.getByText(copy.invitation.delivery.unknown)).toBeVisible();
      await expect(page.getByRole('heading', { name: copy.request.ready })).toHaveCount(0);
      await expect(page.getByText('ข้อความผู้ใช้ keep this', { exact: false })).toBeVisible();
      const time = page.locator('time').first();
      await expect(time).toBeVisible();
      const instant = await time.getAttribute('datetime');
      const before = await time.textContent();
      const count = reads;
      await expectAccessible(page);
      await page.getByRole('button', { name: copy.language.switch }).click();
      await expect(page.getByText(other.actions.unknown)).toBeVisible();
      await expect(time).toHaveAttribute('datetime', instant!);
      expect(await time.textContent()).not.toBe(before);
      expect(await time.textContent()).toContain('10:01');
      await expect(page.getByText('ข้อความผู้ใช้ keep this', { exact: false })).toBeVisible();
      await expect(page.getByRole('heading', { name: other.request.ready })).toHaveCount(0);
      expect(reads).toBe(count);
      expect(api.posts).toHaveLength(0);
      await expectAccessible(page);
    });

    test('keyboard ของ Table และ Select ใช้พฤติกรรมจาก component ร่วม', async ({ page }) => {
      const api = new MockPlatformApi();
      seedRequest(api, 'SUCCEEDED');
      await open(page, api);
      const table = page.getByRole('grid', { name: copy.list.table });
      await table.focus();
      await page.keyboard.press('ArrowDown');
      const row = page.getByRole('row', { name: /Synthetic Customer/ });
      await expect(row).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('End');
      const openButton = page.getByRole('button', {
        name: copy.list.openDetails.replace('{{name}}', 'Synthetic Customer'),
      });
      await expect(openButton).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/requests\//);
      await page
        .getByRole('navigation')
        .getByRole('button', { name: copy.navigation.create })
        .focus();
      await page.keyboard.press('Enter');
      const plan = page.getByRole('button', { name: new RegExp(copy.fields.planCode) });
      await plan.focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('Home');
      await page.keyboard.press('Enter');
      await expect(plan).toContainText('growth (v3)');
      await expect(plan).toBeFocused();
      await expectAccessible(page);
    });
  });
}
