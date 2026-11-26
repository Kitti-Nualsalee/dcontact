/** #956 rules of the case draft in Workspace, separate from the component so it can be unit tested */
import { AgentApiError } from './agent-api.js';

export const CASE_SUBJECT_MAX = 200;
export const CASE_NOTE_MAX = 2000;

export type CasePhase = 'editing' | 'pending' | 'unknown' | 'created';
export type CaseError =
  'failed' | 'assigneeRejected' | 'workClosed' | 'workHasCase' | 'noTeam' | 'invalid';

export interface CaseDraft {
  subject: string;
  note: string;
  /** empty = themselves */
  assigneeUserId: string;
  /** reused when the result is unknown, so the server answers the original result instead of creating a duplicate case */
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

/** count length in characters after normalizing the same way as the wrapup note */
export function normalizeCaseText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

export function caseTextValid(value: string, max: number): boolean {
  const length = [...normalizeCaseText(value)].length;
  return length >= 1 && length <= max;
}

/**
 * convert an error of the open-case command into what the user sees; `unknown` = unknown whether the server committed yet
 * the form must be locked and the same commandId resent; an error with a known result uses a new commandId on the next press
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
      // the "choose a customer first" bar already says the reason
      return { phase: 'editing', error: undefined, newCommand: true };
    case 'INVALID_INPUT':
      return { phase: 'editing', error: 'invalid', newCommand: true };
    default:
      return { phase: 'editing', error: 'failed', newCommand: true };
  }
}
