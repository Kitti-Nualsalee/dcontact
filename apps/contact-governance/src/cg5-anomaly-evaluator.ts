import { CG5_RULE_CODES, cg5RuleMetadata, type Cg5RuleCode } from '@d-contact/cxa-contracts';

export interface Cg5AnomalyObservation {
  readonly ruleCode: Cg5RuleCode;
  readonly value: number;
  readonly baseline: number | null;
  readonly volume: number;
  readonly projectionLagSeconds: number;
  readonly scopePaused: boolean;
}

export type Cg5AnomalyResult =
  | { readonly state: 'OPEN' | 'RESOLVED'; readonly value: number; readonly threshold: number }
  | {
      readonly state: 'SUPPRESSED';
      readonly value: number;
      readonly threshold: number;
      readonly reason: string;
    };

/** CG5.6 (#290): pure rule evaluation; it has no authority to mutate Governance state. */
export function evaluateCg5Anomaly(
  observation: Cg5AnomalyObservation,
  config: { lagSloSeconds: number; anomalyMinimumVolume: number },
  previous: { state: string; consecutiveHits: number } | null,
): Cg5AnomalyResult {
  const metadata = cg5RuleMetadata(observation.ruleCode);
  if (metadata.kind === 'FIXED_THRESHOLD') {
    const threshold = observation.ruleCode === 'CG5_PROJECTION_LAG' ? config.lagSloSeconds : 0;
    const value =
      observation.ruleCode === 'CG5_PROJECTION_LAG'
        ? observation.projectionLagSeconds
        : observation.value;
    return value > threshold
      ? { state: 'OPEN', value, threshold }
      : { state: 'RESOLVED', value, threshold };
  }
  if (observation.scopePaused || observation.projectionLagSeconds > config.lagSloSeconds) {
    return { state: 'SUPPRESSED', value: observation.value, threshold: 0, reason: 'DATA_GAP' };
  }
  if (observation.baseline === null || observation.volume < config.anomalyMinimumVolume) {
    return {
      state: 'SUPPRESSED',
      value: observation.value,
      threshold: 0,
      reason: 'BASELINE_UNAVAILABLE',
    };
  }
  const threshold = observation.baseline * 1.5;
  const hit = observation.value > threshold;
  const needed = previous?.state === 'OPEN' || previous?.state === 'ACKED' ? 0.8 : 1;
  return hit || observation.value > threshold * needed
    ? { state: 'OPEN', value: observation.value, threshold }
    : { state: 'RESOLVED', value: observation.value, threshold };
}

export function cg5AnomalyRuleCodes(): readonly Cg5RuleCode[] {
  return CG5_RULE_CODES;
}
