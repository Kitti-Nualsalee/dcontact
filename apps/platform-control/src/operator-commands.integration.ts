/**
 * A1.6 (#411) บน Postgres จริง: durable operator command + read model ของ Platform API
 *
 * ครอบ: preview/execute ผ่าน worker (actor จริงใน audit), idempotency replay, target swap,
 * stale revision, stale preview, concurrent recovery, resend cap 429, retry เมื่อ dependency ล้ม,
 * search pagination ที่เสถียร, email search ด้วย hash, masked email และ action history cursor
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PlatformProvisioningError, type PlatformProvisioningErrorCode } from '@d-contact/shared';
import {
  OperatorCommandIntake,
  OperatorCommandWorker,
  PlatformRetryAfterError,
} from './operator-commands.js';
import { createPlatformFixture, OPERATOR, SIP_BASE } from './platform-fixture.js';
import { PlatformQueries } from './platform-queries.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import { ProvisioningRecoveryService } from './provisioning-recovery.js';
import { ProvisioningSagaWorker } from './provisioning-saga.js';

async function setup(t: TestContext) {
  const f = await createPlatformFixture();
  t.after(() => f.dispose());
  const tenants: string[] = [];
  const fakes = createFakeProvisioningPorts();
  const recovery = new ProvisioningRecoveryService(f.platform, fakes.ports, {
    sipBaseDomain: SIP_BASE,
  });
  const intake = new OperatorCommandIntake(f.platform);
  const queries = new PlatformQueries(f.platform);
  const saga = new ProvisioningSagaWorker(f.platform, fakes.ports, {
    workerId: `saga-${randomUUID().slice(0, 8)}`,
    sipBaseDomain: SIP_BASE,
    scope: () => ({ tenantId: { in: [...tenants] } }),
    backoffBaseMs: 1,
    backoffMaxMs: 1,
  });
  const commandWorker = (
    handlers: Partial<ConstructorParameters<typeof OperatorCommandWorker>[1]> = {},
  ) =>
    new OperatorCommandWorker(
      f.platform,
      { recovery, ...handlers },
      {
        workerId: `commands-${randomUUID().slice(0, 8)}`,
        scope: () => ({ tenantId: { in: [...tenants] } }),
        retryMs: 0,
      },
    );
  const accept = async (overrides: Parameters<typeof f.input>[0] = {}) => {
    const input = f.input(overrides);
    const key = `idem-${randomUUID()}`;
    const result = await f.repository().accept({
      idempotencyKey: key,
      input,
      plan: f.plan,
      actor: OPERATOR,
      correlationId: `corr-${key}`,
    });
    f.track(result.tenantId);
    tenants.push(result.tenantId);
    return { ...result, input };
  };
  /** request ที่รอ operator: step แรกล้มถาวรก่อนสร้าง resource (find = NOT_FOUND → Retry ได้) */
  const actionRequired = async () => {
    const accepted = await accept();
    fakes.systems.KEYCLOAK_ORGANIZATION.fail('permanent');
    await saga.drain();
    return accepted;
  };
  const request = (requestId: string) =>
    f.owner.pfProvisioningRequest.findUniqueOrThrow({ where: { id: requestId } });
  const preview = async (
    requestId: string,
    action: 'RETRY_STEP' | 'MARK_FAILED_FINAL' = 'RETRY_STEP',
  ) => {
    const queued = await intake.requestPreview({
      requestId,
      action,
      actor: OPERATOR,
      correlationId: 'corr-preview',
    });
    await commandWorker().drain();
    return intake.command(requestId, queued.commandId, 'PREVIEW');
  };
  return {
    f,
    fakes,
    recovery,
    intake,
    queries,
    saga,
    commandWorker,
    accept,
    actionRequired,
    request,
    preview,
  };
}

async function rejectsWith(work: Promise<unknown>, code: PlatformProvisioningErrorCode) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof PlatformProvisioningError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

