/**
 * #971 ฟอร์มประเมินคุณภาพและสูตรคะแนน (docs/quality-management.md §8) — ฟังก์ชันล้วน ไม่แตะ DB
 *
 * - ฟอร์มรอบนี้มีคำถาม YES_NO, SCALE และ TEXT (ไม่คิดคะแนน) คิดแบบ WEIGHTED_POINTS
 * - N/A ออกจากตัวหาร; section ที่ไม่มีข้อให้คะแนนเหลือออกจากตัวหารของ weight
 * - auto-fail ทำให้ final = 0 แต่เก็บ raw ไว้เสมอ
 * - server เป็นผู้คำนวณคะแนน client ส่งเฉพาะคำตอบ
 */

export const QM_QUESTION_TYPES = ['YES_NO', 'SCALE', 'TEXT'] as const;
export type QmQuestionType = (typeof QM_QUESTION_TYPES)[number];

export interface QmFormQuestion {
  id: string;
  type: QmQuestionType;
  text: string;
  /** คะแนนเต็มของข้อ (ไม่มีสำหรับ TEXT) */
  points?: number;
  /** ช่วงคะแนนของ SCALE เช่น [1, 5] */
  scale?: [number, number];
  allowNa?: boolean;
  /** YES_NO เท่านั้น: ตอบ "ไม่" แล้วคะแนนสุดท้ายเป็น 0 */
  autoFail?: boolean;
}

export interface QmFormSection {
  id: string;
  name: string;
  weight: number;
  questions: QmFormQuestion[];
}

export interface QmFormDefinition {
  scoreMethod: 'WEIGHTED_POINTS';
  /** คะแนนสุดท้ายต่ำกว่าค่านี้ (0–100) ต้องเขียนความเห็น; null = ไม่บังคับ */
  requireCommentBelow: number | null;
  sections: QmFormSection[];
}

export type QmAnswerValue = boolean | number | string;

export interface QmAnswer {
  questionId: string;
  /** null เมื่อ N/A */
  value: QmAnswerValue | null;
  na: boolean;
}

export interface QmScore {
  rawScore: number;
  finalScore: number;
  autoFailed: boolean;
  sections: { sectionId: string; score: number | null }[];
}

export interface QmFieldError {
  /** ตำแหน่งใน definition หรือ answers เช่น `sections.0.questions.1.points` */
  path: string;
  code: string;
}

export class QmFormValidationError extends Error {
  constructor(readonly errors: QmFieldError[]) {
    super(`QM form invalid: ${errors.map((e) => `${e.path}:${e.code}`).join(', ')}`);
  }
}

export const QM_LIMITS = Object.freeze({
  formName: 120,
  sections: 20,
  questionsPerSection: 30,
  sectionName: 120,
  questionText: 500,
  textAnswer: 2000,
  comment: 4000,
  maxPoints: 100,
  maxWeight: 100,
  scaleMin: 0,
  scaleMax: 10,
});

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : undefined;
}

export function normalizeFormName(value: unknown): string {
  const name = text(value, QM_LIMITS.formName);
  if (!name) throw new QmFormValidationError([{ path: 'name', code: 'INVALID_NAME' }]);
  return name;
}

/**
 * ตรวจและทำให้ definition อยู่ในรูปมาตรฐาน (ตัดช่องว่าง, ตัด field ที่ไม่รู้จัก)
 * `mode = 'draft'` ยอมฟอร์มที่ยังไม่มีคำถาม เพื่อให้ Admin บันทึกระหว่างสร้างได้
 * `mode = 'publish'` ต้องมีอย่างน้อยหนึ่ง section และหนึ่งข้อที่ให้คะแนน
 */
