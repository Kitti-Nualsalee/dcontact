/**
 * U1.9 (#506) — fixture pack ของ UAT first slice ที่ commit ไว้ (template + renderer + example) ต้องไม่ rot:
 * render ได้, ผ่าน parser/negative scan ของ U1.1/U1.8, digest คงที่, baseline ผ่าน J5 validate/compile/simulate
 * ตามที่ step catalog บอก, catalog ครบทุกข้อของ walkthrough #416 และ example ที่ยังไม่กรอกถูกปฏิเสธ
 * (ส่วนที่ต้องใช้ Postgres อยู่ใน `uat-fixture-pack.integration.ts`)
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

/** ค่าสังเคราะห์คงที่แทนค่าจาก secret store — ไม่ใช่ข้อมูลจริงของใคร */
const SYNTHETIC_FILL = Object.freeze({
  tenantId: '0b9d6a52-1f0e-4c1a-9a51-7d7c2f9e0001',
  ownerTeamId: '0b9d6a52-1f0e-4c1a-9a51-7d7c2f9e0002',
  maker: '0b9d6a52-1f0e-4c1a-9a51-7d7c2f9e0003',
  reviewer: '0b9d6a52-1f0e-4c1a-9a51-7d7c2f9e0004',
  buildSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
});

/** สำเนาของ example ที่กรอกแล้ว (แบบที่ operator ทำจาก secret store) */
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
      displayName: `ผู้ทดสอบ Maker ${short}`,
    },
    reviewer: {
      dcUserId: ids.reviewer,
      email: `reviewer-${short}@uat-tester.example`,
      displayName: `ผู้ทดสอบ Reviewer ${short}`,
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

/** MAKER_EDIT ของ catalog: แทรก WAIT หลัง SEND (Console ตั้ง node id เอง — ที่นี่ใช้ `wait-1`) */
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
 * walkthrough ของ #416 และรายการ step ของ #379 → stepId ที่ต้องมีใน catalog
 * stepId ที่ซ้ำกับ `U1_STEP_CATALOG` ของ acceptance gate (U1.7 #435) ใช้ id/expected เดียวกัน
 */
const WALKTHROUGH_STEPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'login ของ maker ด้วย TOTP': ['MAKER_LOGIN_TOTP', 'LOGIN_WITHOUT_TOTP_REFUSED'],
  'สร้าง/แก้ Journey': ['RUN_OPENED', 'BASELINE_OPEN', 'MAKER_EDIT'],
  'validate และแก้ตาม diagnostic': ['DIAGNOSTIC_RECOVERY'],
  'compile, preview, simulate': [
    'COMPILE',
    'PREVIEW_PLAN',
    'SIMULATE',
    'SIMULATE_EXIT_PATH',
    'SIMULATE_REPEATABLE',
    'SIMULATION_NOT_DELIVERY',
  ],
  ส่งตรวจ: ['SUBMIT_REVIEW'],
  'reviewer login และหา candidate เอง': ['REVIEWER_LOGIN_TOTP', 'REVIEW_APPROVE'],
  'ตรวจ candidate ตรงตัวแล้วอนุมัติ': ['REVIEW_APPROVE'],
  อนุมัติงานตัวเองถูกปฏิเสธ: ['SELF_APPROVAL_REJECTED'],
  'maker publish และ version/receipt ที่เป็นทางการ': ['PUBLISH'],
  audit: ['AUDIT'],
  'เริ่มรอบใหม่ และ rerun': ['RUN_OPENED', 'BASELINE_OPEN', 'RUN_RESTART_BLOCKED_IN_REVIEW'],
  'failure/recovery': ['FAILURE_STALE_TAB', 'FAILURE_RETRY_NO_DUPLICATE'],
  'session หมดอายุ': ['SESSION_EXPIRED'],
  'refresh / deep link / Back / Forward': ['NAV_REFRESH', 'NAV_DEEP_LINK', 'NAV_BACK_FORWARD'],
  'accessibility (keyboard/focus)': ['A11Y_KEYBOARD', 'A11Y_FOCUS'],
  'ไม่มีขั้น CLI/DB': ['NO_CLI_OR_DB'],
  'แนบหลักฐานและ export bundle ที่ผ่าน scan': [
    'EVIDENCE_UPLOAD',
    'STEP_RESULTS_RECORDED',
    'EVIDENCE_EXPORT_BUNDLE',
  ],
});
/** step ของ acceptance gate U1.7 (`U1_STEP_CATALOG`) — ต้องอยู่ใน pack ครบและเรียงลำดับเดียวกัน */
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
 * digest ของ pack ที่ render ด้วย `SYNTHETIC_FILL` — เปลี่ยนเมื่อเนื้อหา template เปลี่ยน ซึ่งต้องออกเป็น
 * template/pack version ใหม่ (pack version เดิมที่ provision แล้วจะได้ `FIXTURE_PACK_DIGEST_MISMATCH`)
 */
const PINNED_DIGEST = '54be2b86acebed6609fbe500366201c3a29220d9d7390c7ac5223ad377dde2f3';

test('U1.9 template มีแต่ข้อมูลสังเคราะห์ + placeholder ของ deployment ครบชุดเดียว', () => {
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
  // template ตรงตัวยัง provision ไม่ได้ (ไม่มี UUID จริง)
  assert.throws(() => parseUatFixturePackManifest(template));
});

