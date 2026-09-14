import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  buildCg4PolicyScopeKey,
  type Cg4EvidenceAccessRecord,
} from '@d-contact/contact-governance';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
} from './gateway-auth.js';
import {
  CG4_API_CONTROLLERS,
  CG4_DATABASE,
  CG4_EVIDENCE_ACCESS_SINK,
} from './contact-governance-cg4-api.js';

/**
 * CG4.7 (#190): the command/query surface end to end, with two tenants in every fixture.
 *
 * The point of the second tenant is not coverage padding: #179 §3 requires a resource in
 * another tenant to be reported exactly like one that never existed, and that is only
 * provable with a real id that really does exist somewhere else.
 */

const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});

const DIGEST = 'a'.repeat(64);
const SCOPE_KEY = buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' });

function workspaceClaims(
  tenantId: string,
  userId: string,
  role: 'agent' | 'admin' | 'compliance' | 'platform-operator',
): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: `tenant-${tenantId}`,
    organization: { [`tenant-${tenantId}`]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: [role] },
  };
}

interface TenantFixture {
  tenantId: string;
  contactId: string;
  identityId: string;
  policyId: string;
  maker: string;
  checker: string;
  reader: string;
}

async function seedTenant(label: string): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const identityId = randomUUID();
  const policyId = randomUUID();
  const maker = `maker-${randomUUID()}`;
  const checker = `checker-${randomUUID()}`;
  const reader = `reader-${randomUUID()}`;

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `CG4.7 ${label} ${tenantId}`,
      slug: `cg47-${label}-${tenantId}`,
      sipDomain: `${tenantId}.cg47.test`,
    },
  });
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'CG4.7' } });
  await owner.contactIdentity.create({
    data: {
      id: identityId,
      tenantId,
      contactId,
      type: 'PHONE',
      value: `+66${tenantId.replace(/\D/g, '').slice(0, 9)}`,
    },
  });
  await owner.cg4Policy.create({
    data: {
      id: randomUUID(),
      tenantId,
      policyId,
      version: 1,
      scopeKey: SCOPE_KEY,
      content: { allowedOperationalRuleCodes: ['QUIET_HOURS'] },
      contentDigest: DIGEST,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      // An exception may only pin a policy that is actually in force (#177 §1).
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      makerActorRef: maker,
    },
  });

  // The authorization store is administered outside the application role, exactly as the
  // production grants require — the app can only read it.
  for (const [subjectId, directCompliance] of [
    [maker, false],
    [checker, true],
    [reader, false],
  ] as const) {
    await owner.cg4AuthorizationSubject.create({
      data: {
        id: randomUUID(),
        tenantId,
        subjectId,
        directComplianceAuthority: directCompliance,
        emergencyAuthority: false,
        isServicePrincipal: false,
        authorizationEpoch: 1,
        scopeVersion: 1,
      },
    });
  }
  for (const [subjectId, capability] of [
    [maker, 'cg.exception.request'],
    [maker, 'cg.policy.draft'],
    [checker, 'cg.exception.approve.standard'],
    [checker, 'cg.exception.approve.high'],
    [checker, 'cg.exception.revoke'],
    [checker, 'cg.policy.publish'],
    [checker, 'cg.policy.publish.relaxation'],
  ] as const) {
    await owner.cg4CapabilityGrant.create({
      data: {
        id: randomUUID(),
        tenantId,
        subjectId,
        capability,
        scopeKey: SCOPE_KEY,
        grantedByRef: 'iam-fixture',
      },
    });
  }

  return { tenantId, contactId, identityId, policyId, maker, checker, reader };
}

