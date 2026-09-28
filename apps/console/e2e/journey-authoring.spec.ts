import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';

// D1.14 (#453): ข้อความมาจาก catalog ตามภาษา browser — ชุดนี้ตรวจ flow J5 เดิมบนภาษาไทย
test.use({ locale: 'th-TH' });

/**
 * J5.6 (#344): Journey authoring Console end-to-end
 *
 * Mock เฉพาะ `/api/v1/journey-authoring/**` แบบมี state (CAS/revision จริง) — ข้อมูลเป็น synthetic
 * ทั้งหมด ไม่มี PII; request ที่ออกนอก origin ของ Console ถือว่าผิด
 */

const JOURNEY_ID = '6f1b2c3d-4e5f-4a60-8b7c-9d0e1f2a3b41';
const NEW_JOURNEY_ID = '7a2b3c4d-5e6f-4a71-9b8c-0d1e2f3a4b52';
const TEMPLATE_ID = '5b0c7a4e-8f1d-4c3a-9b2e-1a7d3c5e9f01';
const REVIEW_ID = '8b3c4d5e-6f7a-4b82-8c9d-1e2f3a4b5c63';
const DIGEST = (seed: string) => seed.repeat(64).slice(0, 64);

type Json = Record<string, unknown>;

function authoringDocument(name = 'ติดตามการชำระ') {
  return {
    schemaVersion: 'J5_AUTHORING_V1',
    registryVersion: 'J5_PALETTE_V1',
    trigger: { nodeId: 'trigger', type: 'EVENT_TRIGGER', config: { eventType: 'invoice.overdue' } },
    nodes: [
      { nodeId: 'send-1', type: 'SEND', config: { channel: 'LINE', contentRef: 'content-a' } },
      { nodeId: 'done', type: 'EXIT', config: { reason: 'COMPLETED' } },
    ],
    edges: [
      {
        edgeId: 'e1',
        source: { nodeId: 'trigger', portId: 'start' },
        target: { nodeId: 'send-1' },
      },
      { edgeId: 'e2', source: { nodeId: 'send-1', portId: 'next' }, target: { nodeId: 'done' } },
    ],
    settings: {
      name,
      purpose: 'SERVICE',
      senderIdentityId: 'sender-synthetic',
      goal: { kind: 'EVENT', eventType: 'invoice.paid' },
      exitRules: [{ kind: 'GOAL' }],
      maxDurationDays: 14,
    },
    layout: {
      nodes: { trigger: { x: 40, y: 40 }, 'send-1': { x: 40, y: 180 }, done: { x: 40, y: 320 } },
    },
  };
}

interface JourneyState {
  headVersion: number;
  revision: number;
  document: Json;
  lifecycle: string;
  activeVersion: number | null;
  review: {
    reviewId: string;
    state: string;
    draftRevision: number;
    draftDigest: string;
    compileDigest: string;
    submittedAt: string;
    makerIsCaller: boolean;
  } | null;
  notices: Json[];
}

/** capability ที่ server คืนตาม persona — reviewer ไม่มีสิทธิ์แก้/publish */
const PERMISSIONS = {
  author: { edit: true, review: true, publish: true },
  reviewer: { edit: false, review: true, publish: false },
};

class AuthoringMock {
  readonly requests: Request[] = [];
  readonly journeys = new Map<string, JourneyState>();
  /** ครั้งถัดไปที่ PUT draft จะเจอ revision ใหม่จากคนอื่นก่อน */
  concurrentEdit = false;
  publishUnknown = false;
  publishCommitted = false;
  persona: keyof typeof PERMISSIONS = 'author';

  constructor() {
    this.journeys.set(JOURNEY_ID, {
      headVersion: 1,
      revision: 1,
      document: authoringDocument(),
      lifecycle: 'DRAFT_ONLY',
      activeVersion: null,
      review: null,
      notices: [],
    });
  }

  snapshot(journeyId: string) {
    const journey = this.journeys.get(journeyId)!;
    return {
      head: {
        journeyId,
        name: (journey.document.settings as Json).name,
        ownerTeamId: 'team-synthetic',
        lifecycle: journey.lifecycle,
        version: journey.headVersion,
        currentDraftRevision: journey.revision,
        currentDraftDigest: DIGEST(String(journey.revision)),
        activeVersion: journey.activeVersion,
        activeRuntimeHash: null,
      },
      draft: {
        revision: journey.revision,
        digest: DIGEST(String(journey.revision)),
        basePublishedVersion: null,
        document: journey.document,
      },
      review: journey.review,
      permissions: PERMISSIONS[this.persona],
      templateNotices: journey.notices,
    };
  }