export function parseFormDefinition(input: unknown, mode: 'draft' | 'publish'): QmFormDefinition {
  const errors: QmFieldError[] = [];
  if (!isRecord(input)) throw new QmFormValidationError([{ path: '', code: 'INVALID_DEFINITION' }]);
  const scoreMethod = input.scoreMethod ?? 'WEIGHTED_POINTS';
  if (scoreMethod !== 'WEIGHTED_POINTS') errors.push({ path: 'scoreMethod', code: 'UNSUPPORTED' });
  let requireCommentBelow: number | null = null;
  if (input.requireCommentBelow !== undefined && input.requireCommentBelow !== null) {
    if (isInt(input.requireCommentBelow, 1, 100)) requireCommentBelow = input.requireCommentBelow;
    else errors.push({ path: 'requireCommentBelow', code: 'OUT_OF_RANGE' });
  }
  const rawSections = input.sections;
  const sections: QmFormSection[] = [];
  if (!Array.isArray(rawSections) || rawSections.length > QM_LIMITS.sections) {
    errors.push({ path: 'sections', code: 'INVALID_SECTIONS' });
  } else {
    const ids = new Set<string>();
    const unique = (id: unknown, path: string): string => {
      if (typeof id !== 'string' || !ID.test(id)) {
        errors.push({ path, code: 'INVALID_ID' });
        return '';
      }
      if (ids.has(id)) errors.push({ path, code: 'DUPLICATE_ID' });
      ids.add(id);
      return id;
    };
    rawSections.forEach((rawSection, s) => {
      const at = `sections.${s}`;
      if (!isRecord(rawSection)) {
        errors.push({ path: at, code: 'INVALID_SECTION' });
        return;
      }
      const id = unique(rawSection.id, `${at}.id`);
      const name = text(rawSection.name, QM_LIMITS.sectionName);
      if (!name) errors.push({ path: `${at}.name`, code: 'INVALID_TEXT' });
      const weight = rawSection.weight;
      if (!isInt(weight, 1, QM_LIMITS.maxWeight)) {
        errors.push({ path: `${at}.weight`, code: 'OUT_OF_RANGE' });
      }
      const rawQuestions = rawSection.questions;
      const questions: QmFormQuestion[] = [];
      if (
        !Array.isArray(rawQuestions) ||
        rawQuestions.length > QM_LIMITS.questionsPerSection ||
        (mode === 'publish' && rawQuestions.length === 0)
      ) {
        errors.push({ path: `${at}.questions`, code: 'INVALID_QUESTIONS' });
      } else {
        rawQuestions.forEach((rawQuestion, q) => {
          const qAt = `${at}.questions.${q}`;
          const question = parseQuestion(rawQuestion, qAt, unique, errors);
          if (question) questions.push(question);
        });
      }
      sections.push({ id, name: name ?? '', weight: weight as number, questions });
    });
    if (mode === 'publish') {
      if (sections.length === 0) errors.push({ path: 'sections', code: 'EMPTY_FORM' });
      else if (!sections.some((section) => section.questions.some(isScored))) {
        errors.push({ path: 'sections', code: 'NO_SCORED_QUESTION' });
      }
    }
  }
  if (errors.length > 0) throw new QmFormValidationError(errors);
  return { scoreMethod: 'WEIGHTED_POINTS', requireCommentBelow, sections };
}

function parseQuestion(
  raw: unknown,
  at: string,
  unique: (id: unknown, path: string) => string,
  errors: QmFieldError[],
): QmFormQuestion | undefined {
  if (!isRecord(raw)) {
    errors.push({ path: at, code: 'INVALID_QUESTION' });
    return undefined;
  }
  const id = unique(raw.id, `${at}.id`);
  const type = raw.type;
  if (!QM_QUESTION_TYPES.includes(type as QmQuestionType)) {
    errors.push({ path: `${at}.type`, code: 'UNSUPPORTED' });
    return undefined;
  }
  const questionText = text(raw.text, QM_LIMITS.questionText);
  if (!questionText) errors.push({ path: `${at}.text`, code: 'INVALID_TEXT' });
  const question: QmFormQuestion = { id, type: type as QmQuestionType, text: questionText ?? '' };
  if (type === 'TEXT') {
    if (raw.points !== undefined || raw.autoFail || raw.scale !== undefined) {
      errors.push({ path: at, code: 'TEXT_NOT_SCORED' });
    }
    return question;
  }
  if (!isInt(raw.points, 1, QM_LIMITS.maxPoints)) {
    errors.push({ path: `${at}.points`, code: 'OUT_OF_RANGE' });
  } else {
    question.points = raw.points;
  }
  if (raw.allowNa === true) question.allowNa = true;
  if (type === 'SCALE') {
    const scale = raw.scale;
    if (
      Array.isArray(scale) &&
      scale.length === 2 &&
      isInt(scale[0], QM_LIMITS.scaleMin, QM_LIMITS.scaleMax) &&
      isInt(scale[1], QM_LIMITS.scaleMin, QM_LIMITS.scaleMax) &&
      scale[0] < scale[1]
    ) {
      question.scale = [scale[0], scale[1]];
    } else {
      errors.push({ path: `${at}.scale`, code: 'INVALID_SCALE' });
    }
    if (raw.autoFail) errors.push({ path: `${at}.autoFail`, code: 'YES_NO_ONLY' });
  } else if (raw.autoFail === true) {
    question.autoFail = true;
  }
  return question;
}

function isScored(question: QmFormQuestion): boolean {
  return question.type !== 'TEXT';
}

/**
 * ตรวจคำตอบเทียบกับฟอร์ม
 * `mode = 'draft'` ยอมให้ตอบไม่ครบ; `mode = 'publish'` ทุกข้อที่ให้คะแนนต้องมีคำตอบหรือ N/A
 */
