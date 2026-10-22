import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from './index.js';

test('Team guards: application User INSERT ไม่เพิ่ม reference เข้าทีมปิด แม้ไม่ผ่าน Core API', async (t) => {
  const owner = new PrismaClient();
  const app = new PrismaClient({
    datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
  });
  t.after(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });
  const tenantId = randomUUID();
  const teamId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'Team guard fixture',
      slug: `guards-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'ทีมปิด', isActive: false } });
  await assert.rejects(
    withTenantDatabaseTransaction(app, tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          teamId,
          keycloakId: randomUUID(),
          email: `${randomUUID()}@test.invalid`,
          displayName: 'ผู้ทดสอบ',
          passwordHash: '!test',
          role: 'AGENT',
        },
      }),
    ),
    /TEAM_INACTIVE/,
  );
  assert.equal(await owner.user.count({ where: { tenantId } }), 0);
});

test('Team guards: final state กัน same-tx insert→deactivate และยอมรับเพิ่มแล้วถอนก่อนปิด', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID();
  const teamId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Final state fixture',
      slug: `final-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await db.team.create({ data: { id: teamId, tenantId, name: 'ทีมใหม่' } });
  const input = {
    tenantId,
    teamId,
    keycloakId: randomUUID(),
    email: `${randomUUID()}@test.invalid`,
    displayName: 'Test',
    passwordHash: '!test',
    role: 'AGENT' as const,
  };
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, async (tx) => {
      await tx.user.create({ data: input });
      await tx.team.update({ where: { id: teamId }, data: { isActive: false } });
    }),
    /TEAM_REFERENCED|TEAM_INACTIVE/,
  );
  assert.equal(await db.user.count({ where: { tenantId } }), 0);
  await withTenantDatabaseTransaction(db, tenantId, async (tx) => {
    const user = await tx.user.create({ data: input });
    await tx.user.update({ where: { id: user.id }, data: { teamId: null } });
    await tx.team.update({ where: { id: teamId }, data: { isActive: false } });
  });
  assert.equal((await db.team.findUniqueOrThrow({ where: { id: teamId } })).isActive, false);
});

