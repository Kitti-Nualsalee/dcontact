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
    await page.route('**/api/v1/journey-authoring/**', async (route) => {
      const request = route.request();
      this.requests.push(request);
      const path = new URL(request.url()).pathname.replace('/api/v1/journey-authoring', '');
      const body = (request.postDataJSON() ?? {}) as Json;
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
