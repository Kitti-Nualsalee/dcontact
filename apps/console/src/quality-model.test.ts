import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addQuestion,
  addSection,
  cleanAnswers,
  emptyDefinition,
  errorMap,
  formatOffset,
  formatScore,
  removeQuestion,
  retype,
  scaleValues,
  setAnswer,
  unanswered,
} from './quality/model.js';

test('#971 adding a category and a question gives a non-duplicate id even after delete then add again', () => {
  let form = addSection(emptyDefinition(), 'Category 1');
  form = addQuestion(form, 0, 'YES_NO');
  form = addQuestion(form, 0, 'SCALE');
  assert.deepEqual(
    form.sections[0]!.questions.map((q) => [q.id, q.type, q.points, q.scale]),
    [
      ['q1', 'YES_NO', 10, undefined],
      ['q2', 'SCALE', 10, [1, 5]],
    ],
  );
  form = removeQuestion(form, 0, 0);
  form = addQuestion(form, 0, 'TEXT');
  assert.deepEqual(
    form.sections[0]!.questions.map((q) => q.id),
    ['q2', 'q1'],
  );
  form = addSection(form, 'Category 2');
  assert.equal(form.sections[1]!.id, 's2');
});

test('#971 changing the question type keeps the text and score and drops unused fields', () => {
  const scored = {
    id: 'q1',
    type: 'YES_NO' as const,
    text: 'Greeting',
    points: 7,
    autoFail: true,
    allowNa: true,
  };
  assert.deepEqual(retype(scored, 'SCALE'), {
    id: 'q1',
    type: 'SCALE',
    text: 'Greeting',
    points: 7,
    scale: [1, 5],
    allowNa: true,
  });
  assert.deepEqual(retype(scored, 'TEXT'), { id: 'q1', type: 'TEXT', text: 'Greeting' });
});

test('#971 answers: an unanswered item, a removed answer, and no empty text sent', () => {
  let form = addSection(emptyDefinition(), 'S');
  form = addQuestion(form, 0, 'YES_NO');
  form = addQuestion(form, 0, 'TEXT');
  let answers = setAnswer({}, 'q1', { value: false });
  answers = setAnswer(answers, 'q2', { value: '   ' });
  assert.deepEqual(unanswered(form, answers), []);
  assert.deepEqual(cleanAnswers(form, { ...answers, ghost: { na: true } }), {
    q1: { value: false },
  });
  assert.deepEqual(
    unanswered(form, setAnswer(answers, 'q1', undefined)).map((q) => q.id),
    ['q1'],
  );
});

test('#971 show the score per locale and the range of the scale', () => {
  assert.equal(formatScore(83.333, 'th-TH'), '83.33');
  assert.equal(formatScore(null, 'th-TH'), '—');
  assert.deepEqual(scaleValues({ id: 'q', type: 'SCALE', text: '', scale: [0, 3] }), [0, 1, 2, 3]);
  assert.deepEqual(errorMap([{ path: 'comment', code: 'COMMENT_REQUIRED' }]), {
    comment: 'COMMENT_REQUIRED',
  });
});

test('a transcript line time is m:ss from the start of the recording, h:mm:ss past an hour', () => {
  assert.equal(formatOffset(0), '0:00');
  assert.equal(formatOffset(960), '0:00');
  assert.equal(formatOffset(65_000), '1:05');
  assert.equal(formatOffset(3_725_000), '1:02:05');
  assert.equal(formatOffset(-5), '0:00');
});
