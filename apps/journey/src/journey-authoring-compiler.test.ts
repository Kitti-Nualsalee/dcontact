import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { DcExprEvaluator } from '@d-contact/expression';
import type { AuthoringDocumentV1, JourneyDiagnosticV1 } from '@d-contact/cxa-contracts';
import {
  JOURNEY_RUNTIME_CAPABILITIES,
  canonicalRuntimeDefinition,
  journeyAuthoringDigest,
  journeyRuntimeHash,
  type JourneyRuntimeCapability,
} from './journey-authoring-canonical.js';
import {
  compileJourneyDraft,
  importJourneyDefinition,
  type CompileBinding,
} from './journey-authoring-compiler.js';
import {
  SimulationSideEffectBlockedError,
  blockedSimulationPort,
  previewJourneyPlan,
  simulateJourneyScenario,
} from './journey-authoring-simulator.js';
import type { JourneyDefinitionContent } from './journey-definition.js';

const evaluator = new DcExprEvaluator();
const capabilities = JOURNEY_RUNTIME_CAPABILITIES;
const unavailable: readonly JourneyRuntimeCapability[] = capabilities.map((capability) => ({
  ...capability,
  available: false,
}));

function fixture(name: string): JourneyDefinitionContent {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'test/fixtures/j5', `${name}.json`), 'utf8'),
  ) as JourneyDefinitionContent;
}

function binding(content: JourneyDefinitionContent, document: unknown): CompileBinding {
  return {
    tenantId: '00000000-0000-4000-8000-000000000001',
    journeyId: '00000000-0000-4000-8000-000000000002',
    ownerTeamId: content.ownerTeamId,
    draftRevision: 1,
    draftDigest: journeyAuthoringDigest(document),
    baseHeadVersion: 1,
  };
}

function compile(document: unknown, content: JourneyDefinitionContent, caps = capabilities) {
  return compileJourneyDraft(document, binding(content, document), {
    evaluator,
    capabilities: caps,
  });
}

const codes = (diagnostics: readonly JourneyDiagnosticV1[]) =>
  diagnostics.map((diagnostic) => diagnostic.code);
const clone = <T>(value: T): T => structuredClone(value) as T;

test('J5-F01 golden round-trip: J1/J2/J3 import → compile yields the same runtime content and hash', () => {
  for (const name of ['j1-event', 'j1-schedule', 'j2-outcome', 'j3-segment']) {
    const content = fixture(name);
    const document = importJourneyDefinition(content);
    const { artifact, diagnostics } = compile(document, content);
    assert.deepEqual(diagnostics, [], name);
    assert.ok(artifact, name);
    assert.deepEqual(artifact.runtimeDefinition, canonicalRuntimeDefinition(content), name);
    assert.equal(artifact.runtimeHash, journeyRuntimeHash(content), name);
    // re-importing the compiled runtime must give back the same document (fixed point)
    assert.deepEqual(importJourneyDefinition(artifact.runtimeDefinition), document, name);
  }
});

test('J5-F01 visual-only changes do not affect the runtime/compile digest but semantic changes do', () => {
  const content = fixture('j1-event');
  const document = importJourneyDefinition(content);
  const base = compile(document, content).artifact!;

  const visual = clone(document) as {
    -readonly [K in keyof AuthoringDocumentV1]: AuthoringDocumentV1[K];
  };
  visual.layout = { nodes: { trigger: { x: 999, y: 5 } }, viewport: { x: 1, y: 2, zoom: 1.5 } };
  visual.nodes = [...document.nodes].reverse();
  visual.edges = [...document.edges].reverse();
  visual.nodes = visual.nodes.map((node) => ({ ...node, label: `renamed ${node.nodeId}` }));
  const visualArtifact = compileJourneyDraft(
    visual,
    { ...binding(content, document) },
    { evaluator, capabilities },
  ).artifact!;
  assert.equal(visualArtifact.runtimeHash, base.runtimeHash);
  assert.equal(visualArtifact.compileDigest, base.compileDigest);

  const semantic = clone(document);
  const wait = semantic.nodes.find((node) => node.nodeId === 'wait-1d') as {
    config: { waitSeconds: number };
  };
  wait.config.waitSeconds = 3_600;
  const semanticArtifact = compile(semantic, content).artifact!;
  assert.notEqual(semanticArtifact.runtimeHash, base.runtimeHash);
  assert.notEqual(semanticArtifact.compileDigest, base.compileDigest);
});

test('J5-F01 compile is deterministic and binds tenant/journey/draft/capability into the digest', () => {
  const content = fixture('j3-segment');
  const document = importJourneyDefinition(content);
  const first = compile(document, content).artifact!;
  assert.deepEqual(compile(clone(document), content).artifact, first);
  const otherTenant = compileJourneyDraft(
    document,
    { ...binding(content, document), tenantId: '00000000-0000-4000-8000-000000000009' },
    { evaluator, capabilities },
  ).artifact!;
  assert.notEqual(otherTenant.compileDigest, first.compileDigest);
  assert.equal(otherTenant.runtimeHash, first.runtimeHash);
  assert.match(first.compileDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.compilerVersion, 'J5_COMPILER_V1');
});

