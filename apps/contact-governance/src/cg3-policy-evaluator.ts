import type {
  Cg4AppliedExceptionPin,
  ContactChannel,
  ContactDecision,
  ContactPolicyTraceEntry,
} from '@d-contact/cxa-contracts';
import type { LocalTimeWindow } from './cg3-persistence.js';
import { resolveCg4ExceptionCoverage, type Cg4ExceptionFacts } from './cg4-exception-evaluation.js';

/**
 * Pure, deterministic CG3 gate evaluator per decisions #101/#98 of the
 * "Wayfinder map: S1 - Safe delivery" (#97). No I/O; the caller (service) loads the facts
 * from the database first and passes them in as pure input so it can be tested and replayed deterministically
 */

export type Cg3PreferenceDecision = 'ALLOW' | 'BLOCK' | 'DEFER';
export type Cg3CallbackMode = 'NO_OVERRIDE' | 'SCOPED_OVERRIDE' | 'TIME_POLICY_OVERRIDE';

export interface Cg3PreferenceCandidate {
  version: number;
  identityId: string | null;
  channel: ContactChannel | null;
  purpose: string | null;
  contactKind: string | null;
  decision: Cg3PreferenceDecision | null;
  timezone: string | null;
  preferredWindows: LocalTimeWindow[];
}

export interface Cg3HolidayEntry {
  /** local calendar date, `YYYY-MM-DD` */
  localDate: string;
  effect: 'CLOSED' | 'WINDOWS';
  windows: LocalTimeWindow[];
}

export interface Cg3PolicyFacts {
  version: number;
  timezoneFallback: string | null;
  quietHours: LocalTimeWindow[];
  callbackMode: Cg3CallbackMode;
  /** names of the temporal-rule reasons that this policy lets a callback exception override */
  overridableRules: string[];
  holidays: Cg3HolidayEntry[];
  /** #1065: present only when the policy does not require consent; absent = consent required */
  consent?: ContactConsentWaiver;
}

/** #1065: a policy that lets work go ahead without a consent record, on another lawful basis */
export interface ContactConsentWaiver {
  requirement: 'NOT_REQUIRED';
  lawfulBasis: string;
}

export interface Cg3CallbackFacts {
  requestId: string;
  identityId: string | null;
  channel: ContactChannel;
  purpose: string;
  expiresAt: string;
  approvedExceptionId: string | null;
}

export interface Cg3EvaluationInput {
  now: Date;
  identityId?: string;
  channel: ContactChannel;
  purpose: string;
  contactKind?: string;
  senderIdentityId?: string;
  /** timezone authority order: customer-explicit -> verified Customer 360 -> tenant default */
  customerExplicitTimezone?: string | null;
  customer360Timezone?: string | null;
  tenantDefaultTimezone?: string | null;
  preferences: Cg3PreferenceCandidate[];
  policy?: Cg3PolicyFacts;
  activeCallback?: Cg3CallbackFacts;
  /** CG4.4 (#187): exact source binding an Approved exception must match. */
  source?: string;
  sourceId?: string;
  /** CG4.4 (#187): APPROVED exceptions whose window covers `now`, unfiltered by scope. */
  activeExceptions?: Cg4ExceptionFacts[];
}

export interface Cg3GateOutcome {
  trace: ContactPolicyTraceEntry[];
  /** undefined = every CG3 gate passed (the caller declares ALLOW/POLICY_PASSED itself) */
  decision?: ContactDecision;
  reasonCode?: string;
  preferenceVersion?: number;
  nextEligibleAt?: string;
  timezoneSource?: string;
  matchedScope?: Record<string, string | null>;
  matchedWindowRef?: string;
  exceptionMode?: Cg3CallbackMode;
  exceptionRef?: string;
  /** if a valid callback was really used to override, the service consumes it atomically */
  consumedCallbackRequestId?: string;
  /** CG4.4 (#187): the exception revision that really lifted the provisional failure, for pinning in the decision trace */
  appliedExceptions?: Cg4AppliedExceptionPin[];
}

