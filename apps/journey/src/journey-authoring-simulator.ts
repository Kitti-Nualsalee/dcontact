import {
  JOURNEY_AUTHORING_LIMITS,
  JOURNEY_NODE_PORTS,
  sortJourneyDiagnostics,
  type ExpressionEvaluator,
  type JourneyDiagnosticV1,
  type JourneyPortId,
  type PlanPreviewV1,
  type SimulationFixtureV1,
  type SimulationResultV1,
  type SimulationTransitionV1,
} from '@d-contact/cxa-contracts';
import {
  RESTRICTED_NODE_CAPABILITY,
  capabilityAvailable,
  compareText,
  type JourneyRuntimeCapability,
} from './journey-authoring-canonical.js';
import type { JourneyCompileArtifact } from './journey-authoring-compiler.js';
import type { JourneyGraphStep } from './journey-definition.js';
import { ownerResultNextStep, planJourneyStep } from './journey-transition-planner.js';

/**
 * J5.2 (#340): plan preview และ scenario simulation แบบ `SIMULATION_ONLY` (#329 §6–§8)
 *
 * ใช้ planner กลางชุดเดียวกับ runtime (`planJourneyStep`) + manual clock + fixture สังเคราะห์
 * ผลของ SEND และ owner action มาจาก fixture ที่ประกาศไว้เท่านั้น ไม่มี DB, Kafka, Governance,
 * Delivery, owner command หรือ network — ของเหล่านั้นถ้าถูกส่งเข้ามาต้องเป็น `blockedSimulationPort`
 */

export class SimulationSideEffectBlockedError extends Error {
  readonly code = 'SIMULATION_SIDE_EFFECT_BLOCKED' as const;

  constructor(readonly port: string) {
    super(`simulation เรียก side effect ไม่ได้: ${port}`);
    this.name = 'SimulationSideEffectBlockedError';
  }
}

/**
 * port ที่ throw ทันทีเมื่อถูกเรียก method ใดก็ตาม — ใช้แทน repository/publisher/owner port ทุกตัวเมื่อ
 * code path เดียวกันถูกเรียกในโหมดจำลอง เพื่อให้ side effect หลุดออกไปไม่ได้แม้โดยบังเอิญ
 */
export function blockedSimulationPort<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (property === 'then') return undefined;
      return () => {
        throw new SimulationSideEffectBlockedError(`${name}.${String(property)}`);
      };
    },
  });
}

export class ManualClock {
  private current: Date;

  constructor(start: Date) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceTo(next: Date): void {
    if (next < this.current) throw new RangeError('manual clock ถอยหลังไม่ได้');
    this.current = new Date(next);
  }
}

const invalidFixture = (field: string): JourneyDiagnosticV1 => ({
  code: 'PREVIEW_FIXTURE_INVALID',
  severity: 'ERROR',
  stage: 'PREVIEW',
  path: { field },
  messageKey: 'journey.authoring.PREVIEW_FIXTURE_INVALID',
});

function stepsById(artifact: JourneyCompileArtifact) {
  return new Map<string, JourneyGraphStep>(
    artifact.runtimeDefinition.graph.steps.map((step) => [step.id, step]),
  );
}

export function previewJourneyPlan(
  artifact: JourneyCompileArtifact,
  capabilities: readonly JourneyRuntimeCapability[],
): PlanPreviewV1 {
  const restrictedAvailable = capabilityAvailable(capabilities, RESTRICTED_NODE_CAPABILITY);
  const steps = [...artifact.runtimeDefinition.graph.steps]
    .sort((left, right) => compareText(left.id, right.id))
    .map((step) => {
      const outputs = JOURNEY_NODE_PORTS[step.type].outputs as Record<string, string>;
      const restricted = 'onReject' in step;
      return {
        nodeId: step.id,
        type: step.type,
        next: Object.entries(outputs).map(([portId, field]) => ({
          portId: portId as JourneyPortId,
          nodeId: (step as unknown as Record<string, string>)[field]!,
        })),
        capability:
          restricted && !restrictedAvailable
            ? ('RUNTIME_CAPABILITY_UNAVAILABLE' as const)
            : ('AVAILABLE' as const),
      };
    });
  return {
    compileDigest: artifact.compileDigest,
    entryNodeId: artifact.runtimeDefinition.graph.entryStepId,
    steps,
    diagnostics: steps.some((step) => step.capability !== 'AVAILABLE')
      ? [
          {
            code: 'RUNTIME_CAPABILITY_UNAVAILABLE',
            severity: 'ERROR',
            stage: 'PREVIEW',
            messageKey: 'journey.authoring.RUNTIME_CAPABILITY_UNAVAILABLE',
            safeParams: { capability: RESTRICTED_NODE_CAPABILITY },
          },
        ]
      : [],
  };
}

