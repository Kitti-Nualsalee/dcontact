/**
 * U1.9 (#506) — the committed UAT first slice fixture pack (template + renderer + example) must not rot:
 * it renders, passes the U1.1/U1.8 parser/negative scan, has a stable digest, the baseline passes J5 validate/compile/simulate
 * as the step catalog says, the catalog covers every item of the #416 walkthrough, and an unfilled example is rejected
 * (the parts that need Postgres are in `uat-fixture-pack.integration.ts`)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { AuthoringDocumentV1, SimulationFixtureV1 } from '@d-contact/cxa-contracts';
import { DcExprEvaluator } from '@d-contact/expression';
import {
  JOURNEY_RUNTIME_CAPABILITIES,
  UAT_STEP_ID_PATTERN,
  compileJourneyDraft,
  parseUatFixturePackManifest,
  previewJourneyPlan,
  scanUatText,
  simulateJourneyScenario,
  uatFixturePackDigest,
  validateAuthoringDocument,
} from '@d-contact/journey';
import { UatProvisionError, parseUatProvisionInput } from './uat-provision.js';

const ROOT = resolve(__dirname, '../../..');
const TEMPLATE_PATH = resolve(ROOT, 'infra/uat/fixtures/uat-first-slice.v1.template.json');
const EXAMPLE_PATH = resolve(ROOT, 'infra/uat/uat-provision.example.json');
const RENDERER = resolve(ROOT, 'scripts/u1-uat-fixture-render.mjs');

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const template = readJson(TEMPLATE_PATH);
const example = readJson(EXAMPLE_PATH);

/** fixed synthetic values standing in for secret store values — not anyone's real data */
const SYNTHETIC_FILL = Object.freeze({
  tenantId: '0b9d6a52-1f0e-4c1a-9a51-7d7c2f9e0001',
  ownerTeamId: '0b9d6a52-1f0e-4c1a-9a51-7d7c2f9e0002',
  maker: '0b9d6a52-1f0e-4c1a-9a51-7d7c2f9e0003',
  reviewer: '0b9d6a52-1f0e-4c1a-9a51-7d7c2f9e0004',
  buildSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
});

/** a copy of the filled example (as an operator makes it from the secret store) */
function filledExample(overrides: Partial<Record<keyof typeof SYNTHETIC_FILL, string>> = {}) {
  const ids = { ...SYNTHETIC_FILL, ...overrides };
  const short = ids.tenantId.slice(0, 8);
  return {
    ...example,
    tenant: { id: ids.tenantId, slug: `uat-fx-${short}`, name: `UAT fixture ${short}` },
    ownerTeam: { id: ids.ownerTeamId, name: `Journey owners ${short}` },
    maker: {
      dcUserId: ids.maker,
      email: `maker-${short}@uat-tester.example`,
      displayName: `Tester Maker ${short}`,
    },
    reviewer: {
      dcUserId: ids.reviewer,
      email: `reviewer-${short}@uat-tester.example`,
      displayName: `Tester Reviewer ${short}`,
    },
    rollout: { ...example.rollout, evidenceRef: 'u1-9-fixture-test' },
    fixturePack: { ...example.fixturePack, packVersion: 'uat-first-slice-1' },
  };
}