async function dropTenant(tenantId: string): Promise<void> {
  await owner.cg4ExceptionApproval.deleteMany({ where: { tenantId } });
  await owner.cg4Exception.updateMany({ where: { tenantId }, data: { renewsExceptionId: null } });
  await owner.cg4ExceptionHead.deleteMany({ where: { tenantId } });
  await owner.cg4Exception.deleteMany({ where: { tenantId } });
  await owner.cg4ContactExceptionHead.deleteMany({ where: { tenantId } });
  await owner.cg4PolicyApproval.deleteMany({ where: { tenantId } });
  await owner.cg4PolicyTestArtifact.deleteMany({ where: { tenantId } });
  await owner.cg4PolicyActivationJob.deleteMany({ where: { tenantId } });
  await owner.cg4PolicyScopeHead.deleteMany({ where: { tenantId } });
  await owner.cg4Policy.deleteMany({ where: { tenantId } });
  await owner.cg4ScopeKillSwitch.deleteMany({ where: { tenantId } });
  await owner.cg4CapabilityGrant.deleteMany({ where: { tenantId } });
  await owner.cg4AuthorizationSubject.deleteMany({ where: { tenantId } });
  await owner.cgEventOutbox.deleteMany({ where: { tenantId } });
  await owner.cgAuditLog.deleteMany({ where: { tenantId } });
  await owner.cgCommandReceipt.deleteMany({ where: { tenantId } });
  await owner.contactIdentity.deleteMany({ where: { tenantId } });
  await owner.contact.deleteMany({ where: { tenantId } });
  await owner.tenant.deleteMany({ where: { id: tenantId } });
}

