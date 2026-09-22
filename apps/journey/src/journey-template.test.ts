import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DcExprEvaluator } from '@d-contact/expression';
import type {
  AuthoringStepNodeV1,
  JourneyDiagnosticV1,
  JourneyTemplateContentV1,
} from '@d-contact/cxa-contracts';
import {
  JOURNEY_RUNTIME_CAPABILITIES,
  journeyAuthoringDigest,
} from './journey-authoring-canonical.js';
import { compileJourneyDraft } from './journey-authoring-compiler.js';
import { bindTemplate, validateTemplatePackage } from './journey-template-binder.js';
import {
  BuiltInTemplateCatalog,
  JourneyTemplatePackageUntrustedError,
} from './journey-template-catalog.js';
import {
  TemplateUpgradeConflictError,
  TemplateUpgradeStaleError,
  applyTemplateUpgrade,
  checkTemplateUpgrade,
} from './journey-template-upgrade.js';

const evaluator = new DcExprEvaluator();
const capabilities = JOURNEY_RUNTIME_CAPABILITIES;
const catalog = new BuiltInTemplateCatalog();
const REMINDER = '5b0c7a4e-8f1d-4c3a-9b2e-1a7d3c5e9f01';
const JOURNEY_A = '00000000-0000-4000-8000-0000000000a1';
const JOURNEY_B = '00000000-0000-4000-8000-0000000000b2';
const bindings = { reminderContent: 'content-thai-reminder', senderIdentity: 'sender-line-oa' };

const codes = (diagnostics: readonly JourneyDiagnosticV1[]) => diagnostics.map(({ code }) => code);
const reminder = () =>
  structuredClone(catalog.get(REMINDER)!.content) as JourneyTemplateContentV1 & {
    document: { nodes: AuthoringStepNodeV1[] };
  };

test('built-in catalog ผ่าน digest allowlist และไฟล์ที่ถูกแก้โดยไม่อัปเดต allowlist ใช้ไม่ได้ทั้ง catalog', () => {
  assert.equal(catalog.list().length, 2);
  for (const entry of catalog.list()) {
    assert.equal(entry.origin, 'PLATFORM_BUILTIN');
    assert.equal(entry.ownerTeamId, null);
    assert.match(entry.contentDigest, /^[a-f0-9]{64}$/);
  }
  const directory = mkdtempSync(join(tmpdir(), 'j5-catalog-'));
  const original = readFileSync(
    new URL('../templates/builtin/catalog.v1.json', import.meta.url),
    'utf8',
  );
  writeFileSync(
    join(directory, 'catalog.json'),
    original.replace('payment.failed', 'payment.hijacked'),
  );
  writeFileSync(
    join(directory, 'catalog.sha256'),
    readFileSync(new URL('../templates/builtin/catalog.v1.sha256', import.meta.url), 'utf8'),
  );
  assert.throws(
    () =>
      new BuiltInTemplateCatalog({
        catalogPath: join(directory, 'catalog.json'),
        allowlistPath: join(directory, 'catalog.sha256'),
      }),
    (error: unknown) =>
      error instanceof JourneyTemplatePackageUntrustedError &&
      error.code === 'TEMPLATE_PACKAGE_UNTRUSTED',
  );
});