  async install(page: Page) {
    // API ที่ไม่ใช่ UAT ไม่มี route profile — Console ต้องไม่แสดง UI ของ UAT (U1.4 #432)
    await page.route('**/api/v1/runtime-profile', (route) =>
      route.fulfill({ status: 404, json: { message: 'Not Found' } }),
    );
    await page.route('**/api/v1/journey-authoring/**', async (route) => {
      const request = route.request();
      this.requests.push(request);
      const path = new URL(request.url()).pathname.replace('/api/v1/journey-authoring', '');
      // ภาพหน้าจอเป็น raw body — parse JSON เฉพาะ request ที่เป็น JSON
      const isJson = (request.headers()['content-type'] ?? '').startsWith('application/json');
      const body = ((isJson ? request.postDataJSON() : null) ?? {}) as Json;
      const reply = (status: number, payload: unknown) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
      const method = request.method();
      const journeyMatch = /^\/journeys\/([^/]+)(\/.*)?$/.exec(path);
      const journeyId = journeyMatch?.[1];
      const journey = journeyId ? this.journeys.get(journeyId) : undefined;
      const tail = journeyMatch?.[2] ?? '';

      if (method === 'GET' && path === '/journeys') {
        return reply(200, {
          items: [...this.journeys.entries()].map(([id, state]) => ({
            journeyId: id,
            name: (state.document.settings as Json).name,
            ownerTeamId: 'team-synthetic',
            lifecycle: state.lifecycle,
            version: state.headVersion,
            currentDraftRevision: state.revision,
            activeVersion: state.activeVersion,
            updatedAt: '2026-09-22T00:00:00.000Z',
            reviewState:
              state.review && ['IN_REVIEW', 'APPROVED'].includes(state.review.state)
                ? state.review.state
                : null,
          })),
          nextCursor: null,
        });
      }
      if (method === 'GET' && path === '/reviews') {
        return reply(200, {
          items: [...this.journeys.entries()]
            .filter(([, state]) => state.review?.state === 'IN_REVIEW')
            .map(([id, state]) => ({
              reviewId: state.review!.reviewId,
              journeyId: id,
              journeyName: (state.document.settings as Json).name,
              ownerTeamId: 'team-synthetic',
              draftRevision: state.review!.draftRevision,
              draftDigest: state.review!.draftDigest,
              compileDigest: state.review!.compileDigest,
              submittedAt: state.review!.submittedAt,
            })),
          nextCursor: null,
        });
      }
      if (method === 'GET' && path === '/templates') {
        return reply(200, {
          items: [
            {
              origin: 'PLATFORM_BUILTIN',
              templateId: TEMPLATE_ID,
              version: 1,
              contentDigest: DIGEST('c'),
              name: 'payment-reminder',
              visibility: 'TENANT',
              ownerTeamId: null,
              lifecycle: 'ACTIVE',
              content: {
                document: authoringDocument('payment-reminder'),
                parameterSchema: [
                  {
                    parameterKey: 'reminderContent',
                    labelKey: 'template.reminderContent',
                    type: 'OPAQUE_RESOURCE_REF',
                    resourceKind: 'CONTENT',
                    required: true,
                    bindTargets: [],
                  },
                ],
              },
              compileDigest: DIGEST('d'),
              nodeMappingDigest: DIGEST('e'),
              publishedAt: '2026-09-01T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        });
      }
      if (method === 'POST' && path === `/templates/${TEMPLATE_ID}/versions/1/instantiate`) {
        this.journeys.set(NEW_JOURNEY_ID, {
          headVersion: 1,
          revision: 1,
          document: authoringDocument(String(body.name)),
          lifecycle: 'DRAFT_ONLY',
          activeVersion: null,
          review: null,
          notices: [
            {
              kind: 'UPDATE_AVAILABLE',
              journeyId: NEW_JOURNEY_ID,
              source: {
                origin: 'PLATFORM_BUILTIN',
                templateId: TEMPLATE_ID,
                version: 1,
                contentDigest: DIGEST('c'),
              },
              latestVersion: 2,
            },
          ],
        });
        return reply(200, {
          journeyId: NEW_JOURNEY_ID,
          headVersion: 1,
          draftRevision: 1,
          draftDigest: DIGEST('1'),
          diagnostics: [],
        });
      }
      if (method === 'POST' && path === `/reviews/${REVIEW_ID}/decisions`) {
        const state = [...this.journeys.values()].find(
          (entry) => entry.review?.reviewId === REVIEW_ID,
        )!;
        state.review = { ...state.review!, state: 'APPROVED' };
        return reply(200, { reviewId: REVIEW_ID, state: 'APPROVED' });
      }
      if (!journey) return reply(404, { code: 'JOURNEY_NOT_FOUND' });

      if (method === 'GET' && tail === '') return reply(200, this.snapshot(journeyId!));
      if (method === 'GET' && tail === '/audit') {
        return reply(200, {
          items: [
            {
              id: 'audit-2',
              action: journey.review?.state === 'APPROVED' ? 'REVIEW_APPROVED' : 'REVIEW_SUBMITTED',
              actorSubjectId: '0a1b2c3d-0000-4000-8000-000000000002',
              reasonCode: 'REVIEW',
              beforeDigest: null,
              afterDigest: null,
              correlationId: 'corr-synthetic-2',
              occurredAt: '2026-09-22T01:00:00.000Z',
            },
            {
              id: 'audit-1',
              action: 'DRAFT_CREATED',
              actorSubjectId: '0a1b2c3d-0000-4000-8000-000000000001',
              reasonCode: 'CREATE',
              beforeDigest: null,
              afterDigest: DIGEST('1'),
              correlationId: 'corr-synthetic-1',
              occurredAt: '2026-09-22T00:00:00.000Z',
            },
          ],
        });
      }
      if (method === 'PUT' && tail === '/draft') {
        if (this.concurrentEdit) {
          this.concurrentEdit = false;
          journey.revision += 1;
          journey.headVersion += 1;
          journey.document = {
            ...journey.document,
            settings: { ...(journey.document.settings as Json), purpose: 'MARKETING' },
          };
        }
        if (
          body.expectedDraftRevision !== journey.revision ||
          body.expectedHeadVersion !== journey.headVersion
        ) {
          return reply(409, {
            code: 'DRAFT_VERSION_CONFLICT',
            safeParams: { currentDraftRevision: journey.revision },
          });
        }
        journey.revision += 1;
        journey.headVersion += 1;
        journey.document = body.document as Json;
        return reply(200, {
          journeyId,
          headVersion: journey.headVersion,
          draftRevision: journey.revision,
          draftDigest: DIGEST(String(journey.revision)),
          diagnostics: [],
        });
      }
      if (method === 'POST' && tail === '/validate') {
        return reply(200, {
          draftRevision: journey.revision,
          draftDigest: DIGEST(String(journey.revision)),
          stale: false,
          diagnostics: [
            {
              code: 'PORT_CARDINALITY_INVALID',
              severity: 'ERROR',
              stage: 'AUTHORING',
              messageKey: 'journey.authoring.PORT_CARDINALITY_INVALID',
              path: { nodeId: 'send-1', portId: 'next' },
            },
          ],
        });
      }
      if (method === 'POST' && tail === '/compile') {
        return reply(200, {
          artifact: {
            compileDigest: DIGEST('a'),
            runtimeHash: DIGEST('b'),
            referenceDigest: DIGEST('f'),
            capabilityDigest: DIGEST('9'),
            baseHeadVersion: journey.headVersion,
          },
          diagnostics: [],
          stale: false,
          headStale: false,
        });
      }
      if (method === 'POST' && tail === '/simulations') {
        const fixture = body.fixture as { fixtureId: string; startAt: string };
        const start = Date.parse(fixture.startAt);
        return reply(200, {
          compileDigest: body.compileDigest,
          fixtureId: fixture.fixtureId,
          profile: 'SIMULATION_ONLY',
          transitions: [
            { sequence: 1, nodeId: 'trigger', portId: 'start', virtualAt: fixture.startAt },
            {
              sequence: 2,
              nodeId: 'send-1',
              portId: 'next',
              virtualAt: new Date(start + 3_600_000).toISOString(),
            },
          ],
          terminal: 'EXIT',
          diagnostics: [],
        });
      }
      if (method === 'POST' && tail === '/reviews') {
        journey.review = {
          reviewId: REVIEW_ID,
          state: 'IN_REVIEW',
          draftRevision: journey.revision,
          draftDigest: DIGEST(String(journey.revision)),
          compileDigest: DIGEST('a'),
          submittedAt: '2026-09-22T01:00:00.000Z',
          makerIsCaller: false,
        };
        return reply(200, { reviewId: REVIEW_ID, state: 'IN_REVIEW' });
      }
      if (method === 'POST' && tail === '/publish') {
        if (this.publishUnknown) {
          this.publishUnknown = false;
          this.publishCommitted = true;
          journey.activeVersion = 1;
          journey.lifecycle = 'ACTIVE';
          return reply(202, {
            code: 'PUBLISH_OUTCOME_UNKNOWN',
            resolution: { journeyId, originalIdempotencyKey: request.headers()['idempotency-key'] },
          });
        }
        return reply(409, { code: 'APPROVAL_REQUIRED' });
      }
      if (method === 'POST' && tail === '/publish-resolution') {
        return reply(200, {
          outcome: this.publishCommitted ? 'PUBLISHED' : 'NOT_COMMITTED',
          journeyId,
          version: this.publishCommitted ? 1 : null,
          runtimeHash: this.publishCommitted ? DIGEST('b') : null,
          receiptId: 'receipt-1',
        });
      }
      if (method === 'POST' && tail === '/template-upgrade-checks') {
        return reply(200, {
          journeyId,
          fromVersion: 1,
          toVersion: 2,
          baseDraftDigest: DIGEST('1'),
          localDraftDigest: DIGEST('1'),
          proposedDocument: journey.document,
          nodeMapping: {},
          conflicts: [
            {
              conflictId: 'c1',
              kind: 'FIELD_CHANGED_BOTH',
              nodeId: 'send-1',
              field: 'config.contentRef',
            },
          ],
          visualOnly: false,
          proposalDigest: DIGEST('7'),
          conflictDigest: DIGEST('8'),
        });
      }
      if (method === 'POST' && tail === '/template-upgrades') {
        journey.revision += 1;
        journey.headVersion += 1;
        journey.notices = [];
        return reply(200, {
          journeyId,
          headVersion: journey.headVersion,
          draftRevision: journey.revision,
          draftDigest: DIGEST(String(journey.revision)),
          diagnostics: [],
        });
      }
      return reply(400, { code: 'REQUEST_MALFORMED' });
    });
  }

  mutations() {
    return this.requests.filter(
      (request) =>
        request.method() !== 'GET' &&
        !/\/(validate|compile|preview|simulations|template-upgrade-checks|publish-resolution)$/.test(
          new URL(request.url()).pathname,
        ),
    );
  }
}

async function openEditor(page: Page, mock: AuthoringMock, journeyId = JOURNEY_ID) {
  await mock.install(page);
  await page.goto(`/?view=journeys&journey=${journeyId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes[0]?.target}`)).toEqual([]);
}

test.use({ viewport: { width: 1440, height: 1000 } });

test('keyboard-only authoring: เพิ่ม/ตั้งค่า/ต่อ/เรียง/ลบ แล้วบันทึกด้วย CAS', async ({ page }) => {
  const mock = new AuthoringMock();
  await openEditor(page, mock);

  // canvas: roving focus ด้วยลูกศร, Enter เลือก → properties เปลี่ยนตาม
  const canvas = page.getByRole('group', { name: 'ผังขั้นตอนของ Journey' });
  await canvas.getByRole('button', { name: 'เริ่มเมื่อเกิด event' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(canvas.getByRole('button', { name: 'ส่งข้อความ' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'ส่งข้อความ' })).toBeVisible();

  // outline: แทรก WAIT หลัง SEND ด้วย control ปกติ
  const insertType = page.getByLabel('แทรกขั้นตอนหลัง ถัดไป').first();
  await insertType.selectOption('WAIT');
  await insertType.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(canvas.getByRole('button', { name: 'รอ' })).toBeVisible();
  await expect(page.getByLabel('ถัดไป ของ รอ ไปที่')).toHaveValue('done');

  // properties: commit ตอน Enter
  const wait = page.getByLabel('ระยะเวลารอ (วินาที)');
  await wait.fill('600');
  await wait.press('Enter');
  const label = page.getByLabel('ชื่อที่แสดง');
  await label.fill('รอชำระ 10 นาที');
  await label.press('Enter');
  await expect(canvas.getByRole('button', { name: 'รอชำระ 10 นาที' })).toBeVisible();

  // reorder + ย้ายตำแหน่งด้วย Shift+ลูกศร (visual-only)
  await page.getByRole('button', { name: 'เลื่อนขึ้น รอชำระ 10 นาที' }).press('Enter');
  await canvas.getByRole('button', { name: 'รอชำระ 10 นาที' }).focus();
  await page.keyboard.press('Shift+ArrowRight');

  // ลบแล้ว undo ด้วย keyboard shortcut
  await page.getByRole('button', { name: 'ลบ จบ Journey' }).press('Enter');
  await expect(canvas.getByRole('button', { name: 'จบ Journey' })).toHaveCount(0);
  await canvas.getByRole('button', { name: 'รอชำระ 10 นาที' }).focus();
  await page.keyboard.press('Control+z');
  await expect(canvas.getByRole('button', { name: 'จบ Journey' })).toBeVisible();

  await page.getByRole('button', { name: 'บันทึกฉบับร่าง' }).press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'บันทึกเป็น revision 2 แล้ว' }),
  ).toBeVisible();

  const put = mock.requests.find((request) => request.method() === 'PUT')!;
  const body = put.postDataJSON() as Json;
  expect(body).toMatchObject({
    expectedHeadVersion: 1,
    expectedDraftRevision: 1,
    expectedDraftDigest: DIGEST('1'),
  });
  expect(put.headers()['idempotency-key']).toMatch(/^draft-/);
  const nodes = (body.document as { nodes: Json[] }).nodes;
  const saved = nodes.find((node) => node.type === 'WAIT')!;
  expect(saved).toMatchObject({ label: 'รอชำระ 10 นาที', config: { waitSeconds: 600 } });
  // reorder ทำให้ WAIT อยู่ก่อน SEND ใน document; layout เปลี่ยนแค่ตำแหน่ง
  expect(nodes.map((node) => node.type)).toEqual(['SEND', 'WAIT', 'EXIT']);
  expect(Object.keys((body.document as { layout: { nodes: Json } }).layout.nodes)).toContain(
    String(saved.nodeId),
  );
});

test('diagnostics ลิงก์กลับ node และ validate ใช้ revision ที่บันทึกแล้ว; dialog trap focus และ Esc คืน focus', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await openEditor(page, mock);
  await page.getByRole('button', { name: 'ตรวจฉบับร่างที่บันทึกแล้ว' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'server พบข้อผิดพลาด 1 รายการ' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'ไปที่ ส่งข้อความ' }).press('Enter');
  await expect(page.getByRole('button', { name: 'ส่งข้อความ มีปัญหา 1 รายการ' })).toBeFocused();

  await page.getByRole('button', { name: 'Compile ฉบับร่าง' }).click();
  await page.getByRole('button', { name: 'ส่งตรวจ' }).click();
  await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ยืนยันอนุมัติ' });
  await expect(dialog.getByLabel('Reason code')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'ยกเลิก' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'อนุมัติ', exact: true })).toBeFocused();
});

