import {
  JOURNEY_AUTHORING_LIMITS,
  JOURNEY_AUTHORING_REGISTRY_VERSION,
  JOURNEY_AUTHORING_SCHEMA_VERSION,
  JOURNEY_COMPILE_ARTIFACT_VERSION,
  JOURNEY_NODE_PORTS,
  journeyDiagnosticsBlockPublish,
  sortJourneyDiagnostics,
  type AuthoringDocumentV1,
  type AuthoringEdgeV1,
  type AuthoringStepNodeV1,
  type AuthoringTriggerNodeV1,
  type AuthoringUnsupportedNodeV1,
  type CompileArtifactV1,
  type CompileJourneyResultV1,
  type ExpressionEvaluator,
  type JourneyAuthoringJsonValue,
  type JourneyDiagnosticV1,
  type JourneyPortId,
} from '@d-contact/cxa-contracts';
import {
  JOURNEY_AUTHORING_COMPILER_VERSION,
  canonicalJourneyJson,
  canonicalRuntimeDefinition,
  compareText,
  journeyAuthoringDigest,
  journeyCapabilityDigest,
  journeyRuntimeHash,
  type JourneyRuntimeCapability,
} from './journey-authoring-canonical.js';
import { validateAuthoringDocument } from './journey-authoring-validator.js';
import type {
  JourneyDefinitionContent,
  JourneyGraphStep,
  JourneyTrigger,
} from './journey-definition.js';
import { validateJourneyDefinitionStructure } from './journey-definition-validator.js';

/**
 * J5.2 (#340): deterministic compiler from an authoring document to the existing `JourneyDefinitionContent`
 * (Phase Spec #337 §4) — no new runtime DSL: one node is one step (`step.id = nodeId`)
 * and an edge compiles into a scalar field per the port catalog; the compiler does not read `layout`
 */

export type JourneyCompileArtifact = CompileArtifactV1<JourneyDefinitionContent>;

export interface CompileBinding {
  readonly tenantId: string;
  readonly journeyId: string;
  readonly ownerTeamId: string;
  readonly draftRevision: number;
  readonly draftDigest: string;
  readonly baseHeadVersion: number;
}

export interface CompileDependencies {
  readonly evaluator: ExpressionEvaluator;
  readonly capabilities: readonly JourneyRuntimeCapability[];
}

const TRIGGER_KIND = {
  EVENT_TRIGGER: 'EVENT',
  SCHEDULE_TRIGGER: 'SCHEDULE',
  INTERACTION_OUTCOME_TRIGGER: 'INTERACTION_OUTCOME',
  SEGMENT_ENTRY_TRIGGER: 'SEGMENT_ENTRY',
} as const;

function compileTrigger(trigger: AuthoringTriggerNodeV1): JourneyTrigger {
  return { kind: TRIGGER_KIND[trigger.type], ...trigger.config } as JourneyTrigger;
}

/**
 * The references being published must be checked against the current owner — the digest binds the artifact to this set of references; if the set changes
 * (e.g. the draft references another team) the old artifact cannot be used to publish
 */
export function journeyReferenceSet(content: JourneyDefinitionContent) {
  const references = new Set<string>([
    `OWNER_TEAM:${content.ownerTeamId}`,
    `SENDER_IDENTITY:${content.senderIdentityId}`,
  ]);
  if (content.trigger.kind === 'SEGMENT_ENTRY')
    references.add(`SEGMENT:${content.trigger.segmentId}`);
  for (const step of content.graph.steps) {
    if (step.type === 'SEND') references.add(`CONTENT:${step.contentRef}`);
    if ('targetOwnerTeamId' in step) references.add(`TARGET_TEAM:${step.targetOwnerTeamId}`);
  }
  return [...references].sort(compareText);
}

function error(
  code: JourneyDiagnosticV1['code'],
  stage: JourneyDiagnosticV1['stage'],
  extra: Partial<JourneyDiagnosticV1> = {},
): JourneyDiagnosticV1 {
  return { code, severity: 'ERROR', stage, messageKey: `journey.authoring.${code}`, ...extra };
}