test('package ต้องปิดชุด: secret/script param, reference ที่ฝังใน graph และ bind target ที่ไม่ใช่ scalar ถูกปฏิเสธ', () => {
  assert.deepEqual(validateTemplatePackage(reminder(), capabilities), []);

  const secret = reminder() as any;
  secret.parameterSchema.push({
    parameterKey: 'apiKey',
    labelKey: 'x',
    type: 'SECRET',
    required: true,
    bindTargets: [],
  });
  assert.ok(
    codes(validateTemplatePackage(secret, capabilities)).includes('TEMPLATE_PARAMETER_INVALID'),
  );

  // contentRef ที่ไม่ได้ผูกกับ parameter = template ฝัง reference จริงไว้
  const embedded = reminder() as any;
  embedded.parameterSchema = embedded.parameterSchema.filter(
    (item: any) => item.parameterKey !== 'reminderContent',
  );
  assert.ok(
    codes(validateTemplatePackage(embedded, capabilities)).includes('TEMPLATE_REFERENCE_UNTRUSTED'),
  );

  const objectTarget = reminder() as any;
  objectTarget.parameterSchema[0].bindTargets = [
    { templateNodeKey: '@settings', pointer: '/config/goal' },
  ];
  assert.ok(
    codes(validateTemplatePackage(objectTarget, capabilities)).includes(
      'TEMPLATE_BIND_TARGET_INVALID',
    ),
  );

  const resourceDefault = reminder() as any;
  resourceDefault.parameterSchema.find(
    (item: any) => item.parameterKey === 'senderIdentity',
  ).default = 'sender-x';
  assert.ok(
    codes(validateTemplatePackage(resourceDefault, capabilities)).includes(
      'TEMPLATE_PARAMETER_INVALID',
    ),
  );

  const unavailable = capabilities.map((capability) => ({ ...capability, available: false }));
  const callback = catalog.get('5b0c7a4e-8f1d-4c3a-9b2e-1a7d3c5e9f02')!.content;
  assert.ok(
    codes(validateTemplatePackage(callback, unavailable)).includes(
      'TEMPLATE_CAPABILITY_UNAVAILABLE',
    ),
  );
});

test('binder: required/unknown/unsafe fail closed และ instance คนละ Journey ได้ node ID คนละชุดแบบ deterministic', () => {
  const content = reminder();
  assert.deepEqual(
    codes(
      bindTemplate(content, { senderIdentity: 'sender-1' }, { journeyId: JOURNEY_A, name: 'x' })
        .diagnostics,
    ),
    ['TEMPLATE_PARAMETER_REQUIRED'],
  );
  assert.ok(
    codes(
      bindTemplate(content, { ...bindings, script: 'x' }, { journeyId: JOURNEY_A, name: 'x' })
        .diagnostics,
    ).includes('TEMPLATE_PARAMETER_INVALID'),
  );
  assert.ok(
    codes(
      bindTemplate(content, { ...bindings, waitSeconds: 60 }, { journeyId: JOURNEY_A, name: 'x' })
        .diagnostics,
    ).includes('TEMPLATE_PARAMETER_INVALID'),
  );
  assert.ok(
    codes(
      bindTemplate(
        content,
        { ...bindings, reminderContent: 'a@b.co' },
        { journeyId: JOURNEY_A, name: 'x' },
      ).diagnostics,
    ).includes('TEMPLATE_PARAMETER_INVALID'),
  );

  const a = bindTemplate(content, bindings, { journeyId: JOURNEY_A, name: 'reminder A' });
  const again = bindTemplate(content, bindings, { journeyId: JOURNEY_A, name: 'reminder A' });
  const b = bindTemplate(content, bindings, { journeyId: JOURNEY_B, name: 'reminder B' });
  assert.deepEqual(a, again);
  assert.equal(a.bindingDigest, b.bindingDigest);
  const idsA = Object.values(a.nodeMapping);
  assert.ok(idsA.every((id) => !Object.values(b.nodeMapping).includes(id)));
  // ค่า binding เข้าไปอยู่ใน document ของ tenant และ compile ได้จริง
  const compiled = compileJourneyDraft(
    a.document,
    {
      tenantId: '00000000-0000-4000-8000-000000000001',
      journeyId: JOURNEY_A,
      ownerTeamId: 'team-1',
      draftRevision: 1,
      draftDigest: journeyAuthoringDigest(a.document),
      baseHeadVersion: 1,
    },
    { evaluator, capabilities },
  );
  assert.deepEqual(compiled.diagnostics, []);
  const steps = compiled.artifact!.runtimeDefinition.graph.steps;
  assert.equal(steps.find((step) => step.type === 'SEND')!.id, a.nodeMapping['send-reminder']);
  assert.equal(
    (steps.find((step) => step.type === 'SEND') as { contentRef: string }).contentRef,
    'content-thai-reminder',
  );
  assert.equal(compiled.artifact!.runtimeDefinition.senderIdentityId, 'sender-line-oa');
});

