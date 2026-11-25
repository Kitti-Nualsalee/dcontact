/** #971: all three quality evaluation pages with a mock API (verifies UI only; permission/DB are checked in the API integration) */
import { expect, test, type Page, type Request } from '@playwright/test';
test.use({ locale: 'th-TH' });

const INTERACTION = '0b7f8f0e-6a4f-4a7e-9a3e-0f5d6f2a9c11';
const EVALUATION = '3c2d1b0a-9f8e-4d7c-8b6a-5e4f3d2c1b0a';
const FORM = '6f1e2d3c-4b5a-4978-8a6b-7c8d9e0f1a2b';
const VERSION = '7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

const definition = {
  scoreMethod: 'WEIGHTED_POINTS',
  requireCommentBelow: 60,
  sections: [
    {
      id: 's1',
      name: 'การเปิดสาย',
      weight: 20,
      questions: [
        { id: 'greet', type: 'YES_NO', text: 'กล่าวชื่อบริษัทและชื่อตัวเอง', points: 10 },
        { id: 'verify', type: 'YES_NO', text: 'ยืนยันตัวตนลูกค้า', points: 10, autoFail: true },
      ],
    },
    {
      id: 's2',
      name: 'การแก้ปัญหา',
      weight: 80,
      questions: [
        { id: 'tone', type: 'SCALE', text: 'น้ำเสียง', points: 10, scale: [1, 5], allowNa: true },
        { id: 'note', type: 'TEXT', text: 'สิ่งที่ทำได้ดี' },
      ],
    },
  ],
};

const interaction = {
  interactionId: INTERACTION,
  agentId: 'agent-1',
  agentName: 'สมหญิง ใจดี',
  queueName: 'Support',
  channel: 'VOICE',
  acceptedAt: '2026-11-20T03:00:00.000Z',
  endedAt: '2026-11-20T03:05:00.000Z',
  hasRecording: true,
};

type Json = Record<string, any>;

interface State {
  evaluation: Json | null;
  saves: Json[];
  publishes: Json[];
  /** answer the next PUT with an error */
  nextSaveFailure?: { status: number; json: Json };
}

function evaluationOf(state: State, body: Json, status: 'DRAFT' | 'PUBLISHED'): Json {
  const answers = body.answers as Json;
  const complete = ['greet', 'verify', 'tone'].every((id) => answers[id] !== undefined);
  return {
    evaluationId: EVALUATION,
    interactionId: INTERACTION,
    agentId: 'agent-1',
    evaluatorName: 'Supervisor A',
    status,
    revision: (state.evaluation?.revision ?? 0) + 1,
    formVersionId: VERSION,
    form: { formId: FORM, formName: 'แบบประเมินสายเข้า', version: 1, definition },
    answers,
    comment: body.comment || null,
    progress: {
      answered: ['greet', 'verify', 'tone'].filter((id) => answers[id] !== undefined).length,
      required: 3,
    },
    score: complete
      ? {
          preview: status === 'DRAFT',
          rawScore: 70,
          finalScore: 0,
          autoFailed: true,
          sections: [
            { sectionId: 's1', score: 50 },
            { sectionId: 's2', score: 75 },
          ],
        }
      : null,
    publishedAt: status === 'PUBLISHED' ? '2026-11-21T02:00:00.000Z' : null,
    updatedAt: '2026-11-21T01:00:00.000Z',
  };
}

