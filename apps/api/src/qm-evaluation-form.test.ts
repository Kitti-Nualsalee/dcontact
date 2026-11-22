import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QmFormValidationError,
  assertPublishable,
  answersView,
  normalizeComment,
  parseAnswers,
  parseFormDefinition,
  scoreEvaluation,
  type QmFormDefinition,
} from './qm-evaluation-form.js';

/** ฟอร์มตัวอย่างใน docs/quality-management.md §8 ย่อเหลือสอง section */
const sample = {
  sections: [
    {
      id: 'opening',
      name: '  การเปิดสาย ',
      weight: 20,
      questions: [
        { id: 'greet', type: 'YES_NO', text: 'กล่าวชื่อบริษัทและชื่อตัวเอง', points: 10 },
        {
          id: 'verify',
          type: 'YES_NO',
          text: 'ยืนยันตัวตนลูกค้าครบถ้วน',
          points: 10,
          autoFail: true,
        },
        { id: 'tone', type: 'SCALE', text: 'น้ำเสียง', scale: [1, 5], points: 10, allowNa: true },
      ],
    },
    {
      id: 'solve',
      name: 'การแก้ปัญหา',
      weight: 80,
      questions: [
        { id: 'fixed', type: 'YES_NO', text: 'แก้ปัญหาได้ในสายเดียว', points: 20, allowNa: true },
        { id: 'note', type: 'TEXT', text: 'สิ่งที่ทำได้ดี' },
      ],
    },
  ],
  requireCommentBelow: 60,
  extra: 'ignored',
};

const form = (): QmFormDefinition => parseFormDefinition(sample, 'publish');

const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof QmFormValidationError);
    return error.errors.map((e) => `${e.path}:${e.code}`);
  }
  assert.fail('expected QmFormValidationError');
};

test('definition ถูกทำให้เป็นรูปมาตรฐาน: ตัดช่องว่างและ field ที่ไม่รู้จัก', () => {
  const parsed = form();
  assert.equal(parsed.sections[0]!.name, 'การเปิดสาย');
  assert.equal(parsed.requireCommentBelow, 60);
  assert.deepEqual(Object.keys(parsed).sort(), ['requireCommentBelow', 'scoreMethod', 'sections']);
  assert.deepEqual(parsed.sections[1]!.questions[1], {
    id: 'note',
    type: 'TEXT',
    text: 'สิ่งที่ทำได้ดี',
  });
});

test('ร่างฟอร์มว่างบันทึกได้ แต่ publish ต้องมีข้อที่ให้คะแนน', () => {
  assert.deepEqual(parseFormDefinition({ sections: [] }, 'draft').sections, []);
  assert.deepEqual(
    codes(() => parseFormDefinition({ sections: [] }, 'publish')),
    ['sections:EMPTY_FORM'],
  );
  const onlyText = {
    sections: [
      { id: 's', name: 'S', weight: 1, questions: [{ id: 't', type: 'TEXT', text: 'T' }] },
    ],
  };
  assert.deepEqual(
    codes(() => parseFormDefinition(onlyText, 'publish')),
    ['sections:NO_SCORED_QUESTION'],
  );
});

test('definition ที่ผิดรายงานทุกตำแหน่ง', () => {
  const bad = {
    sections: [
      {
        id: 'Bad Id',
        name: '',
        weight: 0,
        questions: [
          { id: 'q', type: 'SCALE', text: 'x', points: 5, scale: [5, 1], autoFail: true },
          { id: 'q', type: 'MULTI_CHOICE', text: 'x' },
          { id: 't', type: 'TEXT', text: 'x', points: 3 },
        ],
      },
    ],
    requireCommentBelow: 101,
  };
  assert.deepEqual(
    codes(() => parseFormDefinition(bad, 'draft')),
    [
      'requireCommentBelow:OUT_OF_RANGE',
      'sections.0.id:INVALID_ID',
      'sections.0.name:INVALID_TEXT',
      'sections.0.weight:OUT_OF_RANGE',
      'sections.0.questions.0.scale:INVALID_SCALE',
      'sections.0.questions.0.autoFail:YES_NO_ONLY',
      'sections.0.questions.1.id:DUPLICATE_ID',
      'sections.0.questions.1.type:UNSUPPORTED',
      'sections.0.questions.2:TEXT_NOT_SCORED',
    ],
  );
});

test('ตอบครบทุกข้อได้เต็ม 100', () => {
  const answers = parseAnswers(
    form(),
    {
      greet: { value: true },
      verify: { value: true },
      tone: { value: 5 },
      fixed: { value: true },
      note: { value: '  ดีมาก ' },
    },
    'publish',
  );
  assert.deepEqual(answers.at(-1), { questionId: 'note', value: 'ดีมาก', na: false });
  assert.deepEqual(scoreEvaluation(form(), answers), {
    rawScore: 100,
    finalScore: 100,
    autoFailed: false,
    sections: [
      { sectionId: 'opening', score: 100 },
      { sectionId: 'solve', score: 100 },
    ],
  });
});