function instance() {
  const base = reminder();
  const bound = bindTemplate(base, bindings, { journeyId: JOURNEY_A, name: 'reminder A' });
  return { base, local: bound.document!, nodeMapping: bound.nodeMapping };
}

const upgradeInput = (
  base: JourneyTemplateContentV1,
  target: JourneyTemplateContentV1,
  local: any,
  nodeMapping: Record<string, string>,
) => ({
  journeyId: JOURNEY_A,
  fromVersion: 1,
  toVersion: 2,
  base,
  target,
  local,
  nodeMapping,
  capabilities,
});

test('upgrade: template ไม่เปลี่ยนความหมายเป็น visual-only และ proposal digest คงที่', () => {
  const { base, local, nodeMapping } = instance();
  const target = reminder() as any;
  target.document.layout.nodes.send = { x: 999, y: 1 };
  const first = checkTemplateUpgrade(upgradeInput(base, target, local, nodeMapping));
  const second = checkTemplateUpgrade(
    upgradeInput(base, structuredClone(target), structuredClone(local), { ...nodeMapping }),
  );
  assert.equal(first.visualOnly, true);
  assert.deepEqual(first.conflicts, []);
  assert.equal(first.proposalDigest, second.proposalDigest);
  assert.deepEqual(first.proposedDocument.nodes, local.nodes);
});

test('upgrade: template แก้ field ที่ local ไม่แตะรับได้เลย, แก้ชนกันต้องเลือก explicit และ field ที่ bind คงค่าของ tenant', () => {
  const { base, local, nodeMapping } = instance();
  const target = reminder() as any;
  target.document.nodes.find((node: any) => node.templateNodeKey === 'done').config.reason =
    'REMINDER_SENT';
  const clean = checkTemplateUpgrade(upgradeInput(base, target, local, nodeMapping));
  assert.deepEqual(clean.conflicts, []);
  const exit = clean.proposedDocument.nodes.find(
    (node: any) => node.nodeId === nodeMapping.done,
  ) as any;
  assert.equal(exit.config.reason, 'REMINDER_SENT');
  const send = clean.proposedDocument.nodes.find(
    (node: any) => node.nodeId === nodeMapping['send-reminder'],
  ) as any;
  assert.equal(send.config.contentRef, 'content-thai-reminder');

  // ทั้ง local และ template แก้ field เดียวกันต่างค่า → conflict ไม่มี silent merge
  const edited = structuredClone(local) as any;
  edited.nodes.find((node: any) => node.nodeId === nodeMapping.done).config.reason = 'LOCAL_REASON';
  const proposal = checkTemplateUpgrade(upgradeInput(base, target, edited, nodeMapping));
  assert.deepEqual(
    proposal.conflicts.map((item) => item.kind),
    ['FIELD_CHANGED_BOTH'],
  );
  const expected = {
    proposalDigest: proposal.proposalDigest,
    conflictDigest: proposal.conflictDigest,
  };
  assert.throws(
    () =>
      applyTemplateUpgrade(upgradeInput(base, target, edited, nodeMapping), {
        ...expected,
        resolutions: {},
      }),
    TemplateUpgradeConflictError,
  );
  const conflictId = proposal.conflicts[0]!.conflictId;
  const take = applyTemplateUpgrade(upgradeInput(base, target, edited, nodeMapping), {
    ...expected,
    resolutions: { [conflictId]: 'TAKE_TEMPLATE' },
  });
  const keep = applyTemplateUpgrade(upgradeInput(base, target, edited, nodeMapping), {
    ...expected,
    resolutions: { [conflictId]: 'KEEP_LOCAL' },
  });
  const reason = (document: any) =>
    document.nodes.find((node: any) => node.nodeId === nodeMapping.done).config.reason;
  assert.equal(reason(take.document), 'REMINDER_SENT');
  assert.equal(reason(keep.document), 'LOCAL_REASON');

  // draft เปลี่ยนหลังเห็น proposal → stale ห้าม apply ทับ
  const moved = structuredClone(edited);
  moved.settings.maxDurationDays = 3;
  assert.throws(
    () =>
      applyTemplateUpgrade(upgradeInput(base, target, moved, nodeMapping), {
        ...expected,
        resolutions: { [conflictId]: 'KEEP_LOCAL' },
      }),
    TemplateUpgradeStaleError,
  );
});