async function mockSupervisor(page: Page, state: State) {
  await page.route('**/api/v1/qm/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/qm', '');
    const method = request.method();
    if (method === 'GET' && path === '/team-interactions')
      return route.fulfill({
        json: {
          asOf: '2026-11-22T00:00:00.000Z',
          items: [
            {
              ...interaction,
              evaluation: state.evaluation
                ? {
                    evaluationId: EVALUATION,
                    status: state.evaluation.status,
                    finalScore: state.evaluation.status === 'PUBLISHED' ? 0 : null,
                  }
                : null,
            },
          ],
          nextCursor: null,
        },
      });
    if (method === 'GET' && path === '/forms')
      return route.fulfill({
        json: {
          items: [
            {
              formId: FORM,
              name: 'แบบประเมินสายเข้า',
              updatedAt: '2026-11-20T00:00:00.000Z',
              current: {
                versionId: VERSION,
                version: 1,
                publishedAt: '2026-11-20T00:00:00.000Z',
                questionCount: 4,
              },
            },
          ],
        },
      });
    if (method === 'GET' && path === `/form-versions/${VERSION}`)
      return route.fulfill({
        json: {
          versionId: VERSION,
          formId: FORM,
          formName: 'แบบประเมินสายเข้า',
          version: 1,
          definition,
        },
      });
    const base = `/interactions/${INTERACTION}/human-evaluation`;
    if (method === 'GET' && path === base)
      return route.fulfill({ json: { interaction, evaluation: state.evaluation } });
    if (method === 'PUT' && path === base) {
      const body = request.postDataJSON() as Json;
      state.saves.push({ ...body, authorization: request.headers().authorization });
      if (state.nextSaveFailure) {
        const failure = state.nextSaveFailure;
        state.nextSaveFailure = undefined;
        return route.fulfill(failure);
      }
      state.evaluation = evaluationOf(state, body, 'DRAFT');
      return route.fulfill({ json: { interaction, evaluation: state.evaluation } });
    }
    if (method === 'POST' && path === `${base}/publish`) {
      const body = request.postDataJSON() as Json;
      state.publishes.push(body);
      state.evaluation = evaluationOf(
        state,
        { answers: state.evaluation!.answers, comment: state.evaluation!.comment },
        'PUBLISHED',
      );
      return route.fulfill({ json: { interaction, evaluation: state.evaluation } });
    }
    return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });
}