async function fixture(t: TestContext) {
  const primary = await seedTenant('a');
  const other = await seedTenant('b');
  const evidenceReads: Cg4EvidenceAccessRecord[] = [];

  const tokens = new Map<string, VerifiedOidcClaims>([
    ['maker-token', workspaceClaims(primary.tenantId, primary.maker, 'admin')],
    ['checker-token', workspaceClaims(primary.tenantId, primary.checker, 'compliance')],
    // Same subject as maker-token, with the gateway role the policy-approval route needs:
    // lets a test isolate the domain-level SoD check from the coarse gateway guard.
    ['maker-compliance-token', workspaceClaims(primary.tenantId, primary.maker, 'compliance')],
    ['reader-token', workspaceClaims(primary.tenantId, primary.reader, 'admin')],
    ['stranger-token', workspaceClaims(primary.tenantId, `unknown-${randomUUID()}`, 'admin')],
    ['other-maker-token', workspaceClaims(other.tenantId, other.maker, 'admin')],
  ]);

  const verifier = {
    verifyAccessToken: async (token: string) => {
      const claims = tokens.get(token);
      if (!claims) throw new Error('invalid token');
      return claims;
    },
  };

  @Module({
    controllers: [...CG4_API_CONTROLLERS],
    providers: [
      { provide: CG4_DATABASE, useValue: application },
      {
        provide: CG4_EVIDENCE_ACCESS_SINK,
        useValue: { record: (access: Cg4EvidenceAccessRecord) => void evidenceReads.push(access) },
      },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/v1/contact-governance`;

  t.after(async () => {
    await app.close();
    await dropTenant(primary.tenantId);
    await dropTenant(other.tenantId);
  });

  return { primary, other, base, evidenceReads };
}

test.after(async () => {
  await Promise.all([owner.$disconnect(), application.$disconnect()]);
});

function post(url: string, token: string, payload: unknown, idempotencyKey = randomUUID()) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
}

function get(url: string, token: string) {
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
}

/**
 * Reads the body exactly once. `assert.equal(res.status, 201, await res.text())` evaluates
 * its message eagerly and leaves the body consumed, which then fails as "Body is unusable".
 */
async function expectJson<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

function exceptionRequest(f: { primary: TenantFixture }, overrides: Record<string, unknown> = {}) {
  return {
    contactId: f.primary.contactId,
    // An EXACT_IDENTITY scope keeps the platform risk floor at STANDARD; CONTACT_WIDE
    // forces HIGH, which is a different (also tested) quorum path.
    identityId: f.primary.identityId,
    channel: 'VOICE',
    purpose: 'SERVICE_NOTIFICATION',
    sourceType: 'DIALER',
    sourceId: 'dialer-1',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: f.primary.policyId,
    policyVersion: 1,
    policyContentDigest: DIGEST,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: '2026-01-05T09:00:00.000Z',
    expiresAt: '2026-01-05T11:00:00.000Z',
    riskTier: 'STANDARD',
    reasonCode: 'OPERATIONAL',
    occurredAt: '2026-01-05T08:00:00.000Z',
    ticketRef: 'ticket://INC-4821',
    evidenceRef: 'evidence://cg47',
    expectedVersion: 0,
    ...overrides,
  };
}

test('subject ที่ไม่มีใน authorization store ถูกปฏิเสธแม้ gateway role จะผ่าน', async (t) => {
  const f = await fixture(t);
  const response = await post(`${f.base}/exceptions`, 'stranger-token', exceptionRequest(f));
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { code: string }).code, 'CAPABILITY_REQUIRED');
});

test('maker สร้าง exception ได้ และ actorRef มาจาก identity ไม่ใช่ body', async (t) => {
  const f = await fixture(t);
  const created = await post(
    `${f.base}/exceptions`,
    'maker-token',
    exceptionRequest(f, { actorRef: 'someone-else', tenantId: f.other.tenantId }),
  );
  assert.equal(created.status, 201);
  const payload = (await created.json()) as { seriesId: string; revision: number };
  assert.equal(payload.revision, 1);

  const row = await owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, exceptionId: payload.seriesId },
  });
  assert.equal(row.actorRef, f.primary.maker, 'actorRef ต้องมาจาก verified identity');
  assert.equal(row.tenantId, f.primary.tenantId, 'tenantId ใน body ต้องถูกละเว้น');
});

test('checker คนอื่น approve ได้ และ maker approve ตัวเองไม่ได้', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };
  const row = await owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, exceptionId: seriesId },
  });

  const decision = {
    decision: 'APPROVE',
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    expectedVersion: 1,
    evidenceRef: 'evidence://approval',
  };

  const selfApproval = await post(
    `${f.base}/exceptions/${seriesId}/approvals`,
    'maker-token',
    decision,
  );
  assert.equal(selfApproval.status, 403);
  assert.equal(((await selfApproval.json()) as { code: string }).code, 'SELF_APPROVAL_FORBIDDEN');

  const approved = await post(
    `${f.base}/exceptions/${seriesId}/approvals`,
    'checker-token',
    decision,
  );
  assert.equal(approved.status, 200);
  const result = (await approved.json()) as { workflowState: string };
  assert.equal(result.workflowState, 'APPROVED');
});

test('resource ของ tenant อื่นตอบ 404 แบบเดียวกับที่ไม่มีอยู่จริง', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };

  const crossTenant = await get(`${f.base}/exceptions/${seriesId}`, 'other-maker-token');
  const missing = await get(`${f.base}/exceptions/${randomUUID()}`, 'other-maker-token');
  assert.equal(crossTenant.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await crossTenant.json(), await missing.json());
});

test('reader ที่ไม่มี approval capability เห็น evidence/ticket/actor เป็น digest เท่านั้น', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };

  const asReader = await get(`${f.base}/exceptions/${seriesId}`, 'reader-token');
  assert.equal(asReader.status, 200);
  const summary = (await asReader.json()) as Record<
    string,
    { redacted?: boolean; digest?: string }
  >;
  for (const field of ['evidenceRef', 'ticketRef', 'actorRef']) {
    assert.equal(summary[field]?.redacted, true, field);
    assert.equal(typeof summary[field]?.digest, 'string', field);
  }
  assert.doesNotMatch(JSON.stringify(summary), /INC-4821/);
  assert.doesNotMatch(JSON.stringify(summary), /evidence:\/\/cg47/);

  const asChecker = await get(`${f.base}/exceptions/${seriesId}`, 'checker-token');
  const evidence = (await asChecker.json()) as Record<string, unknown>;
  assert.equal(evidence.evidenceRef, 'evidence://cg47');
  assert.equal(evidence.ticketRef, 'ticket://INC-4821');
  assert.equal(evidence.actorRef, f.primary.maker);
});

test('การอ่าน evidence ถูกบันทึกไว้ ส่วนการอ่านแบบ summary ไม่ถูกบันทึก', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };

  await get(`${f.base}/exceptions/${seriesId}`, 'reader-token');
  assert.equal(f.evidenceReads.length, 0);

  await get(`${f.base}/exceptions/${seriesId}`, 'checker-token');
  assert.equal(f.evidenceReads.length, 1);
  assert.equal(f.evidenceReads[0]?.resourceKind, 'EXCEPTION');
  assert.equal(f.evidenceReads[0]?.resourceId, seriesId);
  assert.equal(f.evidenceReads[0]?.viewerSubjectId, f.primary.checker);
});

test('Idempotency-Key ที่หายไปถูกปฏิเสธ และ key เดิม body ต่างเป็น conflict', async (t) => {
  const f = await fixture(t);
  const noKey = await fetch(`${f.base}/exceptions`, {
    method: 'POST',
    headers: { authorization: 'Bearer maker-token', 'content-type': 'application/json' },
    body: JSON.stringify(exceptionRequest(f)),
  });
  assert.equal(noKey.status, 400);
  assert.equal(((await noKey.json()) as { code: string }).code, 'VALIDATION_FAILED');

  const key = randomUUID();
  const first = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f), key);
  assert.equal(first.status, 201);
  const replay = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f), key);
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), await first.json());

  const conflicting = await post(
    `${f.base}/exceptions`,
    'maker-token',
    exceptionRequest(f, { reasonCode: 'DIFFERENT' }),
    key,
  );
  assert.equal(conflicting.status, 409);
  assert.equal(((await conflicting.json()) as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
});

test('expectedVersion ที่ล้าสมัยเป็น 409 VERSION_CONFLICT', async (t) => {
  const f = await fixture(t);
  await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const stale = await post(
    `${f.base}/exceptions`,
    'maker-token',
    exceptionRequest(f, {
      sourceId: 'dialer-2',
      expectedVersion: 0,
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, 'VERSION_CONFLICT');
});

test('GET คืน ETag ที่ผูกกับ revision ปัจจุบัน', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };
  const response = await get(`${f.base}/exceptions/${seriesId}`, 'checker-token');
  const etag = response.headers.get('etag');
  assert.ok(etag);
  assert.match(etag, new RegExp(`^"cg4-exception:${seriesId}:1:`));
  // CG4.9 (#192): query คืน current CAS version ที่ Console ต้องส่งกลับเป็น expectedVersion (#179 §2)
  const view = (await response.json()) as { aggregateVersion: number };
  assert.equal(view.aggregateVersion, 1);
  const listing = (await (
    await get(`${f.base}/contacts/${f.primary.contactId}/exceptions`, 'checker-token')
  ).json()) as { exceptions: Array<{ aggregateVersion: number }> };
  assert.equal(listing.exceptions[0]?.aggregateVersion, 1);
});

test('history และ contact listing ถูก redact ตาม viewer และไม่ข้าม tenant', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };

  const history = await get(`${f.base}/exceptions/${seriesId}/history`, 'reader-token');
  assert.equal(history.status, 200);
  const historyBody = await history.text();
  assert.doesNotMatch(historyBody, /INC-4821/);

  const listing = await get(`${f.base}/contacts/${f.primary.contactId}/exceptions`, 'reader-token');
  assert.equal(listing.status, 200);
  const listed = (await listing.json()) as { exceptions: unknown[] };
  assert.equal(listed.exceptions.length, 1);

  // contact ของ tenant นี้ เมื่อมองจาก tenant อื่น ต้องว่างเปล่า ไม่ใช่ 403 ที่บอกว่ามีอยู่
  const crossTenant = await get(
    `${f.base}/contacts/${f.primary.contactId}/exceptions`,
    'other-maker-token',
  );
  assert.equal(crossTenant.status, 200);
  assert.deepEqual(((await crossTenant.json()) as { exceptions: unknown[] }).exceptions, []);
});