function render(input: unknown, argv: string[] = ['--build-sha', SYNTHETIC_FILL.buildSha]) {
  const result = spawnSync(process.execPath, [RENDERER, '--input', '-', ...argv], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  const status = JSON.parse(result.stderr.trim().split('\n').at(-1)!) as Record<string, string>;
  return {
    code: result.status,
    status,
    stderr: result.stderr,
    output: result.stdout ? (JSON.parse(result.stdout) as Record<string, any>) : null,
  };
}

const evaluator = new DcExprEvaluator();
const capabilities = JOURNEY_RUNTIME_CAPABILITIES;

function compile(document: unknown) {
  return compileJourneyDraft(
    document,
    {
      tenantId: SYNTHETIC_FILL.tenantId,
      journeyId: '0b9d6a52-1f0e-4c1a-9a51-7d7c2f9e0010',
      ownerTeamId: SYNTHETIC_FILL.ownerTeamId,
      draftRevision: 1,
      draftDigest: 'a'.repeat(64),
      baseHeadVersion: 0,
    },
    { evaluator, capabilities },
  );
}

/** MAKER_EDIT of the catalog: insert a WAIT after SEND (the Console sets the node id itself — here `wait-1` is used) */
function withInsertedWait(document: AuthoringDocumentV1, waitSeconds = 600): AuthoringDocumentV1 {
  return {
    ...document,
    nodes: [
      ...document.nodes,
      { nodeId: 'wait-1', type: 'WAIT', config: { waitSeconds } },
    ] as AuthoringDocumentV1['nodes'],
    edges: [
      ...document.edges.filter((edge) => edge.edgeId !== 'send-1.next'),
      {
        edgeId: 'send-1.next',
        source: { nodeId: 'send-1', portId: 'next' },
        target: { nodeId: 'wait-1' },
      },
      {
        edgeId: 'wait-1.next',
        source: { nodeId: 'wait-1', portId: 'next' },
        target: { nodeId: 'done' },
      },
    ],
  };
}

/**
 * #416 walkthrough and #379 step list → the stepIds that must be in the catalog
 * a stepId that duplicates `U1_STEP_CATALOG` of the acceptance gate (U1.7 #435) uses the same id/expected
 */
const WALKTHROUGH_STEPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'maker login with TOTP': ['MAKER_LOGIN_TOTP', 'LOGIN_WITHOUT_TOTP_REFUSED'],
  'create/edit a Journey': ['RUN_OPENED', 'BASELINE_OPEN', 'MAKER_EDIT'],
  'validate and fix per diagnostic': ['DIAGNOSTIC_RECOVERY'],
  'compile, preview, simulate': [
    'COMPILE',
    'PREVIEW_PLAN',
    'SIMULATE',
    'SIMULATE_EXIT_PATH',
    'SIMULATE_REPEATABLE',
    'SIMULATION_NOT_DELIVERY',
  ],
  'submit for review': ['SUBMIT_REVIEW'],
  'reviewer login and finds the candidate themselves': ['REVIEWER_LOGIN_TOTP', 'REVIEW_APPROVE'],
  'check the exact candidate and approve': ['REVIEW_APPROVE'],
  'approving own work is rejected': ['SELF_APPROVAL_REJECTED'],
  'maker publish and the official version/receipt': ['PUBLISH'],
  audit: ['AUDIT'],
  'start a new round and rerun': ['RUN_OPENED', 'BASELINE_OPEN', 'RUN_RESTART_BLOCKED_IN_REVIEW'],
  'failure/recovery': ['FAILURE_STALE_TAB', 'FAILURE_RETRY_NO_DUPLICATE'],
  'session expired': ['SESSION_EXPIRED'],
  'refresh / deep link / Back / Forward': ['NAV_REFRESH', 'NAV_DEEP_LINK', 'NAV_BACK_FORWARD'],
  'accessibility (keyboard/focus)': ['A11Y_KEYBOARD', 'A11Y_FOCUS'],
  'no CLI/DB step': ['NO_CLI_OR_DB'],
  'attach evidence and export a bundle that passes the scan': [
    'EVIDENCE_UPLOAD',
    'STEP_RESULTS_RECORDED',
    'EVIDENCE_EXPORT_BUNDLE',
  ],
});
/** steps of the U1.7 acceptance gate (`U1_STEP_CATALOG`) — must all be in the pack in the same order */
const GATE_STEP_IDS = [
  'RUN_OPENED',
  'MAKER_EDIT',
  'DIAGNOSTIC_RECOVERY',
  'COMPILE',
  'SIMULATE',
  'SUBMIT_REVIEW',
  'REVIEW_APPROVE',
  'PUBLISH',
  'AUDIT',
];
const SIMULATION_ONLY_STEPS = [
  'PREVIEW_PLAN',
  'SIMULATE',
  'SIMULATE_EXIT_PATH',
  'SIMULATE_REPEATABLE',
  'SIMULATION_NOT_DELIVERY',
];