test('U1.9 render ได้ input UatProvisionV1 ที่ parser ของ U1.8/U1.1 รับ และ digest คงที่', () => {
  const first = render(filledExample());
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.status, {
    type: 'u1.uat.fixture-render',
    status: 'PASS',
    template: 'uat-first-slice.v1',
    steps: String(template.steps.length),
  });
  // stderr ไม่สะท้อนค่าจาก input (อีเมล/ชื่อ)
  assert.doesNotMatch(first.stderr, /@|ผู้ทดสอบ/);
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
  // ส่วนอื่นของ input ไม่ถูกแตะ
  assert.deepEqual({ ...rendered, fixturePack: null }, { ...filledExample(), fixturePack: null });
  assert.deepEqual(scanUatText(JSON.stringify(rendered.fixturePack)), []);

  const digest = uatFixturePackDigest(manifest);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(
    uatFixturePackDigest(parseUatFixturePackManifest(render(filledExample()).output!.fixturePack)),
    digest,
  );
  assert.equal(digest, PINNED_DIGEST);
  // ค่าของ deployment อยู่ใน digest: build SHA อื่น = digest อื่น
  const other = render(filledExample(), ['--build-sha', 'f'.repeat(40)]);
  assert.notEqual(
    uatFixturePackDigest(parseUatFixturePackManifest(other.output!.fixturePack)),
    digest,
  );
});

test('U1.9 baseline + MAKER_EDIT (EVENT_TRIGGER → SEND → WAIT → EXIT) ผ่าน J5 validate/compile/preview/simulate ตามที่ catalog บอก', () => {
  const manifest = parseUatFixturePackManifest(render(filledExample()).output!.fixturePack);
  const document = manifest.baselineDocument as unknown as AuthoringDocumentV1;
  // baseline เดียวกับ acceptance gate U1.7: EVENT_TRIGGER → SEND → EXIT แล้ว maker แทรก WAIT เอง
  assert.equal(document.trigger.type, 'EVENT_TRIGGER');
  assert.deepEqual(
    document.nodes.map((node) => [node.nodeId, node.type]),
    [
      ['send-1', 'SEND'],
      ['done', 'EXIT'],
    ],
  );
  // ref ของ manifest ตรงกับที่ baseline ใช้จริง
  assert.equal(document.settings.senderIdentityId, manifest.senderRef);
  assert.deepEqual(document.nodes[0]!.type === 'SEND' && document.nodes[0]!.config, {
    channel: 'LINE',
    contentRef: manifest.contentRef,
  });
  const fixture = manifest.simulationFixture as SimulationFixtureV1;
  // ไม่มี sendOutcomes ของ SEND = simulation จบพร้อม PREVIEW_FIXTURE_INVALID (สิ่งที่ gate พบ)
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

  // DIAGNOSTIC_RECOVERY: ตัดเส้นถัดไปของ WAIT = PORT_CARDINALITY_INVALID ที่ node และยังบันทึกได้
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

test('U1.9 step catalog ครอบทุกข้อของ walkthrough #416/#379 ด้วย stepId คงที่และป้ายสถานะถูก', () => {
  const manifest = parseUatFixturePackManifest(render(filledExample()).output!.fixturePack);
  const steps = manifest.steps;
  assert.ok(steps.length <= 60);
  const ids = steps.map((step) => step.stepId);
  assert.equal(new Set(ids).size, ids.length);
  for (const step of steps) {
    assert.match(step.stepId, UAT_STEP_ID_PATTERN);
    // title ของ step จาก gate U1.7 คงตามต้นฉบับ (เช่น `Publish`) เพื่อให้ #416 มี catalog เดียว
    if (!GATE_STEP_IDS.includes(step.stepId)) {
      assert.match(step.title, /[\u0E00-\u0E7F]/, `title ภาษาไทย: ${step.stepId}`);
    }
    assert.match(step.expected, /[\u0E00-\u0E7F]/, `expected ภาษาไทย: ${step.stepId}`);
  }
  // หนึ่ง catalog สำหรับ #416: step ของ gate อยู่ครบ ตามลำดับเดิม
  assert.deepEqual(
    ids.filter((id) => GATE_STEP_IDS.includes(id)),
    GATE_STEP_IDS,
  );
  for (const [item, required] of Object.entries(WALKTHROUGH_STEPS)) {
    for (const stepId of required) assert.ok(ids.includes(stepId), `${item}: ขาด ${stepId}`);
  }
  // ไม่มี step ลอยที่ไม่ได้ผูกกับข้อใดของ walkthrough (ยกเว้นป้าย profile UAT ที่เป็นเงื่อนไขก่อนเริ่ม)
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

test('U1.9 example ที่ยังไม่กรอกหรือยังไม่ render ถูกปฏิเสธทั้ง renderer และ parser ของ CLI', () => {
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
  // field อิสระที่รูปแบบรับ `__UAT_…__` ได้ก็ยังถูกดัก
  const filled = filledExample();
  rejects(
    { ...filled, tenant: { ...filled.tenant, name: '__UAT_TENANT_NAME__' } },
    'INPUT_PLACEHOLDER',
    'tenant.name',
  );
  rejects(filled, 'FIXTURE_PACK_NOT_RENDERED', 'fixturePack.template');
  // template ตรง ๆ แทน manifest
  rejects({ ...filled, fixturePack: template }, 'INPUT_PLACEHOLDER', 'fixturePack.environment');

  const renderRejects = (input: unknown, code: string, field?: string, argv?: string[]) => {
    const result = render(input, argv);
    assert.equal(result.code, 1);
    assert.equal(result.output, null);
    assert.equal(result.status.status, 'FAIL');
    assert.equal(result.status.code, code, JSON.stringify(result.status));
    if (field) assert.equal(result.status.field, field);
    assert.doesNotMatch(result.stderr, /@|ผู้ทดสอบ/);
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
  // render แล้วซ้ำอีกรอบไม่ได้ (stub หายไปแล้ว)
  renderRejects(render(filled).output, 'INPUT_INVALID', 'fixturePack');
});
