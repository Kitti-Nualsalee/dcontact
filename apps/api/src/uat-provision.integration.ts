/**
 * U1.8 (#502) acceptance — the CLI that provisions a UAT tenant/accounts/rollout/fixture pack on real Postgres
 * (the owner connection writes; the app connection + RLS + the real J5 prove that `start a new round` works after provisioning)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import {
  JourneyTemplateRepository,
  UatJourneyWriteGuard,
  UatRunRepository,
  importJourneyDefinition,
  type JourneyDefinitionContent,
} from '@d-contact/journey';
import { runUatProvisionCli } from './uat-provision.js';

const OWNER_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://dcontact:dcontact@localhost:5433/dcontact?schema=public';
const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../journey/test/fixtures/j5/j1-schedule.json'), 'utf8'),
) as JourneyDefinitionContent;

type Line = Record<string, string>;

async function harness(t: TestContext) {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_DATABASE_URL } } });
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const directory = mkdtempSync(join(tmpdir(), 'u1-8-'));
  t.after(async () => {
    rmSync(directory, { recursive: true, force: true });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  const short = randomUUID().slice(0, 8);
  const ids = {
    tenantId: randomUUID(),
    teamId: randomUUID(),
    maker: randomUUID(),
    reviewer: randomUUID(),
  };
  /** values that must never appear in the output */
  const pii = {
    makerEmail: `maker-${short}@uat-tester.example`,
    reviewerEmail: `reviewer-${short}@uat-tester.example`,
    makerName: `Tester Maker ${short}`,
    reviewerName: `Tester Reviewer ${short}`,
    tenantName: `UAT Tenant ${short}`,
    teamName: `Journey Owners ${short}`,
  };

  const manifest = (overrides: Record<string, unknown> = {}) => ({
    schema: 'UatFixturePackV1',
    environment: 'uat',
    packVersion: 'pack-1',
    buildSha: 'a1b2c3d4e5f6',
    tenantId: ids.tenantId,
    ownerTeamId: ids.teamId,
    makerSubjectId: ids.maker,
    reviewerSubjectId: ids.reviewer,
    senderRef: 'sender-synthetic-1',
    contentRef: 'content-synthetic-1',
    baselineDocument: importJourneyDefinition({ ...fixture, ownerTeamId: ids.teamId }),
    simulationFixture: {
      fixtureId: 'uat-fx-1',
      startAt: '2026-09-01T00:00:00.000Z',
      seed: 'uat-seed-1',
      context: {},
    },
    steps: [
      {
        stepId: 'LOGIN',
        title: 'Login',
        expected: 'Sees the Journey list',
        stateLabel: 'REAL_STATE',
      },
    ],
    ...overrides,
  });

  const input = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schema: 'UatProvisionV1',
    tenant: { id: ids.tenantId, slug: `u1-8-${short}`, name: pii.tenantName },
    ownerTeam: { id: ids.teamId, name: pii.teamName },
    maker: { dcUserId: ids.maker, email: pii.makerEmail, displayName: pii.makerName },
    reviewer: { dcUserId: ids.reviewer, email: pii.reviewerEmail, displayName: pii.reviewerName },
    rollout: {
      stage: 'INTERNAL_SYNTHETIC',
      canvasWriteEnabled: true,
      publishUiEnabled: true,
      templateCatalogEnabled: false,
      templateUpgradeEnabled: false,
      evidenceRef: 'u1-8-provision-test',
    },
    fixturePack: manifest(),
    ...overrides,
  });

  const output: string[] = [];
  let files = 0;
  const cli = async (
    value: unknown,
    options: { check?: boolean; url?: string; env?: Record<string, string> } = {},
  ) => {
    const file = join(directory, `input-${(files += 1)}.json`);
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    const lines: string[] = [];
    const code = await runUatProvisionCli(
      ['--input', file, ...(options.check ? ['--check'] : [])],
      { DATABASE_URL: options.url ?? OWNER_DATABASE_URL, ...options.env },
      (line) => lines.push(line),
    );
    output.push(...lines);
    const parsed = lines.map((line) => JSON.parse(line) as Line);
    const last = parsed[parsed.length - 1]!;
    return {
      code,
      lines: parsed,
      last,
      parts: parsed.filter((line) => line.part && line.status !== 'FAIL'),
    };
  };

  /** every row the CLI can touch for this tenant/account — used to prove that "nothing changed" */
  const snapshot = async () => {
    const tenantId = ids.tenantId;
    const subjects = [ids.maker, ids.reviewer];
    return JSON.stringify(
      {
        tenant: await owner.tenant.findMany({
          where: { OR: [{ id: tenantId }, { slug: `u1-8-${short}` }] },
        }),
        team: await owner.team.findMany({ where: { OR: [{ id: ids.teamId }, { tenantId }] } }),
        users: await owner.user.findMany({
          where: { OR: [{ id: { in: subjects } }, { tenantId }] },
          orderBy: { id: 'asc' },
        }),
        subjects: await owner.iamAuthoringSubject.findMany({
          where: { OR: [{ subjectId: { in: subjects } }, { tenantId }] },
          orderBy: { subjectId: 'asc' },
        }),
        grants: await owner.iamAuthoringCapabilityGrant.findMany({
          where: { OR: [{ subjectId: { in: subjects } }, { tenantId }] },
          orderBy: [{ subjectId: 'asc' }, { capability: 'asc' }],
        }),
        rollout: await owner.jrAuthoringRolloutState.findMany({ where: { tenantId } }),
        packs: await owner.uatFixturePack.findMany({ where: { tenantId } }),
      },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    );
  };

  /** no output line of this test contains an email, name or credential */
  const assertNoSensitiveOutput = () => {
    const all = output.join('\n');
    for (const value of Object.values(pii)) assert.ok(!all.includes(value), 'output contains PII');
    assert.doesNotMatch(all, /@/);
    for (const url of [OWNER_DATABASE_URL, APPLICATION_DATABASE_URL]) {
      assert.ok(!all.includes(url), 'output contains DATABASE_URL');
      const password = /:\/\/[^:]+:([^@]+)@/.exec(url)?.[1];
      if (password) assert.ok(!all.includes(`:${password}@`));
    }
    assert.doesNotMatch(all, /postgres(ql)?:\/\//);
  };

  return { owner, application, ids, pii, manifest, input, cli, snapshot, assertNoSensitiveOutput };
}

