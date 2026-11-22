/** #971: กติกาของหน้าประเมินคุณภาพที่ทดสอบได้โดยไม่มี browser — server ยังเป็นผู้ตรวจและคิดคะแนนจริง */
import type {
  Answers,
  FieldError,
  FormDefinition,
  FormQuestion,
  FormSection,
  QuestionType,
} from './api.js';

export const DEFAULT_SCALE: [number, number] = [1, 5];
export const DEFAULT_POINTS = 10;
export const DEFAULT_WEIGHT = 10;

function nextId(prefix: string, used: Iterable<string>): string {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

function allIds(definition: FormDefinition): string[] {
  return definition.sections.flatMap((section) => [
    section.id,
    ...section.questions.map((question) => question.id),
  ]);
}

export function emptyDefinition(): FormDefinition {
  return { scoreMethod: 'WEIGHTED_POINTS', requireCommentBelow: null, sections: [] };
}

export function addSection(definition: FormDefinition, name: string): FormDefinition {
  const section: FormSection = {
    id: nextId('s', allIds(definition)),
    name,
    weight: DEFAULT_WEIGHT,
    questions: [],
  };
  return { ...definition, sections: [...definition.sections, section] };
}

export function questionOf(type: QuestionType, id: string, text: string): FormQuestion {
  if (type === 'TEXT') return { id, type, text };
  if (type === 'SCALE')
    return { id, type, text, points: DEFAULT_POINTS, scale: [...DEFAULT_SCALE] };
  return { id, type, text, points: DEFAULT_POINTS };
}

export function addQuestion(
  definition: FormDefinition,
  sectionIndex: number,
  type: QuestionType,
): FormDefinition {
  const id = nextId('q', allIds(definition));
  return updateSection(definition, sectionIndex, (section) => ({
    ...section,
    questions: [...section.questions, questionOf(type, id, '')],
  }));
}

/** เปลี่ยนชนิดคำถามโดยคงข้อความและคะแนนเต็มไว้ ตัด field ที่ชนิดใหม่ไม่ใช้ */
export function retype(question: FormQuestion, type: QuestionType): FormQuestion {
  const next = questionOf(type, question.id, question.text);
  if (type !== 'TEXT' && question.points !== undefined) next.points = question.points;
  if (type !== 'TEXT' && question.allowNa) next.allowNa = true;
  return next;
}

export function updateSection(
  definition: FormDefinition,
  index: number,
  change: (section: FormSection) => FormSection,
): FormDefinition {
  return {
    ...definition,
    sections: definition.sections.map((section, i) => (i === index ? change(section) : section)),
  };
}

export function updateQuestion(
  definition: FormDefinition,
  sectionIndex: number,
  questionIndex: number,
  change: (question: FormQuestion) => FormQuestion,
): FormDefinition {
  return updateSection(definition, sectionIndex, (section) => ({
    ...section,
    questions: section.questions.map((question, i) =>
      i === questionIndex ? change(question) : question,
    ),
  }));
}

export function removeSection(definition: FormDefinition, index: number): FormDefinition {
  return { ...definition, sections: definition.sections.filter((_, i) => i !== index) };
}

export function removeQuestion(
  definition: FormDefinition,
  sectionIndex: number,
  questionIndex: number,
): FormDefinition {
  return updateSection(definition, sectionIndex, (section) => ({
    ...section,
    questions: section.questions.filter((_, i) => i !== questionIndex),
  }));
}

/** error จาก server เป็น map ของ path → code เพื่อแสดงใต้ field ที่ผิด */
export function errorMap(errors: FieldError[]): Record<string, string> {
  return Object.fromEntries(errors.map((error) => [error.path, error.code]));
}

export function scoredQuestions(definition: FormDefinition): FormQuestion[] {
  return definition.sections
    .flatMap((section) => section.questions)
    .filter((question) => question.type !== 'TEXT');
}

/** ข้อที่ให้คะแนนซึ่งยังไม่มีคำตอบหรือ N/A */
export function unanswered(definition: FormDefinition, answers: Answers): FormQuestion[] {
  return scoredQuestions(definition).filter((question) => answers[question.id] === undefined);
}

export function setAnswer(
  answers: Answers,
  questionId: string,
  value: Answers[string] | undefined,
): Answers {
  const next = { ...answers };
  if (value === undefined) delete next[questionId];
  else next[questionId] = value;
  return next;
}

/** ช่องความเห็นที่ว่างไม่ถูกส่งเป็นคำตอบ TEXT */
export function cleanAnswers(definition: FormDefinition, answers: Answers): Answers {
  const known = new Set(definition.sections.flatMap((s) => s.questions.map((q) => q.id)));
  return Object.fromEntries(
    Object.entries(answers).filter(([id, answer]) => {
      if (!known.has(id)) return false;
      return !('value' in answer) || typeof answer.value !== 'string' || answer.value.trim() !== '';
    }),
  );
}

export function formatScore(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

export function scaleValues(question: FormQuestion): number[] {
  const [min, max] = question.scale ?? DEFAULT_SCALE;
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}
