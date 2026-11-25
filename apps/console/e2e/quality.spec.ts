/** #971: all three quality evaluation pages with a mock API (verifies UI only; permission/DB are checked in the API integration) */
import { expect, test, type Page, type Request } from '@playwright/test';
import { th } from './support/catalog';

const AGENT_NAME = 'Somying Jaidee';
const FORM_NAME = 'Inbound call evaluation';
const FORM_LABEL = th('quality:editor.formName', { name: FORM_NAME, version: 1 });
const Q_GREET = 'Greets with company name and own name';
const Q_VERIFY = 'Verifies customer identity';
const Q_TONE = 'Tone';
const COMMENT = 'Did not verify identity';
const NOTE = 'Polite';
const NEW_FORM = 'New form';

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
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
      name: 'Call opening',
      weight: 20,
      questions: [
        { id: 'greet', type: 'YES_NO', text: Q_GREET, points: 10 },
        { id: 'verify', type: 'YES_NO', text: Q_VERIFY, points: 10, autoFail: true },
      ],
    },
    {
      id: 's2',
      name: 'Problem solving',
      weight: 80,
      questions: [
        { id: 'tone', type: 'SCALE', text: Q_TONE, points: 10, scale: [1, 5], allowNa: true },
        { id: 'note', type: 'TEXT', text: 'What went well' },
      ],
    },
  ],
};

const interaction = {
  interactionId: INTERACTION,
  agentId: 'agent-1',
  agentName: AGENT_NAME,
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
    form: { formId: FORM, formName: FORM_NAME, version: 1, definition },
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
              name: FORM_NAME,
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
          formName: FORM_NAME,
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
    page.getByRole('heading', { name: th('quality:team.title'), level: 1 }),
  ).toBeVisible();
  const grid = page.getByRole('grid', { name: th('quality:team.list') });
  await expect(grid).toContainText(AGENT_NAME);
  await expect(grid).toContainText(th('quality:team.filter.NOT_EVALUATED'));
  await grid
    .getByRole('button', {
      name: new RegExp(
        `^${escapeRegExp(th('quality:team.open.NOT_EVALUATEDItem', { agent: AGENT_NAME, time: '' }))}`,
      ),
    })
    .click();

  await expect(
    page.getByRole('heading', {
      name: th('quality:editor.title', { agent: AGENT_NAME }),
      level: 1,
    }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: new RegExp(escapeRegExp(th('quality:editor.chooseForm'))) })
    .click();
  await page.getByRole('option', { name: FORM_LABEL }).click();

  const greet = page.getByRole('group', { name: Q_GREET });
  await greet.getByRole('radio', { name: th('quality:evaluation.yes'), exact: true }).check();
  // incomplete answers cannot be published but the draft can be saved
  await expect(page.getByRole('button', { name: th('quality:editor.publish') })).toBeDisabled();
  await expect(page.getByText(th('quality:editor.publishNeedsAll', { count: 2 }))).toBeVisible();
  await page.getByRole('button', { name: th('quality:editor.save') }).click();
  // the harness has no navigation API, hence no shell toast: check the result on the page instead
  await expect(page.getByText(th('quality:editor.lastSavedBy'))).toBeVisible();
  expect(state.saves[0]).toMatchObject({
    formVersionId: VERSION,
    answers: { greet: { value: true } },
    comment: '',
  });
  expect(state.saves[0]!.revision).toBeUndefined();
  expect(state.saves[0]!.authorization).toMatch(/^Bearer /);

  await page
    .getByRole('group', { name: Q_VERIFY })
    .getByRole('radio', { name: th('quality:evaluation.no') })
    .check();
  await page.getByRole('group', { name: Q_TONE }).getByRole('radio', { name: '4' }).check();
  await page.getByRole('textbox', { name: th('quality:editor.comment') }).fill(COMMENT);
  await page.getByRole('button', { name: th('quality:editor.publish') }).click();
  const dialog = page.getByRole('alertdialog', {
    name: th('quality:editor.publishDialog.title', { agent: AGENT_NAME }),
  });
  await expect(dialog).toContainText(
    th('quality:editor.publishDialog.body', { agent: AGENT_NAME }),
  );
  await dialog.getByRole('button', { name: 'Publish' }).click();

  await expect(page.getByText(th('quality:score.final'))).toBeVisible();
  // save the latest edits before publish with the draft's revision, then publish with the new revision
  expect(state.saves[1]).toMatchObject({
    revision: 1,
    answers: { greet: { value: true }, verify: { value: false }, tone: { value: 4 } },
    comment: COMMENT,
  });
  expect(state.publishes[0]).toMatchObject({ revision: 2 });
  expect(state.saves[0]!.commandId).not.toBe(state.saves[1]!.commandId);

  // focus goes to the heading after the Dialog closes, not to body
  await expect(
    page.getByRole('heading', {
      name: th('quality:editor.title', { agent: AGENT_NAME }),
      level: 1,
    }),
  ).toBeFocused();
  // after publish it is read-only, with the score and the reasons for failing the criteria
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByText(th('quality:score.final'))).toBeVisible();
  await expect(page.getByText(th('quality:score.autoFailed'))).toBeVisible();
  await expect(page.getByText(th('quality:score.raw', { score: 70 }))).toBeVisible();

  await page.getByRole('button', { name: th('quality:editor.back') }).click();
  await expect(grid).toContainText(th('quality:team.filter.PUBLISHED'));
  await expect(
    grid.getByRole('button', {
      name: new RegExp(
        `^${escapeRegExp(th('quality:team.open.PUBLISHEDItem', { agent: AGENT_NAME, time: '' }))}`,
      ),
    }),
  ).toBeFocused();
});