test('409 เปิด compare/reload/keep-copy และ keep-copy บันทึกบน revision ล่าสุด', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await openEditor(page, mock);
  const exitReason = page.getByLabel('Event ที่ถือว่าบรรลุเป้าหมาย');
  await exitReason.fill('invoice.settled');
  await exitReason.press('Enter');
  mock.concurrentEdit = true;
  await page.getByRole('button', { name: 'บันทึกฉบับร่าง' }).click();
  const conflict = page.getByRole('alert').filter({ hasText: 'ฉบับร่างถูกแก้โดยผู้อื่น' });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('revision 2');
  await expect(page.getByRole('button', { name: 'บันทึกฉบับร่าง' })).toBeDisabled();

  await conflict.getByRole('button', { name: 'ใช้การแก้ของฉันต่อบนฉบับล่าสุด' }).click();
  await page.getByRole('button', { name: 'บันทึกฉบับร่าง' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'บันทึกเป็น revision 3 แล้ว' }),
  ).toBeVisible();
  const puts = mock.requests.filter((request) => request.method() === 'PUT');
  expect(puts).toHaveLength(2);
  expect(puts[1]!.postDataJSON()).toMatchObject({ expectedDraftRevision: 2 });
  expect(
    (puts[1]!.postDataJSON() as { document: { settings: Json } }).document.settings,
  ).toMatchObject({
    purpose: 'MARKETING',
    goal: { eventType: 'invoice.settled' },
  });
});