test('Team guards: Queue ที่ inactive และ Skill ยังเป็น current reference; ย้ายออก/ถอนได้ก่อนปิด', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID();
  const teamId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'References',
      slug: `refs-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await db.team.create({ data: { id: teamId, tenantId, name: 'References' } });
  const queue = await db.queue.create({
    data: { tenantId, teamId, name: 'Inactive queue', channels: ['VOICE'], isActive: false },
  });
  const skill = await db.skill.create({ data: { tenantId, teamId, name: 'Skill' } });
  const close = () =>
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.team.update({ where: { id: teamId }, data: { isActive: false } }),
    );
  await assert.rejects(close(), /TEAM_REFERENCED/);
  await db.queue.update({ where: { id: queue.id }, data: { teamId: null } });
  await assert.rejects(close(), /TEAM_REFERENCED/);
  await db.skill.update({ where: { id: skill.id }, data: { teamId: null } });
  await close();
  await assert.rejects(
    db.skill.update({ where: { id: skill.id }, data: { teamId } }),
    /TEAM_INACTIVE/,
  );
});

test('Team guards: future delegation ยังบล็อก แต่หมดอายุ/ถอนแล้วไม่บล็อก', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    otherTeam = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'IAM refs',
      slug: `rights-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  for (const id of [teamId, otherTeam]) await db.team.create({ data: { id, tenantId, name: id } });
  for (const subjectId of ['maker', 'reviewer', 'legacy'])
    await db.iamAuthoringSubject.create({
      data: { tenantId, subjectId, authenticationStrength: 'STRONG' },
    });
  const future = await db.iamAuthoringDelegation.create({
    data: {
      tenantId,
      delegatorSubjectId: 'maker',
      delegateSubjectId: 'reviewer',
      capability: 'journey.edit',
      scopeKind: 'TEAM',
      scopeId: teamId,
      startsAt: new Date(Date.now() + 3600000),
      expiresAt: new Date(Date.now() + 7200000),
      evidenceRef: 'fixture',
    },
  });
  const close = (id: string) =>
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.team.update({ where: { id }, data: { isActive: false } }),
    );
  await assert.rejects(close(teamId), /TEAM_REFERENCED/);
  await db.iamAuthoringDelegationRevocation.create({
    data: {
      tenantId,
      delegationId: future.id,
      reasonCode: 'TEST',
      revokedByRef: 'operator',
      revokedAt: new Date(),
    },
  });
  const expired = await db.iamAuthoringCapabilityGrant.create({
    data: {
      tenantId,
      subjectId: 'maker',
      capability: 'journey.edit',
      scopeKind: 'TEAM',
      scopeId: teamId,
      expiresAt: new Date(0),
      grantedByRef: 'operator',
    },
  });
  await close(teamId);
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, async (tx) => {
      await tx.iamAuthoringDelegationRevocation.delete({
        where: { tenantId_delegationId: { tenantId, delegationId: future.id } },
      });
      // ลบ suppressor ต้องถือ affected Team lock ก่อน final-state check ด้วย
      const [observer] = await db.$transaction(
        (other) =>
          other.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(hashtextextended(${'team-reference:' + tenantId + ':' + teamId},0)) AS locked`,
      );
      assert.equal(
        observer.locked,
        false,
        'material writer ต้องถือ Team shared fence ก่อนลบ proof',
      );
    }),
    /TEAM_INACTIVE/,
  );
  await assert.rejects(
    db.iamAuthoringCapabilityGrant.update({ where: { id: expired.id }, data: { expiresAt: null } }),
    /TEAM_INACTIVE/,
  );
  await close(otherTeam);
});

test('Team guards: Journey ใช้ pinned version; terminal/history ไม่บล็อก และ unresolved legacy บล็อกเฉพาะการปิด', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    newOwner = randomUUID(),
    spare = randomUUID(),
    journeyId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Pinned Journey',
      slug: `pinned-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  for (const id of [teamId, newOwner, spare])
    await db.team.create({ data: { id, tenantId, name: id } });
  for (const [version, ownerTeamId] of [
    [1, teamId],
    [2, newOwner],
  ] as const)
    await db.jrJourneyDefinition.create({
      data: {
        tenantId,
        journeyId,
        version,
        name: 'Pinned',
        ownerTeamId,
        purpose: 'SERVICE',
        senderIdentityId: 'sender',
        status: 'PUBLISHED',
        trigger: {},
        graph: {},
        goal: {},
        exitRules: {},
        maxDurationDays: 1,
        inputHash: 'a'.repeat(64),
        correlationId: randomUUID(),
      },
    });
  const enrollment = await db.jrEnrollment.create({
    data: { tenantId, journeyId, journeyVersion: 1, runState: 'RUNNING' },
  });
  const close = (id: string) =>
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.team.update({ where: { id }, data: { isActive: false } }),
    );
  await assert.rejects(close(teamId), /TEAM_REFERENCED/);
  await close(newOwner);
  await db.jrEnrollment.update({ where: { id: enrollment.id }, data: { runState: 'TERMINAL' } });
  const legacy = await withTenantDatabaseTransaction(db, tenantId, (tx) =>
    tx.jrEnrollment.create({ data: { tenantId, journeyVersion: 1, runState: 'TERMINAL' } }),
  );
  // สถานะเดิมที่ resolve ไม่ได้ต้องปฏิเสธการเปิดใหม่เมื่อมี inactive team แล้ว
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.jrEnrollment.update({ where: { id: legacy.id }, data: { runState: 'RUNNING' } }),
    ),
    /TEAM_REFERENCE_UNRESOLVED/,
  );
  await db.team.update({ where: { id: spare }, data: { name: 'ยังเปลี่ยนชื่อได้' } });
  await close(teamId);
  await close(spare);
});