test('a Supervisor picks a form, saves a draft, answers everything, then publishes the team call evaluation', async ({
  page,
}) => {
  const state: State = { evaluation: null, saves: [], publishes: [] };
  await mockSupervisor(page, state);
  await page.goto('/?view=team-evaluations&tenant=demo');

  await expect(
    page.getByRole('heading', { name: 'ประเมินคุณภาพสายของทีม', level: 1 }),
  ).toBeVisible();
  const grid = page.getByRole('grid', { name: 'รายการสายของทีม' });
  await expect(grid).toContainText('สมหญิง ใจดี');
  await expect(grid).toContainText('ยังไม่ประเมิน');
  await grid.getByRole('button', { name: /^ประเมินสายของ สมหญิง ใจดี/ }).click();

  await expect(
    page.getByRole('heading', { name: 'ประเมินสายของ สมหญิง ใจดี', level: 1 }),
  ).toBeFocused();
  await page.getByRole('button', { name: /ฟอร์มประเมิน/ }).click();
  await page.getByRole('option', { name: 'แบบประเมินสายเข้า (เวอร์ชัน 1)' }).click();

  const greet = page.getByRole('group', { name: 'กล่าวชื่อบริษัทและชื่อตัวเอง' });
  await greet.getByRole('radio', { name: 'ใช่', exact: true }).check();
  // incomplete answers cannot be published but the draft can be saved
  await expect(page.getByRole('button', { name: 'Publish ผลประเมิน' })).toBeDisabled();
  await expect(page.getByText('ตอบให้ครบอีก 2 ข้อจึง publish ได้')).toBeVisible();
  await page.getByRole('button', { name: 'บันทึกร่าง' }).click();
  // the harness has no navigation API, hence no shell toast: check the result on the page instead
  await expect(page.getByText('บันทึกล่าสุดโดย')).toBeVisible();
  expect(state.saves[0]).toMatchObject({
    formVersionId: VERSION,
    answers: { greet: { value: true } },
    comment: '',
  });
  expect(state.saves[0]!.revision).toBeUndefined();
  expect(state.saves[0]!.authorization).toMatch(/^Bearer /);

  await page
    .getByRole('group', { name: 'ยืนยันตัวตนลูกค้า' })
    .getByRole('radio', { name: 'ไม่ใช่' })
    .check();
  await page.getByRole('group', { name: 'น้ำเสียง' }).getByRole('radio', { name: '4' }).check();
  await page.getByRole('textbox', { name: 'ความเห็นถึง Agent' }).fill('ไม่ยืนยันตัวตน');
  await page.getByRole('button', { name: 'Publish ผลประเมิน' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Publish ผลประเมินสายของ สมหญิง ใจดี?' });
  await expect(dialog).toContainText('แก้ไขไม่ได้');
  await dialog.getByRole('button', { name: 'Publish' }).click();

  await expect(page.getByText('คะแนนสุดท้าย')).toBeVisible();
  // save the latest edits before publish with the draft's revision, then publish with the new revision
  expect(state.saves[1]).toMatchObject({
    revision: 1,
    answers: { greet: { value: true }, verify: { value: false }, tone: { value: 4 } },
    comment: 'ไม่ยืนยันตัวตน',
  });
  expect(state.publishes[0]).toMatchObject({ revision: 2 });
  expect(state.saves[0]!.commandId).not.toBe(state.saves[1]!.commandId);

  // focus goes to the heading after the Dialog closes, not to body
  await expect(
    page.getByRole('heading', { name: 'ประเมินสายของ สมหญิง ใจดี', level: 1 }),
  ).toBeFocused();
  // after publish it is read-only, with the score and the reasons for failing the criteria
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByText('คะแนนสุดท้าย')).toBeVisible();
  await expect(page.getByText('ตกเกณฑ์บังคับ')).toBeVisible();
  await expect(page.getByText('คะแนนก่อนตกเกณฑ์ 70%')).toBeVisible();

  await page.getByRole('button', { name: 'กลับไปรายการ' }).click();
  await expect(grid).toContainText('เผยแพร่แล้ว');
  await expect(grid.getByRole('button', { name: /^ดูผลประเมินสายของ สมหญิง ใจดี/ })).toBeFocused();
});

test('a save fails: the error is under the wrong item, answers are not lost, and a stale draft has a way to reload', async ({
  page,
}) => {
  const state: State = { evaluation: null, saves: [], publishes: [] };
  await mockSupervisor(page, state);
  await page.goto('/?view=team-evaluations&tenant=demo');
  await page.getByRole('button', { name: /^ประเมินสายของ สมหญิง ใจดี/ }).click();
  await page.getByRole('button', { name: /ฟอร์มประเมิน/ }).click();
  await page.getByRole('option', { name: 'แบบประเมินสายเข้า (เวอร์ชัน 1)' }).click();
  await page
    .getByRole('group', { name: 'กล่าวชื่อบริษัทและชื่อตัวเอง' })
    .getByRole('radio', { name: 'ใช่', exact: true })
    .check();

  state.nextSaveFailure = {
    status: 422,
    json: {
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'answers.greet', code: 'EXPECTED_BOOLEAN' }],
    },
  };
  await page.getByRole('button', { name: 'บันทึกร่าง' }).click();
  await expect(page.getByRole('alert')).toContainText('ตรวจข้อที่มีข้อความแจ้งเตือน');
  const greet = page.getByRole('group', { name: 'กล่าวชื่อบริษัทและชื่อตัวเอง' });
  await expect(greet).toContainText('เลือก ใช่ หรือ ไม่ใช่');
  await expect(greet.getByRole('radio', { name: 'ใช่', exact: true })).toBeChecked();

  state.nextSaveFailure = { status: 409, json: { code: 'STALE_REVISION' } };
  await page.getByRole('button', { name: 'บันทึกร่าง' }).click();
  await expect(page.getByRole('alert')).toContainText('มีผู้แก้ผลประเมินนี้ก่อนคุณ');
  await expect(page.getByRole('button', { name: 'โหลดฉบับล่าสุด' })).toBeVisible();

  // leaving a page with unsaved changes must be confirmed
  await page.getByRole('button', { name: 'กลับไปรายการ' }).click();
  const leave = page.getByRole('alertdialog', { name: 'ออกโดยไม่บันทึก?' });
  await leave.getByRole('button', { name: 'อยู่ต่อ' }).click();
  await expect(greet.getByRole('radio', { name: 'ใช่', exact: true })).toBeChecked();
});