export interface SimulateJourneyDependencies {
  readonly evaluator: ExpressionEvaluator;
  readonly capabilities: readonly JourneyRuntimeCapability[];
}

export function simulateJourneyScenario(
  artifact: JourneyCompileArtifact,
  fixture: SimulationFixtureV1,
  dependencies: SimulateJourneyDependencies,
): SimulationResultV1 {
  const result = (
    terminal: SimulationResultV1['terminal'],
    transitions: SimulationTransitionV1[],
    diagnostics: JourneyDiagnosticV1[] = [],
  ): SimulationResultV1 => ({
    compileDigest: artifact.compileDigest,
    fixtureId: fixture.fixtureId,
    profile: 'SIMULATION_ONLY',
    transitions,
    terminal,
    diagnostics: sortJourneyDiagnostics(diagnostics),
  });

  const start = new Date(fixture.startAt);
  if (Number.isNaN(start.getTime())) return result('EXIT', [], [invalidFixture('startAt')]);
  for (const [key, value] of Object.entries(fixture.context ?? {})) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      return result('EXIT', [], [invalidFixture(`context.${key}`)]);
    }
  }

  const clock = new ManualClock(start);
  const deadline = new Date(
    start.getTime() + artifact.runtimeDefinition.maxDurationDays * 86_400_000,
  );
  const steps = stepsById(artifact);
  const restrictedAvailable = capabilityAvailable(
    dependencies.capabilities,
    RESTRICTED_NODE_CAPABILITY,
  );
  const transitions: SimulationTransitionV1[] = [];
  let stepId: string | undefined = artifact.runtimeDefinition.graph.entryStepId;

  while (stepId) {
    if (transitions.length >= JOURNEY_AUTHORING_LIMITS.simulationTransitions) {
      return result('TRANSITION_LIMIT', transitions, [
        {
          code: 'SIMULATION_LIMIT_EXCEEDED',
          severity: 'ERROR',
          stage: 'PREVIEW',
          messageKey: 'journey.authoring.SIMULATION_LIMIT_EXCEEDED',
          safeParams: { limit: JOURNEY_AUTHORING_LIMITS.simulationTransitions },
        },
      ]);
    }
    const step = steps.get(stepId);
    if (!step) return result('EXIT', transitions, [invalidFixture('graph')]);
    const plan = planJourneyStep(step, {
      now: clock.now(),
      context: { vars: fixture.context },
      evaluator: dependencies.evaluator,
    });
    const record = (portId: JourneyPortId | null) =>
      transitions.push({
        sequence: transitions.length + 1,
        nodeId: step.id,
        portId,
        virtualAt: clock.now().toISOString(),
      });

    switch (plan.kind) {
      case 'EXIT':
        record(null);
        return result('EXIT', transitions);
      case 'WAIT':
        record('next');
        // runtime ปิด enrollment เมื่อ maxAgeAt <= now จึงนับขอบพอดีเป็นหมดอายุเหมือนกัน
        if (plan.wakeAt >= deadline) return result('MAX_DURATION', transitions);
        clock.advanceTo(plan.wakeAt);
        stepId = plan.nextStepId;
        break;
      case 'BRANCH':
        record(plan.branchResult ? 'true' : 'false_or_error');
        stepId = plan.nextStepId;
        break;
      case 'AWAIT_SEND': {
        if (!fixture.sendOutcomes?.[step.id]) {
          return result('EXIT', transitions, [invalidFixture(`sendOutcomes.${step.id}`)]);
        }
        // SEND มี continuation เดียว: ส่ง/ถูกระงับ/ไม่มีสิทธิ์ ล้วนเดินต่อ `next` เหมือน runtime
        record('next');
        stepId = plan.nextStepId;
        break;
      }
      case 'AWAIT_OWNER': {
        if (!restrictedAvailable) return result('CAPABILITY_UNAVAILABLE', transitions);
        const outcome = fixture.ownerOutcomes?.[step.id];
        if (!outcome) {
          return result('EXIT', transitions, [invalidFixture(`ownerOutcomes.${step.id}`)]);
        }
        record(outcome === 'ACCEPTED' ? 'accepted' : 'rejected');
        stepId = ownerResultNextStep(plan, outcome);
        break;
      }
    }
  }
  return result('EXIT', transitions);
}