test('Team guards: CG และ outbound แยก terminal จริงจาก expiry/lease; reopening ต้องใช้ทีม active', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    contactId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Runtime refs',
      slug: `runtime-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await db.team.create({ data: { id: teamId, tenantId, name: 'Runtime' } });
  await db.contact.create({ data: { id: contactId, tenantId } });
  const close = () =>
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.team.update({ where: { id: teamId }, data: { isActive: false } }),
    );
  const reservation = await db.cgReservation.create({
    data: {
      tenantId,
      teamId,
      contactId,
      channel: 'VOICE',
      purpose: 'SERVICE',
      source: 'TEST',
      sourceId: 'test',
      actionKey: randomUUID(),
      inputHash: 'a'.repeat(64),
      expiresAt: new Date(0),
    },
  });
  await assert.rejects(close(), /TEAM_REFERENCED/);
  await db.cgReservation.update({ where: { id: reservation.id }, data: { state: 'RELEASED' } });
  const alert = await db.cg5AlertState.create({
    data: {
      tenantId,
      teamId,
      ruleCode: 'TEST',
      scopeKey: 'a'.repeat(64),
      severity: 'CRITICAL',
      state: 'OPEN',
      value: 1,
      threshold: 1,
      consecutiveHits: 1,
      version: 1,
      updatedAt: new Date(),
    },
  });
  await assert.rejects(close(), /TEAM_REFERENCED/);
  await db.cg5AlertState.update({ where: { id: alert.id }, data: { state: 'RESOLVED' } });
  const queue = await db.queue.create({
    data: { tenantId, name: 'Callback queue', channels: ['VOICE'] },
  });
  const callback = await db.obCallback.create({
    data: {
      tenantId,
      contactId,
      queueId: queue.id,
      sourceOwnerTeamId: teamId,
      targetOwnerTeamId: teamId,
      requestedFor: new Date(0),
      expiresAt: new Date(1),
    },
  });
  await assert.rejects(close(), /TEAM_REFERENCED/);
  await db.obCallback.update({ where: { id: callback.id }, data: { state: 'CANCELLED' } });
  const target = await db.obCampaignTarget.create({
    data: {
      tenantId,
      contactId,
      campaignId: randomUUID(),
      sourceOwnerTeamId: teamId,
      targetOwnerTeamId: teamId,
      admissionPolicyVersion: 1,
    },
  });
  await assert.rejects(close(), /TEAM_REFERENCED/);
  await db.obCampaignTarget.update({ where: { id: target.id }, data: { state: 'CONSUMED' } });
  await close();
  await assert.rejects(
    db.obCallback.update({ where: { id: callback.id }, data: { state: 'SCHEDULED' } }),
    /TEAM_INACTIVE/,
  );
});

function latch() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
test('Team guards: User writer-first/deactivate-first แข่งกันด้วย transaction จริงและ try-lock ไม่รอ', async (t) => {
  const db = new PrismaClient();
  const app = new PrismaClient({
    datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
  });
  t.after(async () => {
    await app.$disconnect();
    await db.$disconnect();
  });
  for (const order of ['writer-first', 'deactivate-first']) {
    const tenantId = randomUUID(),
      teamId = randomUUID();
    await db.tenant.create({
      data: { id: tenantId, name: order, slug: `race-${tenantId}`, sipDomain: `${tenantId}.test` },
    });
    await db.team.create({ data: { id: teamId, tenantId, name: 'Race' } });
    const entered = latch(),
      release = latch();
    t.after(() => release.open());
    const data = {
      tenantId,
      teamId,
      keycloakId: randomUUID(),
      email: `${randomUUID()}@test.invalid`,
      displayName: 'Race',
      passwordHash: '!test',
      role: 'AGENT' as const,
    };
    const first = withTenantDatabaseTransaction(db, tenantId, async (tx) => {
      if (order === 'writer-first') await tx.user.create({ data });
      else await tx.team.update({ where: { id: teamId }, data: { isActive: false } });
      entered.open();
      await release.promise;
    });
    const observed = first.catch((error) => {
      entered.open();
      throw error;
    });
    await entered.promise;
    const start = performance.now();
    const second =
      order === 'writer-first'
        ? withTenantDatabaseTransaction(db, tenantId, (tx) =>
            tx.team.update({ where: { id: teamId }, data: { isActive: false } }),
          )
        : withTenantDatabaseTransaction(app, tenantId, (tx) => tx.user.create({ data }));
    await assert.rejects(second, /TEAM_REFERENCE_BUSY/);
    assert.ok(performance.now() - start < 2000);
    release.open();
    await observed;
    if (order === 'writer-first')
      await assert.rejects(
        withTenantDatabaseTransaction(db, tenantId, (tx) =>
          tx.team.update({ where: { id: teamId }, data: { isActive: false } }),
        ),
        /TEAM_REFERENCED/,
      );
    else
      await assert.rejects(
        withTenantDatabaseTransaction(app, tenantId, (tx) => tx.user.create({ data })),
        /TEAM_INACTIVE/,
      );
  }
});

test('Team guards: owner intent legacy ไม่มี canonical binding ปิดทีมใดใน tenant ไม่ได้ แต่ rename/cleanup ยังทำได้', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    other = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Owner legacy',
      slug: `owner-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  for (const id of [teamId, other]) await db.team.create({ data: { id, tenantId, name: id } });
  const action = await db.jrOwnerAction.create({
    data: {
      tenantId,
      actionKey: randomUUID(),
      enrollmentId: randomUUID(),
      kind: 'ENSURE_CASE',
      requestHash: 'a'.repeat(64),
      correlationId: randomUUID(),
    },
  });
  const command = await db.jrOwnerCommandOutbox.create({
    data: {
      tenantId,
      commandId: randomUUID(),
      actionId: action.id,
      actionKey: action.actionKey,
      kind: action.kind,
      requestHash: action.requestHash,
      correlationId: randomUUID(),
    },
  });
  const close = (id: string) =>
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.team.update({ where: { id }, data: { isActive: false } }),
    );
  for (const id of [teamId, other]) await assert.rejects(close(id), /TEAM_REFERENCE_UNRESOLVED/);
  await db.team.update({ where: { id: teamId }, data: { name: 'เปลี่ยนชื่อได้ระหว่างรอตรวจ' } });
  await db.jrOwnerAction.update({ where: { id: action.id }, data: { state: 'CANCELLED' } });
  await assert.rejects(close(other), /TEAM_REFERENCE_UNRESOLVED/);
  await db.jrOwnerCommandOutbox.update({ where: { id: command.id }, data: { state: 'CANCELLED' } });
  await close(teamId);
  await close(other);
});