const submission = (requestId: string, overrides: Record<string, unknown> = {}) => ({
  requestId,
  action: 'RETRY_STEP' as const,
  idempotencyKey: `key-${randomUUID()}`,
  reasonCode: 'OPERATOR_VERIFIED',
  comment: 'ตรวจแล้วว่า resource ไม่มีอยู่จริง',
  actor: OPERATOR,
  correlationId: 'corr-action',
  ...overrides,
});

test('preview → execute ผ่าน worker: recovery สำเร็จและ audit ผูก operator ที่สั่ง', async (t) => {
  const s = await setup(t);
  const accepted = await s.actionRequired();
  const preview = await s.preview(accepted.requestId);
  assert.equal(preview.state, 'SUCCEEDED');
  assert.equal(preview.result?.allowed, true);
  const current = await s.request(accepted.requestId);
  const queued = await s.intake.submit(
    submission(accepted.requestId, {
      expectedRevision: current.revision,
      previewDigest: preview.result!.previewDigest,
    }),
  );
  assert.deepEqual([queued.state, queued.replayed], ['QUEUED', false]);
  // ยังไม่มีอะไรเปลี่ยนจนกว่า worker จะทำ (202 = รับไว้แล้ว)
  assert.equal((await s.request(accepted.requestId)).status, 'ACTION_REQUIRED');
  await s.commandWorker().drain();
  const done = await s.intake.command(accepted.requestId, queued.commandId);
  assert.deepEqual([done.state, done.result?.status], ['SUCCEEDED', 'RUNNING']);
  await s.saga.drain();
  assert.equal((await s.request(accepted.requestId)).status, 'SUCCEEDED');
  const audit = await s.f.owner.pfActionHistory.findFirstOrThrow({
    where: { requestId: accepted.requestId, action: 'RETRY_STEP', outcome: 'SUCCEEDED' },
  });
  assert.deepEqual(
    [audit.actorKind, audit.actorSubject, audit.reasonCode],
    ['PLATFORM_OPERATOR', OPERATOR.subject, 'OPERATOR_VERIFIED'],
  );
});

test('idempotency: key เดิม replay command เดิม; payload อื่นหรือ request อื่น (target swap) = 409', async (t) => {
  const s = await setup(t);
  const first = await s.actionRequired();
  const second = await s.actionRequired();
  const preview = await s.preview(first.requestId);
  const revision = (await s.request(first.requestId)).revision;
  const command = submission(first.requestId, {
    expectedRevision: revision,
    previewDigest: preview.result!.previewDigest,
  });
  const queued = await s.intake.submit(command);
  const replayed = await s.intake.submit(command);
  assert.deepEqual([replayed.commandId, replayed.replayed], [queued.commandId, true]);
  await rejectsWith(
    s.intake.submit({ ...command, comment: 'ข้อความอื่น' }),
    'IDEMPOTENCY_KEY_REUSED',
  );
  await rejectsWith(
    s.intake.submit({ ...command, requestId: second.requestId }),
    'IDEMPOTENCY_KEY_REUSED',
  );
  assert.equal(
    await s.f.owner.pfOperatorCommand.count({
      where: {
        idempotencyKeyHash: { not: null },
        requestId: { in: [first.requestId, second.requestId] },
      },
    }),
    1,
  );
});

test('stale revision ถูกปฏิเสธทันที; preview ที่เก่าตอน worker ทำ = REJECTED PREVIEW_STALE', async (t) => {
  const s = await setup(t);
  const accepted = await s.actionRequired();
  const preview = await s.preview(accepted.requestId);
  const revision = (await s.request(accepted.requestId)).revision;
  await rejectsWith(
    s.intake.submit(
      submission(accepted.requestId, {
        expectedRevision: revision - 1,
        previewDigest: preview.result!.previewDigest,
      }),
    ),
    'REVISION_CONFLICT',
  );
  // digest ของ action อื่น = ไม่ตรงกับสถานะปัจจุบันของ RETRY_STEP
  const other = await s.preview(accepted.requestId, 'MARK_FAILED_FINAL');
  const queued = await s.intake.submit(
    submission(accepted.requestId, {
      expectedRevision: revision,
      previewDigest: other.result!.previewDigest,
    }),
  );
  await s.commandWorker().drain();
  const result = await s.intake.command(accepted.requestId, queued.commandId);
  assert.deepEqual([result.state, result.errorCode], ['REJECTED', 'PREVIEW_STALE']);
  const rejected = await s.f.owner.pfActionHistory.findMany({
    where: { requestId: accepted.requestId, outcome: 'REJECTED' },
  });
  assert.ok(rejected.some((row) => row.errorCode === 'REVISION_CONFLICT'));
});

