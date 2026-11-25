/** S1.5 metrics use only the metric name and numbers; never put tenant/action/contact as a label. */
export type JourneyGovernanceMetric =
  | 'journey_cg3_mutation_to_apply_ms'
  | 'journey_cg3_stale_revalidation_total'
  | 'journey_cg3_pre_barrier_cancellation_total'
  | 'journey_cg3_post_barrier_cancellation_total'
  | 'journey_cg3_version_gap_total'
  | 'journey_cg3_hash_conflict_total'
  | 'journey_cg3_reconcile_age_ms'
  | 'journey_cg3_reconcile_backlog'
  // CG4.8 (#191)
  | 'journey_cg4_duplicate_total'
  | 'journey_cg4_relaxation_noop_total'
  | 'journey_cg4_kill_switch_hold_total'
  | 'journey_cg4_unsupported_contract_total'
  | 'journey_cg4_canonical_reload_total';

export interface JourneyGovernanceMetrics {
  increment(
    metric: Exclude<
      JourneyGovernanceMetric,
      | 'journey_cg3_mutation_to_apply_ms'
      | 'journey_cg3_reconcile_age_ms'
      | 'journey_cg3_reconcile_backlog'
    >,
  ): void;
  observe(
    metric: Extract<
      JourneyGovernanceMetric,
      | 'journey_cg3_mutation_to_apply_ms'
      | 'journey_cg3_reconcile_age_ms'
      | 'journey_cg3_reconcile_backlog'
    >,
    value: number,
  ): void;
}

export const noOpJourneyGovernanceMetrics: JourneyGovernanceMetrics = {
  increment() {},
  observe() {},
};

/** Emits a structured log the metric backend can keep, without any PII or identifier. */
export class JsonJourneyGovernanceMetrics implements JourneyGovernanceMetrics {
  increment(metric: Parameters<JourneyGovernanceMetrics['increment']>[0]): void {
    console.info(JSON.stringify({ metric, value: 1 }));
  }

  observe(metric: Parameters<JourneyGovernanceMetrics['observe']>[0], value: number): void {
    console.info(JSON.stringify({ metric, value: Math.max(0, value) }));
  }
}