/** A document that passed the validator → runtime content (not yet through the runtime validator) */
function buildRuntimeContent(
  document: AuthoringDocumentV1,
  ownerTeamId: string,
): JourneyDefinitionContent {
  const targets = new Map<string, string>();
  for (const edge of document.edges)
    targets.set(`${edge.source.nodeId}|${edge.source.portId}`, edge.target.nodeId);
  const steps = (document.nodes as AuthoringStepNodeV1[]).map((node) => {
    const transitions = Object.fromEntries(
      Object.entries(JOURNEY_NODE_PORTS[node.type].outputs as Record<string, string>).map(
        ([portId, field]) => [field, targets.get(`${node.nodeId}|${portId}`)],
      ),
    );
    return { id: node.nodeId, type: node.type, ...node.config, ...transitions } as JourneyGraphStep;
  });
  const { settings } = document;
  return {
    name: settings.name,
    ownerTeamId,
    purpose: settings.purpose,
    senderIdentityId: settings.senderIdentityId,
    trigger: compileTrigger(document.trigger),
    graph: {
      entryStepId: targets.get(`${document.trigger.nodeId}|start`) ?? '',
      steps,
    },
    goal: settings.goal,
    exitRules: settings.exitRules,
    maxDurationDays: settings.maxDurationDays,
  };
}

export function compileJourneyDraft(
  document: unknown,
  binding: CompileBinding,
  dependencies: CompileDependencies,
): CompileJourneyResultV1<JourneyDefinitionContent> {
  const diagnostics = validateAuthoringDocument(document, {
    capabilities: dependencies.capabilities,
  });
  if (journeyDiagnosticsBlockPublish(diagnostics)) {
    return { artifact: null, diagnostics, stale: false };
  }

  const content = buildRuntimeContent(document as AuthoringDocumentV1, binding.ownerTeamId);
  // the existing runtime validator is the last gate on structure — its reason code is carried in legacyReasonCode
  const runtimeCodes = validateJourneyDefinitionStructure(content, dependencies.evaluator);
  const compileDiagnostics: JourneyDiagnosticV1[] = runtimeCodes.map((code) =>
    error('DEFINITION_INVALID', 'COMPILE', { legacyReasonCode: code }),
  );
  const runtimeDefinition = canonicalRuntimeDefinition(content);
  if (
    Buffer.byteLength(canonicalJourneyJson(runtimeDefinition), 'utf8') >
    JOURNEY_AUTHORING_LIMITS.compiledRuntimeBytes
  ) {
    compileDiagnostics.push(
      error('GRAPH_LIMIT_EXCEEDED', 'COMPILE', {
        safeParams: { limit: JOURNEY_AUTHORING_LIMITS.compiledRuntimeBytes },
      }),
    );
  }
  const all = sortJourneyDiagnostics([...diagnostics, ...compileDiagnostics]);
  if (journeyDiagnosticsBlockPublish(all))
    return { artifact: null, diagnostics: all, stale: false };

  const withoutDigest = {
    artifactVersion: JOURNEY_COMPILE_ARTIFACT_VERSION,
    schemaVersion: JOURNEY_AUTHORING_SCHEMA_VERSION,
    compilerVersion: JOURNEY_AUTHORING_COMPILER_VERSION,
    authoringRegistryVersion: JOURNEY_AUTHORING_REGISTRY_VERSION,
    tenantId: binding.tenantId,
    journeyId: binding.journeyId,
    draftRevision: binding.draftRevision,
    draftDigest: binding.draftDigest,
    baseHeadVersion: binding.baseHeadVersion,
    referenceDigest: journeyAuthoringDigest(journeyReferenceSet(runtimeDefinition)),
    capabilityDigest: journeyCapabilityDigest(dependencies.capabilities),
    runtimeDefinition,
    runtimeHash: journeyRuntimeHash(runtimeDefinition),
    diagnosticDigest: journeyAuthoringDigest(all),
  } as const;
  const artifact: JourneyCompileArtifact = {
    ...withoutDigest,
    compileDigest: journeyAuthoringDigest(withoutDigest),
  };
  return { artifact, diagnostics: all, stale: false };
}