test('an Agent opens their own scores list and views the per-item answers', async ({ page }) => {
  const published = evaluationOf(
    { evaluation: null, saves: [], publishes: [] },
    {
      answers: {
        greet: { value: true },
        verify: { value: false },
        tone: { value: 4 },
        note: { value: 'สุภาพ' },
      },
      comment: 'ไม่ยืนยันตัวตน',
    },
    'PUBLISHED',
  );
  await page.route('**/api/v1/qm/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1/qm', '');
    if (path === '/my-evaluations')
      return route.fulfill({
        json: {
          items: [
            {
              evaluationId: EVALUATION,
              interactionId: INTERACTION,
              channel: 'VOICE',
              interactionAt: '2026-11-20T03:00:00.000Z',
              formName: 'แบบประเมินสายเข้า',
              formVersion: 1,
              rawScore: 70,
              finalScore: 0,
              autoFailed: true,
              publishedAt: '2026-11-21T02:00:00.000Z',
            },
          ],
          nextCursor: null,
        },
      });
    if (path === `/my-evaluations/${EVALUATION}`) return route.fulfill({ json: published });
    return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });
  await page.goto('/?view=my-quality&tenant=demo');
  await expect(page.getByRole('heading', { name: 'คะแนนคุณภาพของฉัน', level: 1 })).toBeVisible();
  const grid = page.getByRole('grid', { name: 'รายการผลประเมินของฉัน' });
  await expect(grid).toContainText('แบบประเมินสายเข้า (เวอร์ชัน 1)');
  await expect(grid).toContainText('0%');
  await expect(grid).toContainText('ตกเกณฑ์บังคับ');
  await grid.getByRole('button', { name: /^ดูรายละเอียดผลประเมิน/ }).click();

  await expect(
    page.getByRole('heading', { name: 'แบบประเมินสายเข้า (เวอร์ชัน 1)', level: 1 }),
  ).toBeFocused();
  await expect(page.getByText('ประเมินโดย Supervisor A')).toBeVisible();
  await expect(page.getByText('4 จาก 5')).toBeVisible();
  await expect(page.getByText('ไม่ยืนยันตัวตน')).toBeVisible();
  await expect(page.getByText('สุภาพ')).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(0);
  await page.getByRole('button', { name: 'กลับไปรายการ' }).click();
  await expect(grid.getByRole('button', { name: /^ดูรายละเอียดผลประเมิน/ })).toBeFocused();
});