const REASON = {
  PREFERENCE_BLOCKED: 'PREFERENCE_BLOCKED',
  PREFERENCE_WINDOW_CLOSED: 'PREFERENCE_WINDOW_CLOSED',
  QUIET_HOURS: 'QUIET_HOURS',
  TENANT_HOLIDAY: 'TENANT_HOLIDAY',
  TIMEZONE_UNKNOWN: 'TIMEZONE_UNKNOWN',
  CALLBACK_OVERRIDE_NOT_ALLOWED: 'CALLBACK_OVERRIDE_NOT_ALLOWED',
  CALLBACK_OVERRIDE_EXPIRED: 'CALLBACK_OVERRIDE_EXPIRED',
  EXCEPTION_APPROVAL_REQUIRED: 'EXCEPTION_APPROVAL_REQUIRED',
  CUSTOMER_REQUESTED_CALLBACK: 'CUSTOMER_REQUESTED_CALLBACK',
  APPROVED_EXCEPTION_APPLIED: 'APPROVED_EXCEPTION_APPLIED',
} as const;

// ---- Preference gate ------------------------------------------------------

interface ScopeMatch {
  candidate: Cg3PreferenceCandidate;
  specificity: number;
}

function preferenceMatches(candidate: Cg3PreferenceCandidate, input: Cg3EvaluationInput): boolean {
  if (candidate.identityId !== null && candidate.identityId !== (input.identityId ?? null)) {
    return false;
  }
  if (candidate.channel !== null && candidate.channel !== input.channel) return false;
  if (candidate.purpose !== null && candidate.purpose !== input.purpose) return false;
  if (candidate.contactKind !== null && candidate.contactKind !== (input.contactKind ?? null)) {
    return false;
  }
  return true;
}

function specificityOf(candidate: Cg3PreferenceCandidate): number {
  return (
    (candidate.identityId !== null ? 1 : 0) +
    (candidate.channel !== null ? 1 : 0) +
    (candidate.purpose !== null ? 1 : 0) +
    (candidate.contactKind !== null ? 1 : 0)
  );
}

const DECISION_RESTRICTIVENESS: Record<Cg3PreferenceDecision, number> = {
  BLOCK: 0,
  DEFER: 1,
  ALLOW: 2,
};

/** subset-containment specificity + restrictive tie-break (BLOCK > DEFER > ALLOW) per #101 §1 */
export function resolveEffectivePreference(
  candidates: readonly Cg3PreferenceCandidate[],
  input: Cg3EvaluationInput,
): Cg3PreferenceCandidate | undefined {
  const matches: ScopeMatch[] = candidates
    .filter((candidate) => preferenceMatches(candidate, input))
    .map((candidate) => ({ candidate, specificity: specificityOf(candidate) }));
  if (matches.length === 0) return undefined;

  const maxSpecificity = Math.max(...matches.map((match) => match.specificity));
  const winners = matches.filter((match) => match.specificity === maxSpecificity);
  if (winners.length === 1) return winners[0]!.candidate;

  winners.sort((left, right) => {
    const leftDecision = left.candidate.decision ?? 'ALLOW';
    const rightDecision = right.candidate.decision ?? 'ALLOW';
    return DECISION_RESTRICTIVENESS[leftDecision] - DECISION_RESTRICTIVENESS[rightDecision];
  });
  return winners[0]!.candidate;
}

// ---- Timezone / local-time window matching --------------------------------

const WEEKDAY_MAP: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function zonedPartsAt(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour === '24' ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_MAP[parts.weekday ?? 'Mon'] ?? 1,
  };
}

/** convert a wall-clock time in an IANA timezone back to a UTC instant with fixed-point correction (enough for DST) */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const displayed = zonedPartsAt(new Date(guess), timeZone);
    const displayedUtc = Date.UTC(
      displayed.year,
      displayed.month - 1,
      displayed.day,
      displayed.hour,
      displayed.minute,
      0,
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    guess += target - displayedUtc;
  }
  return new Date(guess);
}

