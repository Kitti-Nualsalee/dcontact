import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addQuestion,
  addSection,
  cleanAnswers,
  emptyDefinition,
  errorMap,
  formatScore,
  removeQuestion,
  retype,
  scaleValues,
  setAnswer,
  unanswered,
} from './quality/model.js';

test('#971 เพิ่มหมวดและคำถามได้ id ที่ไม่ซ้ำแม้ลบแล้วเพิ่มใหม่', () => {
  let form = addSection(emptyDefinition(), 'หมวด 1');
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
  form = addSection(form, 'หมวด 2');
  assert.equal(form.sections[1]!.id, 's2');
});

test('#971 เปลี่ยนชนิดคำถามคงข้อความและคะแนน ตัด field ที่ไม่ใช้', () => {
  const scored = {
    id: 'q1',
    type: 'YES_NO' as const,
    text: 'ทักทาย',
    points: 7,
    autoFail: true,
    allowNa: true,
  };
  assert.deepEqual(retype(scored, 'SCALE'), {
    id: 'q1',
    type: 'SCALE',
    text: 'ทักทาย',
    points: 7,
    scale: [1, 5],
    allowNa: true,
  });
  assert.deepEqual(retype(scored, 'TEXT'), { id: 'q1', type: 'TEXT', text: 'ทักทาย' });
});

test('#971 คำตอบ: ข้อที่ยังไม่ตอบ ลบคำตอบ และไม่ส่งข้อความว่าง', () => {
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

test('#971 แสดงคะแนนตาม locale และช่วงของสเกล', () => {
  assert.equal(formatScore(83.333, 'th-TH'), '83.33');
  assert.equal(formatScore(null, 'th-TH'), '—');
  assert.deepEqual(scaleValues({ id: 'q', type: 'SCALE', text: '', scale: [0, 3] }), [0, 1, 2, 3]);
  assert.deepEqual(errorMap([{ path: 'comment', code: 'COMMENT_REQUIRED' }]), {
    comment: 'COMMENT_REQUIRED',
  });
});
