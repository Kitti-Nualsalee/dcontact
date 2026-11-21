/** #956 กฎของร่างเคสใน Workspace แยกจาก component เพื่อทดสอบด้วย unit test */
import { AgentApiError } from './agent-api.js';

export const CASE_SUBJECT_MAX = 200;
export const CASE_NOTE_MAX = 2000;

export type CasePhase = 'editing' | 'pending' | 'unknown' | 'created';
export type CaseError =
  'failed' | 'assigneeRejected' | 'workClosed' | 'workHasCase' | 'noTeam' | 'invalid';

export interface CaseDraft {
  subject: string;
  note: string;
  /** ว่าง = ตัวเอง */
  assigneeUserId: string;
  /** ใช้ซ้ำเมื่อผลไม่ทราบ เพื่อให้ server ตอบผลเดิมแทนการสร้างเคสซ้ำ */
  commandId: string;
  phase: CasePhase;
  error?: CaseError;
  attempted: boolean;
  created?: { caseId: string; subject: string; assigneeUserId: string };
}

export function emptyCaseDraft(newId: () => string = () => crypto.randomUUID()): CaseDraft {
  return {
    subject: '',
    note: '',
    assigneeUserId: '',
    commandId: newId(),
    phase: 'editing',
    attempted: false,
  };
}

/** นับความยาวเป็นตัวอักษรหลัง normalize แบบเดียวกับโน้ตของ wrapup */
export function normalizeCaseText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

export function caseTextValid(value: string, max: number): boolean {
  const length = [...normalizeCaseText(value)].length;
  return length >= 1 && length <= max;
}

/**
 * แปลง error ของคำสั่งเปิดเคสเป็นสิ่งที่ผู้ใช้เห็น `unknown` = ไม่รู้ว่า server commit หรือยัง
 * ต้องล็อกฟอร์มและส่ง commandId เดิมซ้ำ ส่วน error ที่รู้ผลแน่นอนให้ใช้ commandId ใหม่ในการกดครั้งถัดไป
 */
export function classifyOpenCaseError(
  error: unknown,
): { phase: 'unknown' } | { phase: 'editing'; error: CaseError | undefined; newCommand: boolean } {
  if (!(error instanceof AgentApiError) || error.status >= 500) return { phase: 'unknown' };
  switch (error.code) {
    case 'WORK_NOT_ACTIVE':
    case 'WORK_NOT_FOUND':
      return { phase: 'editing', error: 'workClosed', newCommand: true };
    case 'ASSIGNEE_NOT_IN_TEAM':
      return { phase: 'editing', error: 'assigneeRejected', newCommand: true };
    case 'TEAM_REQUIRED':
    case 'AGENT_REQUIRED':
      return { phase: 'editing', error: 'noTeam', newCommand: true };
    case 'WORK_HAS_CASE':
      return { phase: 'editing', error: 'workHasCase', newCommand: true };
    case 'CONTACT_REQUIRED':
      // แถบ "เลือกลูกค้าก่อน" บอกเหตุอยู่แล้ว
      return { phase: 'editing', error: undefined, newCommand: true };
    case 'INVALID_INPUT':
      return { phase: 'editing', error: 'invalid', newCommand: true };
    default:
      return { phase: 'editing', error: 'failed', newCommand: true };
  }
}