function localDateKey(parts: ZonedParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function withinWindow(window: LocalTimeWindow, weekday: number, minuteOfDay: number): boolean {
  if (!window.daysOfWeek.includes(weekday)) return false;
  const [startHour, startMinute] = window.startLocal.split(':').map(Number);
  const [endHour, endMinute] = window.endLocal.split(':').map(Number);
  const start = startHour! * 60 + startMinute!;
  const end = endHour! * 60 + endMinute!;
  if (end > start) return minuteOfDay >= start && minuteOfDay < end;
  // cross-midnight window: [start, 24:00) ∪ [0, end)
  return minuteOfDay >= start || minuteOfDay < end;
}

function anyWindowMatches(
  windows: readonly LocalTimeWindow[],
  weekday: number,
  minuteOfDay: number,
): boolean {
  return windows.some((window) => withinWindow(window, weekday, minuteOfDay));
}

export interface TemporalEvaluation {
  eligible: boolean;
  reasonCode?: 'PREFERENCE_WINDOW_CLOSED' | 'QUIET_HOURS' | 'TENANT_HOLIDAY';
  matchedWindowRef?: string;
}

/** evaluate at a single point in time: holiday > quiet hours > preferred windows (in order of specificity) */
function evaluateInstant(
  parts: ZonedParts,
  preferredWindows: readonly LocalTimeWindow[],
  quietHours: readonly LocalTimeWindow[],
  holidays: readonly Cg3HolidayEntry[],
): TemporalEvaluation {
  const dateKey = localDateKey(parts);
  const holiday = holidays.find((entry) => entry.localDate === dateKey);
  if (holiday) {
    if (holiday.effect === 'CLOSED') {
      return {
        eligible: false,
        reasonCode: 'TENANT_HOLIDAY',
        matchedWindowRef: `holiday:${dateKey}`,
      };
    }
    if (!anyWindowMatches(holiday.windows, parts.weekday, parts.hour * 60 + parts.minute)) {
      return {
        eligible: false,
        reasonCode: 'TENANT_HOLIDAY',
        matchedWindowRef: `holiday:${dateKey}`,
      };
    }
  }
  const minuteOfDay = parts.hour * 60 + parts.minute;
  if (anyWindowMatches(quietHours, parts.weekday, minuteOfDay)) {
    return { eligible: false, reasonCode: 'QUIET_HOURS', matchedWindowRef: 'policy:quietHours' };
  }
  if (
    preferredWindows.length > 0 &&
    !anyWindowMatches(preferredWindows, parts.weekday, minuteOfDay)
  ) {
    return {
      eligible: false,
      reasonCode: 'PREFERENCE_WINDOW_CLOSED',
      matchedWindowRef: 'preference:preferredWindows',
    };
  }
  return { eligible: true };
}

const NEXT_ELIGIBLE_MAX_LOOKAHEAD_DAYS = 30;
const NEXT_ELIGIBLE_STEP_MINUTES = 5;

/** bounded forward scan to find the first instant that passes every temporal gate; undefined if none is found within the lookahead */
function findNextEligibleAt(
  now: Date,
  timeZone: string,
  preferredWindows: readonly LocalTimeWindow[],
  quietHours: readonly LocalTimeWindow[],
  holidays: readonly Cg3HolidayEntry[],
): Date | undefined {
  const horizon = NEXT_ELIGIBLE_MAX_LOOKAHEAD_DAYS * 24 * 60;
  for (
    let offsetMinutes = 0;
    offsetMinutes <= horizon;
    offsetMinutes += NEXT_ELIGIBLE_STEP_MINUTES
  ) {
    const candidate = new Date(now.getTime() + offsetMinutes * 60_000);
    const parts = zonedPartsAt(candidate, timeZone);
    const evaluation = evaluateInstant(parts, preferredWindows, quietHours, holidays);
    if (evaluation.eligible) {
      return zonedToUtc(parts.year, parts.month, parts.day, parts.hour, parts.minute, timeZone);
    }
  }
  return undefined;
}

// ---- Callback exception ----------------------------------------------------

/**
 * CG4.4 (#187): an Approved exception lifts a provisional failure only when every scope
 * dimension matches exactly and its pinned policy/registry binding is still current.
 * `seriesId` narrows the search to one series, which is how a CG3 callback's
 * `approvedExceptionId` reference is validated against canonical state.
 */
function approvedExceptionFor(
  input: Cg3EvaluationInput,
  reasonCode: string,
  seriesId?: string,
): Cg4AppliedExceptionPin | undefined {
  const candidates = input.activeExceptions ?? [];
  if (candidates.length === 0 || input.source === undefined || input.sourceId === undefined) {
    return undefined;
  }
  const coverage = resolveCg4ExceptionCoverage({
    exceptions: seriesId ? candidates.filter((entry) => entry.seriesId === seriesId) : candidates,
    context: {
      ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
      channel: input.channel,
      purpose: input.purpose,
      source: input.source,
      sourceId: input.sourceId,
      now: input.now,
    },
    reasonCode,
  });
  return coverage.covered ? coverage.pin : undefined;
}

function callbackIsExactScopeMatch(callback: Cg3CallbackFacts, input: Cg3EvaluationInput): boolean {
  return (
    callback.identityId === (input.identityId ?? null) &&
    callback.channel === input.channel &&
    callback.purpose === input.purpose
  );
}

// ---- Top-level orchestrator -------------------------------------------------

/**
 * continues only from a C1 gate (IDENTITY/HARD_RESTRICTION/CONSENT) that has already passed
 * order: PREFERENCE -> TEMPORAL_POLICY -> CALLBACK_EXCEPTION (only when the temporal result is provisional)
 *        -> ATTEMPT_TOUCH_CAP -> SENDER_IDENTITY
 * returns a decision when any CG3 gate determines a definitive result; returns no decision when all pass (the caller declares ALLOW itself)
 */
export function evaluateCg3Policy(input: Cg3EvaluationInput): Cg3GateOutcome {
  const trace: ContactPolicyTraceEntry[] = [];

  // --- PREFERENCE ---
  const winner = resolveEffectivePreference(input.preferences, input);
  if (winner && winner.decision && winner.decision !== 'ALLOW') {
    trace.push({
      gate: 'PREFERENCE',
      outcome: winner.decision,
      reasonCode: REASON.PREFERENCE_BLOCKED,
    });
    return {
      trace,
      decision: winner.decision,
      reasonCode: REASON.PREFERENCE_BLOCKED,
      preferenceVersion: winner.version,
      matchedScope: {
        identityId: winner.identityId,
        channel: winner.channel,
        purpose: winner.purpose,
        contactKind: winner.contactKind,
      },
    };
  }
  trace.push({ gate: 'PREFERENCE', outcome: 'PASS' });

  // --- TEMPORAL_POLICY ---
  const timezoneChain: Array<{ value: string | null | undefined; source: string }> = [
    { value: winner?.timezone, source: 'PREFERENCE' },
    { value: input.customerExplicitTimezone, source: 'CUSTOMER_EXPLICIT' },
    { value: input.customer360Timezone, source: 'CUSTOMER_360' },
    { value: input.policy?.timezoneFallback, source: 'POLICY_FALLBACK' },
    { value: input.tenantDefaultTimezone, source: 'TENANT_DEFAULT' },
  ];
  const resolvedTimezone = timezoneChain.find(
    (candidate) => candidate.value && isValidTimeZone(candidate.value),
  );

  const preferredWindows = winner?.preferredWindows ?? [];
  const quietHours = input.policy?.quietHours ?? [];
  const holidays = input.policy?.holidays ?? [];
  const hasTemporalConstraint =
    preferredWindows.length > 0 || quietHours.length > 0 || holidays.length > 0;

  if (hasTemporalConstraint && !resolvedTimezone) {
    trace.push({ gate: 'TEMPORAL_POLICY', outcome: 'DEFER', reasonCode: REASON.TIMEZONE_UNKNOWN });
    return {
      trace,
      decision: 'DEFER',
      reasonCode: REASON.TIMEZONE_UNKNOWN,
      preferenceVersion: winner?.version,
    };
  }

  let temporalBlock:
    | {
        reasonCode: 'PREFERENCE_WINDOW_CLOSED' | 'QUIET_HOURS' | 'TENANT_HOLIDAY';
        matchedWindowRef?: string;
      }
    | undefined;
  let nextEligibleAt: string | undefined;

  if (hasTemporalConstraint && resolvedTimezone) {
    const nowParts = zonedPartsAt(input.now, resolvedTimezone.value!);
    const evaluation = evaluateInstant(nowParts, preferredWindows, quietHours, holidays);
    if (!evaluation.eligible) {
      temporalBlock = {
        reasonCode: evaluation.reasonCode!,
        matchedWindowRef: evaluation.matchedWindowRef,
      };
      const found = findNextEligibleAt(
        input.now,
        resolvedTimezone.value!,
        preferredWindows,
        quietHours,
        holidays,
      );
      nextEligibleAt = found?.toISOString();
    }
  }

  const appliedExceptions: Cg4AppliedExceptionPin[] = [];
  // make it clear "who" lifted the provisional block: a callback that is actually used must be consumed as
  // one-use, while an exception that lifts it by itself does not touch the callback at all
  let callbackOverrodeBlock = false;

  if (temporalBlock) {
    // A valid customer callback owns the override when it applies: it is one-use evidence
    // that this send exercised, so it must be consumed rather than bypassed. In
    // TIME_POLICY_OVERRIDE mode it additionally needs a resolving Approved exception
    // behind it, which is then pinned by the callback path itself.
    const callbackMode = input.policy?.callbackMode ?? 'SCOPED_OVERRIDE';
    const pendingCallback = input.activeCallback;
    const callbackWillOverride =
      pendingCallback !== undefined &&
      callbackMode !== 'NO_OVERRIDE' &&
      callbackIsExactScopeMatch(pendingCallback, input) &&
      new Date(pendingCallback.expiresAt) > input.now &&
      (input.policy?.overridableRules.includes(temporalBlock.reasonCode) ?? false) &&
      (callbackMode !== 'TIME_POLICY_OVERRIDE' ||
        approvedExceptionFor(
          input,
          temporalBlock.reasonCode,
          pendingCallback.approvedExceptionId ?? undefined,
        ) !== undefined);

    // Otherwise an Approved exception is its own override mechanism: it depends on the
    // exception's own pinned CG4 policy allowlist, not on CG3's `overridableRules`, so it
    // can lift a rule that CG3 alone would treat as final.
    const appliedException = callbackWillOverride
      ? undefined
      : approvedExceptionFor(input, temporalBlock.reasonCode);
    if (appliedException) {
      trace.push({
        gate: 'TEMPORAL_POLICY',
        outcome: 'DEFER',
        reasonCode: temporalBlock.reasonCode,
      });
      trace.push({
        gate: 'APPROVED_EXCEPTION',
        outcome: 'PASS',
        reasonCode: REASON.APPROVED_EXCEPTION_APPLIED,
      });
      appliedExceptions.push(appliedException);
    } else {
      const overridable =
        input.policy?.overridableRules.includes(temporalBlock.reasonCode) ?? false;
      if (!overridable) {
        trace.push({
          gate: 'TEMPORAL_POLICY',
          outcome: 'DEFER',
          reasonCode: temporalBlock.reasonCode,
        });
        return {
          trace,
          decision: 'DEFER',
          reasonCode: temporalBlock.reasonCode,
          preferenceVersion: winner?.version,
          nextEligibleAt,
          timezoneSource: resolvedTimezone?.source,
          matchedWindowRef: temporalBlock.matchedWindowRef,
        };
      }
      trace.push({
        gate: 'TEMPORAL_POLICY',
        outcome: 'DEFER',
        reasonCode: temporalBlock.reasonCode,
      });

      // --- CALLBACK_EXCEPTION (only when the temporal result is provisional/overridable) ---
      const mode = input.policy?.callbackMode ?? 'SCOPED_OVERRIDE';
      const callback = input.activeCallback;
      const callbackScopeMatches = callback ? callbackIsExactScopeMatch(callback, input) : false;
      const callbackExpired = callback ? new Date(callback.expiresAt) <= input.now : false;

      if (mode === 'NO_OVERRIDE' || !callback) {
        trace.push({
          gate: 'CALLBACK_EXCEPTION',
          outcome: 'DEFER',
          reasonCode: callback ? REASON.CALLBACK_OVERRIDE_NOT_ALLOWED : temporalBlock.reasonCode,
        });
        return {
          trace,
          decision: 'DEFER',
          reasonCode: callback ? REASON.CALLBACK_OVERRIDE_NOT_ALLOWED : temporalBlock.reasonCode,
          preferenceVersion: winner?.version,
          nextEligibleAt,
          timezoneSource: resolvedTimezone?.source,
          matchedWindowRef: temporalBlock.matchedWindowRef,
        };
      }
      if (!callbackScopeMatches) {
        trace.push({
          gate: 'CALLBACK_EXCEPTION',
          outcome: 'DEFER',
          reasonCode: REASON.CALLBACK_OVERRIDE_NOT_ALLOWED,
        });
        return {
          trace,
          decision: 'DEFER',
          reasonCode: REASON.CALLBACK_OVERRIDE_NOT_ALLOWED,
          preferenceVersion: winner?.version,
          nextEligibleAt,
          timezoneSource: resolvedTimezone?.source,
          matchedWindowRef: temporalBlock.matchedWindowRef,
        };
      }
      if (callbackExpired) {
        trace.push({
          gate: 'CALLBACK_EXCEPTION',
          outcome: 'DEFER',
          reasonCode: REASON.CALLBACK_OVERRIDE_EXPIRED,
        });
        return {
          trace,
          decision: 'DEFER',
          reasonCode: REASON.CALLBACK_OVERRIDE_EXPIRED,
          preferenceVersion: winner?.version,
          nextEligibleAt,
          timezoneSource: resolvedTimezone?.source,
          matchedWindowRef: temporalBlock.matchedWindowRef,
        };
      }
      // TIME_POLICY_OVERRIDE needs a real Approved exception behind it: a reference that does not resolve to an
      // exception that is active/in scope/matching the rule counts as absent (fail closed) without changing the callback mode
      const referencedException = callback.approvedExceptionId
        ? approvedExceptionFor(input, temporalBlock.reasonCode, callback.approvedExceptionId)
        : undefined;
      if (mode === 'TIME_POLICY_OVERRIDE' && !referencedException) {
        trace.push({
          gate: 'CALLBACK_EXCEPTION',
          outcome: 'REVIEW',
          reasonCode: REASON.EXCEPTION_APPROVAL_REQUIRED,
        });
        return {
          trace,
          decision: 'REVIEW',
          reasonCode: REASON.EXCEPTION_APPROVAL_REQUIRED,
          preferenceVersion: winner?.version,
          nextEligibleAt,
          timezoneSource: resolvedTimezone?.source,
          matchedWindowRef: temporalBlock.matchedWindowRef,
        };
      }

      // valid override: lift the provisional temporal block and continue (not an immediate ALLOW)
      trace.push({
        gate: 'CALLBACK_EXCEPTION',
        outcome: 'PASS',
        reasonCode: REASON.CUSTOMER_REQUESTED_CALLBACK,
      });
      callbackOverrodeBlock = true;
      if (referencedException) appliedExceptions.push(referencedException);
    }
  } else {
    trace.push({ gate: 'TEMPORAL_POLICY', outcome: 'PASS' });
  }

  // --- ATTEMPT_TOUCH_CAP ---
  // no cap threshold has been decided in #101/#98 yet (no field paired with quiet hours/preference);
  // keep the trace slot open as an always-PASS until a ticket defines the cap policy specifically
  trace.push({ gate: 'ATTEMPT_TOUCH_CAP', outcome: 'PASS' });

  // --- SENDER_IDENTITY ---
  // the authority table (cg_sender_identity) is not frozen yet: it belongs to S1.6 (LINE DeliveryPort pilot);
  // S1.2 opens the trace slot and checks only syntactic non-empty so as not to break the contract in future
  if (input.senderIdentityId !== undefined && input.senderIdentityId.trim().length === 0) {
    trace.push({
      gate: 'SENDER_IDENTITY',
      outcome: 'BLOCK',
      reasonCode: 'SENDER_IDENTITY_INVALID',
    });
    return {
      trace,
      decision: 'BLOCK',
      reasonCode: 'SENDER_IDENTITY_INVALID',
      preferenceVersion: winner?.version,
      timezoneSource: resolvedTimezone?.source,
    };
  }
  trace.push({ gate: 'SENDER_IDENTITY', outcome: 'PASS' });

  return {
    trace,
    preferenceVersion: winner?.version,
    timezoneSource: hasTemporalConstraint ? resolvedTimezone?.source : undefined,
    ...(temporalBlock ? { matchedWindowRef: temporalBlock.matchedWindowRef } : {}),
    ...(input.policy && temporalBlock
      ? { exceptionMode: input.policy.callbackMode, exceptionRef: input.activeCallback?.requestId }
      : {}),
    ...(input.activeCallback && callbackOverrodeBlock
      ? { consumedCallbackRequestId: input.activeCallback.requestId }
      : {}),
    ...(appliedExceptions.length > 0 ? { appliedExceptions } : {}),
  };
}

export { zonedPartsAt, zonedToUtc, isValidTimeZone };
