import {
  canonicalCg4Digest,
  type Cg4Digest,
  type Cg4PolicyDiffClass,
} from '@d-contact/cxa-contracts';
import type { LocalTimeWindow } from './cg3-persistence.js';
import type { Cg3CallbackMode, Cg3HolidayEntry } from './cg3-policy-evaluator.js';
import type { Cg4PolicyContentV1 } from './cg4-policy-compiler.js';

/**
 * CG4.5 (#188): semantic diff between the current active policy content and a candidate.
 * The class drives the required quorum (#173 §2), so it is deliberately fail-closed: a
 * change is only `TIGHTENING` when every dimension is provably narrower-or-equal. Any
 * mixed or unprovable change (a widened window somewhere, a timezone swap) classifies as
 * `RELAXATION` and therefore demands two checkers.
 */

export type Cg4PolicyDiffDirection = 'EQUAL' | 'TIGHTENING' | 'RELAXATION';

export type Cg4PolicyDiffDimension =
  | 'quietHours'
  | 'holidays'
  | 'callbackMode'
  | 'overridableRules'
  | 'allowedOperationalRuleCodes'
  | 'timezoneFallback';

export interface Cg4PolicyDiffChange {
  dimension: Cg4PolicyDiffDimension;
  direction: Cg4PolicyDiffDirection;
}

export interface Cg4PolicyDiff {
  diffClass: Cg4PolicyDiffClass;
  diffDigest: Cg4Digest;
  changes: readonly Cg4PolicyDiffChange[];
}

/** Baseline for the first version on a scope: no temporal restriction, no override allowed. */
export const CG4_EMPTY_POLICY_CONTENT: Cg4PolicyContentV1 = Object.freeze({
  timezoneFallback: null,
  quietHours: [],
  callbackMode: 'NO_OVERRIDE' as Cg3CallbackMode,
  overridableRules: [],
  allowedOperationalRuleCodes: [],
  holidays: [],
});

const MINUTES_PER_DAY = 1440;

function withinWindow(window: LocalTimeWindow, weekday: number, minuteOfDay: number): boolean {
  if (!window.daysOfWeek.includes(weekday)) return false;
  const [startHour = 0, startMinute = 0] = window.startLocal.split(':').map(Number);
  const [endHour = 0, endMinute = 0] = window.endLocal.split(':').map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (end > start) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

function covers(windows: readonly LocalTimeWindow[], weekday: number, minute: number): boolean {
  return windows.some((window) => withinWindow(window, weekday, minute));
}

/** Blocked minutes per ISO weekday, matching the runtime evaluator's window semantics. */
function quietMinutes(content: Cg4PolicyContentV1): Set<string> {
  const blocked = new Set<string>();
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
      if (covers(content.quietHours, weekday, minute)) blocked.add(`${weekday}:${minute}`);
    }
  }
  return blocked;
}

function isoWeekday(localDate: string): number {
  const [year = 0, month = 1, day = 1] = localDate.split('-').map(Number);
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

/**
 * Blocked minutes contributed by the holiday calendar. A date with no entry contributes
 * nothing — the runtime holiday gate only fires when an entry exists for that date.
 */
function holidayMinutes(content: Cg4PolicyContentV1): Set<string> {
  const blocked = new Set<string>();
  for (const entry of content.holidays as readonly Cg3HolidayEntry[]) {
    const weekday = isoWeekday(entry.localDate);
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
      const open = entry.effect === 'WINDOWS' && covers(entry.windows, weekday, minute);
      if (!open) blocked.add(`${entry.localDate}:${minute}`);
    }
  }
  return blocked;
}

function isSubset(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const entry of left) if (!right.has(entry)) return false;
  return true;
}

/** More blocked = tighter. Mixed (neither is a subset of the other) fails closed. */
function blockedDirection(
  base: ReadonlySet<string>,
  candidate: ReadonlySet<string>,
): Cg4PolicyDiffDirection {
  const baseInCandidate = isSubset(base, candidate);
  const candidateInBase = isSubset(candidate, base);
  if (baseInCandidate && candidateInBase) return 'EQUAL';
  if (baseInCandidate) return 'TIGHTENING';
  if (candidateInBase) return 'RELAXATION';
  return 'RELAXATION';
}

/** More allowed = looser — the inverse of `blockedDirection`. */
function allowlistDirection(
  base: readonly string[],
  candidate: readonly string[],
): Cg4PolicyDiffDirection {
  return blockedDirection(new Set(candidate), new Set(base));
}

function hasTemporalConstraint(content: Cg4PolicyContentV1): boolean {
  return content.quietHours.length > 0 || content.holidays.length > 0;
}

const CALLBACK_MODE_RANK: Readonly<Record<Cg3CallbackMode, number>> = Object.freeze({
  NO_OVERRIDE: 0,
  SCOPED_OVERRIDE: 1,
  TIME_POLICY_OVERRIDE: 2,
});

export function classifyCg4PolicyDiff(
  base: Cg4PolicyContentV1 | null,
  candidate: Cg4PolicyContentV1,
): Cg4PolicyDiff {
  const from = base ?? CG4_EMPTY_POLICY_CONTENT;
  const callbackRankDelta =
    CALLBACK_MODE_RANK[candidate.callbackMode] - CALLBACK_MODE_RANK[from.callbackMode];

  const changes: Cg4PolicyDiffChange[] = [
    {
      dimension: 'quietHours',
      direction: blockedDirection(quietMinutes(from), quietMinutes(candidate)),
    },
    {
      dimension: 'holidays',
      direction: blockedDirection(holidayMinutes(from), holidayMinutes(candidate)),
    },
    {
      dimension: 'callbackMode',
      direction:
        callbackRankDelta === 0 ? 'EQUAL' : callbackRankDelta > 0 ? 'RELAXATION' : 'TIGHTENING',
    },
    {
      dimension: 'overridableRules',
      direction: allowlistDirection(from.overridableRules, candidate.overridableRules),
    },
    {
      dimension: 'allowedOperationalRuleCodes',
      direction: allowlistDirection(
        from.allowedOperationalRuleCodes,
        candidate.allowedOperationalRuleCodes,
      ),
    },
    {
      dimension: 'timezoneFallback',
      // A different fallback zone shifts every window, and a shifted window cannot be
      // proven narrower — so it fails closed. The exception is a side with no
      // zone-dependent constraint at all: there the zone changes nothing, and the
      // quiet-hours/holiday dimensions above already carry the whole direction.
      direction:
        from.timezoneFallback === candidate.timezoneFallback ||
        !hasTemporalConstraint(from) ||
        !hasTemporalConstraint(candidate)
          ? 'EQUAL'
          : 'RELAXATION',
    },
  ];

  const diffClass: Cg4PolicyDiffClass = changes.some((change) => change.direction === 'RELAXATION')
    ? 'RELAXATION'
    : changes.every((change) => change.direction === 'EQUAL')
      ? 'NEUTRAL'
      : 'TIGHTENING';

  return {
    diffClass,
    changes,
    diffDigest: canonicalCg4Digest({ base: base ?? null, candidate, diffClass, changes }),
  };
}
