/**
 * #956 — ต้องรันบนฐานแยก (เช่น dcontact_956) โดยตั้ง DATABASE_URL เป็น owner role และ
 * APPLICATION_DATABASE_URL เป็น dcontact_app ที่ไม่ bypass RLS ห้ามรันบนฐาน dcontact ร่วม
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import { AgentCaseError, AgentCases } from './agent-cases.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

interface TenantFixture {
  tenantId: string;
  teamId: string;
  otherTeamId: string;
  agentId: string;
  teammateId: string;
  otherTeamAgentId: string;
  inactiveTeammateId: string;
  contactId: string;
  linkedWorkId: string;
  unlinkedWorkId: string;
  teammateWorkId: string;
  completedWorkId: string;
}

async function seedTenant(owner: PrismaClient, label: string): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const fixture: TenantFixture = {
    tenantId,
    teamId: randomUUID(),
    otherTeamId: randomUUID(),
    agentId: randomUUID(),
    teammateId: randomUUID(),
    otherTeamAgentId: randomUUID(),
    inactiveTeammateId: randomUUID(),
    contactId: randomUUID(),
    linkedWorkId: randomUUID(),
    unlinkedWorkId: randomUUID(),
    teammateWorkId: randomUUID(),
    completedWorkId: randomUUID(),
  };
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `#956 ${label} ${suffix}`,
      slug: `cases-956-${suffix}`,
      sipDomain: `${suffix}.cases-956.test`,
    },
  });
  await owner.team.createMany({
    data: [
      { id: fixture.teamId, tenantId, name: 'Service' },
      { id: fixture.otherTeamId, tenantId, name: 'Sales' },
    ],
  });
  const user = (id: string, name: string, teamId: string, isActive = true) => ({
    id,
    tenantId,
    email: `${name}-${suffix}@cases-956.test`,
    passwordHash: 'not-used',
    displayName: name,
    role: 'AGENT' as const,
    teamId,
    isActive,
  });
  await owner.user.createMany({
    data: [
      user(fixture.agentId, 'Somchai', fixture.teamId),
      user(fixture.teammateId, 'Somying', fixture.teamId),
      user(fixture.inactiveTeammateId, 'Former', fixture.teamId, false),
      user(fixture.otherTeamAgentId, 'Outsider', fixture.otherTeamId),
    ],
  });
  await owner.contact.create({
    data: { id: fixture.contactId, tenantId, displayName: 'ลูกค้า #956' },
  });
  const work = (
    id: string,
    agentId: string,
    contactId: string | null,
    state: 'WRAPUP' | 'COMPLETED' = 'WRAPUP',
  ) => ({
    id,
    tenantId,
    channel: 'VOICE' as const,
    direction: 'INBOUND' as const,
    state,
    agentId,
    contactId,
  });
  await owner.interaction.createMany({
    data: [
      work(fixture.linkedWorkId, fixture.agentId, fixture.contactId),
      work(fixture.unlinkedWorkId, fixture.agentId, null),
      work(fixture.teammateWorkId, fixture.teammateId, fixture.contactId),
      work(fixture.completedWorkId, fixture.agentId, fixture.contactId, 'COMPLETED'),
    ],
  });
  return fixture;
}

async function cleanup(owner: PrismaClient, tenantId: string): Promise<void> {
  await owner.commandReceipt.deleteMany({ where: { tenantId } });
  await owner.csCaseActivity.deleteMany({ where: { tenantId } });
  await owner.csCase.deleteMany({ where: { tenantId } });
  await owner.interaction.deleteMany({ where: { tenantId } });
  await owner.contact.deleteMany({ where: { tenantId } });
  await owner.user.deleteMany({ where: { tenantId } });
  await owner.team.deleteMany({ where: { tenantId } });
  await owner.tenant.deleteMany({ where: { id: tenantId } });
}

async function setup(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const a = await seedTenant(owner, 'A');
  const b = await seedTenant(owner, 'B');
  t.after(async () => {
    await cleanup(owner, a.tenantId);
    await cleanup(owner, b.tenantId);
    await owner.$disconnect();
    await application.$disconnect();
  });
  /** งาน WRAPUP ใหม่ของ Agent A ที่ผูกลูกค้าแล้ว — งานหนึ่งเปิดเคสได้ใบเดียว */
  const newWork = async () => {
    const id = randomUUID();
    await owner.interaction.create({
      data: {
        id,
        tenantId: a.tenantId,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'WRAPUP',
        agentId: a.agentId,
        contactId: a.contactId,
      },
    });
    return id;
  };
  return { owner, cases: new AgentCases(application), a, b, newWork };
}

