/**
 * CG4.9 (#192): Hybrid Console logic with no I/O
 *
 * No policy or quorum decision is made here (#174 §1 forbids an alternate evaluator) — only queue ordering,
 * display of redacted references, mapping server errors to recovery states (#180), and the vocabulary
 * that must keep Approve / ALLOW / Activate / Development Complete / Release Enabled clearly separate
 */
import {
  GovernanceApiError,
  type ExceptionSeries,
  type MaybeRedacted,
  type RiskTier,
} from './governance-api.js';

/**
 * Translator for the `governance` namespace — functions in the model accept it instead of importing i18n directly
 * so Node tests can pass a catalog in any language (same as `account`)
 */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** `Intl` locale per UI language (Thai = Buddhist calendar by default for th-TH) */
export function intlLocale(locale: string): string {
  return locale === 'en' ? 'en-GB' : 'th-TH';
}

export type GovernanceViewer = 'SUPERVISOR' | 'TENANT_ADMIN' | 'COMPLIANCE';
export type GovernanceSection = 'overview' | 'exceptions' | 'policies' | 'audit';

/**
 * One vocabulary across the Console: an approval is not a runtime decision and is not opening traffic
 * text lives in the `governance` catalog under `vocabulary` (approve / activate / developmentComplete)
 */

const RISK_RANK: Readonly<Record<RiskTier, number>> = { EMERGENCY: 0, HIGH: 1, STANDARD: 2 };

/** queue order: items still awaiting a decision first, then higher risk first, then earlier expiry first (#180 A) */
export function sortExceptionQueue(items: readonly ExceptionSeries[]): ExceptionSeries[] {
  return [...items].sort((left, right) => {
    const pending =
      Number(right.workflowState === 'PENDING') - Number(left.workflowState === 'PENDING');
    if (pending !== 0) return pending;
    const risk = RISK_RANK[left.riskTier] - RISK_RANK[right.riskTier];
    if (risk !== 0) return risk;
    return new Date(left.expiresAt).getTime() - new Date(right.expiresAt).getTime();
  });
}

export function isRedacted(
  ref: MaybeRedacted | undefined,
): ref is { redacted: true; digest: string } {
  return typeof ref === 'object' && ref !== null && ref.redacted === true;
}

/** a redacted reference is always shown as a short digest and can never reveal content from the Console side */
export function referenceLabel(ref: MaybeRedacted | undefined, t: Translate): string {
  if (ref === undefined) return '—';
  if (isRedacted(ref)) return t('reference.redacted', { tail: ref.digest.slice(-6) });
  return ref;
}

export function digestLabel(digest: string | undefined): string {
  return digest ? `…${digest.slice(-8)}` : '—';
}

/** status must have text and a symbol, never color alone */
export function riskLabel(tier: RiskTier): string {
  return { EMERGENCY: '▲▲ EMERGENCY', HIGH: '▲ HIGH', STANDARD: '● STANDARD' }[tier];
}

export function stateLabel(state: string): string {
  const symbol =
    state === 'ACTIVE' || state === 'APPROVED'
      ? '✓'
      : state === 'PENDING' || state === 'IN_REVIEW' || state === 'SCHEDULED'
        ? '○'
        : state === 'REJECTED' || state === 'REVOKED' || state === 'CANCELLED'
          ? '✕'
          : '•';
  return `${symbol} ${state.replaceAll('_', ' ')}`;
}

export type RecoveryKind =
  | 'STALE_APPROVAL'
  | 'VERSION_CONFLICT'
  | 'HEAD_CONFLICT'
  | 'OUTCOME_UNKNOWN'
  | 'FORBIDDEN'
  | 'LIFECYCLE_BLOCKED'
  | 'NOT_FOUND'
  | 'INVALID';

export interface RecoveryState {
  kind: RecoveryKind;
  code?: string;
  message: string;
  /**
   * - `RELOAD` reload the canonical state, then decide again with a new intent
   * - `SAME_KEY` uncertain result: load state first, resend only with the same Idempotency-Key
   * - `NONE` no action on this page can help
   */
  recovery: 'RELOAD' | 'SAME_KEY' | 'NONE';
}