export function parseAnswers(
  form: QmFormDefinition,
  input: unknown,
  mode: 'draft' | 'publish',
): QmAnswer[] {
  const errors: QmFieldError[] = [];
  if (!isRecord(input))
    throw new QmFormValidationError([{ path: 'answers', code: 'INVALID_ANSWERS' }]);
  const questions = new Map(
    form.sections
      .flatMap((section) => section.questions)
      .map((question) => [question.id, question]),
  );
  for (const key of Object.keys(input)) {
    if (!questions.has(key)) errors.push({ path: `answers.${key}`, code: 'UNKNOWN_QUESTION' });
  }
  const answers: QmAnswer[] = [];
  for (const [id, question] of questions) {
    const at = `answers.${id}`;
    const raw = input[id];
    if (raw === undefined || raw === null) {
      if (mode === 'publish' && isScored(question)) errors.push({ path: at, code: 'REQUIRED' });
      continue;
    }
    if (!isRecord(raw)) {
      errors.push({ path: at, code: 'INVALID_ANSWER' });
      continue;
    }
    if (raw.na === true) {
      if (!question.allowNa) errors.push({ path: at, code: 'NA_NOT_ALLOWED' });
      else answers.push({ questionId: id, value: null, na: true });
      continue;
    }
    const value = raw.value;
    if (question.type === 'YES_NO') {
      if (typeof value !== 'boolean') errors.push({ path: at, code: 'EXPECTED_BOOLEAN' });
      else answers.push({ questionId: id, value, na: false });
    } else if (question.type === 'SCALE') {
      const [min, max] = question.scale!;
      if (!isInt(value, min, max)) errors.push({ path: at, code: 'OUT_OF_RANGE' });
      else answers.push({ questionId: id, value, na: false });
    } else {
      if (typeof value !== 'string' || value.length > QM_LIMITS.textAnswer) {
        errors.push({ path: at, code: 'INVALID_TEXT' });
      } else if (value.trim().length > 0) {
        answers.push({ questionId: id, value: value.trim(), na: false });
      }
    }
  }
  if (errors.length > 0) throw new QmFormValidationError(errors);
  return answers;
}

/** คะแนนเป็นร้อยละ ปัดสองตำแหน่ง; null เมื่อไม่มีข้อให้คะแนนที่ตอบ (ไม่ใช่ N/A) เลย */
export function scoreEvaluation(form: QmFormDefinition, answers: QmAnswer[]): QmScore | null {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  let autoFailed = false;
  let weighted = 0;
  let weights = 0;
  const sections = form.sections.map((section) => {
    let earned = 0;
    let possible = 0;
    for (const question of section.questions) {
      if (!isScored(question)) continue;
      const answer = byId.get(question.id);
      if (!answer || answer.na) continue;
      const points = question.points!;
      possible += points;
      if (question.type === 'YES_NO') {
        if (answer.value === true) earned += points;
        else if (question.autoFail) autoFailed = true;
      } else {
        const [min, max] = question.scale!;
        earned += (points * ((answer.value as number) - min)) / (max - min);
      }
    }
    if (possible === 0) return { sectionId: section.id, score: null };
    const score = earned / possible;
    weighted += score * section.weight;
    weights += section.weight;
    return { sectionId: section.id, score: round(score * 100) };
  });
  if (weights === 0) return null;
  const rawScore = round((weighted / weights) * 100);
  return { rawScore, finalScore: autoFailed ? 0 : rawScore, autoFailed, sections };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** ความเห็นที่ตัดช่องว่างแล้ว; สตริงว่างเป็น null */
export function normalizeComment(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > QM_LIMITS.comment) {
    throw new QmFormValidationError([{ path: 'comment', code: 'INVALID_TEXT' }]);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** กติกาตอน publish: ต้องได้คะแนน และคะแนนต่ำกว่าเกณฑ์ต้องมีความเห็น */
export function assertPublishable(
  form: QmFormDefinition,
  score: QmScore | null,
  comment: string | null,
): QmScore {
  if (!score) throw new QmFormValidationError([{ path: 'answers', code: 'NO_SCORABLE_ANSWER' }]);
  if (
    form.requireCommentBelow !== null &&
    score.finalScore < form.requireCommentBelow &&
    !comment
  ) {
    throw new QmFormValidationError([{ path: 'comment', code: 'COMMENT_REQUIRED' }]);
  }
  return score;
}

/** แปลงคำตอบที่เก็บใน DB กลับเป็น map แบบที่ API รับ เพื่อให้ client ส่งกลับมาแก้ต่อได้ */
export function answersView(
  answers: QmAnswer[],
): Record<string, { value?: QmAnswerValue; na?: true }> {
  return Object.fromEntries(
    answers.map((answer) => [
      answer.questionId,
      answer.na ? { na: true as const } : { value: answer.value as QmAnswerValue },
    ]),
  );
}