test('upgrade: template ลบ node ที่ local แก้ไว้ และ required parameter ใหม่ที่ไม่มีค่าต้องไม่ผ่านแบบเงียบ', () => {
  const { base, local, nodeMapping } = instance();
  const target = reminder() as any;
  target.document.nodes = target.document.nodes.filter(
    (node: any) => node.templateNodeKey !== 'wait',
  );
  target.document.edges = [
    { edgeId: 'start', source: { nodeId: 'trigger', portId: 'start' }, target: { nodeId: 'send' } },
    { edgeId: 'send-next', source: { nodeId: 'send', portId: 'next' }, target: { nodeId: 'done' } },
  ];
  target.parameterSchema = target.parameterSchema.filter(
    (item: any) => item.parameterKey !== 'waitSeconds',
  );
  // local ไม่ได้แก้ wait: ลบตาม template ได้และ compile ได้
  const removed = checkTemplateUpgrade(upgradeInput(base, target, local, nodeMapping));
  assert.ok(!removed.proposedDocument.nodes.some((node: any) => node.nodeId === nodeMapping.wait));

  const edited = structuredClone(local) as any;
  edited.nodes.find((node: any) => node.nodeId === nodeMapping.wait).label = 'x';
  edited.nodes.find((node: any) => node.nodeId === nodeMapping.done).config.reason = 'LOCAL';
  // template เพิ่ม SEND ใหม่ที่ต้องใช้ content ใหม่ (required ไม่มี default) — ไม่มีค่าเดิมให้ใช้ต่อจึง block
  const withRequired = structuredClone(target) as any;
  withRequired.document.nodes.find((node: any) => node.templateNodeKey === 'done').config.reason =
    'TEMPLATE';
  withRequired.document.nodes.push({
    nodeId: 'follow',
    type: 'SEND',
    templateNodeKey: 'follow-up',
    config: { channel: 'LINE', contentRef: 'placeholder-content' },
  });
  withRequired.document.edges = [
    { edgeId: 'start', source: { nodeId: 'trigger', portId: 'start' }, target: { nodeId: 'send' } },
    {
      edgeId: 'send-next',
      source: { nodeId: 'send', portId: 'next' },
      target: { nodeId: 'follow' },
    },
    {
      edgeId: 'follow-next',
      source: { nodeId: 'follow', portId: 'next' },
      target: { nodeId: 'done' },
    },
  ];
  withRequired.parameterSchema.push({
    parameterKey: 'followUpContent',
    labelKey: 'x',
    type: 'OPAQUE_RESOURCE_REF',
    resourceKind: 'CONTENT',
    required: true,
    bindTargets: [{ templateNodeKey: 'follow-up', pointer: '/config/contentRef' }],
  });
  assert.deepEqual(validateTemplatePackage(withRequired, capabilities), []);
  const blocked = checkTemplateUpgrade(upgradeInput(base, withRequired, edited, nodeMapping));
  assert.ok(blocked.conflicts.some((item) => item.kind === 'PARAMETER_REQUIRED_UNBOUND'));
  assert.throws(
    () =>
      applyTemplateUpgrade(upgradeInput(base, withRequired, edited, nodeMapping), {
        proposalDigest: blocked.proposalDigest,
        conflictDigest: blocked.conflictDigest,
        resolutions: Object.fromEntries(
          blocked.conflicts.map((item) => [item.conflictId, 'KEEP_LOCAL']),
        ),
      }),
    TemplateUpgradeConflictError,
  );
});
