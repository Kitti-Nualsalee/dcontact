/** #1061 pure rules of the callback screens: times, errors and what the list shows. */
import { AgentApiError } from '../agent-api-error.js';
import { CallbackApiError, type AgentCallback } from './callback-api.js';

export const CALLBACK_NOTE_MAX = 500;
const MIN_LEAD_MS = 60_000;
const MAX_AHEAD_MS = 30 * 24 * 60 * 60_000;

const pad = (value: number) => String(value).padStart(2, '0');

/** `yyyy-mm-dd` and `hh:mm` of a time in the browser's time zone (what date/time inputs use) */
export function localParts(at: Date): { date: string; time: string } {
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
}

/** the suggested time: one hour from now, rounded up to the next quarter hour */
export function suggestedSlot(now: Date): { date: string; time: string } {
  const at = new Date(now.getTime() + 60 * 60_000);
  at.setSeconds(0, 0);
  at.setMinutes(Math.ceil(at.getMinutes() / 15) * 15);
  return localParts(at);
}

export type SlotProblem = 'missing' | 'past' | 'tooSoon' | 'tooFar';

/** the chosen local date and time as an instant, or why it cannot be used */
export function slotInstant(
  date: string,
  time: string,
  now: Date,
): { at: Date } | { problem: SlotProblem } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !clock) return { problem: 'missing' };
  const at = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(clock[1]),
    Number(clock[2]),
  );
  if (!Number.isFinite(at.getTime())) return { problem: 'missing' };
  if (at.getTime() < now.getTime()) return { problem: 'past' };
  if (at.getTime() < now.getTime() + MIN_LEAD_MS) return { problem: 'tooSoon' };
  if (at.getTime() > now.getTime() + MAX_AHEAD_MS) return { problem: 'tooFar' };
  return { at };
}

export type CallbackErrorKey =
  | 'exists'
  | 'notDialable'
  | 'noVoiceQueue'
  | 'blocked'
  | 'blockedConsent'
  | 'blockedIdentity'
  | 'review'
  | 'workEnded'
  | 'contactRequired'
  | 'changed'
  | 'gone'
  | 'noSession'
  | 'notReady'
  | 'voiceDown'
  | 'invalidTime'
  | 'failed';

/** maps an API error to the message the Agent sees; `retry` = the same command may be sent again */
export function callbackErrorKey(error: unknown): { key: CallbackErrorKey; retry: boolean } {
  if (!(error instanceof AgentApiError)) return { key: 'failed', retry: true };
  switch (error.code) {
    case 'CALLBACK_EXISTS':
      return { key: 'exists', retry: false };
    case 'NUMBER_NOT_DIALABLE':
    case 'NUMBER_NOT_FOUND':
      return { key: 'notDialable', retry: false };
    case 'NO_VOICE_QUEUE':
      return { key: 'noVoiceQueue', retry: false };
    case 'GOVERNANCE_BLOCKED':
      return {
        key: governanceBlockKey(error instanceof CallbackApiError ? error.field : undefined),
        retry: false,
      };
    case 'GOVERNANCE_REVIEW':
      return { key: 'review', retry: false };
    case 'WORK_NOT_ACTIVE':
    case 'WORK_NOT_FOUND':
      return { key: 'workEnded', retry: false };
    case 'CONTACT_REQUIRED':
      return { key: 'contactRequired', retry: false };
    case 'VERSION_CONFLICT':
    case 'CALLBACK_NOT_SCHEDULED':
      return { key: 'changed', retry: false };
    case 'CALLBACK_NOT_FOUND':
      return { key: 'gone', retry: false };
    case 'NO_WORK_SESSION':
      return { key: 'noSession', retry: false };
    case 'AGENT_NOT_AVAILABLE':
      return { key: 'notReady', retry: false };
    case 'VOICE_NOT_READY':
      return { key: 'voiceDown', retry: false };
    case 'INVALID_INPUT':
      return { key: 'invalidTime', retry: false };
    default:
      return { key: 'failed', retry: error.status >= 500 };
  }
}

/** due first (oldest time first), then upcoming; the server already orders by time */
export function dueCount(items: readonly AgentCallback[], now: number): number {
  return items.filter((item) => item.state === 'SCHEDULED' && Date.parse(item.requestedFor) <= now)
    .length;
}

/** callbacks whose time came since the last look, for a one-time notice */
export function newlyDue(
  items: readonly AgentCallback[],
  now: number,
  noticed: ReadonlySet<string>,
): AgentCallback[] {
  return items.filter(
    (item) =>
      item.state === 'SCHEDULED' &&
      Date.parse(item.requestedFor) <= now &&
      !noticed.has(`${item.id}:${item.requestedFor}`),
  );
}

export const noticeKey = (item: AgentCallback) => `${item.id}:${item.requestedFor}`;

/** why Contact Governance said no, in the words the Agent needs (consent can still be given later) */
export function governanceBlockKey(
  reasonCode: string | undefined,
): 'blocked' | 'blockedConsent' | 'blockedIdentity' {
  if (reasonCode?.startsWith('CONSENT_')) return 'blockedConsent';
  if (reasonCode?.startsWith('IDENTITY_')) return 'blockedIdentity';
  return 'blocked';
}

/** the catalog key of the message for a time that cannot be used */
export function slotProblemKey(problem: SlotProblem) {
  return (
    {
      missing: 'callback.timeMissing',
      past: 'callback.timePast',
      tooSoon: 'callback.timeTooSoon',
      tooFar: 'callback.timeTooFar',
    } as const
  )[problem];
}