/**
 * digest of the pack rendered with `SYNTHETIC_FILL` — changes when the template content changes, which must be issued as a
 * new template/pack version (an already provisioned pack of the old version would get `FIXTURE_PACK_DIGEST_MISMATCH`)
 */
const PINNED_DIGEST = '54be2b86acebed6609fbe500366201c3a29220d9d7390c7ac5223ad377dde2f3';

test('U1.9 the template has only synthetic data + a single complete set of deployment placeholders', () => {
  assert.deepEqual(scanUatText(readFileSync(TEMPLATE_PATH, 'utf8')), []);
  assert.deepEqual(scanUatText(readFileSync(EXAMPLE_PATH, 'utf8')), []);
  const placeholders = [...readFileSync(TEMPLATE_PATH, 'utf8').matchAll(/__UAT_[A-Z0-9_]+__/g)]
    .map(([token]) => token)
    .sort();
  assert.deepEqual(placeholders, [
    '__UAT_BUILD_SHA__',
    '__UAT_ENVIRONMENT__',
    '__UAT_FIXTURE_PACK_VERSION__',
    '__UAT_MAKER_SUBJECT_ID__',
    '__UAT_OWNER_TEAM_ID__',
    '__UAT_REVIEWER_SUBJECT_ID__',
    '__UAT_TENANT_ID__',
  ]);
  // the exact template cannot be provisioned yet (no real UUID)
  assert.throws(() => parseUatFixturePackManifest(template));
});

test('U1.9 renders a UatProvisionV1 input that the U1.8/U1.1 parser accepts, with a stable digest', () => {
  const first = render(filledExample());
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.status, {
    type: 'u1.uat.fixture-render',
    status: 'PASS',
    template: 'uat-first-slice.v1',
    steps: String(template.steps.length),
  });
  // stderr does not echo values from the input (email/name)
  assert.doesNotMatch(first.stderr, /@|Tester/);
  const rendered = first.output!;
  const input = parseUatProvisionInput(rendered);
  const manifest = parseUatFixturePackManifest(input.fixturePack);
  assert.equal(manifest.environment, 'uat');
  assert.equal(manifest.packVersion, 'uat-first-slice-1');
  assert.equal(manifest.buildSha, SYNTHETIC_FILL.buildSha);
  assert.equal(manifest.tenantId, SYNTHETIC_FILL.tenantId);
  assert.equal(manifest.ownerTeamId, SYNTHETIC_FILL.ownerTeamId);
  assert.equal(manifest.makerSubjectId, SYNTHETIC_FILL.maker);
  assert.equal(manifest.reviewerSubjectId, SYNTHETIC_FILL.reviewer);
  // the other parts of the input are untouched
  assert.deepEqual({ ...rendered, fixturePack: null }, { ...filledExample(), fixturePack: null });
  assert.deepEqual(scanUatText(JSON.stringify(rendered.fixturePack)), []);

  const digest = uatFixturePackDigest(manifest);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(
    uatFixturePackDigest(parseUatFixturePackManifest(render(filledExample()).output!.fixturePack)),
    digest,
  );
  assert.equal(digest, PINNED_DIGEST);
  // deployment values are in the digest: a different build SHA = a different digest
  const other = render(filledExample(), ['--build-sha', 'f'.repeat(40)]);
  assert.notEqual(
    uatFixturePackDigest(parseUatFixturePackManifest(other.output!.fixturePack)),
    digest,
  );
});

