/**
 * J2.8 (#136) — PII-safe observability of the owner command/result path
 *
 * Closes the last item of the out-of-scope list in the original PR #149. The relay/consumer/escalator worked
 * completely silently, with no way to tell from outside how many commands were stuck, how many results were rejected by binding,
 * or how many escalated actions were waiting
 *
 * The same contract as `journey-governance-metrics.ts` of S1.5 and the reason this interface
 * **accepts no labels at all**: metrics of the owner path involve tenant, actionKey,
 * commandId and contactId, and if a label slot were ever opened someone would put these values
 * in by accident and they would flow to the metric backend, which has longer retention and broader access
 * than the database — cutting it off at the type level is safer than a warning in code review
 *
 * To investigate which one has a problem, use `JrRecoveryAudit` with the admin recovery API (#235), which lives
 * inside the tenant boundary and has real access control, not metrics
 */

/** counter — a pure count of occurrences */
export type JourneyOwnerCounterMetric =
  | 'journey_owner_command_dispatched_total'
  | 'journey_owner_command_dispatch_failed_total'
  | 'journey_owner_result_applied_total'
  | 'journey_owner_result_duplicate_total'
  | 'journey_owner_result_conflict_total'
  | 'journey_owner_result_binding_rejected_total'
  | 'journey_owner_ack_unknown_total'
  | 'journey_owner_ack_reconciled_total'
  | 'journey_owner_ack_escalated_total';

/** gauge/histogram — a measured numeric value */
export type JourneyOwnerGaugeMetric =
  'journey_owner_dispatch_to_result_ms' | 'journey_owner_ack_attempts';

export type JourneyOwnerMetric = JourneyOwnerCounterMetric | JourneyOwnerGaugeMetric;

/**
 * no label parameter on purpose — see the doc above
 */
export interface JourneyOwnerMetrics {
  increment(metric: JourneyOwnerCounterMetric): void;
  observe(metric: JourneyOwnerGaugeMetric, value: number): void;
}

export const noOpJourneyOwnerMetrics: JourneyOwnerMetrics = {
  increment() {},
  observe() {},
};

/** a structured log the metric backend can keep, with no identifier attached */
export class JsonJourneyOwnerMetrics implements JourneyOwnerMetrics {
  increment(metric: JourneyOwnerCounterMetric): void {
    console.info(JSON.stringify({ metric, value: 1 }));
  }

  observe(metric: JourneyOwnerGaugeMetric, value: number): void {
    console.info(JSON.stringify({ metric, value: Math.max(0, value) }));
  }
}