test('Team guards: validated owner payload ระบุ source/target โดยไม่เดา head และ ACK ยังบล็อกจน continuation durable', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID(),
    source = randomUUID(),
    target = randomUUID(),
    spare = randomUUID(),
    journeyId = randomUUID(),
    commandId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Owner binding',
      slug: `binding-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  for (const id of [source, target, spare])
    await db.team.create({ data: { id, tenantId, name: id } });
  await db.jrJourneyDefinition.create({
    data: {
      tenantId,
      journeyId,
      version: 1,
      name: 'Owner',
      ownerTeamId: source,
      purpose: 'SERVICE',
      senderIdentityId: 'sender',
      status: 'PUBLISHED',
      trigger: {},
      graph: {},
      goal: {},
      exitRules: {},
      maxDurationDays: 1,
      inputHash: 'a'.repeat(64),
      correlationId: randomUUID(),
    },
  });
  const enrollment = await db.jrEnrollment.create({
    data: { tenantId, journeyId, journeyVersion: 1, runState: 'TERMINAL' },
  });
  const action = await db.jrOwnerAction.create({
    data: {
      tenantId,
      actionKey: randomUUID(),
      enrollmentId: enrollment.id,
      stepId: 'owner-step',
      stepSequence: 0,
      kind: 'ENSURE_CASE',
      requestHash: 'a'.repeat(64),
      correlationId: randomUUID(),
    },
  });
  const payload = {
    contractVersion: 1,
    commandId,
    actionKey: action.actionKey,
    requestHash: action.requestHash,
    journeyId,
    journeyVersion: 1,
    enrollmentId: enrollment.id,
    stepId: 'owner-step',
    sourceOutcome: {
      outcomeType: 'INTERACTION_ABANDONED',
      outcomeId: randomUUID(),
      outcomeVersion: 1,
    },
    interactionId: randomUUID(),
    contactId: randomUUID(),
    sourceOwnerTeamId: source,
    targetOwnerTeamId: target,
    commandType: 'ENSURE_CASE',
    intent: { caseTypePolicyRef: 'service', routingPolicyRef: 'service' },
  };
  await db.jrOwnerCommandOutbox.create({
    data: {
      tenantId,
      commandId,
      actionId: action.id,
      actionKey: action.actionKey,
      kind: action.kind,
      requestHash: action.requestHash,
      payload,
      correlationId: randomUUID(),
      state: 'SENT',
    },
  });
  const close = (id: string) =>
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.team.update({ where: { id }, data: { isActive: false } }),
    );
  await close(spare);
  const conflictingCommandId = randomUUID();
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.jrOwnerCommandOutbox.create({
        data: {
          tenantId,
          commandId: conflictingCommandId,
          actionId: action.id,
          actionKey: action.actionKey,
          kind: action.kind,
          requestHash: 'c'.repeat(64),
          payload: {
            ...payload,
            commandId: conflictingCommandId,
            requestHash: 'c'.repeat(64),
            targetOwnerTeamId: source,
          },
          correlationId: randomUUID(),
        },
      }),
    ),
    /TEAM_REFERENCE_UNRESOLVED/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.jrJourneyDefinition.delete({
        where: { tenantId_journeyId_version: { tenantId, journeyId, version: 1 } },
      }),
    ),
    /TEAM_REFERENCE_UNRESOLVED/,
  );
  for (const id of [source, target]) await assert.rejects(close(id), /TEAM_REFERENCED/);
  await db.jrOwnerAction.update({ where: { id: action.id }, data: { state: 'ACKNOWLEDGED' } });
  for (const id of [source, target]) await assert.rejects(close(id), /TEAM_REFERENCED/);
  await db.jrOwnerResultInbox.create({
    data: {
      tenantId,
      commandId,
      actionKey: action.actionKey,
      resultKind: 'ACKNOWLEDGED',
      resultHash: 'b'.repeat(64),
      correlationId: randomUUID(),
    },
  });
  await withTenantDatabaseTransaction(db, tenantId, (tx) =>
    tx.jrOwnerContinuation.create({
      data: {
        tenantId,
        commandId,
        actionId: action.id,
        actionKey: action.actionKey,
        enrollmentId: enrollment.id,
        fromStepId: 'owner-step',
        fromStepSequence: 0,
        resultKind: 'ACKNOWLEDGED',
        outcome: 'TERMINAL_IGNORED',
        resultHash: 'b'.repeat(64),
        correlationId: randomUUID(),
      },
    }),
  );
  await close(source);
  await close(target);
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.jrOwnerContinuation.delete({
        where: { tenantId_actionId: { tenantId, actionId: action.id } },
      }),
    ),
    /TEAM_INACTIVE/,
  );
});

test('Team guards: schedule CLAIMED ต้องมี durable enrollment จึงเลิกบล็อก pinned owner', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    journeyId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Schedule',
      slug: `schedule-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await db.team.create({ data: { id: teamId, tenantId, name: 'Schedule' } });
  await db.jrJourneyDefinition.create({
    data: {
      tenantId,
      journeyId,
      version: 1,
      name: 'Schedule',
      ownerTeamId: teamId,
      purpose: 'SERVICE',
      senderIdentityId: 'sender',
      status: 'PUBLISHED',
      trigger: {},
      graph: {},
      goal: {},
      exitRules: {},
      maxDurationDays: 1,
      inputHash: 'a'.repeat(64),
      correlationId: randomUUID(),
    },
  });
  const occurrence = await db.jrScheduleOccurrence.create({
    data: {
      tenantId,
      journeyId,
      journeyVersion: 1,
      occurrenceAt: new Date(0),
      correlationId: randomUUID(),
    },
  });
  const close = () =>
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.team.update({ where: { id: teamId }, data: { isActive: false } }),
    );
  await assert.rejects(close(), /TEAM_REFERENCED/);
  const enrolled = await db.jrEnrollment.create({
    data: {
      tenantId,
      journeyId,
      journeyVersion: 1,
      occurrenceId: occurrence.id,
      runState: 'TERMINAL',
    },
  });
  await close();
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.jrScheduleOccurrence.create({
        data: {
          tenantId,
          journeyId,
          journeyVersion: 1,
          occurrenceAt: new Date(1),
          correlationId: randomUUID(),
        },
      }),
    ),
    /TEAM_INACTIVE/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.jrEnrollment.delete({ where: { id: enrolled.id } }),
    ),
    /TEAM_INACTIVE/,
  );
  await db.jrScheduleOccurrence.update({
    where: { id: occurrence.id },
    data: { state: 'ENROLLED' },
  });
  await withTenantDatabaseTransaction(db, tenantId, (tx) =>
    tx.jrEnrollment.delete({ where: { id: enrolled.id } }),
  );
});