test('policy draft สร้าง scope key จาก scope object ไม่ใช่จาก string ที่ caller ส่ง', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/policies`, 'maker-token', {
    scope: { channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' },
    scopeKey: 'channel=*|contactKind=*|purpose=*|sourceType=*',
    content: {
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '22:00', endLocal: '06:00' }],
      callbackMode: 'NO_OVERRIDE',
      overridableRules: [],
      allowedOperationalRuleCodes: [],
      holidays: [],
    },
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    evidenceRef: 'evidence://policy',
  });
  assert.equal(created.status, 201);
  const payload = (await created.json()) as { scopeKey: string; policyId: string };
  assert.equal(payload.scopeKey, SCOPE_KEY, 'scopeKey ใน body ต้องถูกละเว้น');
});

test('content ที่หลุด non-overridable rule ถูกปฏิเสธที่ API', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/policies`, 'maker-token', {
    scope: { channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' },
    content: {
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [],
      callbackMode: 'NO_OVERRIDE',
      overridableRules: [],
      allowedOperationalRuleCodes: ['DNC_GLOBAL'],
      holidays: [],
    },
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    evidenceRef: 'evidence://policy',
  });
  assert.equal(created.status, 422);
  assert.equal(((await created.json()) as { code: string }).code, 'NON_OVERRIDABLE_RULE');
});