test('U1.9 baseline + MAKER_EDIT (EVENT_TRIGGER → SEND → WAIT → EXIT) pass J5 validate/compile/preview/simulate as the catalog says', () => {
  const manifest = parseUatFixturePackManifest(render(filledExample()).output!.fixturePack);
  const document = manifest.baselineDocument as unknown as AuthoringDocumentV1;
  // same baseline as the U1.7 acceptance gate: EVENT_TRIGGER → SEND → EXIT, then the maker inserts WAIT themselves
  assert.equal(document.trigger.type, 'EVENT_TRIGGER');
  assert.deepEqual(
    document.nodes.map((node) => [node.nodeId, node.type]),
    [
      ['send-1', 'SEND'],
      ['done', 'EXIT'],
    ],
  );
  // the manifest refs match what the baseline actually uses
  assert.equal(document.settings.senderIdentityId, manifest.senderRef);
  assert.deepEqual(document.nodes[0]!.type === 'SEND' && document.nodes[0]!.config, {
    channel: 'LINE',
    contentRef: manifest.contentRef,
  });
  const fixture = manifest.simulationFixture as SimulationFixtureV1;
  // no sendOutcomes for SEND = the simulation ends with PREVIEW_FIXTURE_INVALID (what the gate found)
  assert.deepEqual(fixture.sendOutcomes, { 'send-1': 'SENT' });
  const simulate = (doc: AuthoringDocumentV1) =>
    simulateJourneyScenario(compile(doc).artifact!, fixture, { evaluator, capabilities });

  for (const [doc, path] of [
    [
      document,
      [
        ['send-1', 'next', '2026-09-01T02:00:00.000Z'],
        ['done', null, '2026-09-01T02:00:00.000Z'],
      ],
    ],
    [
      withInsertedWait(document),
      [
        ['send-1', 'next', '2026-09-01T02:00:00.000Z'],
        ['wait-1', 'next', '2026-09-01T02:00:00.000Z'],
        ['done', null, '2026-09-01T02:10:00.000Z'],
      ],
    ],
  ] as const) {
    assert.deepEqual(validateAuthoringDocument(doc, { capabilities }), []);
    const compiled = compile(doc);
    assert.deepEqual(compiled.diagnostics, []);
    assert.ok(compiled.artifact);
    assert.equal(compile(doc).artifact!.compileDigest, compiled.artifact.compileDigest);
    const preview = previewJourneyPlan(compiled.artifact, capabilities);
    assert.equal(preview.entryNodeId, 'send-1');
    assert.deepEqual(preview.diagnostics, []);
    assert.ok(preview.steps.every((step) => step.capability === 'AVAILABLE'));

    const result = simulate(doc);
    assert.deepEqual(result, simulate(doc));
    assert.equal(result.profile, 'SIMULATION_ONLY');
    assert.equal(result.terminal, 'EXIT');
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
      result.transitions.map((entry) => [entry.nodeId, entry.portId, entry.virtualAt]),
      path,
    );
  }

  // DIAGNOSTIC_RECOVERY: cutting the next edge of WAIT = PORT_CARDINALITY_INVALID at the node and it can still be saved
  const edited = withInsertedWait(document);
  const broken = { ...edited, edges: edited.edges.filter((e) => e.edgeId !== 'wait-1.next') };
  assert.deepEqual(
    validateAuthoringDocument(broken, { capabilities }).map((item) => [
      item.code,
      item.severity,
      item.path,
    ]),
    [['PORT_CARDINALITY_INVALID', 'ERROR', { nodeId: 'wait-1', portId: 'next' }]],
  );
  assert.equal(compile(broken).artifact, null);
});