const PARTS = [
  'tenant',
  'ownerTeam',
  'rollout',
  'user:maker',
  'user:reviewer',
  'subject:maker',
  'subject:reviewer',
  'grants:maker',
  'grants:reviewer',
  'fixturePack',
];

test('U1.8 first provision = CREATED for every part, the maker can start a new round via the app connection, a rerun = UNCHANGED', async (t) => {
  const f = await harness(t);
  const first = await f.cli(f.input());
  assert.equal(first.code, 0, JSON.stringify(first.last));
  assert.deepEqual(
    first.parts.map((line) => [line.part, line.status]),
    PARTS.map((part) => [part, 'CREATED']),
  );
  assert.deepEqual(first.last, { type: 'u1.uat.provision', mode: 'apply', status: 'PASS' });
  const pack = first.parts.find((line) => line.part === 'fixturePack')!;
  assert.match(pack.digest!, /^[0-9a-f]{64}$/);

  // what is actually written: users have no real password hash, the subject is STANDARD, the grant matches the preflight
  const maker = await f.owner.user.findUniqueOrThrow({ where: { id: f.ids.maker } });
  assert.equal(maker.passwordHash, '!keycloak-managed');
  assert.equal(maker.teamId, f.ids.teamId);
  const grants = await f.owner.iamAuthoringCapabilityGrant.findMany({
    where: { tenantId: f.ids.tenantId },
    orderBy: [{ subjectId: 'asc' }, { capability: 'asc' }],
  });
  assert.deepEqual(
    grants
      .map(
        (grant) => `${grant.subjectId === f.ids.maker ? 'maker' : 'reviewer'}:${grant.capability}`,
      )
      .sort(),
    [
      'maker:journey.edit',
      'maker:journey.publish',
      'maker:journey.read',
      'reviewer:journey.read',
      'reviewer:journey.review',
    ],
  );
  const tenant = await f.owner.tenant.findUniqueOrThrow({ where: { id: f.ids.tenantId } });
  assert.equal(tenant.lifecycleStatus, 'ACTIVE');

  // the maker's `start a new round` via the app role (RLS) + the real J5 (permission/rollout/audit) — no stub
  const authoring = new JourneyTemplateRepository(f.application, {
    authorization: new IamJourneyAuthoringAuthorizer(),
    evaluator: new DcExprEvaluator(),
    flags: { canvasWrite: true, publishUi: true, templateCatalog: false, templateUpgrade: false },
    writeGuard: new UatJourneyWriteGuard(),
  });
  const runs = new UatRunRepository(f.application, authoring);
  const run = await runs.startNewRun(
    {
      tenantId: f.ids.tenantId,
      actor: { subjectId: f.ids.maker, correlationId: 'u1-8-start' },
      idempotencyKey: `u1-8-${randomUUID()}`,
    },
    { environment: 'uat', packVersion: 'pack-1', expectedRevision: 0 },
  );
  assert.equal(run.lifecycle, 'ACTIVE');
  assert.equal(run.fixturePack.digest, pack.digest);
  assert.ok(run.journeyId);

  // a rerun with the same input = UNCHANGED for every part, and does not touch a run/Journey already started
  const before = await f.snapshot();
  const again = await f.cli(f.input());
  assert.equal(again.code, 0, JSON.stringify(again.last));
  assert.deepEqual(
    again.parts.map((line) => [line.part, line.status]),
    PARTS.map((part) => [part, 'UNCHANGED']),
  );
  assert.equal(again.parts.find((line) => line.part === 'fixturePack')!.digest, pack.digest);
  assert.equal(
    again.parts.find((line) => line.part === 'fixturePack')!.fixturePackId,
    pack.fixturePackId,
  );
  assert.equal(await f.snapshot(), before);
  assert.equal(await f.owner.uatRun.count({ where: { tenantId: f.ids.tenantId } }), 1);
  f.assertNoSensitiveOutput();
});