async function rejects(work: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof AgentCaseError, `ควรได้ AgentCaseError แต่ได้ ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function openBody(f: TenantFixture, overrides: Record<string, unknown> = {}) {
  return {
    commandId: randomUUID(),
    interactionId: f.linkedWorkId,
    subject: 'ลูกค้าขอคืนสินค้า รอฝ่ายคลังยืนยัน',
    note: 'ลูกค้าแจ้งสินค้าชำรุด ส่งรูปทางไลน์แล้ว',
    ...overrides,
  };
}

test('เปิดเคสจากงานที่ผูกลูกค้า: ได้เคส OPEN ของทีม และไทม์ไลน์ เปิด → ผูกงาน → โน้ต', async (t) => {
  const { cases, a } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };

  const opened = await cases.open(agent, openBody(a));
  assert.equal(opened.version, 1);

  const detail = await cases.detail(agent, opened.caseId);
  assert.equal(detail.status, 'OPEN');
  assert.equal(detail.teamId, a.teamId);
  assert.equal(detail.contactId, a.contactId);
  assert.equal(detail.assigneeUserId, a.agentId);
  assert.equal(detail.sourceInteractionId, a.linkedWorkId);
  assert.deepEqual(
    detail.activities.map((activity) => activity.kind),
    ['CREATED', 'LINKED', 'NOTE'],
  );
  assert.equal(detail.activities[1]?.interactionId, a.linkedWorkId);
  assert.equal(detail.activities[2]?.body, 'ลูกค้าแจ้งสินค้าชำรุด ส่งรูปทางไลน์แล้ว');
  assert.equal(detail.linkedWorkCount, 1);
});

test('ส่งคำสั่งเปิดเคสเดิมซ้ำได้ผลเดิม ไม่เกิดเคสที่สอง ส่วน commandId เดิมกับข้อมูลต่างถูกปฏิเสธ', async (t) => {
  const { owner, cases, a } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };
  const body = openBody(a);

  const first = await cases.open(agent, body);
  const again = await cases.open(agent, body);
  assert.deepEqual(again, first);
  assert.equal(await owner.csCase.count({ where: { tenantId: a.tenantId } }), 1);

  await rejects(cases.open(agent, { ...body, subject: 'หัวข้ออื่น' }), 'COMMAND_PAYLOAD_MISMATCH');
  await rejects(
    cases.addNote(agent, first.caseId, {
      commandId: body.commandId,
      expectedVersion: 1,
      note: 'x',
    }),
    'COMMAND_ID_REUSED',
  );
});

test('งานที่ยังไม่ผูกลูกค้า งานที่บันทึกผลจบแล้ว หรืองานของคนอื่น เปิดเคสไม่ได้', async (t) => {
  const { owner, cases, a } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };

  await rejects(
    cases.open(agent, openBody(a, { interactionId: a.unlinkedWorkId })),
    'CONTACT_REQUIRED',
  );
  await rejects(
    cases.open(agent, openBody(a, { interactionId: a.teammateWorkId })),
    'WORK_NOT_FOUND',
  );
  await rejects(cases.open(agent, openBody(a, { interactionId: randomUUID() })), 'WORK_NOT_FOUND');
  await rejects(
    cases.open(agent, openBody(a, { interactionId: a.completedWorkId })),
    'WORK_NOT_ACTIVE',
  );
  assert.equal(await owner.csCase.count({ where: { tenantId: a.tenantId } }), 0);
});

test('มอบหมายได้เฉพาะ Agent ที่ active ในทีมเดียวกัน', async (t) => {
  const { cases, a, b } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };

  await rejects(
    cases.open(agent, openBody(a, { assigneeUserId: a.otherTeamAgentId })),
    'ASSIGNEE_NOT_IN_TEAM',
  );
  const opened = await cases.open(agent, openBody(a, { assigneeUserId: a.teammateId }));
  let detail = await cases.detail(agent, opened.caseId);
  assert.equal(detail.assigneeUserId, a.teammateId);

  for (const outsider of [a.otherTeamAgentId, a.inactiveTeammateId, b.agentId]) {
    await rejects(
      cases.assign(agent, opened.caseId, {
        commandId: randomUUID(),
        expectedVersion: 1,
        assigneeUserId: outsider,
      }),
      'ASSIGNEE_NOT_IN_TEAM',
    );
  }

  const assigned = await cases.assign(agent, opened.caseId, {
    commandId: randomUUID(),
    expectedVersion: 1,
    assigneeUserId: a.agentId,
  });
  assert.equal(assigned.version, 2);
  detail = await cases.detail(agent, opened.caseId);
  assert.equal(detail.assigneeUserId, a.agentId);
  assert.equal(detail.activities.at(-1)?.kind, 'ASSIGNED');

  const team = await cases.teamAgents(agent);
  assert.deepEqual(team.map((member) => member.userId).sort(), [a.agentId, a.teammateId].sort());
});

test('ผู้รับผิดชอบที่ย้ายทีมแล้ว: เคสยังอยู่กับทีมเดิม และรายละเอียดบอกให้มอบหมายใหม่', async (t) => {
  const { owner, cases, a } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };
  const opened = await cases.open(agent, openBody(a, { assigneeUserId: a.teammateId }));
  assert.equal((await cases.detail(agent, opened.caseId)).assigneeInTeam, true);

  await owner.user.update({ where: { id: a.teammateId }, data: { teamId: a.otherTeamId } });
  const detail = await cases.detail(agent, opened.caseId);
  assert.equal(detail.teamId, a.teamId);
  assert.equal(detail.assigneeUserId, a.teammateId);
  assert.equal(detail.assigneeInTeam, false);
  // ผู้ที่ย้ายออกไปมองไม่เห็นเคสของทีมเดิมแล้ว
  await rejects(
    cases.detail({ tenantId: a.tenantId, userId: a.teammateId }, opened.caseId),
    'CASE_NOT_FOUND',
  );
});

test('งานที่ผูกในไทม์ไลน์บอกว่าเป็นงานของผู้ดูหรือไม่', async (t) => {
  const { cases, a } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };
  const opened = await cases.open(agent, openBody(a));
  const linked = (detail: Awaited<ReturnType<typeof cases.detail>>) =>
    detail.activities.find((activity) => activity.kind === 'LINKED');

  const own = linked(await cases.detail(agent, opened.caseId));
  assert.equal(own?.interactionMine, true);
  assert.equal(own?.interactionChannel, 'VOICE');
  assert.equal(own?.interactionDirection, 'INBOUND');
  const teammateView = await cases.detail(
    { tenantId: a.tenantId, userId: a.teammateId },
    opened.caseId,
  );
  assert.equal(linked(teammateView)?.interactionMine, false);
  assert.ok(
    teammateView.activities.every(
      (activity) => activity.kind === 'LINKED' || !activity.interactionMine,
    ),
  );
});

test('version ไม่ตรงได้ conflict และไม่มีอะไรถูกเขียน', async (t) => {
  const { cases, a } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };
  const teammate = { tenantId: a.tenantId, userId: a.teammateId };
  const opened = await cases.open(agent, openBody(a));

  await cases.addNote(teammate, opened.caseId, {
    commandId: randomUUID(),
    expectedVersion: 1,
    note: 'โทรตามคลังแล้ว รอคำตอบพรุ่งนี้',
  });
  await rejects(
    cases.addNote(agent, opened.caseId, {
      commandId: randomUUID(),
      expectedVersion: 1,
      note: 'ซ้อน',
    }),
    'VERSION_CONFLICT',
  );
  const detail = await cases.detail(agent, opened.caseId);
  assert.equal(detail.version, 2);
  assert.deepEqual(
    detail.activities
      .filter((activity) => activity.kind === 'NOTE')
      .map((activity) => activity.actorUserId),
    [a.agentId, a.teammateId],
  );
});

test('สถานะ OPEN → RESOLVED → OPEN → RESOLVED → CLOSED แล้วแก้ต่อไม่ได้', async (t) => {
  const { cases, a } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };
  const opened = await cases.open(agent, openBody(a));
  const status = (expectedVersion: number, value: string) =>
    cases.changeStatus(agent, opened.caseId, {
      commandId: randomUUID(),
      expectedVersion,
      status: value,
    });

  await status(1, 'RESOLVED');
  let detail = await cases.detail(agent, opened.caseId);
  assert.equal(detail.status, 'RESOLVED');
  assert.ok(detail.resolvedAt);

  await status(2, 'OPEN');
  detail = await cases.detail(agent, opened.caseId);
  assert.equal(detail.status, 'OPEN');
  assert.equal(detail.resolvedAt, null);

  await rejects(status(3, 'OPEN'), 'INVALID_TRANSITION');
  // ปิดจาก OPEN ตรงไม่ได้ ต้องผ่าน RESOLVED ก่อน
  await rejects(status(3, 'CLOSED'), 'INVALID_TRANSITION');
  await status(3, 'RESOLVED');
  await status(4, 'CLOSED');
  detail = await cases.detail(agent, opened.caseId);
  assert.equal(detail.status, 'CLOSED');
  assert.ok(detail.closedAt);
  assert.deepEqual(
    detail.activities
      .filter((activity) => activity.kind === 'STATUS_CHANGED')
      .map((activity) => `${activity.fromStatus}>${activity.toStatus}`),
    ['OPEN>RESOLVED', 'RESOLVED>OPEN', 'OPEN>RESOLVED', 'RESOLVED>CLOSED'],
  );
  assert.equal(detail.reopenCount, 1);

  await rejects(status(5, 'OPEN'), 'CASE_CLOSED');
  await rejects(
    cases.addNote(agent, opened.caseId, {
      commandId: randomUUID(),
      expectedVersion: 5,
      note: 'หลังปิด',
    }),
    'CASE_CLOSED',
  );
});

test('ทีมอื่นและ tenant อื่นมองไม่เห็นและแก้เคสไม่ได้', async (t) => {
  const { cases, a, b } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };
  const opened = await cases.open(agent, openBody(a));

  const otherTeam = { tenantId: a.tenantId, userId: a.otherTeamAgentId };
  assert.deepEqual((await cases.list(otherTeam)).items, []);
  await rejects(cases.detail(otherTeam, opened.caseId), 'CASE_NOT_FOUND');
  await rejects(
    cases.addNote(otherTeam, opened.caseId, {
      commandId: randomUUID(),
      expectedVersion: 1,
      note: 'x',
    }),
    'CASE_NOT_FOUND',
  );

  // Agent ของ tenant B ที่รู้ caseId ก็ยังหาไม่เจอ (RLS และเงื่อนไขทีม)
  const otherTenant = { tenantId: b.tenantId, userId: b.agentId };
  assert.deepEqual((await cases.list(otherTenant)).items, []);
  await rejects(cases.detail(otherTenant, opened.caseId), 'CASE_NOT_FOUND');

  // ผู้ที่อ้าง tenant A แต่ไม่มีบัญชี Agent ใน tenant A ถูกปฏิเสธก่อนอ่านเคส
  await rejects(cases.list({ tenantId: a.tenantId, userId: b.agentId }), 'AGENT_REQUIRED');
});

test('RLS: application role มองไม่เห็นแถว cs_cases ของ tenant อื่นแม้ query ตรง', async (t) => {
  const { cases, a, b } = await setup(t);
  const opened = await cases.open({ tenantId: a.tenantId, userId: a.agentId }, openBody(a));
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  t.after(() => application.$disconnect());

  const visible = await application.$transaction(async (transaction) => {
    await transaction.$executeRaw(
      Prisma.sql`SELECT set_config('app.tenant_id', ${b.tenantId}, true)`,
    );
    return transaction.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM cs_cases WHERE id = ${opened.caseId}::uuid`,
    );
  });
  assert.deepEqual(visible, []);
});