test('agent role ที่ไม่มี grant ถูกกันตั้งแต่ gateway และ subject ที่ไม่มี capability ตรง scope ถูกกันที่ domain', async (t) => {
  const f = await fixture(t);
  // reader มี subject อยู่ใน store แต่ไม่มี capability ใด ๆ
  const denied = await post(`${f.base}/exceptions`, 'reader-token', exceptionRequest(f));
  assert.equal(denied.status, 403);
  const payload = (await denied.json()) as { code: string; capability?: string };
  assert.equal(payload.code, 'CAPABILITY_REQUIRED');
});

test('kill switch เปิดได้และ list กรองตาม state', async (t) => {
  const f = await fixture(t);
  const activated = await post(`${f.base}/kill-switches`, 'checker-token', {
    scopeKey: SCOPE_KEY,
    reasonCode: 'INCIDENT',
    evidenceRef: 'evidence://kill',
  });
  assert.equal(activated.status, 201);
  const { killSwitchId } = (await activated.json()) as { killSwitchId: string };

  const listed = await get(`${f.base}/kill-switches?state=ACTIVE`, 'checker-token');
  const rows = (await listed.json()) as { killSwitches: { killSwitchId: string }[] };
  assert.equal(rows.killSwitches.length, 1);
  assert.equal(rows.killSwitches[0]?.killSwitchId, killSwitchId);

  // tenant อื่นต้องไม่เห็น kill switch ของ tenant นี้
  const crossTenant = await get(`${f.base}/kill-switches?state=ACTIVE`, 'other-maker-token');
  assert.deepEqual(((await crossTenant.json()) as { killSwitches: unknown[] }).killSwitches, []);
});

test('kill switch clear ต้องเป็นคนละ subject และมี approval ref', async (t) => {
  const f = await fixture(t);
  const activated = await post(`${f.base}/kill-switches`, 'checker-token', {
    scopeKey: SCOPE_KEY,
    reasonCode: 'INCIDENT',
    evidenceRef: 'evidence://kill',
  });
  const { killSwitchId } = (await activated.json()) as { killSwitchId: string };

  const selfClear = await post(`${f.base}/kill-switches/${killSwitchId}/clear`, 'checker-token', {
    reasonCode: 'RESOLVED',
    clearApprovalRef: 'approval://clear',
    evidenceRef: 'evidence://clear',
  });
  assert.equal(selfClear.status, 422);
  assert.equal(((await selfClear.json()) as { code: string }).code, 'APPROVAL_REQUIRED');
});

const TENANT_PACK = {
  packId: 'TENANT_SYNTHETIC',
  suiteVersion: 'TENANT_SYNTHETIC_V1',
  checks: [
    {
      id: 'tenant:quiet-hours-local-clock',
      kind: 'QUIET_HOURS_FOLLOW_LOCAL_CLOCK',
      timezone: 'Asia/Bangkok',
      fromInstant: '2026-01-05T00:00:00.000Z',
      probeHours: 12,
      stepMinutes: 120,
    },
  ],
};