test('session recovery ของแท็บ: reload แล้วกู้การแก้ที่ยังไม่บันทึกได้', async ({ page }) => {
  const mock = new AuthoringMock();
  await openEditor(page, mock);
  const name = page.getByLabel('ชื่อ Journey');
  await name.fill('ชื่อใหม่ก่อน reload');
  await name.press('Enter');
  await page.reload();
  await expect(
    page.getByRole('alert').filter({ hasText: 'พบการแก้ไขที่ยังไม่บันทึก' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'กู้คืนการแก้ไข' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ชื่อใหม่ก่อน reload' })).toBeVisible();
  expect(mock.mutations()).toHaveLength(0);
});

test('publish ที่ไม่รู้ผล (202) ต้อง resolve ด้วย key เดิม ไม่แสดงว่าสำเร็จก่อนรู้ผล', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  const journey = mock.journeys.get(JOURNEY_ID)!;
  journey.review = {
    reviewId: REVIEW_ID,
    state: 'APPROVED',
    draftRevision: 1,
    draftDigest: DIGEST('1'),
    compileDigest: DIGEST('a'),
    submittedAt: '2026-09-22T01:00:00.000Z',
    makerIsCaller: false,
  };
  mock.publishUnknown = true;
  await openEditor(page, mock);
  await page.getByRole('button', { name: 'Compile ฉบับร่าง' }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: /ยืนยัน publish version 1/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'ยืนยัน Publish' }).click();
  await expect(page.getByText('ยังไม่ทราบผล publish')).toBeVisible();
  await expect(page.getByText('Publish version 1 สำเร็จ')).toHaveCount(0);

  await page.getByRole('button', { name: 'ตรวจผล publish' }).click();
  await expect(page.getByText('Publish version 1 สำเร็จ')).toBeVisible();
  const publish = mock.requests.filter((request) =>
    new URL(request.url()).pathname.endsWith('/publish'),
  );
  const resolution = mock.requests.find((request) =>
    request.url().endsWith('/publish-resolution'),
  )!;
  expect(publish).toHaveLength(1);
  expect(resolution.postDataJSON()).toEqual({
    originalIdempotencyKey: publish[0]!.headers()['idempotency-key'],
  });
});

test('templates: instantiate ด้วย version+digest ที่เห็น แล้ว upgrade ต้องเลือก resolution ก่อน apply', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await mock.install(page);
  await page.goto('/?view=journeys');
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'payment-reminder' }).click();
  const form = page.getByRole('form', { name: 'สร้าง Journey จาก payment-reminder' });
  await form.getByLabel('ชื่อ Journey').fill('เตือนชำระ Q4');
  await form.getByLabel('ทีมเจ้าของ (team ID)').fill('team-synthetic');
  await form.getByLabel('reminderContent *').fill('content-q4');
  await form.getByRole('button', { name: 'สร้าง Journey จาก template' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'เตือนชำระ Q4' })).toBeVisible();
  const instantiate = mock.requests.find((request) => request.url().endsWith('/instantiate'))!;
  expect(instantiate.postDataJSON()).toEqual({
    expectedContentDigest: DIGEST('c'),
    bindings: { reminderContent: 'content-q4' },
    targetOwnerTeamId: 'team-synthetic',
    name: 'เตือนชำระ Q4',
  });
  // ค่า parameter ไม่ถูกเก็บลง storage ของ browser
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage })),
  ).not.toContain('content-q4');

  await expect(page.getByText('มี template version 2')).toBeVisible();
  await page.getByRole('button', { name: 'ตรวจการ upgrade' }).click();
  const apply = page.getByRole('button', { name: 'ปรับฉบับร่างตาม proposal' });
  await expect(apply).toBeDisabled();
  await page.getByLabel('ใช้ของ template').check();
  await apply.click();
  await expect(
    page.getByText('ปรับเป็น template version 2 ในฉบับร่างแล้ว ยังไม่ publish'),
  ).toBeVisible();
  const upgrade = mock.requests.find((request) => request.url().endsWith('/template-upgrades'))!;
  expect(upgrade.postDataJSON()).toMatchObject({
    targetVersion: 2,
    proposalDigest: DIGEST('7'),
    conflictDigest: DIGEST('8'),
    resolutions: { c1: 'TAKE_TEMPLATE' },
  });
});