test('U1.8 --check writes nothing at all, both before and after provisioning, and accepts a path-style manifest', async (t) => {
  const f = await harness(t);
  const empty = await f.snapshot();
  const checked = await f.cli(f.input(), { check: true });
  assert.equal(checked.code, 0, JSON.stringify(checked.last));
  assert.deepEqual(
    checked.parts.map((line) => [line.part, line.status]),
    PARTS.map((part) => [part, 'WOULD_CREATE']),
  );
  // items 1–4 do not exist yet → the pack preflight waits for the apply round (the manifest/digest is still checked)
  assert.equal(checked.parts.at(-1)!.preflight, 'SKIPPED');
  assert.equal(checked.last.mode, 'check');
  assert.equal(await f.snapshot(), empty);

  // a path-style manifest (referenced from the input file's folder)
  const directory = mkdtempSync(join(tmpdir(), 'u1-8-pack-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'pack.json'), JSON.stringify(f.manifest()));
  const { fixturePack: _inline, ...withoutPack } = f.input();
  const byPath = { ...withoutPack, fixturePackPath: join(directory, 'pack.json') };
  const applied = await f.cli(byPath);
  assert.equal(applied.code, 0, JSON.stringify(applied.last));

  // after provisioning: --check = UNCHANGED + the full U1.1 preflight passes, without writing
  const provisioned = await f.snapshot();
  const recheck = await f.cli(f.input(), { check: true });
  assert.equal(recheck.code, 0, JSON.stringify(recheck.last));
  assert.deepEqual(
    recheck.parts.map((line) => line.status),
    PARTS.map(() => 'UNCHANGED'),
  );
  assert.equal(recheck.parts.at(-1)!.preflight, 'PASS');
  // a new pack version that does not exist yet: WOULD_CREATE with the full preflight — still nothing written
  const next = await f.cli(f.input({ fixturePack: f.manifest({ packVersion: 'pack-2' }) }), {
    check: true,
  });
  assert.equal(next.code, 0, JSON.stringify(next.last));
  assert.deepEqual(
    [next.parts.at(-1)!.status, next.parts.at(-1)!.preflight],
    ['WOULD_CREATE', 'PASS'],
  );
  // a --check that finds a conflict fails closed just like apply
  const conflict = await f.cli(f.input({ fixturePack: f.manifest({ buildSha: 'ffffffffffff' }) }), {
    check: true,
  });
  assert.deepEqual([conflict.code, conflict.last.code], [1, 'FIXTURE_PACK_DIGEST_MISMATCH']);
  assert.equal(await f.snapshot(), provisioned);
  f.assertNoSensitiveOutput();
});

test('U1.8 an input that differs from existing rows is rejected (fail closed) with no row changed', async (t) => {
  const f = await harness(t);
  assert.equal((await f.cli(f.input())).code, 0);
  const provisioned = await f.snapshot();
  const base = f.input();
  const rejects = async (value: unknown, code: string, params: Line = {}) => {
    const result = await f.cli(value);
    assert.equal(result.code, 1);
    assert.deepEqual(result.parts, [], 'no part is reported as written');
    assert.equal(result.last.status, 'FAIL');
    assert.equal(result.last.code, code, JSON.stringify(result.last));
    for (const [key, value] of Object.entries(params)) assert.equal(result.last[key], value);
    assert.equal(await f.snapshot(), provisioned);
  };
  const tenant = base.tenant as Record<string, string>;
  await rejects({ ...base, tenant: { ...tenant, slug: `${tenant.slug}-x` } }, 'TENANT_CONFLICT');
  await rejects({ ...base, tenant: { ...tenant, name: 'UAT Tenant renamed' } }, 'TENANT_CONFLICT');
  await rejects(
    { ...base, ownerTeam: { id: f.ids.teamId, name: 'Journey Owners renamed' } },
    'OWNER_TEAM_CONFLICT',
  );
  await rejects(
    { ...base, rollout: { ...(base.rollout as object), templateCatalogEnabled: true } },
    'ROLLOUT_CONFLICT',
  );
  await rejects(
    { ...base, rollout: { ...(base.rollout as object), stage: 'CONTROLLED_AUTHORING' } },
    'ROLLOUT_CONFLICT',
  );
  await rejects(
    {
      ...base,
      maker: { ...(base.maker as object), displayName: 'Tester Maker renamed' },
    },
    'USER_CONFLICT',
    { part: 'user:maker' },
  );
  // the same pack version with different content = the original U1.1 behavior
  await rejects(
    { ...base, fixturePack: f.manifest({ buildSha: 'ffffffffffff' }) },
    'FIXTURE_PACK_DIGEST_MISMATCH',
  );
  // the first parts that "would create" must not be written when a later part conflicts: a new tenant + the owner team of another tenant
  const otherTenant = randomUUID();
  const orphan = await f.cli({
    ...base,
    tenant: { id: otherTenant, slug: `u1-8-${otherTenant.slice(0, 8)}`, name: 'UAT other' },
    fixturePack: f.manifest({ tenantId: otherTenant }),
  });
  assert.deepEqual([orphan.code, orphan.last.code], [1, 'OWNER_TEAM_CONFLICT']);
  assert.equal(await f.owner.tenant.count({ where: { id: otherTenant } }), 0);

  // a grant edited by hand (the maker also got review = a maker-checker violation) → not overwritten, not deleted
  await f.owner.iamAuthoringCapabilityGrant.create({
    data: {
      tenantId: f.ids.tenantId,
      subjectId: f.ids.maker,
      capability: 'journey.review',
      scopeKind: 'TEAM',
      scopeId: f.ids.teamId,
      grantedByRef: 'hand-edit',
    },
  });
  const tampered = await f.snapshot();
  const grants = await f.cli(base);
  assert.deepEqual(
    [grants.code, grants.last.code, grants.last.part],
    [1, 'GRANTS_CONFLICT', 'grants:maker'],
  );
  assert.equal(await f.snapshot(), tampered);
  f.assertNoSensitiveOutput();
});

test('U1.8 rejects an app role, maker = reviewer, a token in free text, the dev seed and unknown keys, before writing', async (t) => {
  const f = await harness(t);
  const empty = await f.snapshot();
  const rejects = async (
    value: unknown,
    code: string,
    params: Line = {},
    options: Parameters<typeof f.cli>[1] = {},
  ) => {
    const result = await f.cli(value, options);
    assert.equal(result.code, 1);
    assert.equal(result.last.code, code, JSON.stringify(result.last));
    for (const [key, entry] of Object.entries(params)) assert.equal(result.last[key], entry);
    assert.equal(await f.snapshot(), empty);
  };
  const base = f.input();
  const maker = base.maker as Record<string, string>;
  const reviewer = base.reviewer as Record<string, string>;

  // the application connection (NOBYPASSRLS) — both apply and check
  await rejects(base, 'APPLICATION_ROLE_REFUSED', {}, { url: APPLICATION_DATABASE_URL });
  await rejects(
    base,
    'APPLICATION_ROLE_REFUSED',
    {},
    { url: APPLICATION_DATABASE_URL, check: true },
  );

  // maker-checker: a duplicate dcUserId or email (case-insensitive)
  await rejects(
    {
      ...base,
      reviewer: { ...reviewer, dcUserId: maker.dcUserId },
      fixturePack: f.manifest({ reviewerSubjectId: maker.dcUserId }),
    },
    'MAKER_REVIEWER_SAME',
    { field: 'dcUserId' },
  );
  await rejects(
    { ...base, reviewer: { ...reviewer, email: maker.email!.toUpperCase() } },
    'MAKER_REVIEWER_SAME',
    { field: 'email' },
  );

  // a fake token in free text → the U1.5 negative scan rejects it before touching the database (assembled from pieces so this file contains no token)
  const fakeJwt = [
    'eyJ' + 'hbGciOiJub25lIn0',
    'eyJ' + 'zdWIiOiJ1YXQtdGVzdCJ9',
    'c2lnbmF0dXJl',
  ].join('.');
  await rejects(
    { ...base, ownerTeam: { id: f.ids.teamId, name: `owners ${fakeJwt}` } },
    'INPUT_SENSITIVE_CONTENT',
    { kind: 'JWT' },
  );
  await rejects(
    { ...base, maker: { ...maker, displayName: `Bearer ${fakeJwt}` } },
    'INPUT_SENSITIVE_CONTENT',
  );
  // an email outside the email field (e.g. in displayName or the manifest) = rejected
  await rejects(
    { ...base, reviewer: { ...reviewer, displayName: 'someone@uat-tester.example' } },
    'INPUT_SENSITIVE_CONTENT',
    { kind: 'EMAIL' },
  );
  await rejects(
    { ...base, fixturePack: f.manifest({ contentRef: 'client_secret=abcdefgh1234' }) },
    'INPUT_SENSITIVE_CONTENT',
    { kind: 'SECRET' },
  );
  // also guards against a JWT filled in via --check (the scan comes before the connection)
  await rejects(
    { ...base, ownerTeam: { id: f.ids.teamId, name: fakeJwt } },
    'INPUT_SENSITIVE_CONTENT',
    { kind: 'JWT' },
    { check: true },
  );

  // dev seed: slug/tenant name and the `.local` accounts
  const tenant = base.tenant as Record<string, string>;
  await rejects({ ...base, tenant: { ...tenant, slug: 'demo' } }, 'DEV_SEED_REFUSED', {
    field: 'tenant.slug',
  });
  await rejects({ ...base, tenant: { ...tenant, name: 'Demo Company' } }, 'DEV_SEED_REFUSED', {
    field: 'tenant.name',
  });
  await rejects({ ...base, maker: { ...maker, email: 'admin@demo.local' } }, 'DEV_SEED_REFUSED', {
    field: 'maker.email',
  });

  // strict schema: unknown/missing keys / wrong values / a manifest bound to a different tenant
  await rejects({ ...base, extra: true }, 'INPUT_INVALID', { field: 'extra' });
  await rejects({ ...base, maker: { ...maker, password: 'x' } }, 'INPUT_INVALID', {
    field: 'maker.password',
  });
  const { rollout: _rollout, ...withoutRollout } = base;
  await rejects(withoutRollout, 'INPUT_INVALID', { field: 'rollout' });
  await rejects(
    { ...base, rollout: { ...(base.rollout as object), publishUiEnabled: false } },
    'INPUT_INVALID',
    { field: 'rollout.publishUiEnabled' },
  );
  await rejects({ ...base, schema: 'UatProvisionV2' }, 'INPUT_INVALID', { field: 'schema' });
  await rejects({ ...base, fixturePack: f.manifest({ tenantId: randomUUID() }) }, 'INPUT_INVALID', {
    field: 'fixturePack.tenantId',
  });
  await rejects({ ...base, fixturePackPath: 'pack.json' }, 'INPUT_INVALID', {
    field: 'fixturePack',
  });
  // the uat.env values must match the input
  await rejects(
    base,
    'TENANT_ENV_MISMATCH',
    { field: 'tenant.id' },
    {
      env: { UAT_TENANT_ID: randomUUID() },
    },
  );
  await rejects(base, 'DATABASE_URL_MISSING', {}, { url: '' });
  f.assertNoSensitiveOutput();
});