const POLICY_CONTENT = {
  timezoneFallback: 'Asia/Bangkok',
  quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '22:00', endLocal: '06:00' }],
  callbackMode: 'NO_OVERRIDE',
  overridableRules: [],
  allowedOperationalRuleCodes: [],
  holidays: [],
};

test('policy เดินครบวงจรผ่าน API: draft → tests → submit → approve → publish', async (t) => {
  const f = await fixture(t);
  // ปล่อย scope ที่ fixture ยึดไว้ เพื่อให้ head ของ scope นี้ว่างสำหรับ publish จริง
  await owner.cg4Policy.deleteMany({ where: { tenantId: f.primary.tenantId } });

  const created = await post(`${f.base}/policies`, 'maker-token', {
    scope: { channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' },
    content: POLICY_CONTENT,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    evidenceRef: 'evidence://policy',
  });
  const draft = await expectJson<{
    policyId: string;
    policyVersionId: string;
    contentDigest: string;
    draftRevision: number;
  }>(created, 201);

  const tested = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/tests`,
    'maker-token',
    {
      expectedContentDigest: draft.contentDigest,
      tenantPack: TENANT_PACK,
      pinnedEvaluationTime: '2026-01-05T00:00:00.000Z',
      pinnedTimezone: 'Asia/Bangkok',
      evidenceRef: 'evidence://tests',
    },
  );
  const artifact = await expectJson<{
    artifactDigest: string;
    diffClass: string;
    outcome: string;
    baseHeadVersion: number;
    baseHeadDigest: string;
  }>(tested, 201);
  assert.equal(artifact.outcome, 'PASS');
  assert.equal(artifact.diffClass, 'TIGHTENING');

  const submitted = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/submit`,
    'maker-token',
    {
      expectedDraftRevision: draft.draftRevision,
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      evidenceRef: 'evidence://submit',
    },
  );
  await expectJson(submitted, 200);

  const approved = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/approvals`,
    'checker-token',
    {
      decision: 'APPROVE',
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      expectedScopeHeadVersion: artifact.baseHeadVersion,
      expectedScopeHeadDigest: artifact.baseHeadDigest,
      activateAt: '2026-01-05T00:00:00.000Z',
      evidenceRef: 'evidence://approval',
    },
  );
  const approvedBody = await expectJson<{ lifecycleState: string }>(approved, 200);
  assert.equal(approvedBody.lifecycleState, 'APPROVED');

  const row = await owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, id: draft.policyVersionId },
  });
  const published = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/publish`,
    'checker-token',
    {
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      expectedApprovalDigest: row.approvalDigest,
      expectedScopeHeadVersion: artifact.baseHeadVersion,
      expectedScopeHeadDigest: artifact.baseHeadDigest,
      evidenceRef: 'evidence://publish',
    },
  );
  const result = await expectJson<{ lifecycleState: string; scopeKey: string }>(published, 200);
  assert.equal(result.lifecycleState, 'ACTIVE');

  const effective = await get(
    `${f.base}/policy-scopes/${encodeURIComponent(result.scopeKey)}/effective`,
    'checker-token',
  );
  assert.equal(effective.status, 200);
  const head = (await effective.json()) as { activePolicyVersion: number; headVersion: number };
  assert.equal(head.activePolicyVersion, 1);
  assert.equal(head.headVersion, 1);
});