test('J5-F02 a graph that breaks the rules fails closed with a precise code', () => {
  const content = fixture('j1-event');
  const document = importJourneyDefinition(content);
  const mutate = (change: (draft: any) => void) => {
    const draft = clone(document) as any;
    change(draft);
    const result = compile(draft, content);
    assert.equal(result.artifact, null);
    return codes(result.diagnostics);
  };

  assert.ok(mutate((d) => (d.nodes[0].type = 'SUBFLOW')).includes('NODE_TYPE_UNSUPPORTED'));
  assert.ok(mutate((d) => (d.nodes[0].config.script = 'x')).includes('NODE_FIELD_UNKNOWN'));
  assert.ok(mutate((d) => (d.extra = true)).includes('AUTHORING_SCHEMA_INVALID'));
  assert.ok(
    mutate((d) => (d.registryVersion = 'J5_PALETTE_V9')).includes('COMPILER_VERSION_UNSUPPORTED'),
  );
  assert.ok(
    mutate(
      (d) => (d.edges.find((e: any) => e.edgeId === 'send-reminder.next').source.portId = 'true'),
    ).includes('PORT_INVALID'),
  );
  assert.ok(
    mutate((d) =>
      d.edges.push({
        edgeId: 'dup',
        source: { nodeId: 'wait-1d', portId: 'next' },
        target: { nodeId: 'exit-paid' },
      }),
    ).includes('PORT_CARDINALITY_INVALID'),
  );
  assert.ok(
    mutate((d) => (d.edges = d.edges.filter((e: any) => e.edgeId !== 'wait-1d.next'))).includes(
      'PORT_CARDINALITY_INVALID',
    ),
  );
  assert.ok(
    mutate(
      (d) => (d.edges.find((e: any) => e.edgeId === 'wait-1d.next').target.nodeId = 'ghost'),
    ).includes('EDGE_REFERENCE_INVALID'),
  );
  assert.ok(
    mutate(
      (d) =>
        (d.edges.find((e: any) => e.edgeId === 'is-paid.false_or_error').target.nodeId =
          'send-reminder'),
    ).includes('GRAPH_CYCLE_UNSUPPORTED'),
  );
  assert.ok(
    mutate(
      (d) => (d.edges.find((e: any) => e.edgeId === 'wait-1d.next').target.nodeId = 'trigger'),
    ).includes('PORT_INVALID'),
  );
  // the existing runtime validator is still the last gate and its reason is carried in legacyReasonCode
  const exitless = clone(document) as any;
  exitless.nodes.find((node: any) => node.nodeId === 'exit-paid').config.reason = ' ';
  assert.ok(codes(compile(exitless, content).diagnostics).includes('AUTHORING_SCHEMA_INVALID'));
});

test('J5-F02 limits and unknown nodes are kept read-only but cannot be published', () => {
  const content = fixture('j1-schedule');
  const document = importJourneyDefinition(content) as any;
  const many = clone(document);
  for (let index = 0; index < 256; index += 1) {
    many.nodes.push({ nodeId: `x-${index}`, type: 'EXIT', config: { reason: 'X' } });
  }
  assert.ok(codes(compile(many, content).diagnostics).includes('GRAPH_LIMIT_EXCEEDED'));

  // an old definition with a future step type: import keeps the whole original source without dropping anything
  const legacy = clone(content) as any;
  legacy.graph.steps.push({ id: 'future', type: 'SUBFLOW', ref: 'abc', next: 'done' });
  const imported = importJourneyDefinition(legacy) as any;
  const preserved = imported.nodes.find((node: any) => node.nodeId === 'future');
  assert.deepEqual(preserved, {
    nodeId: 'future',
    type: 'UNSUPPORTED',
    sourceType: 'SUBFLOW',
    source: { id: 'future', type: 'SUBFLOW', ref: 'abc', next: 'done' },
  });
  const result = compile(imported, content);
  assert.equal(result.artifact, null);
  assert.ok(codes(result.diagnostics).includes('NODE_TYPE_UNSUPPORTED'));
});

test('J5-F02 a restricted owner action can only be placed as an entry after INTERACTION_OUTCOME and needs a capability', () => {
  const content = fixture('j2-outcome');
  const document = importJourneyDefinition(content);
  assert.ok(compile(document, content).artifact);

  const blocked = compile(document, content, unavailable);
  assert.equal(blocked.artifact, null);
  assert.ok(codes(blocked.diagnostics).includes('RUNTIME_CAPABILITY_UNAVAILABLE'));

  const midGraph = importJourneyDefinition({
    ...fixture('j1-schedule'),
    graph: {
      entryStepId: 'send-weekly',
      steps: [
        { id: 'send-weekly', type: 'SEND', channel: 'EMAIL', contentRef: 'content', next: 'case' },
        {
          id: 'case',
          type: 'ENSURE_CASE',
          caseTypeId: 'case-type',
          routingIntentRef: 'routing',
          targetOwnerTeamId: 'team-2',
          next: 'done',
          onReject: 'done',
        },
        { id: 'done', type: 'EXIT', reason: 'DONE' },
      ],
    },
  });
  const placement = compile(midGraph, content);
  assert.equal(placement.artifact, null);
  assert.ok(
    placement.diagnostics.some(
      (item) =>
        item.code === 'NODE_TYPE_UNSUPPORTED' && item.safeParams?.reason === 'RESTRICTED_PLACEMENT',
    ),
  );
});