test('N/A ออกจากตัวหาร ไม่ใช่ได้ 0 และ SCALE คิดตามสัดส่วนจากค่าต่ำสุด', () => {
  // opening: greet 10 + tone (3-1)/(5-1)*10 = 5 → 15/20; verify N/A ไม่ได้ (ไม่ allowNa) จึงตอบ true
  const answers = parseAnswers(
    form(),
    { greet: { value: true }, verify: { value: true }, tone: { value: 3 }, fixed: { na: true } },
    'publish',
  );
  const score = scoreEvaluation(form(), answers)!;
  // opening = 25/30 = 83.33%; solve ไม่มีข้อให้คะแนนเหลือ → ตัดออกจาก weight ทั้ง section
  assert.deepEqual(score.sections, [
    { sectionId: 'opening', score: 83.33 },
    { sectionId: 'solve', score: null },
  ]);
  assert.equal(score.rawScore, 83.33);
  assert.equal(score.finalScore, 83.33);
});

test('weight ของ section ถ่วงคะแนนรวม', () => {
  const answers = parseAnswers(
    form(),
    {
      greet: { value: false },
      verify: { value: true },
      tone: { na: true },
      fixed: { value: true },
    },
    'publish',
  );
  // opening 10/20 = 0.5 × 20; solve 1 × 80 → (10 + 80) / 100
  assert.equal(scoreEvaluation(form(), answers)!.rawScore, 90);
});

test('auto-fail ทำให้คะแนนสุดท้ายเป็น 0 แต่เก็บ raw ไว้', () => {
  const answers = parseAnswers(
    form(),
    {
      greet: { value: true },
      verify: { value: false },
      tone: { value: 5 },
      fixed: { value: true },
    },
    'publish',
  );
  const score = scoreEvaluation(form(), answers)!;
  assert.equal(score.autoFailed, true);
  assert.equal(score.finalScore, 0);
  // opening 20/30 × 20 + 1 × 80 = 93.33
  assert.equal(score.rawScore, 93.33);
});

test('ร่างตอบไม่ครบได้ แต่ publish ต้องตอบทุกข้อที่ให้คะแนน (TEXT ไม่บังคับ)', () => {
  const partial = parseAnswers(form(), { greet: { value: true } }, 'draft');
  assert.equal(partial.length, 1);
  assert.deepEqual(
    codes(() => parseAnswers(form(), { greet: { value: true } }, 'publish')),
    ['answers.verify:REQUIRED', 'answers.tone:REQUIRED', 'answers.fixed:REQUIRED'],
  );
});

test('คำตอบที่ผิดชนิด ผิดช่วง N/A ที่ไม่อนุญาต และข้อที่ไม่มีในฟอร์มถูกปฏิเสธ', () => {
  assert.deepEqual(
    codes(() =>
      parseAnswers(
        form(),
        {
          greet: { value: 'yes' },
          verify: { na: true },
          tone: { value: 6 },
          fixed: 'x',
          ghost: { value: true },
        },
        'draft',
      ),
    ),
    [
      'answers.ghost:UNKNOWN_QUESTION',
      'answers.greet:EXPECTED_BOOLEAN',
      'answers.verify:NA_NOT_ALLOWED',
      'answers.tone:OUT_OF_RANGE',
      'answers.fixed:INVALID_ANSWER',
    ],
  );
});

test('ทุกข้อเป็น N/A ไม่มีคะแนน และ publish ไม่ได้', () => {
  const onlyNa = parseFormDefinition(
    {
      sections: [
        {
          id: 's',
          name: 'S',
          weight: 1,
          questions: [{ id: 'q', type: 'YES_NO', text: 'Q', points: 1, allowNa: true }],
        },
      ],
    },
    'publish',
  );
  const answers = parseAnswers(onlyNa, { q: { na: true } }, 'publish');
  assert.equal(scoreEvaluation(onlyNa, answers), null);
  assert.deepEqual(
    codes(() => assertPublishable(onlyNa, null, null)),
    ['answers:NO_SCORABLE_ANSWER'],
  );
});

test('คะแนนต่ำกว่าเกณฑ์ต้องมีความเห็น', () => {
  const answers = parseAnswers(
    form(),
    {
      greet: { value: true },
      verify: { value: false },
      tone: { value: 5 },
      fixed: { value: true },
    },
    'publish',
  );
  const score = scoreEvaluation(form(), answers);
  assert.deepEqual(
    codes(() => assertPublishable(form(), score, normalizeComment('   '))),
    ['comment:COMMENT_REQUIRED'],
  );
  assert.equal(assertPublishable(form(), score, 'ไม่ยืนยันตัวตน').finalScore, 0);
});

test('answersView คืนรูปที่ API รับ เพื่อส่งกลับมาแก้ต่อได้', () => {
  const answers = parseAnswers(form(), { greet: { value: true }, tone: { na: true } }, 'draft');
  const view = answersView(answers);
  assert.deepEqual(view, { greet: { value: true }, tone: { na: true } });
  assert.deepEqual(parseAnswers(form(), view, 'draft'), answers);
});