test('maker submit แล้ว approve ตัวเองไม่ได้ แม้จะมี publish capability', async (t) => {
  const f = await fixture(t);
  await owner.cg4CapabilityGrant.create({
    data: {
      id: randomUUID(),
      tenantId: f.primary.tenantId,
      subjectId: f.primary.maker,
      capability: 'cg.policy.publish',
      scopeKey: SCOPE_KEY,
      grantedByRef: 'iam-fixture',
    },
  });
  await owner.cg4Policy.deleteMany({ where: { tenantId: f.primary.tenantId } });

  const created = await post(`${f.base}/policies`, 'maker-token', {
    scope: { channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' },
    content: POLICY_CONTENT,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    evidenceRef: 'evidence://policy',
  });
  const draft = (await created.json()) as {
    policyVersionId: string;
    contentDigest: string;
    draftRevision: number;
  };
  const tested = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/tests`,
    'maker-token',
    {
      expectedContentDigest: draft.contentDigest,
      tenantPack: TENANT_PACK,
      pinnedEvaluationTime: '2026-01-05T00:00:00.000Z',
      pinnedTimezone: 'Asia/Bangkok',
      evidenceRef: 'evidence://tests',
    },
  );
  const artifact = (await tested.json()) as {
    artifactDigest: string;
    baseHeadVersion: number;
    baseHeadDigest: string;
  };
  await post(`${f.base}/policy-versions/${draft.policyVersionId}/submit`, 'maker-token', {
    expectedDraftRevision: draft.draftRevision,
    expectedContentDigest: draft.contentDigest,
    expectedTestArtifactDigest: artifact.artifactDigest,
    evidenceRef: 'evidence://submit',
  });

  const selfApproval = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/approvals`,
    'maker-compliance-token',
    {
      decision: 'APPROVE',
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      expectedScopeHeadVersion: artifact.baseHeadVersion,
      expectedScopeHeadDigest: artifact.baseHeadDigest,
      activateAt: '2026-01-05T00:00:00.000Z',
      evidenceRef: 'evidence://approval',
    },
  );
  assert.equal(selfApproval.status, 403);
  assert.equal(((await selfApproval.json()) as { code: string }).code, 'SELF_APPROVAL_FORBIDDEN');
});

test('exception ที่ approve แล้ว revoke ได้ และ history เก็บทุก revision', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };
  const row = await owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, exceptionId: seriesId },
  });

  await post(`${f.base}/exceptions/${seriesId}/approvals`, 'checker-token', {
    decision: 'APPROVE',
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    expectedVersion: 1,
    evidenceRef: 'evidence://approval',
  });

  const revoked = await post(`${f.base}/exceptions/${seriesId}/revoke`, 'checker-token', {
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    expectedVersion: 2,
    reasonCode: 'INCIDENT',
    evidenceRef: 'evidence://revoke',
  });
  const revokedBody = await expectJson<{ workflowState: string }>(revoked, 200);
  assert.equal(revokedBody.workflowState, 'REVOKED');

  const history = await get(`${f.base}/exceptions/${seriesId}/history`, 'checker-token');
  const body = (await history.json()) as { revisions: { revision: number }[] };
  assert.equal(body.revisions.length, 1);
  assert.equal(body.revisions[0]?.revision, 1);
});

test('cancel ทำได้เฉพาะ maker ของ request นั้น', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };
  const row = await owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, exceptionId: seriesId },
  });
  await owner.cg4CapabilityGrant.create({
    data: {
      id: randomUUID(),
      tenantId: f.primary.tenantId,
      subjectId: f.primary.maker,
      capability: 'cg.exception.amend',
      scopeKey: SCOPE_KEY,
      grantedByRef: 'iam-fixture',
    },
  });
  await owner.cg4CapabilityGrant.create({
    data: {
      id: randomUUID(),
      tenantId: f.primary.tenantId,
      subjectId: f.primary.checker,
      capability: 'cg.exception.amend',
      scopeKey: SCOPE_KEY,
      grantedByRef: 'iam-fixture',
    },
  });

  const payload = {
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    expectedVersion: 1,
    reasonCode: 'WITHDRAWN',
    evidenceRef: 'evidence://cancel',
  };
  // checker มี capability แต่ไม่ใช่ maker — ต้องเป็น 404 ไม่ใช่ 403 ที่ยืนยันว่า resource มีอยู่
  const byChecker = await post(`${f.base}/exceptions/${seriesId}/cancel`, 'checker-token', payload);
  assert.equal(byChecker.status, 404);

  const byMaker = await post(`${f.base}/exceptions/${seriesId}/cancel`, 'maker-token', payload);
  const cancelled = await expectJson<{ workflowState: string }>(byMaker, 200);
  assert.equal(cancelled.workflowState, 'CANCELLED');
});