test('รายการของทีมกรองตามสถานะและของฉัน เรียงตามอัปเดตล่าสุด', async (t) => {
  const { cases, a, newWork } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };
  const first = await cases.open(agent, openBody(a, { subject: 'เคสแรก' }));
  const second = await cases.open(
    agent,
    openBody(a, {
      subject: 'เคสสอง',
      assigneeUserId: a.teammateId,
      interactionId: await newWork(),
    }),
  );
  await cases.changeStatus(agent, first.caseId, {
    commandId: randomUUID(),
    expectedVersion: 1,
    status: 'RESOLVED',
  });

  const all = (await cases.list(agent)).items;
  assert.deepEqual(
    all.map((item) => item.subject),
    ['เคสแรก', 'เคสสอง'],
  );
  assert.equal(all[0]?.linkedWorkCount, 1);
  const ids = async (filter: Parameters<typeof cases.list>[1]) =>
    (await cases.list(agent, filter)).items.map((item) => item.id);
  assert.deepEqual(await ids({ status: 'OPEN' }), [second.caseId]);
  assert.deepEqual(await ids({ assignedToMe: true }), [first.caseId]);

  await cases.changeStatus(agent, first.caseId, {
    commandId: randomUUID(),
    expectedVersion: 2,
    status: 'CLOSED',
  });
  assert.deepEqual(await ids({ status: 'NOT_CLOSED' }), [second.caseId]);
  assert.deepEqual(await ids({ status: 'CLOSED' }), [first.caseId]);
});

