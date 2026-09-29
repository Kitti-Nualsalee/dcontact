/**
 * E1.14 (#488) click-to-call บน Postgres จริงด้วย role ของแอป (`dcontact_app`, RLS):
 * - BLOCK/DEFER/REVIEW ไม่โทรออก และตอบ host โดยไม่มี PII; ALLOW ยังไม่โทรจริง (E1.18 #520) แต่ปล่อย reservation
 * - contact resolve จากเบอร์ฝั่ง server; rate limit ต่อ agent; audit ทุกครั้งโดยไม่เก็บเบอร์
 * - ต้องมี lease `embedded` ของตัวเอง; Contact Governance ตัวจริงถูกเรียกได้ครบทาง
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import type { AuthorizationOutcome, AuthorizeAndReserveInput } from '@d-contact/cxa-contracts';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { CLICK_TO_CALL_SERVICE, ClickToCallController } from './click-to-call-api.js';
import {
  ClickToCallService,
  OUTBOUND_VOICE_NOT_ENABLED,
  type ClickToCallGovernance,
} from './click-to-call.js';
import { DPHONE_EMBED_FLAG, EmbedOriginService } from './embed-origins.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { WorkSessionLeases } from './work-session.js';

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

const HOST = 'https://crm.example.test';
const NUMBER = '081-234-5678';

function claims(token: string): VerifiedOidcClaims {
  const [tenantId, userId, role] = token.split('|');
  const tenantSlug = `tenant-${tenantId}`;
  return {
    tenant_id: tenantId,
    tenant_slug: tenantSlug,
    organization: { [tenantSlug]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: [role!] },
  };
}

/** Governance จำลอง: บันทึกคำขอและตอบตาม decision ที่ตั้ง */
function stubGovernance(
  decision: AuthorizationOutcome['decision'],
  extra: Partial<AuthorizationOutcome> = {},
) {
  const calls: AuthorizeAndReserveInput[] = [];
  const reservations: [string, string][] = [];
  const governance: ClickToCallGovernance = {
    authorizeAndReserve: async (_tenantId, input) => {
      calls.push(input);
      return {
        decisionId: `dec-${calls.length}`,
        decision,
        reasonCode: decision === 'ALLOW' ? 'ALLOWED' : `TEST_${decision}`,
        policyVersion: 1,
        trace: [],
        ...(decision === 'ALLOW' ? { reservationId: `res-${calls.length}` } : {}),
        ...extra,
      };
    },
    changeReservationState: async (_tenantId, reservationId, command) => {
      reservations.push([reservationId, String(command)]);
      return undefined;
    },
  };
  return { governance, calls, reservations };
}

