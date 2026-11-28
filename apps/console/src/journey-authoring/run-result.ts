import type { JourneyRun } from './api.js';

export type RunResult = 'done' | 'rejected' | 'waiting' | 'blocked' | 'cancelled';

const DONE = new Set(['ACKNOWLEDGED']);
const REJECTED = new Set(['REJECTED', 'TOO_LATE']);
const CANCELLED = new Set(['CANCELLED', 'CANCEL_REQUESTED', 'SUPERSEDED']);

/** One readable result per enrollment — the raw state codes stay available in the title for support */
export function runResult(run: JourneyRun): RunResult {
  if (run.terminalReason === 'CANCELLED') return 'cancelled';
  if (run.state === 'BLOCKED') return 'blocked';
  const action = run.actions.at(-1);
  if (!action) return 'waiting';
  if (DONE.has(action.state)) return 'done';
  if (REJECTED.has(action.state)) return 'rejected';
  if (CANCELLED.has(action.state)) return 'cancelled';
  return 'waiting';
}