test('960px แก้ได้เต็ม; 959px อ่านอย่างเดียวและไม่ส่ง mutation', async ({ page }) => {
  const mock = new AuthoringMock();
  await page.setViewportSize({ width: 960, height: 900 });
  await openEditor(page, mock);
  await expect(page.getByRole('button', { name: 'บันทึกฉบับร่าง' })).toBeVisible();

  await page.setViewportSize({ width: 959, height: 900 });
  await expect(page.getByRole('note').filter({ hasText: 'อ่านอย่างเดียว' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกฉบับร่าง' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^ลบ / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  const canvas = page.getByRole('group', { name: 'ผังขั้นตอนของ Journey' });
  await canvas.getByRole('button', { name: 'ส่งข้อความ' }).focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(canvas.getByRole('button', { name: 'ส่งข้อความ' })).toBeVisible();
  await expect(page.getByText('มีการแก้ไขที่ยังไม่บันทึก')).toHaveCount(0);
  await page.goto('/?view=journeys');
  await expect(page.getByRole('heading', { name: 'สร้าง Journey เปล่า' })).toHaveCount(0);
  expect(mock.mutations()).toHaveLength(0);
});

test('a11y: editor ไม่มี serious/critical, 200% zoom ไม่ล้นแนวนอน และ reduced motion ปิด transition', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await openEditor(page, mock);
  await expectNoSeriousA11yViolations(page);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const transition = await page
    .getByRole('group', { name: 'ผังขั้นตอนของ Journey' })
    .getByRole('button', { name: 'ส่งข้อความ' })
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(transition.split(',').every((value) => parseFloat(value) === 0)).toBe(true);

  // 200% zoom ของจอ 1280px = viewport 640 CSS px
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(page.getByRole('note').filter({ hasText: 'อ่านอย่างเดียว' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page);
});

test('U1.3 reviewer หา candidate ที่รอตรวจจากรายการ เปิดดู exact candidate แล้วอนุมัติ และดู audit ได้', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  mock.persona = 'reviewer';
  mock.journeys.get(JOURNEY_ID)!.review = {
    reviewId: REVIEW_ID,
    state: 'IN_REVIEW',
    draftRevision: 1,
    draftDigest: DIGEST('1'),
    compileDigest: DIGEST('a'),
    submittedAt: '2026-09-22T01:00:00.000Z',
    makerIsCaller: false,
  };
  await mock.install(page);
  await page.goto('/?view=journeys');

  // รายการบอก review state จาก server; ตัวกรอง "รอตรวจ" แสดงงานที่ reviewer ตัดสินได้
  await expect(page.getByRole('cell', { name: 'รอตรวจ' })).toBeVisible();
  await page.getByRole('button', { name: 'รอตรวจ' }).click();
  await expect(page.getByRole('button', { name: 'รอตรวจ' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('heading', { level: 2, name: 'งานที่รอให้คุณตรวจ' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'ติดตามการชำระ' }).click();

  // reviewer เห็น exact candidate และปุ่มตัดสิน แต่ไม่มีปุ่มส่งตรวจ (ไม่มี journey.edit)
  const candidate = page.getByRole('definition').filter({ hasText: DIGEST('a').slice(0, 12) });
  await expect(candidate).toBeVisible();
  await expect(page.getByRole('button', { name: 'ส่งตรวจ' })).toHaveCount(0);
  await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason code').fill('LOOKS_GOOD');
  await dialog.getByLabel('Evidence reference').fill('uat-431');
  await dialog.getByRole('button', { name: 'อนุมัติ' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'สถานะการตรวจ: APPROVED' }),
  ).toBeVisible();
  const decision = mock.requests.find((request) =>
    new URL(request.url()).pathname.endsWith(`/reviews/${REVIEW_ID}/decisions`),
  );
  expect(decision?.postDataJSON()).toMatchObject({ decision: 'APPROVE', reasonCode: 'LOOKS_GOOD' });

  // audit โหลดเมื่อกดเท่านั้น (การอ่าน audit ถูกบันทึกเป็น audit เอง)
  expect(mock.requests.some((request) => request.url().endsWith('/audit'))).toBe(false);
  await page.getByRole('button', { name: 'แสดงประวัติ' }).click();
  const timeline = page.getByRole('list', { name: 'ประวัติการเปลี่ยนแปลง ใหม่สุดก่อน' });
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
  await expect(timeline).toContainText('REVIEW_APPROVED');
  await expect(timeline).toContainText('corr-synthetic-1');
  await expectNoSeriousA11yViolations(page);
});

test('U1.3 ผู้ส่งตรวจเห็นเหตุผลว่าต้องใช้ reviewer คนอื่น และไม่มีปุ่มตัดสิน', async ({ page }) => {
  const mock = new AuthoringMock();
  mock.journeys.get(JOURNEY_ID)!.review = {
    reviewId: REVIEW_ID,
    state: 'IN_REVIEW',
    draftRevision: 1,
    draftDigest: DIGEST('1'),
    compileDigest: DIGEST('a'),
    submittedAt: '2026-09-22T01:00:00.000Z',
    makerIsCaller: true,
  };
  await openEditor(page, mock);
  await expect(page.getByRole('note').filter({ hasText: 'ต้องให้ reviewer คนอื่น' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'อนุมัติ', exact: true })).toHaveCount(0);
});

// ── D1.14 (#453): หน้า Journeys บน shell/i18n/component ใหม่ ────────────────────────────────

function shellNavigation(shellV2: boolean) {
  return {
    groups: [
      { id: 'live', labelKey: 'navigation.groups.live' },
      { id: 'automation', labelKey: 'navigation.groups.automation' },
    ],
    apps: [
      {
        id: 'agent-workspace',
        groupId: 'live',
        labelKey: 'navigation.apps.agentWorkspace',
        hostApp: 'workspace',
        path: '/',
      },
      {
        id: 'journeys',
        groupId: 'automation',
        labelKey: 'navigation.apps.journeys',
        hostApp: 'console',
        path: '/?view=journeys',
      },
    ],
    pins: { appIds: ['agent-workspace', 'journeys'], source: 'SYSTEM', revision: 0 },
    limits: { maxPins: 15 },
    features: { shellV2 },
  };
}

async function withShell(page: Page, shellV2: boolean) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: shellNavigation(shellV2) }),
  );
}

test.describe('D1.14 ภาษาอังกฤษ', () => {
  test.use({ locale: 'en-US' });

  test('ข้อความทั้งหน้าเป็นภาษาอังกฤษจาก catalog และ axe ไม่มี serious/critical ทั้งรายการและ editor', async ({
    page,
  }) => {
    const mock = new AuthoringMock();
    await mock.install(page);
    await page.goto('/?view=journeys');
    await expect(page.getByRole('heading', { name: 'Journeys you can see' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create draft' })).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    await page.goto(`/?view=journeys&journey=${JOURNEY_ID}`);
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Structure' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Journey step diagram' })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});

test('flag ui.shell.v2 เปิด: Journeys อยู่ใน AppShell โดยไม่มี chrome เดิมซ้ำ และ axe ผ่านทั้ง TH/EN', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await withShell(page, true);
  await openEditor(page, mock);

  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByText('D-CONTACT', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'ข้ามไปที่เนื้อหา' })).toHaveCount(1);
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

// D1.16 (#455): visual evidence ของ Phase Contract (#428) — รันเมื่อขอเท่านั้น
// `D1_VISUAL_EVIDENCE_DIR=<dir> pnpm --filter @d-contact/console exec playwright test -g "visual evidence"`
test('D1.16 visual evidence: Journeys TH/EN ใน shell และ App launcher', async ({ page }) => {
  const dir = process.env.D1_VISUAL_EVIDENCE_DIR;
  test.skip(!dir, 'ตั้ง D1_VISUAL_EVIDENCE_DIR เพื่อสร้างภาพหลักฐาน');
  await page.setViewportSize({ width: 1440, height: 900 });
  const mock = new AuthoringMock();
  await withShell(page, true);
  await mock.install(page);
  await page.goto('/?view=journeys&tenant=demo');
  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toBeVisible();
  await page.screenshot({ path: `${dir}/console-journeys-th.png` });
  await page.getByRole('button', { name: 'แอปทั้งหมด' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: `${dir}/app-launcher-th.png` });
  await page.keyboard.press('Escape');
  // e2e ไม่มี Keycloak เก็บ locale — โหลดหน้าใหม่แล้วกลับเป็นไทย จึงสลับภาษาบนหน้าที่เปิดอยู่
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Journeys you can see' })).toBeVisible();
  await page.screenshot({ path: `${dir}/console-journeys-en.png` });

  await page.goto(`/?view=journeys&tenant=demo&journey=${JOURNEY_ID}`);
  await expect(page.getByRole('button', { name: 'บันทึกฉบับร่าง' })).toBeVisible();
  await page.screenshot({ path: `${dir}/console-journey-editor-th.png` });
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
  await page.screenshot({ path: `${dir}/console-journey-editor-en.png` });
});

test('flag ปิด: Journeys ใช้ chrome เดิมของหน้า (skip link + header) บน component/token ใหม่', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await withShell(page, false);
  await openEditor(page, mock);
  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toHaveCount(0);
  await expect(page.getByText('D-CONTACT', { exact: true })).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);
  const brand = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--dc-brand-700').trim(),
  );
  expect(brand).toBe('#0f766e');
  await expectNoSeriousA11yViolations(page);
});

test('สลับภาษาระหว่างแก้ Journey: ข้อความเปลี่ยนทันที ไม่ reload และการแก้ที่ยังไม่บันทึกยังอยู่', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await withShell(page, true);
  await openEditor(page, mock);
  const origin = await page.evaluate(() => performance.timeOrigin);

  await page.getByRole('button', { name: 'เพิ่ม', exact: true }).last().click();
  await expect(page.getByText(/มีการแก้ไขที่ยังไม่บันทึก 1 รายการ/)).toBeVisible();

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByText(/1 unsaved change/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  await page.getByRole('button', { name: 'ไทย' }).click();
  await expect(page.getByText(/มีการแก้ไขที่ยังไม่บันทึก 1 รายการ/)).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
});

// ── U1.4 (#432): UAT run บน Journey Console ────────────────────────────────────────────────

const RUN_ID = '9c4d5e6f-7a8b-4c93-9dae-2f3a4b5c6d74';
const NEXT_RUN_ID = 'ad5e6f7a-8b9c-4da4-8ebf-3a4b5c6d7e85';
const UAT_STEPS = [
  {
    stepId: 'MAKER_EDIT',
    title: 'Maker แก้ฉบับร่าง',
    expected: 'บันทึกฉบับร่างได้ revision ใหม่',
    stateLabel: 'REAL_STATE',
  },
  {
    stepId: 'SIMULATE',
    title: 'จำลองการทำงาน',
    expected: 'ผลจำลองจบที่ EXIT',
    stateLabel: 'SIMULATION_ONLY',
  },
];
const UAT_FIXTURE = {
  fixtureId: 'uat-fixture-1',
  startAt: '2026-09-01T02:00:00.000Z',
  seed: 'seed-uat-1',
  context: { segment: 'synthetic-a', amountDue: 1200 },
};

/**
 * mock ของ `/api/v1/runtime-profile` (profile uat) และ `/api/v1/uat-runs/**` แบบมี state — ติดตั้งหลัง
 * `AuthoringMock` จึงชนะ route 404 ของ profile; ข้อมูล synthetic ทั้งหมด
 */
class UatMock {
  readonly requests: Request[] = [];
  run: Json | null;
  /** ครั้งถัดไปที่ `เริ่มรอบใหม่` ถูกปฏิเสธด้วย response นี้ */
  startFailure: { status: number; body: Json } | null = null;
  unauthorized = false;
  /** U1.5 (#433): metadata ของภาพหน้าจอที่ mock รับไว้ */
  evidence: Json[] = [];

  constructor(private readonly authoring: AuthoringMock) {
    this.run = this.makeRun(RUN_ID, 1, JOURNEY_ID);
  }

  makeRun(runId: string, sequence: number, journeyId: string): Json {
    return {
      runId,
      sequence,
      lifecycle: 'ACTIVE',
      revision: 1,
      journeyId,
      fixturePack: {
        environment: 'uat',
        packVersion: 'uat-pack-1',
        digest: DIGEST('5'),
        buildSha: 'abc1234def5678',
      },
      steps: UAT_STEPS,
      openedAt: '2026-09-22T00:00:00.000Z',
      closedAt: null,
      stepResults: [],
    };
  }

