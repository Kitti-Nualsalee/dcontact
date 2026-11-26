/**
 * Owner: Delivery/Channels — atomic simulated caps of the LINE profile (S1.6, decision #102 §6)
 *
 * The fixture cap is a test contract, not the real LINE quota/SLA. Enforced per a single scope tuple
 * (tenant + LINE + senderIdentityId) only — a guard for another tenant/sender always has its
 * own separate counter because the key is bound to the scope, not to the whole process.
 */
import { LINE_SIMULATION_CAPS, scopeKey, type LineScopeTuple } from './line-simulation-fixture.js';

export type LineCapExceededCode =
  | 'SUBMISSION_WINDOW_CAP_EXCEEDED'
  | 'CONCURRENT_SUBMISSION_CAP_EXCEEDED'
  | 'CONTACT_WINDOW_CAP_EXCEEDED'
  | 'CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED';

export class LineCapExceededError extends Error {
  constructor(readonly code: LineCapExceededCode) {
    super(`simulated cap of the LINE profile exceeded: ${code}`);
    this.name = 'LineCapExceededError';
  }
}

interface ScopeCounters {
  submissionTimestampsMs: number[];
  contactSubmissionTimestampsMs: Map<string, number[]>;
  concurrentSubmissions: number;
  unknownReconcilingStartedAtMs: Map<string, number>;
}

export class LineCapsTracker {
  private readonly scopes = new Map<string, ScopeCounters>();

  private stateFor(scope: LineScopeTuple): ScopeCounters {
    const key = scopeKey(scope);
    let state = this.scopes.get(key);
    if (!state) {
      state = {
        submissionTimestampsMs: [],
        contactSubmissionTimestampsMs: new Map(),
        concurrentSubmissions: 0,
        unknownReconcilingStartedAtMs: new Map(),
      };
      this.scopes.set(key, state);
    }
    return state;
  }

  private prune(timestamps: number[], nowMs: number): number[] {
    const cutoff = nowMs - LINE_SIMULATION_CAPS.windowMs;
    return timestamps.filter((ts) => ts > cutoff);
  }

  /** Must be called before crossing the submission barrier only; does not mutate when the cap is exceeded */
  reserveSubmission(scope: LineScopeTuple, contactId: string, nowMs: number): void {
    const state = this.stateFor(scope);
    const windowSubmissions = this.prune(state.submissionTimestampsMs, nowMs);
    if (windowSubmissions.length >= LINE_SIMULATION_CAPS.maxSubmissionsPerWindow) {
      throw new LineCapExceededError('SUBMISSION_WINDOW_CAP_EXCEEDED');
    }
    if (state.concurrentSubmissions >= LINE_SIMULATION_CAPS.maxConcurrentSubmissions) {
      throw new LineCapExceededError('CONCURRENT_SUBMISSION_CAP_EXCEEDED');
    }
    const contactSubmissions = this.prune(
      state.contactSubmissionTimestampsMs.get(contactId) ?? [],
      nowMs,
    );
    if (contactSubmissions.length >= LINE_SIMULATION_CAPS.maxSubmissionsPerContactPerWindow) {
      throw new LineCapExceededError('CONTACT_WINDOW_CAP_EXCEEDED');
    }

    windowSubmissions.push(nowMs);
    contactSubmissions.push(nowMs);
    state.submissionTimestampsMs = windowSubmissions;
    state.contactSubmissionTimestampsMs.set(contactId, contactSubmissions);
    state.concurrentSubmissions += 1;
  }

  /** Called when a delivery reaches a terminal outcome (settled/cancelled/released) to return the concurrent allowance */
  releaseSubmission(scope: LineScopeTuple): void {
    const state = this.stateFor(scope);
    state.concurrentSubmissions = Math.max(0, state.concurrentSubmissions - 1);
  }

  enterUnknownReconciling(scope: LineScopeTuple, deliveryId: string, nowMs: number): void {
    const state = this.stateFor(scope);
    if (
      state.unknownReconcilingStartedAtMs.size >=
        LINE_SIMULATION_CAPS.maxConcurrentUnknownReconciling &&
      !state.unknownReconcilingStartedAtMs.has(deliveryId)
    ) {
      throw new LineCapExceededError('CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED');
    }
    state.unknownReconcilingStartedAtMs.set(deliveryId, nowMs);
  }

  exitUnknownReconciling(scope: LineScopeTuple, deliveryId: string): void {
    this.stateFor(scope).unknownReconcilingStartedAtMs.delete(deliveryId);
  }

  /** deliveryIds stuck unknown beyond the threshold per the current virtual clock — the caller orders a kill */
  findTimedOutUnknownReconciling(scope: LineScopeTuple, nowMs: number): string[] {
    const state = this.stateFor(scope);
    const timeout = LINE_SIMULATION_CAPS.unknownReconcilingTimeoutMs;
    return [...state.unknownReconcilingStartedAtMs.entries()]
      .filter(([, startedAtMs]) => nowMs - startedAtMs > timeout)
      .map(([deliveryId]) => deliveryId);
  }
}