test('an Admin creates a form, adds a category and questions, saves a draft, then publishes', async ({
  page,
}) => {
  const calls: { method: string; path: string; body?: Json }[] = [];
  let detail: Json = {
    formId: FORM,
    name: 'ฟอร์มใหม่',
    updatedAt: '2026-11-22T00:00:00.000Z',
    versions: [{ versionId: VERSION, version: 1, status: 'DRAFT', publishedAt: null }],
    draft: {
      versionId: VERSION,
      version: 1,
      revision: 1,
      definition: { scoreMethod: 'WEIGHTED_POINTS', requireCommentBelow: null, sections: [] },
      updatedAt: '2026-11-22T00:00:00.000Z',
    },
    current: null,
  };
  let publishFailure = true;
  await page.route('**/api/v1/qm/**', async (route) => {
    const request: Request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/qm', '');
    const body = request.method() === 'GET' ? undefined : (request.postDataJSON() as Json);
    calls.push({ method: request.method(), path, ...(body ? { body } : {}) });
    if (request.method() === 'GET' && path === '/forms')
      return route.fulfill({ json: { items: [] } });
    if (request.method() === 'POST' && path === '/forms')
      return route.fulfill({ status: 201, json: detail });
    if (request.method() === 'GET' && path === `/forms/${FORM}`)
      return route.fulfill({ json: detail });
    if (request.method() === 'PUT' && path === `/forms/${FORM}/draft`) {
      detail = {
        ...detail,
        draft: {
          ...detail.draft,
          revision: detail.draft.revision + 1,
          definition: body!.definition,
        },
      };
      return route.fulfill({ json: detail });
    }
    if (request.method() === 'POST' && path === `/forms/${FORM}/draft/publish`) {
      if (publishFailure) {
        publishFailure = false;
        return route.fulfill({
          status: 422,
          json: {
            code: 'VALIDATION_FAILED',
            errors: [{ path: 'sections.0.questions.0.text', code: 'INVALID_TEXT' }],
          },
        });
      }
      detail = {
        ...detail,
        versions: [
          {
            versionId: VERSION,
            version: 1,
            status: 'PUBLISHED',
            publishedAt: '2026-11-22T01:00:00.000Z',
          },
        ],
        current: {
          versionId: VERSION,
          version: 1,
          definition: detail.draft.definition,
          publishedAt: '2026-11-22T01:00:00.000Z',
        },
        draft: null,
      };
      return route.fulfill({ json: detail });
    }
    return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });

  await page.goto('/?view=qm-forms&tenant=demo');
  await expect(page.getByRole('heading', { name: 'ฟอร์มประเมินคุณภาพ', level: 1 })).toBeVisible();
  await expect(page.getByText('ยังไม่มีฟอร์มประเมิน')).toBeVisible();
  await page.getByRole('textbox', { name: 'ชื่อฟอร์มใหม่' }).fill('ฟอร์มใหม่');
  await page.getByRole('button', { name: 'สร้างฟอร์ม' }).click();
  expect(
    calls.find((call) => call.method === 'POST' && call.path === '/forms')?.body,
  ).toMatchObject({
    name: 'ฟอร์มใหม่',
  });

  await expect(page.getByRole('heading', { name: 'ฟอร์มใหม่', level: 1 })).toBeFocused();
  await page.getByRole('button', { name: '+ เพิ่มหมวด' }).click();
  await page.getByRole('button', { name: '+ ใช่/ไม่ใช่' }).click();
  // the react-aria checkbox hides the input under a self-drawn box, so press the label text
  await page.getByText('ตกเกณฑ์บังคับ (ตอบ ไม่ใช่ = 0)').click();
  await expect(
    page.getByRole('checkbox', { name: 'ตกเกณฑ์บังคับ (ตอบ ไม่ใช่ = 0)' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'บันทึกร่าง' }).click();
  await expect.poll(() => calls.filter((call) => call.method === 'PUT').length).toBe(1);
  await expect(page.getByRole('button', { name: 'บันทึกร่าง' })).toBeDisabled();
  const saved = calls.find((call) => call.method === 'PUT')!;
  expect(saved.body).toMatchObject({
    revision: 1,
    name: 'ฟอร์มใหม่',
    definition: {
      sections: [
        {
          id: 's1',
          name: 'หมวด 1',
          weight: 10,
          questions: [{ id: 'q1', type: 'YES_NO', text: '', points: 10, autoFail: true }],
        },
      ],
    },
  });

  // the server rejects: the error is under the question field
  await page.getByRole('button', { name: 'Publish เวอร์ชัน 1' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('กรอกข้อความ (ยาวไม่เกินที่กำหนด)')).toBeVisible();

  await page.getByRole('textbox', { name: 'คำถามข้อ 1' }).fill('ยืนยันตัวตนลูกค้า');
  await page.getByRole('button', { name: 'Publish เวอร์ชัน 1' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('เวอร์ชัน 1 ที่ใช้อยู่ (อ่านอย่างเดียว)')).toBeVisible();
  // unsaved edits are saved before publish
  expect(calls.filter((call) => call.method === 'PUT').at(-1)?.body).toMatchObject({ revision: 2 });
  await expect(page.getByText('เวอร์ชัน 1 ที่ใช้อยู่ (อ่านอย่างเดียว)')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ฟอร์มใหม่', level: 1 })).toBeFocused();
  await expect(page.getByRole('button', { name: 'ออกร่างเวอร์ชันใหม่' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'คำถามข้อ 1' })).toBeDisabled();
});