test('a save fails: the error is under the wrong item, answers are not lost, and a stale draft has a way to reload', async ({
  page,
}) => {
  const state: State = { evaluation: null, saves: [], publishes: [] };
  await mockSupervisor(page, state);
  await page.goto('/?view=team-evaluations&tenant=demo');
  await page
    .getByRole('button', {
      name: new RegExp(
        `^${escapeRegExp(th('quality:team.open.NOT_EVALUATEDItem', { agent: AGENT_NAME, time: '' }))}`,
      ),
    })
    .click();
  await page
    .getByRole('button', { name: new RegExp(escapeRegExp(th('quality:editor.chooseForm'))) })
    .click();
  await page.getByRole('option', { name: FORM_LABEL }).click();
  await page
    .getByRole('group', { name: Q_GREET })
    .getByRole('radio', { name: th('quality:evaluation.yes'), exact: true })
    .check();

  state.nextSaveFailure = {
    status: 422,
    json: {
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'answers.greet', code: 'EXPECTED_BOOLEAN' }],
    },
  };
  await page.getByRole('button', { name: th('quality:editor.save') }).click();
  await expect(page.getByRole('alert')).toContainText(
    th('quality:editor.failure.VALIDATION_FAILED'),
  );
  const greet = page.getByRole('group', { name: Q_GREET });
  await expect(greet).toContainText(th('quality:errors.EXPECTED_BOOLEAN'));
  await expect(
    greet.getByRole('radio', { name: th('quality:evaluation.yes'), exact: true }),
  ).toBeChecked();

  state.nextSaveFailure = { status: 409, json: { code: 'STALE_REVISION' } };
  await page.getByRole('button', { name: th('quality:editor.save') }).click();
  await expect(page.getByRole('alert')).toContainText(th('quality:editor.failure.STALE_REVISION'));
  await expect(page.getByRole('button', { name: th('quality:editor.reload') })).toBeVisible();

  // leaving a page with unsaved changes must be confirmed
  await page.getByRole('button', { name: th('quality:editor.back') }).click();
  const leave = page.getByRole('alertdialog', { name: th('quality:editor.leaveDialog.title') });
  await leave.getByRole('button', { name: th('quality:editor.leaveDialog.stay') }).click();
  await expect(
    greet.getByRole('radio', { name: th('quality:evaluation.yes'), exact: true }),
  ).toBeChecked();
});