test('concurrent recovery: execute ที่ยังไม่จบได้ครั้งละหนึ่ง — อีกคำสั่งได้ COMMAND_IN_PROGRESS', async (t) => {
  const s = await setup(t);
  const accepted = await s.actionRequired();
  const preview = await s.preview(accepted.requestId);
  const revision = (await s.request(accepted.requestId)).revision;
  const results = await Promise.allSettled(
    [1, 2, 3].map(() =>
      s.intake.submit(
        submission(accepted.requestId, {
          expectedRevision: revision,
          previewDigest: preview.result!.previewDigest,
        }),
      ),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results.filter((entry) => entry.status === 'rejected')) {
    assert.equal(
      ((result as PromiseRejectedResult).reason as PlatformProvisioningError).code,
      'COMMAND_IN_PROGRESS',
    );
  }
  await s.commandWorker().drain();
  // จบแล้วสั่งใหม่ได้ แต่สถานะไม่ใช่ ACTION_REQUIRED แล้ว = 409 แบบ deterministic
  await rejectsWith(
    s.intake.submit(
      submission(accepted.requestId, {
        expectedRevision: revision + 1,
        previewDigest: preview.result!.previewDigest,
      }),
    ),
    'INVALID_STATE_TRANSITION',
  );
});

test('resend cap: ครบ 3 ครั้งในชั่วโมง = INVITATION_RESEND_LIMITED พร้อม Retry-After', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const created = new Date(Date.now() - 20 * 60_000);
  for (let generation = 1; generation <= 3; generation += 1) {
    if (generation > 1) {
      await s.f.platform.pfInvitation.updateMany({
        where: { requestId: accepted.requestId, generation: generation - 1 },
        data: { supersededAt: created, revision: { increment: 1 } },
      });
    }
    await s.f.platform.pfInvitation.create({
      data: {
        id: randomUUID(),
        requestId: accepted.requestId,
        tenantId: accepted.tenantId,
        generation,
        keycloakUserId: randomUUID(),
        recipientHash: 'c'.repeat(64),
        lifespanSeconds: 259200,
        requestedByKind: generation === 1 ? 'SYSTEM' : 'PLATFORM_OPERATOR',
        requestedBy: 'fixture',
        reasonCode: generation === 1 ? null : 'RECIPIENT_REQUESTED',
        createdAt: new Date(created.getTime() + generation * 1000),
      },
    });
  }
  // resend ที่รอ worker นับรวมด้วย: 2 ที่ส่งแล้ว + 1 ที่คิวไว้ = ครบ
  await s.intake.submit(
    submission(accepted.requestId, {
      action: 'RESEND_INVITATION',
      reasonCode: 'RECIPIENT_REQUESTED',
    }),
  );
  await assert.rejects(
    s.intake.submit(
      submission(accepted.requestId, {
        action: 'RESEND_INVITATION',
        reasonCode: 'RECIPIENT_REQUESTED',
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof PlatformRetryAfterError);
      assert.equal(error.code, 'INVITATION_RESEND_LIMITED');
      assert.ok(error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 3600);
      return true;
    },
  );
  // worker ที่ไม่มี Keycloak ปฏิเสธ resend อย่างชัดเจน ไม่ค้าง
  await s.commandWorker().drain();
  const [pending] = await s.f.owner.pfOperatorCommand.findMany({
    where: { requestId: accepted.requestId, action: 'RESEND_INVITATION' },
  });
  assert.deepEqual([pending!.state, pending!.errorCode], ['REJECTED', 'RESEND_UNAVAILABLE']);
});

test('dependency ล้มระหว่างทำ: worker คืน lease แล้วลองใหม่ ≤ 5 ครั้งก่อน REJECTED', async (t) => {
  const s = await setup(t);
  const accepted = await s.actionRequired();
  let calls = 0;
  const flaky = {
    ...s.recovery,
    preview: async () => {
      calls += 1;
      throw new Error('keycloak unreachable');
    },
  } as unknown as ProvisioningRecoveryService;
  const queued = await s.intake.requestPreview({
    requestId: accepted.requestId,
    action: 'RETRY_STEP',
    actor: OPERATOR,
    correlationId: 'corr-flaky',
  });
  await s.commandWorker({ recovery: flaky }).drain();
  const result = await s.intake.command(accepted.requestId, queued.commandId);
  assert.deepEqual(
    [result.state, result.errorCode, calls],
    ['REJECTED', 'COMMAND_ATTEMPTS_EXHAUSTED', 5],
  );
});

test('read model: search pagination เสถียร, email ค้นด้วย hash, masked email และ history cursor', async (t) => {
  const s = await setup(t);
  const marker = `pg-${randomUUID().slice(0, 6)}`;
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    created.push(await s.accept({ displayName: `${marker} Customer ${index}` }));
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  let inserted = false;
  do {
    const page = await s.queries.searchTenants({
      query: marker,
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.items.map((item) => item.tenantId));
    // tenant ใหม่ระหว่างเปิดหน้า ต้องไม่ทำให้หน้าเดิมซ้ำหรือหาย
    if (!inserted) {
      await s.accept({ displayName: `${marker} Late` });
      inserted = true;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length);
  for (const accepted of created) assert.ok(seen.includes(accepted.tenantId));

  const target = created[2]!;
  // local part ถือตัวพิมพ์ตาม A1.1 — domain ตัวพิมพ์ใหญ่ต้องหาเจอเพราะ normalize แล้ว hash ตรงกัน
  const [local, domain] = target.input.firstAdmin.email.split('@');
  const byEmail = await s.queries.searchTenants({ query: `${local}@${domain!.toUpperCase()}` });
  assert.deepEqual(
    byEmail.items.map((item) => item.tenantId),
    [target.tenantId],
  );
  const byRequest = await s.queries.searchTenants({ query: target.requestId });
  assert.deepEqual(
    byRequest.items.map((item) => item.request?.requestId),
    [target.requestId],
  );
  const provisioning = await s.queries.searchTenants({
    query: marker,
    status: 'PENDING',
    limit: 100,
  });
  assert.ok(provisioning.items.every((item) => item.request?.status === 'PENDING'));
  assert.equal(provisioning.items[0]!.slug.startsWith('~pv-'), false);

  const view = await s.queries.requestView(target.requestId);
  const serialized = JSON.stringify([view, byEmail]);
  assert.equal(serialized.includes(target.input.firstAdmin.email), false);
  assert.match(view.firstAdmin.emailMasked, /^a\*\*\*@/);

  await s.saga.drain();
  const history: string[] = [];
  let historyCursor: string | undefined;
  do {
    const page = await s.queries.actionHistory({
      tenantId: target.tenantId,
      limit: 3,
      ...(historyCursor ? { cursor: historyCursor } : {}),
    });
    history.push(...page.items.map((item) => item.id));
    historyCursor = page.nextCursor ?? undefined;
  } while (historyCursor);
  const total = await s.f.owner.pfActionHistory.count({ where: { tenantId: target.tenantId } });
  assert.equal(new Set(history).size, total);

  await rejectsWith(s.queries.requestView(randomUUID()), 'NOT_FOUND');
  await rejectsWith(s.queries.actionHistory({ tenantId: 'not-a-uuid' }), 'NOT_FOUND');
  await rejectsWith(s.queries.searchTenants({ cursor: 'garbage' }), 'VALIDATION_FAILED');
});