test('Team guards: scoped refilter/future work และ pending segment intent บล็อก; unscoped/terminal entry ไม่บล็อก', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    intentTeam = randomUUID(),
    spare = randomUUID(),
    contactId = randomUUID(),
    journeyId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Segment',
      slug: `segment-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  for (const id of [teamId, intentTeam, spare])
    await db.team.create({ data: { id, tenantId, name: id } });
  await db.contact.create({ data: { id: contactId, tenantId } });
  const receipt = await db.jrSegmentReceipt.create({
    data: {
      tenantId,
      contactId,
      source: 'TEST',
      eventId: randomUUID(),
      segmentId: 'segment-a',
      membershipRevision: 1,
      changeKind: 'ENTERED',
      entryId: 'entry-a',
      segmentDefinitionVersion: 1,
      payloadHash: 'a'.repeat(64),
      correlationId: randomUUID(),
    },
  });
  const cursor = await db.jrSegmentRefilterCursor.create({
    data: {
      tenantId,
      contactId,
      segmentId: 'segment-a',
      membershipRevision: 1,
      receiptId: receipt.id,
      scopeTeamId: teamId,
      availableAt: new Date(Date.now() + 86400000),
      correlationId: randomUUID(),
    },
  });
  const close = (id: string) =>
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.team.update({ where: { id }, data: { isActive: false } }),
    );
  await assert.rejects(close(teamId), /TEAM_REFERENCED/);
  await db.jrSegmentRefilterCursor.update({
    where: { id: cursor.id },
    data: { state: 'NO_OP', settledAt: new Date(), version: { increment: 1 } },
  });
  await close(teamId);
  await db.jrSegmentRefilterCursor.create({
    data: {
      tenantId,
      contactId,
      segmentId: 'segment-unscoped',
      membershipRevision: 1,
      receiptId: receipt.id,
      scopeTeamId: null,
      correlationId: randomUUID(),
    },
  });
  await close(spare);
  await db.jrJourneyDefinition.create({
    data: {
      tenantId,
      journeyId,
      version: 1,
      name: 'Segment',
      ownerTeamId: intentTeam,
      purpose: 'SERVICE',
      senderIdentityId: 'sender',
      status: 'PUBLISHED',
      trigger: {},
      graph: {},
      goal: {},
      exitRules: {},
      maxDurationDays: 1,
      inputHash: 'a'.repeat(64),
      correlationId: randomUUID(),
    },
  });
  await withTenantDatabaseTransaction(db, tenantId, (tx) =>
    tx.jrSegmentEnrollmentIntent.create({
      data: {
        tenantId,
        journeyId,
        journeyVersion: 1,
        contactId,
        segmentId: 'segment-a',
        entryId: 'entry-a',
        receiptId: receipt.id,
        reasonMembershipRevision: 1,
        reasonDefinitionVersion: 1,
        reasonDigest: 'a'.repeat(64),
        correlationId: randomUUID(),
      },
    }),
  );
  await assert.rejects(close(intentTeam), /TEAM_REFERENCED/);
  await withTenantDatabaseTransaction(db, tenantId, (tx) =>
    tx.jrSegmentHead.create({
      data: {
        tenantId,
        contactId,
        segmentId: 'segment-a',
        lastAppliedRevision: 1,
        terminalEntryId: 'entry-a',
        terminalRevision: 1,
        terminalReasonCode: 'LEFT',
      },
    }),
  );
  await close(intentTeam);
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.jrSegmentHead.delete({
        where: { tenantId_contactId_segmentId: { tenantId, contactId, segmentId: 'segment-a' } },
      }),
    ),
    /TEAM_INACTIVE/,
  );
});

test('Team guards: SEND ที่ยัง HELD บล็อกแม้ enrollment terminal และ reservation release แล้ว; terminal SEND เป็น history', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    journeyId = randomUUID(),
    contactId = randomUUID();
  await db.tenant.create({
    data: { id: tenantId, name: 'SEND', slug: `send-${tenantId}`, sipDomain: `${tenantId}.test` },
  });
  await db.team.create({ data: { id: teamId, tenantId, name: 'SEND' } });
  await db.contact.create({ data: { id: contactId, tenantId } });
  await db.jrJourneyDefinition.create({
    data: {
      tenantId,
      journeyId,
      version: 1,
      name: 'SEND',
      ownerTeamId: teamId,
      purpose: 'SERVICE',
      senderIdentityId: 'sender',
      status: 'PUBLISHED',
      trigger: {},
      graph: {},
      goal: {},
      exitRules: {},
      maxDurationDays: 1,
      inputHash: 'a'.repeat(64),
      correlationId: randomUUID(),
    },
  });
  const enrollment = await db.jrEnrollment.create({
    data: { tenantId, journeyId, journeyVersion: 1, runState: 'TERMINAL', contactId },
  });
  const identity = await db.contactIdentity.create({
    data: { tenantId, contactId, type: 'EMAIL', value: `${randomUUID()}@test.invalid` },
  });
  const reservation = await db.cgReservation.create({
    data: {
      tenantId,
      teamId,
      contactId,
      identityId: identity.id,
      channel: 'EMAIL',
      purpose: 'SERVICE',
      source: 'JOURNEY',
      sourceId: enrollment.id,
      actionKey: randomUUID(),
      inputHash: 'a'.repeat(64),
      expiresAt: new Date(0),
      state: 'RELEASED',
    },
  });
  const decision = await db.cgDecisionLog.create({
    data: {
      tenantId,
      teamId,
      contactId,
      identityId: identity.id,
      channel: 'EMAIL',
      purpose: 'SERVICE',
      source: 'JOURNEY',
      sourceId: enrollment.id,
      actionKey: reservation.actionKey,
      decision: 'ALLOW',
      reasonCode: 'ALLOWED',
      policyVersion: 1,
      gate: 'ALLOW',
      trace: {},
    },
  });
  const action = await db.jrAction.create({
    data: {
      tenantId,
      enrollmentId: enrollment.id,
      actionKey: reservation.actionKey,
      contactId,
      identityId: identity.id,
      channel: 'EMAIL',
      purpose: 'SERVICE',
      decisionId: decision.id,
      reservationId: reservation.id,
      realtimeState: 'HELD',
    },
  });
  const close = () =>
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.team.update({ where: { id: teamId }, data: { isActive: false } }),
    );
  await assert.rejects(close(), /TEAM_REFERENCED/);
  await db.jrAction.update({ where: { id: action.id }, data: { realtimeState: 'CANCELLED' } });
  await close();
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.jrAction.update({ where: { id: action.id }, data: { realtimeState: 'HELD' } }),
    ),
    /TEAM_INACTIVE/,
  );
});

test('Team guards: resolve canonical owner receipt ก่อนถือว่า legacy unknown; version ที่ไม่รู้จักไม่ยืม proof ของ command เดิม', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID(),
    source = randomUUID(),
    target = randomUUID(),
    spare = randomUUID(),
    journeyId = randomUUID(),
    contactId = randomUUID(),
    commandId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Canonical owner',
      slug: `canonical-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  for (const id of [source, target, spare])
    await db.team.create({ data: { id, tenantId, name: id } });
  await db.contact.create({ data: { id: contactId, tenantId } });
  await db.jrJourneyDefinition.create({
    data: {
      tenantId,
      journeyId,
      version: 1,
      name: 'Canonical',
      ownerTeamId: source,
      purpose: 'SERVICE',
      senderIdentityId: 'sender',
      status: 'PUBLISHED',
      trigger: {},
      graph: {},
      goal: {},
      exitRules: {},
      maxDurationDays: 1,
      inputHash: 'a'.repeat(64),
      correlationId: randomUUID(),
    },
  });
  const enrollment = await db.jrEnrollment.create({
    data: { tenantId, journeyId, journeyVersion: 1, runState: 'TERMINAL' },
  });
  const action = await db.jrOwnerAction.create({
    data: {
      tenantId,
      actionKey: randomUUID(),
      enrollmentId: enrollment.id,
      kind: 'ADMIT_CAMPAIGN_TARGET',
      requestHash: 'a'.repeat(64),
      correlationId: randomUUID(),
    },
  });
  const record = await db.obCampaignTarget.create({
    data: {
      tenantId,
      contactId,
      campaignId: randomUUID(),
      sourceOwnerTeamId: source,
      targetOwnerTeamId: target,
      state: 'CONSUMED',
      admissionPolicyVersion: 1,
    },
  });
  await db.obDialerCommandInbox.create({
    data: {
      tenantId,
      commandId,
      actionKey: action.actionKey,
      commandType: 'ADMIT_CAMPAIGN_TARGET',
      requestHash: action.requestHash,
      status: 'ADMITTED',
      code: 'ADMITTED',
      category: 'SUCCESS',
      reasonCode: 'ADMITTED',
      failureClass: 'NONE',
      retryDisposition: 'NONE',
      recordId: record.id,
      recordVersion: record.version,
      correlationId: randomUUID(),
      observedAt: new Date(),
    },
  });
  const close = (id: string) =>
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.team.update({ where: { id }, data: { isActive: false } }),
    );
  await close(spare);
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.jrOwnerCommandOutbox.create({
        data: {
          tenantId,
          commandId,
          actionId: action.id,
          actionKey: action.actionKey,
          kind: action.kind,
          requestHash: action.requestHash,
          payload: { contractVersion: 2, sourceOwnerTeamId: source, targetOwnerTeamId: target },
          correlationId: randomUUID(),
        },
      }),
    ),
    /TEAM_REFERENCE_UNRESOLVED/,
  );
  for (const id of [source, target]) await assert.rejects(close(id), /TEAM_REFERENCED/);
  await db.jrOwnerAction.update({ where: { id: action.id }, data: { state: 'CANCELLED' } });
  await close(source);
  await close(target);
});

