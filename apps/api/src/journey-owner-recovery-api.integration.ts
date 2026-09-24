/**
 * J2.8 follow-up (#136) — admin recovery API
 *
 * ครอบ acceptance ที่ #136 ระบุไว้: บังคับ `Idempotency-Key`/`expectedVersion`/structured
 * reason, generic cross-tenant `404 RESOURCE_NOT_FOUND`, forensic view ไม่เปิด payload
 * และ blind retry ถูกปฏิเสธ
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { JourneyOwnerActionRepository } from '@d-contact/journey';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import {
  JOURNEY_RECOVERY_DATABASE,
  JourneyOwnerRecoveryController,
} from './journey-owner-recovery-api.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

async function harness(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const adminUserId = randomUUID();

  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: {
        id,
        name: `J2.8 recovery ${id.slice(0, 8)}`,
        slug: `j2-8-recovery-${id.slice(0, 8)}`,
        sipDomain: `${id.slice(0, 8)}.j2-8-recovery.test`,
      },
    });
  }

  const claims = (roles: string[], tenant: string): VerifiedOidcClaims => ({
    tenant_id: tenant,
    tenant_slug: `j2-8-recovery-${tenant.slice(0, 8)}`,
    organization: { [`j2-8-recovery-${tenant.slice(0, 8)}`]: { tenant_id: [tenant] } },
    azp: 'agent-desktop',
    sub: adminUserId,
    preferred_username: 'admin-user',
    exp: 2_000_000_000,
    realm_access: { roles },
    dc_user_id: adminUserId,
    sid: 'admin-session',
  });
  const verifier = {
    verifyAccessToken: async (token: string): Promise<VerifiedOidcClaims> => {
      if (token === 'admin-token') return claims(['admin'], tenantId);
      if (token === 'agent-token') return claims(['agent'], tenantId);
      if (token === 'other-tenant-admin') return claims(['admin'], otherTenantId);
      throw new Error('token ไม่ถูกต้อง');
    },
  };

  @Module({
    controllers: [JourneyOwnerRecoveryController],
    providers: [
      { provide: JOURNEY_RECOVERY_DATABASE, useValue: application },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;

  t.after(async () => {
    await app.close();
    for (const id of [tenantId, otherTenantId]) {
      await owner.jrRecoveryAudit.deleteMany({ where: { tenantId: id } });
      await owner.jrOwnerResultInbox.deleteMany({ where: { tenantId: id } });
      await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId: id } });
      await owner.jrOwnerAction.deleteMany({ where: { tenantId: id } });
      await owner.tenant.deleteMany({ where: { id } });
    }
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const repository = new JourneyOwnerActionRepository(application);

  async function seedAction(tenant: string, actionKey: string) {
    const { action } = await repository.ensureAction({
      tenantId: tenant,
      actionKey,
      enrollmentId: randomUUID(),
      kind: 'ENSURE_CASE',
      requestHash: 'a'.repeat(64),
      correlationId: 'corr-seed',
      commandId: randomUUID(),
      commandPayload: { secretBusinessField: 'ห้ามหลุดออก API' },
    });
    return action;
  }

  const call = (
    method: 'GET' | 'POST',
    path: string,
    token: string,
    init: { idempotencyKey?: string; body?: unknown } = {},
  ) =>
    fetch(`http://127.0.0.1:${port}/internal/journey/owner-actions/${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

  return { owner, application, tenantId, otherTenantId, adminUserId, repository, seedAction, call };
}

test('query คืนเฉพาะ metadata ที่ sanitized แล้ว ไม่มี payload หรือ hash หลุด', async (t) => {
  const h = await harness(t);
  const actionKey = `action-${randomUUID()}`;
  await h.seedAction(h.tenantId, actionKey);

  const response = await h.call('GET', actionKey, 'admin-token');
  assert.equal(response.status, 200);
  const raw = await response.text();

  assert.equal(raw.includes('ห้ามหลุดออก API'), false, 'command payload ต้องไม่หลุดออก API');
  assert.equal(raw.includes('a'.repeat(64)), false, 'requestHash ต้องไม่หลุดออก API');

  const view = JSON.parse(raw) as { actionKey: string; state: string; version: number };
  assert.equal(view.actionKey, actionKey);
  assert.equal(view.state, 'PENDING');
  assert.equal(view.version, 1);
});

test('role ที่ไม่ใช่ admin/compliance เข้าไม่ได้', async (t) => {
  const h = await harness(t);
  const actionKey = `action-${randomUUID()}`;
  await h.seedAction(h.tenantId, actionKey);

  assert.equal((await h.call('GET', actionKey, 'agent-token')).status, 403);
});

test('action ของ tenant อื่นตอบ 404 RESOURCE_NOT_FOUND เหมือนที่ไม่เคยมีอยู่จริง', async (t) => {
  const h = await harness(t);
  const foreignKey = `action-${randomUUID()}`;
  await h.seedAction(h.otherTenantId, foreignKey);
  const neverExisted = `action-${randomUUID()}`;

  const foreign = await h.call('GET', foreignKey, 'admin-token');
  const missing = await h.call('GET', neverExisted, 'admin-token');

  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  // ต้องแยกไม่ออกจริง ๆ ทั้ง status และ body
  assert.deepEqual(await foreign.json(), await missing.json());
});

test('mutation ที่ไม่มี Idempotency-Key, expectedVersion หรือ reasonCode ถูกปฏิเสธ', async (t) => {
  const h = await harness(t);
  const actionKey = `action-${randomUUID()}`;
  await h.seedAction(h.tenantId, actionKey);

  const noKey = await h.call('POST', `${actionKey}/replay`, 'admin-token', {
    body: { expectedVersion: 1, reasonCode: 'ACK_UNKNOWN_TIMEOUT' },
  });
  const noVersion = await h.call('POST', `${actionKey}/replay`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { reasonCode: 'ACK_UNKNOWN_TIMEOUT' },
  });
  const noReason = await h.call('POST', `${actionKey}/replay`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: 1 },
  });
  const freeTextReason = await h.call('POST', `${actionKey}/replay`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: 1, reasonCode: 'ลูกค้าโทรมาบอกว่าไม่ได้รับ' },
  });

  assert.equal(noKey.status, 400);
  assert.equal(noVersion.status, 400);
  assert.equal(noReason.status, 400);
  assert.equal(freeTextReason.status, 400);
  assert.equal(await h.owner.jrRecoveryAudit.count({ where: { tenantId: h.tenantId } }), 0);
});

test('replay ด้วย expectedVersion ที่ไม่ตรงถูกปฏิเสธเป็น 409 — blind retry ทำไม่ได้', async (t) => {
  const h = await harness(t);
  const actionKey = `action-${randomUUID()}`;
  const action = await h.seedAction(h.tenantId, actionKey);
  const command = await h.owner.jrOwnerCommandOutbox.findFirstOrThrow({
    where: { tenantId: h.tenantId, actionKey },
  });
  await h.repository.markCommandDispatched(h.tenantId, command.commandId); // version 1 -> 2

  const stale = await h.call('POST', `${actionKey}/replay`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: action.version, reasonCode: 'ACK_UNKNOWN_TIMEOUT' },
  });

  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    code: 'VERSION_CONFLICT',
    expectedVersion: 1,
    actualVersion: 2,
  });
  assert.equal(await h.owner.jrRecoveryAudit.count({ where: { tenantId: h.tenantId } }), 0);
});

test('replay ที่ version ตรงคืน command เข้าคิวด้วย commandId เดิม และบันทึก audit', async (t) => {
  const h = await harness(t);
  const actionKey = `action-${randomUUID()}`;
  await h.seedAction(h.tenantId, actionKey);
  const command = await h.owner.jrOwnerCommandOutbox.findFirstOrThrow({
    where: { tenantId: h.tenantId, actionKey },
  });
  await h.repository.markCommandDispatched(h.tenantId, command.commandId);

  const response = await h.call('POST', `${actionKey}/replay`, 'admin-token', {
    idempotencyKey: 'replay-key-1',
    body: { expectedVersion: 2, reasonCode: 'ACK_UNKNOWN_TIMEOUT' },
  });

  assert.equal(response.status, 201);
  const result = (await response.json()) as { replayedCommandIds: string[]; version: number };
  // commandId เดิมถูก reuse — owner dedupe ได้ ไม่ใช่ effect ใหม่
  assert.deepEqual(result.replayedCommandIds, [command.commandId]);
  assert.equal(result.version, 3);

  const requeued = await h.owner.jrOwnerCommandOutbox.findFirstOrThrow({
    where: { tenantId: h.tenantId, commandId: command.commandId },
  });
  assert.equal(requeued.state, 'PENDING');
  assert.equal(requeued.sentAt, null);

  const audit = await h.owner.jrRecoveryAudit.findFirstOrThrow({
    where: { tenantId: h.tenantId, targetRef: actionKey },
  });
  assert.equal(audit.operation, 'REPLAY');
  assert.equal(audit.reasonCode, 'ACK_UNKNOWN_TIMEOUT');
  assert.equal(audit.actorId, h.adminUserId);
  assert.equal(audit.evidenceRef, 'replay-key-1');
});

test('cancel ผ่าน API ของ action ที่ command ยังไม่ออกจาก Journey ยกเลิกในบ้านและ audit เป็น CANCEL', async (t) => {
  const h = await harness(t);
  const actionKey = `action-${randomUUID()}`;
  await h.seedAction(h.tenantId, actionKey);

  const response = await h.call('POST', `${actionKey}/cancel`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: 1, reasonCode: 'OPERATOR_ABORT' },
  });

  assert.equal(response.status, 201);
  const result = (await response.json()) as { state: string; version: number };
  assert.equal(result.state, 'CANCELLED');
  assert.equal(result.version, 2);
  const commands = await h.owner.jrOwnerCommandOutbox.findMany({
    where: { tenantId: h.tenantId, actionKey },
  });
  assert.deepEqual(
    commands.map(({ state }) => state),
    ['CANCELLED'],
  );

  const audit = await h.owner.jrRecoveryAudit.findFirstOrThrow({
    where: { tenantId: h.tenantId, targetRef: actionKey },
  });
  assert.equal(audit.operation, 'CANCEL');
  assert.equal(audit.reasonCode, 'OPERATOR_ABORT');
});

test('reconcile บันทึก audit โดยไม่แตะ canonical state', async (t) => {
  const h = await harness(t);
  const actionKey = `action-${randomUUID()}`;
  await h.seedAction(h.tenantId, actionKey);

  const response = await h.call('POST', `${actionKey}/reconcile`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: 1, reasonCode: 'OWNER_SILENT' },
  });

  assert.equal(response.status, 201);
  const after = await h.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: h.tenantId, actionKey },
  });
  assert.equal(after.state, 'PENDING');
  assert.equal(after.version, 1);

  const audit = await h.owner.jrRecoveryAudit.findFirstOrThrow({
    where: { tenantId: h.tenantId, targetRef: actionKey },
  });
  assert.equal(audit.operation, 'RECONCILE');
});

test('mutation ข้าม tenant ตอบ 404 และไม่เขียน audit ให้ tenant เจ้าของจริง', async (t) => {
  const h = await harness(t);
  const actionKey = `action-${randomUUID()}`;
  await h.seedAction(h.tenantId, actionKey);

  const response = await h.call('POST', `${actionKey}/cancel`, 'other-tenant-admin', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: 1, reasonCode: 'OPERATOR_ABORT' },
  });

  assert.equal(response.status, 404);
  assert.equal(await h.owner.jrRecoveryAudit.count({ where: { tenantId: h.tenantId } }), 0);
  const untouched = await h.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: h.tenantId, actionKey },
  });
  assert.equal(untouched.state, 'PENDING');
});