test('U1.9 the step catalog covers every item of the #416/#379 walkthrough with fixed stepIds and correct state labels', () => {
  const manifest = parseUatFixturePackManifest(render(filledExample()).output!.fixturePack);
  const steps = manifest.steps;
  assert.ok(steps.length <= 60);
  const ids = steps.map((step) => step.stepId);
  assert.equal(new Set(ids).size, ids.length);
  for (const step of steps) {
    assert.match(step.stepId, UAT_STEP_ID_PATTERN);
    // the step title from gate U1.7 stays as originally written (e.g. `Publish`) so #416 has a single catalog
    if (!GATE_STEP_IDS.includes(step.stepId)) {
      assert.match(step.title, /[\u0E00-\u0E7F]/, `Thai title: ${step.stepId}`);
    }
    assert.match(step.expected, /[\u0E00-\u0E7F]/, `Thai expected: ${step.stepId}`);
  }
  // one catalog for #416: the gate steps are all there, in the original order
  assert.deepEqual(
    ids.filter((id) => GATE_STEP_IDS.includes(id)),
    GATE_STEP_IDS,
  );
  for (const [item, required] of Object.entries(WALKTHROUGH_STEPS)) {
    for (const stepId of required) assert.ok(ids.includes(stepId), `${item}: missing ${stepId}`);
  }
  // no stray step that is not tied to any walkthrough item (except the UAT profile label, a precondition before starting)
  const covered = new Set([...Object.values(WALKTHROUGH_STEPS).flat(), 'UAT_PROFILE_VISIBLE']);
  assert.deepEqual(
    ids.filter((id) => !covered.has(id)),
    [],
  );
  for (const step of steps) {
    assert.equal(
      step.stateLabel,
      SIMULATION_ONLY_STEPS.includes(step.stepId) ? 'SIMULATION_ONLY' : 'REAL_STATE',
      step.stepId,
    );
  }
});

test('U1.9 an unfilled or unrendered example is rejected by both the renderer and the CLI parser', () => {
  const rejects = (value: unknown, code: string, field?: string) =>
    assert.throws(
      () => parseUatProvisionInput(value),
      (error: unknown) => {
        assert.ok(error instanceof UatProvisionError, String(error));
        assert.equal(error.code, code);
        if (field) assert.equal(error.safeParams.field, field);
        return true;
      },
    );
  rejects(example, 'INPUT_PLACEHOLDER', 'tenant.id');
  // a free field whose format accepts `__UAT_…__` is still caught
  const filled = filledExample();
  rejects(
    { ...filled, tenant: { ...filled.tenant, name: '__UAT_TENANT_NAME__' } },
    'INPUT_PLACEHOLDER',
    'tenant.name',
  );
  rejects(filled, 'FIXTURE_PACK_NOT_RENDERED', 'fixturePack.template');
  // the template itself instead of a manifest
  rejects({ ...filled, fixturePack: template }, 'INPUT_PLACEHOLDER', 'fixturePack.environment');

  const renderRejects = (input: unknown, code: string, field?: string, argv?: string[]) => {
    const result = render(input, argv);
    assert.equal(result.code, 1);
    assert.equal(result.output, null);
    assert.equal(result.status.status, 'FAIL');
    assert.equal(result.status.code, code, JSON.stringify(result.status));
    if (field) assert.equal(result.status.field, field);
    assert.doesNotMatch(result.stderr, /@|Tester/);
  };
  renderRejects(example, 'PLACEHOLDER_UNFILLED', 'tenant.id');
  renderRejects(
    { ...filled, maker: { ...filled.maker, email: '__UAT_MAKER_EMAIL__' } },
    'PLACEHOLDER_UNFILLED',
    'maker.email',
  );
  renderRejects(filled, 'BUILD_SHA_INVALID', '--build-sha', ['--build-sha', 'abc1234']);
  renderRejects(filled, 'USAGE', undefined, []);
  renderRejects(
    { ...filled, fixturePack: { ...filled.fixturePack, template: 'other' } },
    'TEMPLATE_UNKNOWN',
  );
  renderRejects(
    { ...filled, fixturePack: { ...filled.fixturePack, extra: 1 } },
    'INPUT_INVALID',
    'fixturePack',
  );
  renderRejects('{not json', 'INPUT_UNREADABLE');
  // rendered once, it cannot be rendered again (the stub is gone)
  renderRejects(render(filled).output, 'INPUT_INVALID', 'fixturePack');
});