/** map an error from #179 §3 to a recovery state of #180 — no case picks a winner or merges by itself */
export function recoveryFor(error: unknown, t: Translate): RecoveryState {
  if (!(error instanceof GovernanceApiError)) {
    return {
      kind: 'OUTCOME_UNKNOWN',
      message: t('recovery.message.outcomeUnknown'),
      recovery: 'SAME_KEY',
    };
  }
  const { status, code, details } = error;
  if (code === 'APPROVAL_STALE') {
    return {
      kind: 'STALE_APPROVAL',
      code,
      message: t('recovery.message.approvalStale'),
      recovery: 'RELOAD',
    };
  }
  if (code === 'VERSION_CONFLICT') {
    const versions =
      details.expectedVersion !== undefined && details.actualVersion !== undefined
        ? t('recovery.message.versions', {
            expected: details.expectedVersion,
            actual: details.actualVersion,
          })
        : '';
    return {
      kind: 'VERSION_CONFLICT',
      code,
      message: t('recovery.message.versionConflict', { versions }),
      recovery: 'RELOAD',
    };
  }
  if (
    code === 'POLICY_HEAD_CONFLICT' ||
    code === 'SCHEDULE_CONFLICT' ||
    code === 'POLICY_SCOPE_AMBIGUOUS'
  ) {
    return {
      kind: 'HEAD_CONFLICT',
      code,
      message: t('recovery.message.headConflict'),
      recovery: 'RELOAD',
    };
  }
  if (code === 'IDEMPOTENCY_CONFLICT') {
    return {
      kind: 'INVALID',
      code,
      message: t('recovery.message.idempotencyConflict'),
      recovery: 'RELOAD',
    };
  }
  if (status === 403) {
    const reason =
      code === 'SELF_APPROVAL_FORBIDDEN'
        ? t('recovery.message.selfApproval')
        : code === 'DUPLICATE_CHECKER'
          ? t('recovery.message.duplicateChecker')
          : code === 'DELEGATION_NOT_ALLOWED'
            ? t('recovery.message.delegation')
            : t('recovery.message.forbidden');
    return { kind: 'FORBIDDEN', code, message: reason, recovery: 'NONE' };
  }
  if (status === 404) {
    return {
      kind: 'NOT_FOUND',
      code,
      message: t('recovery.message.notFound'),
      recovery: 'NONE',
    };
  }
  if (status === 422) {
    const quorum =
      code === 'QUORUM_NOT_MET' && details.required !== undefined
        ? ` (${details.current ?? 0}/${details.required})`
        : '';
    return {
      kind: 'LIFECYCLE_BLOCKED',
      code,
      message: t('recovery.message.lifecycle', {
        code: code ?? 'INVALID_LIFECYCLE_TRANSITION',
        quorum,
      }),
      recovery: 'RELOAD',
    };
  }
  if (status >= 500 || status === 0) {
    return {
      kind: 'OUTCOME_UNKNOWN',
      code,
      message: t('recovery.message.unavailable'),
      recovery: 'SAME_KEY',
    };
  }
  return {
    kind: 'INVALID',
    code,
    message: t('recovery.message.invalid', { code: code ?? status }),
    recovery: 'NONE',
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GovernanceLocation {
  section: GovernanceSection;
  contactId?: string;
  seriesId?: string;
  policyId?: string;
  versionId?: string;
}

/**
 * The Console URL accepts only opaque UUIDs — other values are dropped so that no contact identity or
 * evidence ends up in the URL, history or telemetry (#180)
 */
export function parseGovernanceLocation(url: URL): GovernanceLocation {
  const section = url.searchParams.get('section');
  const pick = (name: string) => {
    const value = url.searchParams.get(name);
    return value && UUID.test(value) ? value : undefined;
  };
  const contactId = pick('contactId');
  const seriesId = pick('seriesId');
  const policyId = pick('policyId');
  const versionId = pick('versionId');
  return {
    section:
      section === 'exceptions' || section === 'policies' || section === 'audit'
        ? section
        : 'overview',
    ...(contactId ? { contactId } : {}),
    ...(seriesId ? { seriesId } : {}),
    ...(policyId ? { policyId } : {}),
    ...(versionId ? { versionId } : {}),
  };
}

export function governanceHref(location: GovernanceLocation): string {
  const params = new URLSearchParams({ view: 'governance', section: location.section });
  for (const key of ['contactId', 'seriesId', 'policyId', 'versionId'] as const) {
    const value = location[key];
    if (value && UUID.test(value)) params.set(key, value);
  }
  return `?${params}`;
}

/** viewers who can run a command in each job — the server re-authorizes every time; this only hides buttons known to fail */
export function canDecide(viewer: GovernanceViewer): boolean {
  return viewer === 'COMPLIANCE';
}

export function canRequestChanges(viewer: GovernanceViewer): boolean {
  return viewer === 'COMPLIANCE' || viewer === 'TENANT_ADMIN';
}

export function effectiveWindowLabel(
  startsAt: string,
  expiresAt: string,
  t: Translate,
  locale: string,
): string {
  const format = (value: string) =>
    new Date(value).toLocaleString(intlLocale(locale), {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  return t('window.range', { from: format(startsAt), to: format(expiresAt) });
}