test('J5-F02 preview shows capabilities that are not ready and simulation walks the accepted/rejected route per fixture', () => {
  const content = fixture('j2-outcome');
  const artifact = compile(importJourneyDefinition(content), content).artifact!;
  assert.deepEqual(previewJourneyPlan(artifact, capabilities).diagnostics, []);
  assert.deepEqual(codes(previewJourneyPlan(artifact, unavailable).diagnostics), [
    'RUNTIME_CAPABILITY_UNAVAILABLE',
  ]);

  const run = (outcome: 'ACCEPTED' | 'REJECTED') =>
    simulateJourneyScenario(
      artifact,
      {
        fixtureId: `f-${outcome}`,
        startAt: '2026-01-01T00:00:00.000Z',
        seed: 's',
        context: {},
        ownerOutcomes: { 'ensure-case': outcome },
      },
      { evaluator, capabilities },
    );
  assert.deepEqual(
    run('ACCEPTED').transitions.map((item) => item.nodeId),
    ['ensure-case', 'exit-case'],
  );
  assert.deepEqual(
    run('REJECTED').transitions.map((item) => item.nodeId),
    ['ensure-case', 'exit-rejected'],
  );
  assert.equal(
    simulateJourneyScenario(
      artifact,
      {
        fixtureId: 'f',
        startAt: '2026-01-01T00:00:00.000Z',
        seed: 's',
        context: {},
        ownerOutcomes: { 'ensure-case': 'ACCEPTED' },
      },
      { evaluator, capabilities: unavailable },
    ).terminal,
    'CAPABILITY_UNAVAILABLE',
  );
});

test('J5-ID02 simulation uses a deterministic manual clock and a BRANCH that cannot be evaluated goes to false_or_error', () => {
  const content = fixture('j1-event');
  const artifact = compile(importJourneyDefinition(content), content).artifact!;
  const scenario = (context: Record<string, string | number | boolean | null>) => ({
    fixtureId: 'paid',
    startAt: '2026-01-01T00:00:00.000Z',
    seed: 'seed-1',
    context,
    sendOutcomes: { 'send-reminder': 'SENT' as const },
  });
  const paid = simulateJourneyScenario(artifact, scenario({ paid: true }), {
    evaluator,
    capabilities,
  });
  assert.equal(paid.profile, 'SIMULATION_ONLY');
  assert.deepEqual(
    paid.transitions.map(({ nodeId, portId, virtualAt }) => [nodeId, portId, virtualAt]),
    [
      ['send-reminder', 'next', '2026-01-01T00:00:00.000Z'],
      ['wait-1d', 'next', '2026-01-01T00:00:00.000Z'],
      ['is-paid', 'true', '2026-01-02T00:00:00.000Z'],
      ['exit-paid', null, '2026-01-02T00:00:00.000Z'],
    ],
  );
  assert.deepEqual(
    simulateJourneyScenario(artifact, scenario({ paid: true }), { evaluator, capabilities }),
    paid,
  );
  const unknown = simulateJourneyScenario(artifact, scenario({}), { evaluator, capabilities });
  assert.equal(
    unknown.transitions.find((item) => item.nodeId === 'is-paid')?.portId,
    'false_or_error',
  );

  const missing = simulateJourneyScenario(
    artifact,
    { ...scenario({}), sendOutcomes: {} },
    { evaluator, capabilities },
  );
  assert.deepEqual(codes(missing.diagnostics), ['PREVIEW_FIXTURE_INVALID']);

  // a WAIT past maxDurationDays is closed with MAX_DURATION like the runtime max-age
  const shortLived = compile(
    importJourneyDefinition({ ...content, maxDurationDays: 1 }),
    content,
  ).artifact!;
  assert.equal(
    simulateJourneyScenario(
      shortLived,
      { ...scenario({}), startAt: '2026-01-01T00:00:01.000Z' },
      { evaluator, capabilities },
    ).terminal,
    'MAX_DURATION',
  );
});

test('J5-RC02 a side-effect port in simulation throws immediately', () => {
  const port = blockedSimulationPort<{ publish(): Promise<void>; reserve(): void }>('kafka');
  assert.throws(
    () => port.reserve(),
    (error: unknown) =>
      error instanceof SimulationSideEffectBlockedError &&
      error.code === 'SIMULATION_SIDE_EFFECT_BLOCKED' &&
      error.port === 'kafka.reserve',
  );
  assert.throws(() => port.publish(), SimulationSideEffectBlockedError);
});