test('Team guards: legacy reference เดิมไม่อนุญาต reactivate User/Queue หรือยืด grant บนทีมปิด; cleanup ยังได้', async (t) => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const tenantId = randomUUID(),
    teamId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Legacy acquisition',
      slug: `renew-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  // fault fixture เฉพาะ owner: จำลอง legacy inactive references ที่มีมาก่อน guard นี้
  const legacy = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
    await tx.team.create({
      data: { id: teamId, tenantId, name: 'ทีมเก่าที่ปิด', isActive: false },
    });
    const user = await tx.user.create({
      data: {
        tenantId,
        teamId,
        keycloakId: randomUUID(),
        email: `${randomUUID()}@test.invalid`,
        displayName: 'Legacy',
        passwordHash: '!test',
        role: 'AGENT',
        isActive: false,
      },
    });
    const queue = await tx.queue.create({
      data: { tenantId, teamId, name: 'Legacy queue', channels: ['VOICE'], isActive: false },
    });
    await tx.iamAuthoringSubject.create({
      data: { tenantId, subjectId: 'legacy', authenticationStrength: 'STRONG' },
    });
    const grant = await tx.iamAuthoringCapabilityGrant.create({
      data: {
        tenantId,
        subjectId: 'legacy',
        scopeKind: 'TEAM',
        scopeId: teamId,
        capability: 'journey.edit',
        expiresAt: new Date(Date.now() + 3600000),
        grantedByRef: 'operator',
      },
    });
    return { user, queue, grant };
  });
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.user.update({ where: { id: legacy.user.id }, data: { isActive: true } }),
    ),
    /TEAM_INACTIVE/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.queue.update({ where: { id: legacy.queue.id }, data: { isActive: true } }),
    ),
    /TEAM_INACTIVE/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(db, tenantId, (tx) =>
      tx.iamAuthoringCapabilityGrant.update({
        where: { id: legacy.grant.id },
        data: { expiresAt: null },
      }),
    ),
    /TEAM_INACTIVE/,
  );
  await withTenantDatabaseTransaction(db, tenantId, async (tx) => {
    await tx.user.update({
      where: { id: legacy.user.id },
      data: { displayName: 'Legacy แก้ข้อมูลทั่วไปได้' },
    });
    await tx.iamAuthoringCapabilityGrant.update({
      where: { id: legacy.grant.id },
      data: { expiresAt: new Date(0) },
    });
  });
});

test('Team guards: EXPLAIN ANALYZE closure บน 60,000 references อยู่ใน budget 2s และไม่รวม tenant อื่น', async (t) => {
  const db = new PrismaClient(),
    app = new PrismaClient({ datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } } });
  t.after(async () => {
    await app.$disconnect();
    await db.$disconnect();
  });
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    otherTeam = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Guard budget',
      slug: `budget-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  for (const id of [teamId, otherTeam]) await db.team.create({ data: { id, tenantId, name: id } });
  // synthetic scale fixture; bypass ใช้เฉพาะ owner ตอนเตรียมข้อมูล ไม่ใช่ query ที่พิสูจน์ budget
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
      await tx.$executeRaw`INSERT INTO users(id,tenant_id,team_id,email,password_hash,display_name,role,created_at)
      SELECT gen_random_uuid(),${tenantId}::uuid,${otherTeam}::uuid,'budget-'||n||'@test.invalid','!test','Budget','AGENT',now() FROM generate_series(1,40000) n`;
      await tx.$executeRaw`INSERT INTO queues(id,tenant_id,team_id,name,channels)
      SELECT gen_random_uuid(),${tenantId}::uuid,${otherTeam}::uuid,'Budget '||n,ARRAY['VOICE']::"ChannelType"[] FROM generate_series(1,10000) n`;
      await tx.$executeRaw`INSERT INTO skills(id,tenant_id,team_id,name)
      SELECT gen_random_uuid(),${tenantId}::uuid,${otherTeam}::uuid,'Budget '||n FROM generate_series(1,10000) n`;
    },
    { timeout: 10000 },
  );
  await db.$executeRawUnsafe('ANALYZE users,queues,skills');
  const plan = await withTenantDatabaseTransaction(app, tenantId, async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout','2s',true)`;
    return tx.$queryRaw<
      { 'QUERY PLAN': Array<{ 'Execution Time': number }> }[]
    >`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM public.dc_team_reference_blockers(${tenantId}::uuid,${teamId}::uuid)`;
  });
  const elapsed = plan[0]['QUERY PLAN'][0]['Execution Time'];
  assert.ok(elapsed < 2000, `closure ${elapsed}ms`);
  t.diagnostic(`closure 60,000 rows: ${elapsed}ms`);
  const own = await withTenantDatabaseTransaction(
    app,
    tenantId,
    (tx) =>
      tx.$queryRaw<
        { kind: string; count: bigint }[]
      >`SELECT * FROM public.dc_team_reference_blockers(${tenantId}::uuid,${otherTeam}::uuid) ORDER BY kind`,
  );
  assert.deepEqual(own, [
    { kind: 'QUEUE_REFERENCE', count: 10000n },
    { kind: 'SKILL_REFERENCE', count: 10000n },
    { kind: 'USER_REFERENCE', count: 40000n },
  ]);
  // budget ครอบ final-state constraint ทั้ง unit ไม่ใช่ EXPLAIN ผ่านแต่ deactivate commit ไม่ได้
  await withTenantDatabaseTransaction(
    db,
    tenantId,
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout','2s',true)`;
      await tx.team.update({ where: { id: teamId }, data: { isActive: false } });
    },
    { timeout: 5000 },
  );
});

test('Team guards: app ไม่ยืม PROVISIONING lifecycle เพื่อข้าม Core effect receipt ของ provisioner', async (t) => {
  const db = new PrismaClient(),
    app = new PrismaClient({ datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } } });
  t.after(async () => {
    await app.$disconnect();
    await db.$disconnect();
  });
  const tenantId = randomUUID();
  await db.tenant.create({
    data: {
      id: tenantId,
      name: 'Provisioner authority',
      slug: `~pv-${tenantId}`,
      sipDomain: `~pv-${tenantId}`,
      lifecycleStatus: 'PROVISIONING',
    },
  });
  await assert.rejects(
    withTenantDatabaseTransaction(app, tenantId, (tx) =>
      tx.team.create({ data: { tenantId, name: 'ห้ามรับรองจาก lifecycle อย่างเดียว' } }),
    ),
    /CORE_ACTIVE_TENANT_CONTEXT_REQUIRED/,
  );
  assert.equal(await db.team.count({ where: { tenantId } }), 0);
});