  async install(page: Page) {
    await page.route('**/api/v1/runtime-profile', (route) =>
      route.fulfill({
        status: 200,
        json: {
          profile: 'uat',
          kafka: 'DISABLED',
          lineWebhook: 'DISABLED',
          providerEgress: 'DISABLED',
          journeyRuntime: 'NOT_DEPLOYED',
          unilateralPublish: 'NOT_EXPOSED',
          blockedRequests: 0,
          journeyAuthoring: { canvasWrite: true, publishUi: true },
        },
      }),
    );
    await page.route('**/api/v1/uat-runs/**', async (route) => {
      const request = route.request();
      this.requests.push(request);
      const path = new URL(request.url()).pathname.replace('/api/v1/uat-runs', '');
      // ภาพหน้าจอเป็น raw body — parse JSON เฉพาะ request ที่เป็น JSON
      const isJson = (request.headers()['content-type'] ?? '').startsWith('application/json');
      const body = ((isJson ? request.postDataJSON() : null) ?? {}) as Json;
      const reply = (status: number, payload: unknown) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
      if (this.unauthorized) return reply(401, { message: 'Unauthorized' });
      if (request.method() === 'GET' && path === '/current') {
        return this.run ? reply(200, this.run) : reply(404, { code: 'UAT_RUN_NOT_FOUND' });
      }
      if (request.method() === 'GET' && path === '/current/simulation-fixture') {
        return this.run
          ? reply(200, { runId: this.run.runId, fixture: UAT_FIXTURE })
          : reply(404, { code: 'UAT_RUN_NOT_FOUND' });
      }
      if (request.method() === 'POST' && path === '/start') {
        if (this.startFailure) {
          const failure = this.startFailure;
          this.startFailure = null;
          return reply(failure.status, failure.body);
        }
        if (body.expectedRevision !== ((this.run?.revision as number | undefined) ?? 0)) {
          return reply(409, { code: 'REVISION_CONFLICT' });
        }
        this.authoring.journeys.set(NEW_JOURNEY_ID, {
          headVersion: 1,
          revision: 1,
          document: authoringDocument('Journey รอบที่ 2'),
          lifecycle: 'DRAFT_ONLY',
          activeVersion: null,
          review: null,
          notices: [],
        });
        this.run = this.makeRun(
          NEXT_RUN_ID,
          ((this.run?.sequence as number) ?? 0) + 1,
          NEW_JOURNEY_ID,
        );
        return reply(200, this.run);
      }
      const record = /^\/([^/]+)\/step-results$/.exec(path);
      if (request.method() === 'POST' && record && this.run?.runId === record[1]) {
        const step = UAT_STEPS.find((entry) => entry.stepId === body.stepId);
        if (!step || (body.outcome === 'FAIL') !== (body.severity !== undefined)) {
          return reply(400, { code: 'VALIDATION_FAILED', safeParams: { field: 'severity' } });
        }
        const result = {
          stepId: step.stepId,
          outcome: body.outcome,
          expected: step.expected,
          actual: body.actual,
          severity: body.severity ?? null,
          correlationId: body.correlationId ?? null,
          stateLabel: step.stateLabel,
          recordedByRef: '0a1b2c3d-0000-4000-8000-000000000001',
          recordedAt: '2026-09-22T03:00:00.000Z',
        };
        (this.run.stepResults as Json[]).push(result);
        return reply(200, result);
      }
      const evidence = /^\/([^/]+)\/evidence$/.exec(path);
      if (evidence && this.run?.runId === evidence[1]) {
        if (request.method() === 'GET') {
          return reply(200, { runId: this.run.runId, items: this.evidence });
        }
        // server จริงตรวจ content type แล้วตรวจ magic bytes ซ้ำ — mock ทำตามขั้นเดียวกันแบบย่อ
        const type = request.headers()['content-type'];
        const bytes = request.postDataBuffer();
        if (type !== 'image/png' && type !== 'image/jpeg') {
          return reply(415, {
            code: 'EVIDENCE_TYPE_REJECTED',
            safeParams: { reason: 'CONTENT_TYPE' },
          });
        }
        if (!bytes || bytes[0] !== 0x89) {
          return reply(415, { code: 'EVIDENCE_TYPE_REJECTED', safeParams: { detected: 'ZIP' } });
        }
        const item = {
          evidenceId: `0e1f2a3b-4c5d-4e6f-8a7b-${String(this.evidence.length + 1).padStart(12, '0')}`,
          stepId: request.headers()['x-uat-step-id'],
          sha256: DIGEST('7'),
          sizeBytes: bytes.length,
          contentType: type,
          recordedByRef: '0a1b2c3d-0000-4000-8000-000000000001',
          recordedAt: '2026-09-22T04:00:00.000Z',
        };
        this.evidence.push(item);
        return reply(200, item);
      }
      if (request.method() === 'GET' && path === `/${this.run?.runId}/bundle`) {
        return reply(200, this.bundle());
      }
      return reply(400, { code: 'REQUEST_MALFORMED' });
    });
  }

  bundle(): Json {
    return {
      schema: 'UatEvidenceBundleV1',
      manifest: { runId: this.run?.runId, sequence: this.run?.sequence },
      stepResults: this.run?.stepResults ?? [],
      screenshots: this.evidence,
      scan: { status: 'PASSED', severity: null, findings: [] },
      verdict: 'INCOMPLETE',
      digest: DIGEST('9'),
    };
  }

  posts(suffix: string) {
    return this.requests.filter(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith(suffix),
    );
  }
}

async function openUat(page: Page, query = '') {
  const authoring = new AuthoringMock();
  const uat = new UatMock(authoring);
  await authoring.install(page);
  await uat.install(page);
  await page.goto(`/?view=journeys${query}`);
  const panel = page.getByRole('region', { name: 'รอบทดสอบ UAT' });
  await expect(panel).toBeVisible();
  return { authoring, uat, panel };
}

/** URL มีแค่ view/tenant/journey (opaque id) — ไม่มี token หรือค่าที่ผู้ทดสอบกรอก */
function expectOpaqueUrl(page: Page) {
  const url = new URL(page.url());
  expect(
    [...url.searchParams.keys()].every((key) => ['view', 'tenant', 'journey'].includes(key)),
  ).toBe(true);
  expect(page.url()).not.toMatch(/token|bearer|eyJ|@/i);
}

