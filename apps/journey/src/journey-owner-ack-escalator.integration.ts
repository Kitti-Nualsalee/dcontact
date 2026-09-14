/**
 * J2.8 (#136) — พิสูจน์ ACK_UNKNOWN escalation และ bounded reconciliation deadlines
 *
 * สิ่งที่ต้องจริง: ถาม owner ก่อนเสมอ (ไม่ retry มั่ว), retry มีเพดาน และเมื่อครบเพดาน
 * ต้องส่งต่อให้คนผ่าน audit ไม่ใช่วนต่อไปเรื่อย ๆ หรือเงียบหาย
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import type { J2OwnerResultPayloadV1 } from '@d-contact/cxa-contracts';
import { JourneyOwnerAckEscalator } from './journey-owner-ack-escalator.js';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneyOwnerResultReconciler } from './journey-owner-result-reconciler.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const REQUEST_HASH = 'e'.repeat(64);

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const enrollmentId = randomUUID();

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.8 ack ${tenantId.slice(0, 8)}`,
      slug: `j2-8-ack-${tenantId.slice(0, 8)}`,
      sipDomain: `${tenantId.slice(0, 8)}.j2-8-ack.test`,
    },
  });

  t.after(async () => {
    await owner.jrRecoveryAudit.deleteMany({ where: { tenantId } });
    await owner.jrOwnerResultInbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const repository = new JourneyOwnerActionRepository(application);

  /** action ที่ dispatch ไปแล้วเมื่อ `agoMs` ที่ผ่านมา */
  async function dispatchedAgo(agoMs: number) {
    const actionKey = `ack-action-${randomUUID()}`;
    const commandId = randomUUID();
    await repository.ensureAction({
      tenantId,
      actionKey,
      enrollmentId,
      kind: 'ENSURE_CASE',
      requestHash: REQUEST_HASH,
      correlationId: commandId,
      commandId,
      commandPayload: { placeholder: true },
    });
    await repository.markCommandDispatched(tenantId, commandId);
    await owner.jrOwnerAction.updateMany({
      where: { tenantId, actionKey },
      data: { dispatchedAt: new Date(Date.now() - agoMs) },
    });
    return { actionKey, commandId };
  }

  /** port ที่ไม่เคยมีผลกลับมา = owner เงียบสนิท */
  const silentPort = {
    async persistCommand() {
      throw new Error('ไม่ควรถูกเรียกใน escalation path');
    },
    async queryAction(): Promise<J2OwnerResultPayloadV1 | undefined> {
      return undefined;
    },
  };

  return { owner, application, tenantId, repository, dispatchedAgo, silentPort };
}

function escalator(
  f: Awaited<ReturnType<typeof fixture>>,
  port: unknown,
  options: { maxAttempts?: number } = {},
) {
  return new JourneyOwnerAckEscalator(
    f.application,
    new JourneyOwnerResultReconciler(f.application, port as never, port as never),
    { ackDeadlineMs: 1_000, maxAttempts: options.maxAttempts ?? 3 },
  );
}

test('action ที่ยังไม่เกิน deadline ต้องไม่ถูกแตะ', async (t) => {
  const f = await fixture(t);
  const { actionKey } = await f.dispatchedAgo(0);

  assert.equal(await escalator(f, f.silentPort).escalateNext(f.tenantId), undefined);

  const untouched = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(untouched.state, 'DISPATCHED');
  assert.equal(untouched.attempts, 0);
});

test('เกิน deadline แล้ว owner ยังเงียบ -> ACK_UNKNOWN พร้อมนับ attempt', async (t) => {
  const f = await fixture(t);
  const { actionKey } = await f.dispatchedAgo(5_000);

  assert.equal(await escalator(f, f.silentPort).escalateNext(f.tenantId), 'WAITING');

  const moved = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(moved.state, 'ACK_UNKNOWN');
  assert.equal(moved.attempts, 1);
  // ยังไม่ครบเพดาน จึงยังไม่บันทึก audit
  assert.equal(await f.owner.jrRecoveryAudit.count({ where: { tenantId: f.tenantId } }), 0);
});

test('ถาม owner แล้วมีผลจริง -> apply ทันทีโดยไม่ต้อง retry', async (t) => {
  const f = await fixture(t);
  const { actionKey, commandId } = await f.dispatchedAgo(5_000);

  const answeringPort = {
    async persistCommand() {
      throw new Error('ไม่ควรถูกเรียก');
    },
    async queryAction(): Promise<J2OwnerResultPayloadV1> {
      return {
        contractVersion: 1,
        commandId,
        actionKey,
        requestHash: REQUEST_HASH,
        commandType: 'ENSURE_CASE',
        status: 'CREATED',
        code: 'CREATED',
        category: 'BUSINESS',
        reasonCode: 'CREATED',
        failureClass: 'NONE',
        retryDisposition: 'NONE',
        observedAt: new Date().toISOString(),
        ownerAggregate: { type: 'case', id: randomUUID(), version: 1 },
      } as J2OwnerResultPayloadV1;
    },
  };

  assert.equal(await escalator(f, answeringPort).escalateNext(f.tenantId), 'RECONCILED');

  const applied = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(applied.state, 'ACKNOWLEDGED');
});

test('ครบเพดาน retry แล้วบันทึก audit แล้วหยุดไล่ตามเอง (bounded)', async (t) => {
  const f = await fixture(t);
  const { actionKey } = await f.dispatchedAgo(5_000);
  const runner = escalator(f, f.silentPort, { maxAttempts: 3 });

  assert.equal(await runner.escalateNext(f.tenantId), 'WAITING');
  assert.equal(await runner.escalateNext(f.tenantId), 'WAITING');
  assert.equal(await runner.escalateNext(f.tenantId), 'ESCALATED');

  const audit = await f.owner.jrRecoveryAudit.findFirstOrThrow({
    where: { tenantId: f.tenantId, targetRef: actionKey },
  });
  assert.equal(audit.reasonCode, 'ACK_UNKNOWN_DEADLINE_EXCEEDED');
  assert.equal(audit.operation, 'RECONCILE');

  // ครบเพดานแล้วต้องไม่ถูกหยิบอีก — ไม่วนเรียก owner ไปเรื่อย ๆ
  assert.equal(await runner.escalateNext(f.tenantId), undefined);
  const final = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(final.attempts, 3);
  assert.equal(final.state, 'ACK_UNKNOWN');
});

test('action ที่ escalate แล้วยังรับผลที่มาช้าได้ (ACK_UNKNOWN เป็น open state)', async (t) => {
  const f = await fixture(t);
  const { actionKey, commandId } = await f.dispatchedAgo(5_000);
  const runner = escalator(f, f.silentPort, { maxAttempts: 1 });

  assert.equal(await runner.escalateNext(f.tenantId), 'ESCALATED');

  const applied = await f.repository.applyResult({
    tenantId: f.tenantId,
    commandId,
    actionKey,
    resultKind: 'ACKNOWLEDGED',
    resultHash: 'f'.repeat(64),
    correlationId: commandId,
  });

  assert.equal(applied.outcome, 'APPLIED');
  assert.equal(applied.action.state, 'ACKNOWLEDGED');
});

test('tenant คนละใบไม่ escalate ของกันและกัน', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  await f.dispatchedAgo(5_000);
  const theirs = await other.dispatchedAgo(5_000);

  assert.equal(await escalator(f, f.silentPort).escalateNext(f.tenantId), 'WAITING');

  const untouched = await other.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: other.tenantId, actionKey: theirs.actionKey },
  });
  assert.equal(untouched.state, 'DISPATCHED');
});