async function setup(
  t: TestContext,
  governance: ClickToCallGovernance,
  rate?: { limit: number; windowMs: number },
) {
  const tenantId = randomUUID();
  const slug = `c2c-${tenantId.slice(0, 8)}`;
  const users = { admin: randomUUID(), agent: randomUUID(), other: randomUUID() };
  await owner.tenant.create({
    data: { id: tenantId, name: slug, slug, sipDomain: `${tenantId}.c2c.test` },
  });
  await owner.user.createMany({
    data: [
      { id: users.admin, role: 'ADMIN' as const },
      { id: users.agent, role: 'AGENT' as const },
      { id: users.other, role: 'AGENT' as const },
    ].map((user) => ({
      ...user,
      tenantId,
      email: `${user.id}@c2c.test`,
      passwordHash: 'test',
      displayName: user.role,
    })),
  });
  await owner.tenantUiFlag.create({
    data: {
      tenantId,
      flagKey: DPHONE_EMBED_FLAG,
      enabled: true,
      reason: 'E1.14 test',
      updatedByActor: 't',
    },
  });
  const origins = new EmbedOriginService(application, { allowLocalhost: false });
  await origins.create({ tenantId, userId: users.admin }, { origin: HOST, label: 'CRM' }, 'c');
  const leases = new WorkSessionLeases(application, { embedOrigins: origins });
  const agent = { tenantId, userId: users.agent };
  const lease = await leases.acquire(agent, { surface: 'embedded', hostOrigin: HOST }, 'l1');
  const workspaceLease = await leases.acquire(
    { tenantId, userId: users.other },
    { surface: 'workspace', hostOrigin: null },
    'l2',
  );
  const contactId = randomUUID();
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'ลูกค้า' } });
  await owner.contactIdentity.create({
    data: { tenantId, contactId, type: 'PHONE', value: '0812345678' },
  });

  const service = new ClickToCallService(application, {
    hostOriginOfLease: (actor, leaseId) => leases.embeddedHostOrigin(actor, leaseId),
    governance,
    ...(rate ? { rate } : {}),
  });

  @Module({
    controllers: [ClickToCallController],
    providers: [
      { provide: CLICK_TO_CALL_SERVICE, useValue: service },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: { verifyAccessToken: async (token: string) => claims(token) },
      },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  t.after(async () => {
    await app.close();
    await owner.dphoneClickToCallAuditEvent.deleteMany({ where: { tenantId } });
    await owner.$executeRaw`DELETE FROM cg_reservations WHERE tenant_id = ${tenantId}::uuid`;
    await owner.$executeRaw`DELETE FROM cg_decision_logs WHERE tenant_id = ${tenantId}::uuid`;
    await owner.contactIdentity.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.agentWorkSessionEvent.deleteMany({ where: { tenantId } });
    await owner.agentWorkSessionLease.deleteMany({ where: { tenantId } });
    await owner.agentStateLog.deleteMany({ where: { tenantId } });
    await owner.tenantEmbedOriginAuditEvent.deleteMany({ where: { tenantId } });
    await owner.tenantEmbedOrigin.deleteMany({ where: { tenantId } });
    await owner.tenantUiFlag.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
  });

  const call = async (
    role: keyof typeof users,
    body: unknown,
    leaseId: string | null = lease.leaseId,
  ) => {
    const response = await fetch(`${base}/api/v1/workspace/agent/click-to-call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tenantId}|${users[role]}|${role === 'other' ? 'agent' : role}`,
        'x-correlation-id': 'corr-c2c',
        'content-type': 'application/json',
        ...(leaseId ? { 'x-work-session-lease-id': leaseId } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  return { tenantId, users, lease, workspaceLease, contactId, call };
}

test('BLOCK / DEFER / REVIEW: ไม่โทรออก ตอบ blocked + reasonCode โดยไม่มี PII และ audit ทุกครั้ง', async (t) => {
  for (const decision of ['BLOCK', 'DEFER', 'REVIEW'] as const) {
    const stub = stubGovernance(
      decision,
      decision === 'DEFER' ? { nextEligibleAt: '2026-09-29T02:00:00.000Z' } : {},
    );
    const f = await setup(t, stub.governance);
    const response = await f.call('agent', { requestId: `req-${decision}`, number: NUMBER });
    assert.equal(response.status, 200);
    assert.equal(response.body.hostOrigin, HOST);
    assert.deepEqual(response.body.message, {
      v: 1,
      type: 'dphone.call.result',
      requestId: `req-${decision}`,
      status: 'blocked',
      blocked: true,
      reasonCode: `TEST_${decision}`,
      decisionId: 'dec-1',
      ...(decision === 'DEFER' ? { retryAt: '2026-09-29T02:00:00.000Z' } : {}),
    });
    assert.equal(JSON.stringify(response.body).includes('5678'), false);
    assert.deepEqual(stub.reservations, []);
    const [input] = stub.calls;
    assert.equal(input!.channel, 'VOICE');
    assert.equal(input!.purpose, 'SERVICE');
    assert.equal(input!.contactId, f.contactId);
    const audit = await owner.dphoneClickToCallAuditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    assert.equal(audit.decision, decision);
    assert.equal(audit.decisionId, 'dec-1');
    assert.equal(audit.outcome, 'blocked');
    assert.equal(audit.hostOrigin, HOST);
    assert.equal(JSON.stringify(audit).includes('5678'), false);
  }
});

test('ALLOW: ยังไม่โทรจริง (Voice Delivery Gate ยังปิด) — ปล่อย reservation ทันทีและตอบ unavailable', async (t) => {
  const stub = stubGovernance('ALLOW');
  const f = await setup(t, stub.governance);
  const response = await f.call('agent', { requestId: 'req-allow', number: NUMBER });
  assert.deepEqual(response.body.message, {
    v: 1,
    type: 'dphone.call.result',
    requestId: 'req-allow',
    status: 'unavailable',
    blocked: false,
    reasonCode: OUTBOUND_VOICE_NOT_ENABLED,
    decisionId: 'dec-1',
  });
  assert.deepEqual(stub.reservations, [['res-1', 'RELEASE']]);
});

test('contact มาจากเบอร์ฝั่ง server — contactId ที่ host ส่งมาไม่ถูกใช้; เบอร์ไม่รู้จัก = NOT_FOUND', async (t) => {
  const stub = stubGovernance('BLOCK');
  const f = await setup(t, stub.governance);
  await f.call('agent', { requestId: 'r1', number: '+66 2 000 0000', contactId: f.contactId });
  assert.equal(stub.calls[0]!.contactId, undefined);
  assert.equal(stub.calls[0]!.identityResolution, 'NOT_FOUND');
  // actionKey ผูก lease + requestId ของ host (idempotent)
  assert.equal(stub.calls[0]!.actionKey, `dphone-click-to-call:${f.lease.leaseId}:r1`);
});

test('rate limit ต่อ agent → rate_limited โดยไม่ถึง Governance แต่ยัง audit', async (t) => {
  const stub = stubGovernance('BLOCK');
  const f = await setup(t, stub.governance, { limit: 2, windowMs: 60_000 });
  for (const requestId of ['a', 'b', 'c']) await f.call('agent', { requestId, number: NUMBER });
  assert.equal(stub.calls.length, 2);
  const audits = await owner.dphoneClickToCallAuditEvent.findMany({
    where: { tenantId: f.tenantId },
    orderBy: { occurredAt: 'asc' },
  });
  assert.equal(audits.length, 3);
  assert.equal(audits.find((row) => row.requestId === 'c')?.outcome, 'rate_limited');
});

test('ต้องมี lease embedded ของตัวเอง: ไม่มี header = 400, lease ของคนอื่น/lease workspace = 404, admin = 403', async (t) => {
  const stub = stubGovernance('BLOCK');
  const f = await setup(t, stub.governance);
  assert.equal((await f.call('agent', { requestId: 'r', number: NUMBER }, null)).status, 400);
  assert.equal((await f.call('other', { requestId: 'r', number: NUMBER })).status, 404);
  assert.equal(
    (await f.call('other', { requestId: 'r', number: NUMBER }, f.workspaceLease.leaseId)).status,
    404,
  );
  assert.equal((await f.call('admin', { requestId: 'r', number: NUMBER })).status, 403);
  assert.equal(stub.calls.length, 0);
});

test('Contact Governance ตัวจริง: ผลใดก็ตามไม่โทรออก และไม่มี reservation ค้าง RESERVED', async (t) => {
  const f = await setup(t, new ContactGovernanceService(application));
  const response = await f.call('agent', { requestId: 'real-1', number: NUMBER });
  assert.equal(response.status, 200);
  const message = response.body.message;
  assert.ok(['blocked', 'unavailable'].includes(message.status), JSON.stringify(message));
  assert.ok(message.decisionId);
  const reserved = await owner.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) FROM cg_reservations WHERE tenant_id = ${f.tenantId}::uuid AND state = 'RESERVED'`;
  assert.equal(Number(reserved[0]!.count), 0);
  const audit = await owner.dphoneClickToCallAuditEvent.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(audit.decisionId, message.decisionId);
});