test('an Agent opens their own scores list and views the per-item answers', async ({ page }) => {
  const published = evaluationOf(
    { evaluation: null, saves: [], publishes: [] },
    {
      answers: {
        greet: { value: true },
        verify: { value: false },
        tone: { value: 4 },
        note: { value: NOTE },
      },
      comment: COMMENT,
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
              formName: FORM_NAME,
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
  await expect(
    page.getByRole('heading', { name: th('quality:mine.title'), level: 1 }),
  ).toBeVisible();
  const grid = page.getByRole('grid', { name: th('quality:mine.list') });
  await expect(grid).toContainText(FORM_LABEL);
  await expect(grid).toContainText('0%');
  await expect(grid).toContainText(th('quality:score.autoFailed'));
  await grid
    .getByRole('button', {
      name: new RegExp(`^${escapeRegExp(th('quality:mine.openItem', { time: '' }).trim())}`),
    })
    .click();

  await expect(page.getByRole('heading', { name: FORM_LABEL, level: 1 })).toBeFocused();
  await expect(
    page.getByText(
      new RegExp(escapeRegExp(th('quality:mine.publishedBy', { name: 'Supervisor A', time: '' }))),
    ),
  ).toBeVisible();
  await expect(
    page.getByText(th('quality:evaluation.scaleAnswer', { value: 4, max: 5 })),
  ).toBeVisible();
  await expect(page.getByText(COMMENT)).toBeVisible();
  await expect(page.getByText(NOTE)).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(0);
  await page.getByRole('button', { name: th('quality:editor.back') }).click();
  await expect(
    grid.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(th('quality:mine.openItem', { time: '' }).trim())}`),
    }),
  ).toBeFocused();
});

test('an Admin creates a form, adds a category and questions, saves a draft, then publishes', async ({
  page,
}) => {
  const calls: { method: string; path: string; body?: Json }[] = [];
  let detail: Json = {
    formId: FORM,
    name: NEW_FORM,
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
  await expect(
    page.getByRole('heading', { name: th('quality:forms.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(th('quality:forms.empty'))).toBeVisible();
  await page.getByRole('textbox', { name: th('quality:forms.newName') }).fill(NEW_FORM);
  await page.getByRole('button', { name: th('quality:forms.create') }).click();
  expect(
    calls.find((call) => call.method === 'POST' && call.path === '/forms')?.body,
  ).toMatchObject({
    name: NEW_FORM,
  });

  await expect(page.getByRole('heading', { name: NEW_FORM, level: 1 })).toBeFocused();
  await page.getByRole('button', { name: th('quality:forms.addSection') }).click();
  await page.getByRole('button', { name: th('quality:forms.add.YES_NO') }).click();
  // the react-aria checkbox hides the input under a self-drawn box, so press the label text
  await page.getByText(th('quality:forms.autoFail')).click();
  await expect(page.getByRole('checkbox', { name: th('quality:forms.autoFail') })).toBeChecked();
  await page.getByRole('button', { name: th('quality:editor.save') }).click();
  await expect.poll(() => calls.filter((call) => call.method === 'PUT').length).toBe(1);
  await expect(page.getByRole('button', { name: th('quality:editor.save') })).toBeDisabled();
  const saved = calls.find((call) => call.method === 'PUT')!;
  expect(saved.body).toMatchObject({
    revision: 1,
    name: NEW_FORM,
    definition: {
      sections: [
        {
          id: 's1',
          name: th('quality:forms.section', { n: 1 }),
          weight: 10,
          questions: [{ id: 'q1', type: 'YES_NO', text: '', points: 10, autoFail: true }],
        },
      ],
    },
  });

  // the server rejects: the error is under the question field
  await page.getByRole('button', { name: th('quality:forms.publish', { version: 1 }) }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(th('quality:errors.INVALID_TEXT'))).toBeVisible();

  await page
    .getByRole('textbox', { name: th('quality:forms.questionText', { n: 1 }) })
    .fill(Q_VERIFY);
  await page.getByRole('button', { name: th('quality:forms.publish', { version: 1 }) }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(th('quality:forms.viewingCurrent', { version: 1 }))).toBeVisible();
  // unsaved edits are saved before publish
  expect(calls.filter((call) => call.method === 'PUT').at(-1)?.body).toMatchObject({ revision: 2 });
  await expect(page.getByText(th('quality:forms.viewingCurrent', { version: 1 }))).toBeVisible();
  await expect(page.getByRole('heading', { name: NEW_FORM, level: 1 })).toBeFocused();
  await expect(page.getByRole('button', { name: th('quality:forms.newVersion') })).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: th('quality:forms.questionText', { n: 1 }) }),
  ).toBeDisabled();
});