test('U1.4 UAT: badge/ขอบเขต + ข้อมูล run จาก server, บันทึก PASS และ FAIL พร้อม severity; axe ผ่าน', async ({
  page,
}) => {
  const { uat, panel } = await openUat(page);
  await expect(panel.getByText('UAT / จำลอง (simulated)')).toBeVisible();
  await expect(panel.getByRole('note').filter({ hasText: 'ข้อมูลสังเคราะห์' })).toBeVisible();
  const facts = panel.getByRole('definition');
  await expect(facts.filter({ hasText: 'รอบที่ 1' })).toBeVisible();
  await expect(facts.filter({ hasText: RUN_ID.slice(0, 8) })).toBeVisible();
  await expect(facts.filter({ hasText: 'uat-pack-1' })).toContainText(DIGEST('5').slice(0, 12));
  await expect(facts.filter({ hasText: 'abc1234def56' })).toBeVisible();
  await expect(panel.getByText('ยังไม่มีผลที่บันทึกในรอบนี้')).toBeVisible();

  // PASS: expected มาจาก step catalog ของ server
  await expect(
    panel.getByRole('definition').filter({ hasText: 'บันทึกฉบับร่างได้ revision ใหม่' }),
  ).toBeVisible();
  const record = panel.getByRole('button', { name: 'บันทึกผล', exact: true });
  await expect(record).toBeDisabled();
  await panel.getByLabel('สิ่งที่เกิดขึ้นจริง').fill('บันทึกได้ revision 2');
  await panel.getByLabel('Correlation ID (ถ้ามี)').fill('corr-uat-1');
  await record.click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'บันทึกผลของ MAKER_EDIT แล้ว' }),
  ).toBeVisible();

  // FAIL: ต้องเลือก severity ก่อนส่ง
  await panel.getByLabel('ขั้นตอนที่ทดสอบ').selectOption('SIMULATE');
  await panel.getByLabel('ไม่ผ่าน (FAIL)').check();
  await panel.getByLabel('สิ่งที่เกิดขึ้นจริง').fill('จบที่ MAX_DURATION');
  await expect(record).toBeDisabled();
  await panel.getByLabel('ความรุนแรง (ต้องระบุเมื่อไม่ผ่าน)').selectOption('S2');
  await record.click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'บันทึกผลของ SIMULATE แล้ว' }),
  ).toBeVisible();

  const rows = panel.getByRole('table').getByRole('row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText('ผ่าน (PASS)');
  await expect(rows.nth(1)).toContainText('REAL_STATE');
  await expect(rows.nth(2)).toContainText('ไม่ผ่าน (FAIL)');
  await expect(rows.nth(2)).toContainText('S2');
  await expect(rows.nth(2)).toContainText('SIMULATION_ONLY');

  const posts = uat.posts('/step-results');
  expect(posts.map((request) => request.postDataJSON())).toEqual([
    {
      stepId: 'MAKER_EDIT',
      outcome: 'PASS',
      actual: 'บันทึกได้ revision 2',
      correlationId: 'corr-uat-1',
    },
    { stepId: 'SIMULATE', outcome: 'FAIL', actual: 'จบที่ MAX_DURATION', severity: 'S2' },
  ]);
  const keys = posts.map((request) => request.headers()['idempotency-key']);
  expect(keys.every((key) => /^uat-step-/.test(key ?? ''))).toBe(true);
  expect(new Set(keys).size).toBe(2);
  expect(new URL(posts[0]!.url()).pathname).toBe(`/api/v1/uat-runs/${RUN_ID}/step-results`);
  expectOpaqueUrl(page);
  await expectNoSeriousA11yViolations(page);
});

