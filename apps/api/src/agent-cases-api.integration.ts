/**
 * #956 — controller ของเคส Agent บนฐานแยก (เช่น dcontact_956) ด้วย application role ที่ไม่ bypass RLS
 * ตั้ง DATABASE_URL (owner) และ APPLICATION_DATABASE_URL ก่อนรัน ห้ามรันบนฐาน dcontact ร่วม
 *
 * การอนุญาตลูกค้าด้วย segment scope จริงทดสอบอยู่ใน customer-360 แล้ว ที่นี่ทดสอบว่า controller
 * เติมชื่อลูกค้าเฉพาะเมื่อตัวตรวจสิทธิ์ตอบว่าเห็นได้ และตัวตรวจจริงที่ไม่มี grant ต้องไม่เห็น (fail closed)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@d-contact/db';
import { AgentCasesController, type CaseCustomerAccess } from './agent-cases-api.js';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

async function setup(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const teamId = randomUUID();
  const otherTeamId = randomUUID();
  const agentId = randomUUID();
  const teammateId = randomUUID();
  const outsiderId = randomUUID();
  const contactId = randomUUID();
  const workId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `#956 api ${suffix}`,
      slug: `cases-api-956-${suffix}`,
      sipDomain: `${suffix}.cases-api-956.test`,
    },
  });
  await owner.team.createMany({
    data: [
      { id: teamId, tenantId, name: 'Retail Support' },
      { id: otherTeamId, tenantId, name: 'Sales' },
    ],
  });
  const user = (id: string, name: string, team: string) => ({
    id,
    tenantId,
    email: `${id.slice(0, 8)}@cases-api-956.test`,
    passwordHash: 'not-used',
    displayName: name,
    role: 'AGENT' as const,
    teamId: team,
  });
  await owner.user.createMany({
    data: [
      user(agentId, 'สมหญิง ใจดี', teamId),
      user(teammateId, 'ปกรณ์ ศรีสุข', teamId),
      user(outsiderId, 'คนทีมอื่น', otherTeamId),
    ],
  });
  await owner.contact.create({
    data: { id: contactId, tenantId, displayName: 'คุณภา จันทร์เพ็ญ', company: 'Siam Retail' },
  });
  await owner.interaction.create({
    data: {
      id: workId,
      tenantId,
      channel: 'VOICE',
      direction: 'INBOUND',
      state: 'ACTIVE',
      agentId,
      contactId,
    },
  });
  t.after(async () => {
    await owner.commandReceipt.deleteMany({ where: { tenantId } });
    await owner.csCaseActivity.deleteMany({ where: { tenantId } });
    await owner.csCase.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await owner.$disconnect();
    await application.$disconnect();
  });
  const request = (userId: string) =>
    ({
      gatewayIdentity: { tenantId, userId, roles: ['agent'] },
      correlationId: 'corr-956',
    }) as unknown as AuthenticatedGatewayRequest;
  const controller = (access?: CaseCustomerAccess) => new AgentCasesController(application, access);
  return { tenantId, agentId, teammateId, outsiderId, contactId, workId, request, controller };
}

const allowAll: CaseCustomerAccess = async () => true;
const denyAll: CaseCustomerAccess = async () => false;

async function httpError(work: Promise<unknown>, status: number, code: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof HttpException, String(error));
    assert.equal(error.getStatus(), status);
    assert.equal((error.getResponse() as { code?: string }).code, code);
    assert.equal((error.getResponse() as { correlationId?: string }).correlationId, 'corr-956');
    return true;
  });
}

test('เปิดเคสผ่าน HTTP แล้วรายละเอียดมีชื่อคน ชื่อทีม และลูกค้าเมื่อทีมเห็นลูกค้าได้', async (t) => {
  const f = await setup(t);
  const api = f.controller(allowAll);
  const opened = await api.open(f.request(f.agentId), {
    commandId: randomUUID(),
    interactionId: f.workId,
    subject: 'เครื่อง X200 ชำรุด',
    note: 'รอคลังยืนยัน',
    assigneeUserId: f.teammateId,
  });

  const detail = await api.detail(f.request(f.agentId), opened.caseId);
  assert.equal(detail.teamName, 'Retail Support');
  assert.deepEqual(detail.customer, { displayName: 'คุณภา จันทร์เพ็ญ', company: 'Siam Retail' });
  assert.equal(detail.case.contactDisplayName, 'คุณภา จันทร์เพ็ญ');
  assert.equal(detail.people[f.agentId], 'สมหญิง ใจดี');
  assert.equal(detail.people[f.teammateId], 'ปกรณ์ ศรีสุข');

  const page = await api.list(f.request(f.teammateId), undefined, '1', undefined, undefined);
  assert.deepEqual(
    page.items.map((item) => [item.id, item.contactDisplayName]),
    [[opened.caseId, 'คุณภา จันทร์เพ็ญ']],
  );
  assert.equal(page.people[f.teammateId], 'ปกรณ์ ศรีสุข');
  assert.equal(page.nextCursor, null);
});

test('ทีมไม่เห็นลูกค้า: ไม่ส่งชื่อหรือบริษัทออกไป แต่เคสยังเปิดดูได้', async (t) => {
  const f = await setup(t);
  const opened = await f.controller(allowAll).open(f.request(f.agentId), {
    commandId: randomUUID(),
    interactionId: f.workId,
    subject: 'ติดตามการคืนเงิน',
    note: 'โน้ต',
  });
  const api = f.controller(denyAll);
  const detail = await api.detail(f.request(f.agentId), opened.caseId);
  assert.equal(detail.customer, null);
  assert.equal('contactDisplayName' in detail.case, false);
  const page = await api.list(f.request(f.agentId), undefined, undefined, undefined, undefined);
  assert.equal('contactDisplayName' in page.items[0]!, false);
  assert.ok(!JSON.stringify({ detail, page }).includes('คุณภา'));
});

test('ตัวตรวจสิทธิ์จริงของ Customer 360 ที่ไม่มี segment grant ต้องไม่เห็นลูกค้า (fail closed)', async (t) => {
  const f = await setup(t);
  const opened = await f.controller(allowAll).open(f.request(f.agentId), {
    commandId: randomUUID(),
    interactionId: f.workId,
    subject: 'ติดตามการคืนเงิน',
    note: 'โน้ต',
  });
  const detail = await f.controller().detail(f.request(f.agentId), opened.caseId);
  assert.equal(detail.customer, null);
});

test('error ของ Cases กลายเป็น HTTP status พร้อม code และ correlationId', async (t) => {
  const f = await setup(t);
  const api = f.controller(denyAll);
  const opened = await api.open(f.request(f.agentId), {
    commandId: randomUUID(),
    interactionId: f.workId,
    subject: 'เรื่องทดสอบ',
    note: 'โน้ต',
  });

  await httpError(api.detail(f.request(f.outsiderId), opened.caseId), 404, 'CASE_NOT_FOUND');
  await httpError(
    api.addNote(f.request(f.agentId), opened.caseId, {
      commandId: randomUUID(),
      expectedVersion: 9,
      note: 'ซ้อน',
    }),
    409,
    'VERSION_CONFLICT',
  );
  await httpError(
    api.assign(f.request(f.agentId), opened.caseId, {
      commandId: randomUUID(),
      expectedVersion: 1,
      assigneeUserId: f.outsiderId,
    }),
    400,
    'ASSIGNEE_NOT_IN_TEAM',
  );
  await httpError(
    api.list(f.request(f.agentId), 'PENDING', undefined, undefined, undefined),
    400,
    'INVALID_INPUT',
  );
  await httpError(api.open(f.request(f.agentId), null), 400, 'INVALID_INPUT');
  await httpError(
    api.list(f.request(randomUUID()), undefined, undefined, undefined, undefined),
    403,
    'AGENT_REQUIRED',
  );

  const noted = await api.addNote(f.request(f.agentId), opened.caseId, {
    commandId: randomUUID(),
    expectedVersion: 1,
    note: 'โทรตามแล้ว',
  });
  assert.equal(noted.version, 2);
  assert.deepEqual(
    (await api.teamAgents(f.request(f.agentId))).items.map((item) => item.displayName).sort(),
    ['ปกรณ์ ศรีสุข', 'สมหญิง ใจดี'].sort(),
  );
});