test('แบ่งหน้าด้วย cursor ได้ครบทุกเคสโดยไม่ซ้ำ', async (t) => {
  const { cases, a, newWork } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };
  const opened = [];
  for (let index = 0; index < 5; index += 1) {
    opened.push(
      (
        await cases.open(
          agent,
          openBody(a, { subject: `เคส ${index}`, interactionId: await newWork() }),
        )
      ).caseId,
    );
  }

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
    const page = await cases.list(agent, { limit: 2, ...(cursor ? { cursor } : {}) });
    seen.push(...page.items.map((item) => item.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 5);
  assert.deepEqual([...seen].sort(), [...opened].sort());
});

test('งานหนึ่งเปิดเคสได้ใบเดียวตาม ADR-016 แต่ส่งคำสั่งเดิมซ้ำยังได้ผลเดิม', async (t) => {
  const { owner, cases, a } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };
  const body = openBody(a);
  const first = await cases.open(agent, body);
  assert.deepEqual(await cases.open(agent, body), first);
  await rejects(cases.open(agent, openBody(a, { subject: 'อีกเรื่อง' })), 'WORK_HAS_CASE');
  assert.equal(await owner.csCase.count({ where: { tenantId: a.tenantId } }), 1);
});

test('สองคำสั่งพร้อมกันบน version เดียวกัน: สำเร็จหนึ่ง อีกคำสั่งได้ VERSION_CONFLICT', async (t) => {
  const { cases, a } = await setup(t);
  const agent = { tenantId: a.tenantId, userId: a.agentId };
  const teammate = { tenantId: a.tenantId, userId: a.teammateId };
  const opened = await cases.open(agent, openBody(a));
  const results = await Promise.allSettled([
    cases.addNote(agent, opened.caseId, { commandId: randomUUID(), expectedVersion: 1, note: 'ก' }),
    cases.changeStatus(teammate, opened.caseId, {
      commandId: randomUUID(),
      expectedVersion: 1,
      status: 'RESOLVED',
    }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected');
  assert.ok(failed?.status === 'rejected' && failed.reason instanceof AgentCaseError);
  assert.equal(failed.reason.code, 'VERSION_CONFLICT');
  assert.equal((await cases.detail(agent, opened.caseId)).version, 2);
});