test('U1.4 เริ่มรอบใหม่: confirm แล้วเห็นรอบใหม่และไปที่ Journey ใหม่; 409 PENDING_REVIEW บอกทางไปต่อ', async ({
  page,
}) => {
  const { uat, panel } = await openUat(page);
  await panel.getByRole('button', { name: 'เริ่มรอบใหม่' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'ยืนยันเริ่มรอบใหม่' });
  await expect(confirm).toContainText('รอบที่ 1 จะถูกปิด');
  await expect(confirm).toContainText('ABANDONED');
  await expect(confirm.getByLabel('Environment ของ fixture pack')).toHaveValue('uat');
  await expect(confirm.getByLabel('Version ของ fixture pack')).toHaveValue('uat-pack-1');
  await expectNoSeriousA11yViolations(page);
  await confirm.getByRole('button', { name: 'เริ่มรอบใหม่' }).click();

  await expect(panel.getByRole('definition').filter({ hasText: 'รอบที่ 2' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Journey รอบที่ 2' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Journey รอบที่ 2' })).toBeFocused();
  expect(new URL(page.url()).searchParams.get('journey')).toBe(NEW_JOURNEY_ID);
  const [start] = uat.posts('/start');
  expect(start!.postDataJSON()).toEqual({
    environment: 'uat',
    packVersion: 'uat-pack-1',
    expectedRevision: 1,
  });
  expect(start!.headers()['idempotency-key']).toMatch(/^uat-start-/);

  // run เดิมยังมีงานรอตรวจ: server ปฏิเสธและบอก next safe action
  uat.startFailure = {
    status: 409,
    body: { code: 'UAT_RUN_PENDING_REVIEW', safeParams: { nextSafeAction: 'DECIDE_REVIEW' } },
  };
  await panel.getByRole('button', { name: 'เริ่มรอบใหม่' }).click();
  await page
    .getByRole('alertdialog', { name: 'ยืนยันเริ่มรอบใหม่' })
    .getByRole('button', { name: 'เริ่มรอบใหม่' })
    .click();
  const alert = panel.getByRole('alert').filter({ hasText: 'ยังมีงานรอตรวจ' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('ให้ reviewer ตัดสินงานที่รอตรวจ');
  await expect(alert.getByRole('button', { name: 'เปิด Journey ของรอบนี้' })).toBeVisible();
  // ไม่อนุมานว่ารอบใหม่เริ่มแล้ว — ยังเป็นรอบที่ 2 ตาม server
  await expect(panel.getByRole('definition').filter({ hasText: 'รอบที่ 2' })).toBeVisible();
  await expect(panel.getByRole('definition').filter({ hasText: 'รอบที่ 3' })).toHaveCount(0);
  expectOpaqueUrl(page);
});

test('U1.4 simulation ใน UAT ใช้ fixture ของ server ตรงตัว และแสดง SIMULATION_ONLY กับเวลาเสมือน', async ({
  page,
}) => {
  const { authoring } = await openUat(page, `&journey=${JOURNEY_ID}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // ไม่มีช่อง JSON context ที่ browser สร้างเองใน UAT
  await expect(page.getByLabel('Context สังเคราะห์สำหรับ simulation (JSON)')).toHaveCount(0);
  const fixture = page.getByRole('definition').filter({ hasText: 'uat-fixture-1' });
  await expect(fixture).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: 'seed-uat-1' })).toBeVisible();

  await page.getByRole('button', { name: 'Compile ฉบับร่าง' }).click();
  await page.getByRole('button', { name: 'จำลองการทำงาน' }).click();
  const result = page.locator('.j5-simulation');
  await expect(result).toContainText('SIMULATION_ONLY');
  await expect(result).toContainText('เวลาเสมือน');
  await expect(result).toContainText('ไม่ใช่เวลาจริงใน audit');
  await expect(result.locator('time').first()).toHaveAttribute('datetime', UAT_FIXTURE.startAt);

  const simulation = authoring.requests.find((request) => request.url().endsWith('/simulations'))!;
  expect((simulation.postDataJSON() as Json).fixture).toEqual(UAT_FIXTURE);
});

test('U1.4 deep link/refresh/Back/Forward ไม่ตัน, focus ไป heading และการแก้ที่ยังไม่บันทึกไม่หาย', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await mock.install(page);
  await page.goto('/?view=journeys');
  await expect(page.getByRole('heading', { level: 1, name: 'Journey authoring' })).toBeVisible();
  // ไม่ใช่ UAT (profile 404): ไม่มี UI ของ UAT เลย
  await expect(page.getByRole('region', { name: 'รอบทดสอบ UAT' })).toHaveCount(0);
  await expect(page.getByText('UAT / จำลอง (simulated)')).toHaveCount(0);

  await page.getByRole('button', { name: 'ติดตามการชำระ' }).click();
  const editorHeading = page.getByRole('heading', { level: 1, name: 'ติดตามการชำระ' });
  await expect(editorHeading).toBeFocused();
  expect(new URL(page.url()).searchParams.get('journey')).toBe(JOURNEY_ID);
  const name = page.getByLabel('ชื่อ Journey');
  await name.fill('ชื่อที่ยังไม่บันทึก');
  await name.press('Enter');

  await page.goBack();
  const listHeading = page.getByRole('heading', { level: 1, name: 'Journey authoring' });
  await expect(listHeading).toBeFocused();
  expect(new URL(page.url()).searchParams.has('journey')).toBe(false);

  await page.goForward();
  await expect(editorHeading).toBeFocused();
  await expect(
    page.getByRole('alert').filter({ hasText: 'พบการแก้ไขที่ยังไม่บันทึก' }),
  ).toBeVisible();

  // refresh บน deep link เปิด Journey เดิมและยังกู้การแก้ได้
  await page.reload();
  await expect(
    page.getByRole('alert').filter({ hasText: 'พบการแก้ไขที่ยังไม่บันทึก' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'กู้คืนการแก้ไข' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ชื่อที่ยังไม่บันทึก' })).toBeVisible();
  expect(page.url()).not.toContain(encodeURIComponent('ชื่อที่ยังไม่บันทึก'));
  expectOpaqueUrl(page);

  await page.getByRole('button', { name: '← รายการ Journey' }).click();
  await expect(listHeading).toBeFocused();
  // ออกจาก editor ด้วยปุ่มกลับแล้ว Back: การแก้ยังอยู่ใน session recovery ให้กู้ได้อีก
  await page.goBack();
  await expect(
    page.getByRole('alert').filter({ hasText: 'พบการแก้ไขที่ยังไม่บันทึก' }),
  ).toBeVisible();
  expect(mock.mutations()).toHaveLength(0);
});

test('U1.4 session หมด (401) ที่ UAT API แสดงทางเข้าสู่ระบบใหม่ ไม่ตัน', async ({ page }) => {
  const authoring = new AuthoringMock();
  const uat = new UatMock(authoring);
  uat.unauthorized = true;
  await authoring.install(page);
  await uat.install(page);
  await page.goto('/?view=journeys');
  const panel = page.getByRole('region', { name: 'รอบทดสอบ UAT' });
  const alert = panel.getByRole('alert').filter({ hasText: 'Session หมดอายุ' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('เข้าสู่ระบบอีกครั้ง');
  await expect(alert.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'เริ่มรอบใหม่' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
});

test('U1.4 959px: แผง UAT อ่านอย่างเดียว ไม่มีปุ่มบันทึกผล/เริ่มรอบใหม่ และไม่ส่ง mutation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 959, height: 900 });
  const { uat, panel } = await openUat(page);
  await expect(panel.getByText('UAT / จำลอง (simulated)')).toBeVisible();
  await expect(panel.getByRole('definition').filter({ hasText: 'รอบที่ 1' })).toBeVisible();
  await expect(
    panel.getByRole('note').filter({ hasText: 'ดูรอบทดสอบได้อย่างเดียว' }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'บันทึกผล', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'เริ่มรอบใหม่' })).toHaveCount(0);
  await expect(panel.getByLabel('สิ่งที่เกิดขึ้นจริง')).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(uat.requests.filter((request) => request.method() !== 'GET')).toHaveLength(0);
  await expectNoSeriousA11yViolations(page);
});

test('U1.4 แผง UAT อยู่ในเนื้อหาหน้า: เห็นเหมือนกันทั้ง flag ui.shell.v2 เปิดและปิด', async ({
  page,
}) => {
  for (const shellV2 of [true, false]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await withShell(page, shellV2);
    await openUat(page);
    await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toHaveCount(shellV2 ? 1 : 0);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('main').getByText('UAT / จำลอง (simulated)')).toBeVisible();
  }
});

// ── U1.5 (#433): ภาพหน้าจอหลักฐานและ evidence bundle ───────────────────────────────────────

/** PNG signature + IHDR ขั้นต่ำ — mock ตรวจแค่ magic bytes */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test('U1.5 แนบภาพหน้าจอ, เห็น digest, trace ถูกปฏิเสธพร้อมทางไปต่อ และส่งออก bundle ผ่าน Blob', async ({
  page,
}) => {
  const { uat, panel } = await openUat(page);
  const evidence = panel.getByRole('region', { name: 'ภาพหน้าจอหลักฐาน' });
  await expect(evidence.getByText('ยังไม่มีภาพหน้าจอในรอบนี้')).toBeVisible();
  const file = evidence.getByLabel('ไฟล์ภาพหน้าจอ');
  await expect(file).toHaveAttribute('accept', 'image/png,image/jpeg');
  const upload = evidence.getByRole('button', { name: 'อัปโหลดภาพหน้าจอ' });
  await expect(upload).toBeDisabled();

  await evidence.getByLabel('ขั้นตอนของภาพหน้าจอ').selectOption('SIMULATE');
  await file.setInputFiles({ name: 'simulate.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await upload.click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'แนบภาพหน้าจอของ SIMULATE แล้ว' }),
  ).toBeVisible();
  const row = evidence.getByRole('table').getByRole('row').nth(1);
  await expect(row).toContainText('SIMULATE');
  await expect(row).toContainText(DIGEST('7').slice(0, 12));
  await expect(row).toContainText('image/png');

  // Playwright trace (zip) ถูก server ปฏิเสธ — แสดงเหตุผลและทางไปต่อ ไม่มีอะไรถูกเพิ่ม
  await file.setInputFiles({
    name: 'trace.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('PK\u0003\u0004trace', 'latin1'),
  });
  await upload.click();
  const alert = panel.getByRole('alert');
  await expect(alert).toContainText('รับเฉพาะภาพหน้าจอ PNG/JPEG');
  await expect(alert).toContainText('เลือกไฟล์ภาพหน้าจอ PNG หรือ JPEG');
  await expect(evidence.getByRole('table').getByRole('row')).toHaveCount(2);

  const posts = uat.posts('/evidence');
  expect(posts).toHaveLength(2);
  const [accepted, rejected] = posts;
  expect(new URL(accepted!.url()).pathname).toBe(`/api/v1/uat-runs/${RUN_ID}/evidence`);
  expect(accepted!.headers()['content-type']).toBe('image/png');
  expect(accepted!.headers()['x-uat-step-id']).toBe('SIMULATE');
  expect(accepted!.headers()['authorization']).toMatch(/^Bearer /);
  expect(accepted!.headers()['idempotency-key']).toMatch(/^uat-evidence-/);
  expect(rejected!.headers()['content-type']).toBe('application/zip');
  expect(rejected!.headers()['idempotency-key']).not.toBe(accepted!.headers()['idempotency-key']);

  // ส่งออก bundle: fetch พร้อม bearer header แล้วดาวน์โหลดจาก Blob — ไม่มี token ใน URL
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    evidence.getByRole('button', { name: 'ส่งออก evidence bundle' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('uat-run-1-evidence-bundle.json');
  expect(download.url()).toMatch(/^blob:/);
  const exported = JSON.parse(readFileSync((await download.path())!, 'utf8')) as Json;
  expect(exported).toEqual(uat.bundle());
  const bundleRequest = uat.requests.find((request) =>
    new URL(request.url()).pathname.endsWith('/bundle'),
  );
  expect(bundleRequest!.headers()['authorization']).toMatch(/^Bearer /);
  for (const request of uat.requests) expect(request.url()).not.toMatch(/token|bearer|eyJ/i);
  const summary = evidence.getByRole('definition');
  await expect(summary.filter({ hasText: 'ยังไม่ครบ (INCOMPLETE)' })).toBeVisible();
  await expect(summary.filter({ hasText: 'ไม่พบข้อมูลต้องห้าม' })).toBeVisible();
  await expect(summary.filter({ hasText: DIGEST('9').slice(0, 12) })).toBeVisible();
  expectOpaqueUrl(page);
  await expectNoSeriousA11yViolations(page);
});