// ── Import: runtime definition → authoring document ─────────────────────────

const TRIGGER_TYPE = {
  EVENT: 'EVENT_TRIGGER',
  SCHEDULE: 'SCHEDULE_TRIGGER',
  INTERACTION_OUTCOME: 'INTERACTION_OUTCOME_TRIGGER',
  SEGMENT_ENTRY: 'SEGMENT_ENTRY_TRIGGER',
} as const;

const TRANSITION_FIELDS = new Set(['next', 'whenTrue', 'whenFalse', 'onReject']);

/**
 * Converts an existing definition (J1–J3) into an authoring document deterministically for round-trip/roll-forward.
 * A step type the registry does not know is kept as `UNSUPPORTED` with its whole original source; never drop or normalize it
 */
export function importJourneyDefinition(source: JourneyDefinitionContent): AuthoringDocumentV1 {
  // works on the canonical form: an unordered set (exit rules) yields the same document regardless of source order
  const content = canonicalRuntimeDefinition(source);
  const stepIds = new Set(content.graph.steps.map((step) => step.id));
  let triggerId = 'trigger';
  for (let suffix = 1; stepIds.has(triggerId); suffix += 1) triggerId = `trigger-${suffix}`;

  const { kind, ...triggerConfig } = content.trigger as JourneyTrigger & Record<string, unknown>;
  const trigger = {
    nodeId: triggerId,
    type: TRIGGER_TYPE[kind as keyof typeof TRIGGER_TYPE],
    config: triggerConfig,
  } as AuthoringTriggerNodeV1;

  const edges: AuthoringEdgeV1[] = [
    {
      edgeId: `${triggerId}.start`,
      source: { nodeId: triggerId, portId: 'start' },
      target: { nodeId: content.graph.entryStepId },
    },
  ];
  const steps = [...content.graph.steps].sort((left, right) => compareText(left.id, right.id));
  const nodes = steps.map((step): AuthoringStepNodeV1 | AuthoringUnsupportedNodeV1 => {
    const ports = JOURNEY_NODE_PORTS[step.type as keyof typeof JOURNEY_NODE_PORTS];
    if (!ports) {
      return {
        nodeId: step.id,
        type: 'UNSUPPORTED',
        sourceType: String(step.type),
        source: step as unknown as JourneyAuthoringJsonValue,
      };
    }
    for (const [portId, field] of Object.entries(ports.outputs as Record<string, string>)) {
      edges.push({
        edgeId: `${step.id}.${portId}`,
        source: { nodeId: step.id, portId: portId as JourneyPortId },
        target: { nodeId: (step as unknown as Record<string, string>)[field]! },
      });
    }
    const config = Object.fromEntries(
      Object.entries(step).filter(
        ([key]) => key !== 'id' && key !== 'type' && !TRANSITION_FIELDS.has(key),
      ),
    );
    return { nodeId: step.id, type: step.type, config } as AuthoringStepNodeV1;
  });

  return {
    schemaVersion: JOURNEY_AUTHORING_SCHEMA_VERSION,
    registryVersion: JOURNEY_AUTHORING_REGISTRY_VERSION,
    trigger,
    nodes,
    edges: edges.sort((left, right) => compareText(left.edgeId, right.edgeId)),
    settings: {
      name: content.name,
      purpose: content.purpose,
      senderIdentityId: content.senderIdentityId,
      goal: content.goal,
      exitRules: content.exitRules,
      maxDurationDays: content.maxDurationDays,
    },
    // layout only provides a readable default arrangement and has no effect on the runtime hash
    layout: {
      nodes: Object.fromEntries([
        [triggerId, { x: 0, y: 0 }],
        ...steps.map((step, index) => [step.id, { x: 240 * (index + 1), y: 0 }] as const),
      ]),
    },
  };
}
