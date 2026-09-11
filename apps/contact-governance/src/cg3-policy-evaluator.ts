import type {
  ContactChannel,
  ContactDecision,
  ContactPolicyTraceEntry,
} from '@d-contact/cxa-contracts';
import type { LocalTimeWindow } from './cg3-persistence.js';

/**
 * Pure, deterministic CG3 gate evaluator ตาม decision #101/#98 ของ
 * "แผนที่ Wayfinder: S1 — Safe delivery" (#97). ไม่มี I/O; caller (service) โหลด facts
 * จาก database ก่อนแล้วส่งเข้ามาเป็น input ล้วน ๆ เพื่อให้ทดสอบและ replay ได้แบบ deterministic
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
  /** ชื่อ reason ของ temporal rule ที่ policy นี้อนุญาตให้ callback exception override ได้ */
  overridableRules: string[];
  holidays: Cg3HolidayEntry[];
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
  /** ลำดับ timezone authority: customer-explicit -> Customer 360 ที่ verified -> tenant default */
  customerExplicitTimezone?: string | null;
  customer360Timezone?: string | null;
  tenantDefaultTimezone?: string | null;
  preferences: Cg3PreferenceCandidate[];
  policy?: Cg3PolicyFacts;
  activeCallback?: Cg3CallbackFacts;
}

export interface Cg3GateOutcome {
  trace: ContactPolicyTraceEntry[];
  /** undefined = ผ่านทุก CG3 gate แล้ว (caller ประกาศ ALLOW/POLICY_PASSED เอง) */
  decision?: ContactDecision;
  reasonCode?: string;
  preferenceVersion?: number;
  nextEligibleAt?: string;
  timezoneSource?: string;
  matchedScope?: Record<string, string | null>;
  matchedWindowRef?: string;
  exceptionMode?: Cg3CallbackMode;
  exceptionRef?: string;
  /** ถ้ามี callback ที่ valid และถูกใช้ override จริง ให้ service consume มันแบบ atomic */
  consumedCallbackRequestId?: string;
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

/** subset-containment specificity + restrictive tie-break (BLOCK > DEFER > ALLOW) ตาม #101 §1 */
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

/** แปลง wall-clock ใน IANA timezone กลับเป็น UTC instant ด้วย fixed-point correction (พอสำหรับ DST) */
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

/** ประเมิน ณ จุดเวลาเดียว: holiday > quiet hours > preferred windows (ตามลำดับความจำเพาะ) */
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

/** สแกนไปข้างหน้าแบบ bounded เพื่อหา instant แรกที่ผ่านทุก temporal gate; undefined ถ้าไม่พบภายใน lookahead */
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

function callbackIsExactScopeMatch(callback: Cg3CallbackFacts, input: Cg3EvaluationInput): boolean {
  return (
    callback.identityId === (input.identityId ?? null) &&
    callback.channel === input.channel &&
    callback.purpose === input.purpose
  );
}

// ---- Top-level orchestrator -------------------------------------------------

/**
 * เดินต่อจาก C1 gate (IDENTITY/HARD_RESTRICTION/CONSENT) ที่ผ่านแล้วเท่านั้น
 * ลำดับ: PREFERENCE -> TEMPORAL_POLICY -> CALLBACK_EXCEPTION (เฉพาะเมื่อ temporal provisional)
 *        -> ATTEMPT_TOUCH_CAP -> SENDER_IDENTITY
 * คืน decision เมื่อ CG3 gate ใดกำหนดผลเด็ดขาด; คืนไม่มี decision เมื่อผ่านครบ (caller ประกาศ ALLOW เอง)
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

  if (temporalBlock) {
    const overridable = input.policy?.overridableRules.includes(temporalBlock.reasonCode) ?? false;
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

    // --- CALLBACK_EXCEPTION (เฉพาะเมื่อ temporal เป็น provisional/overridable) ---
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
    if (mode === 'TIME_POLICY_OVERRIDE' && !callback.approvedExceptionId) {
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

    // valid override: ยก provisional temporal block แล้วเดินต่อ (ไม่ใช่ ALLOW ทันที)
    trace.push({
      gate: 'CALLBACK_EXCEPTION',
      outcome: 'PASS',
      reasonCode: REASON.CUSTOMER_REQUESTED_CALLBACK,
    });
  } else {
    trace.push({ gate: 'TEMPORAL_POLICY', outcome: 'PASS' });
  }

  // --- ATTEMPT_TOUCH_CAP ---
  // ยังไม่มี cap threshold ที่ decide ไว้ใน #101/#98 (ไม่มี field คู่กับ quiet hours/preference);
  // เปิด trace slot ไว้แบบ PASS เสมอจนกว่าจะมี ticket กำหนด cap policy โดยเฉพาะ
  trace.push({ gate: 'ATTEMPT_TOUCH_CAP', outcome: 'PASS' });

  // --- SENDER_IDENTITY ---
  // authority table (cg_sender_identity) ยังไม่ freeze — เป็นของ S1.6 (LINE DeliveryPort pilot);
  // S1.2 เปิด trace slot และตรวจแค่ syntactic non-empty เพื่อไม่ break contract ในอนาคต
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
    ...(input.activeCallback && temporalBlock
      ? { consumedCallbackRequestId: input.activeCallback.requestId }
      : {}),
  };
}

export { zonedPartsAt, zonedToUtc, isValidTimeZone };
