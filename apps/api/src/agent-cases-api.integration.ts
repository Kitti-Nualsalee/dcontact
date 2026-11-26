/**
 * #956 — the Agent cases controller on a separate database (e.g. dcontact_956) with an application role that does not bypass RLS
 * set DATABASE_URL (owner) and APPLICATION_DATABASE_URL before running; never run on the shared dcontact database
 *
 * customer authorization by a real segment scope is tested in customer-360 already; here we test that the controller
 * fills in the customer name only when the permission checker says it is visible, and a real checker without a grant must not see it (fail closed)
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
      user(agentId, 'Somying Jaidee', teamId),
      user(teammateId, 'Pakorn Srisuk', teamId),
      user(outsiderId, 'Other team member', otherTeamId),
    ],
  });
  await owner.contact.create({
    data: { id: contactId, tenantId, displayName: 'Khun Pa Chanpen', company: 'Siam Retail' },
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

test('open a case via HTTP and the detail has the person names, team name and customer when the team can see the customer', async (t) => {
  const f = await setup(t);
  const api = f.controller(allowAll);
  const opened = await api.open(f.request(f.agentId), {
    commandId: randomUUID(),
    interactionId: f.workId,
    subject: 'Machine X200 is broken',
    note: 'Waiting for warehouse confirmation',
    assigneeUserId: f.teammateId,
  });

  const detail = await api.detail(f.request(f.agentId), opened.caseId);
  assert.equal(detail.teamName, 'Retail Support');
  assert.deepEqual(detail.customer, { displayName: 'Khun Pa Chanpen', company: 'Siam Retail' });
  assert.equal(detail.case.contactDisplayName, 'Khun Pa Chanpen');
  assert.equal(detail.people[f.agentId], 'Somying Jaidee');
  assert.equal(detail.people[f.teammateId], 'Pakorn Srisuk');

  const page = await api.list(f.request(f.teammateId), undefined, '1', undefined, undefined);
  assert.deepEqual(
    page.items.map((item) => [item.id, item.contactDisplayName]),
    [[opened.caseId, 'Khun Pa Chanpen']],
  );
  assert.equal(page.people[f.teammateId], 'Pakorn Srisuk');
  assert.equal(page.nextCursor, null);
});

test('a team that cannot see the customer: no name or company is sent out, but the case can still be opened', async (t) => {
  const f = await setup(t);
  const opened = await f.controller(allowAll).open(f.request(f.agentId), {
    commandId: randomUUID(),
    interactionId: f.workId,
    subject: 'Refund follow-up',
    note: 'Note',
  });
  const api = f.controller(denyAll);
  const detail = await api.detail(f.request(f.agentId), opened.caseId);
  assert.equal(detail.customer, null);
  assert.equal('contactDisplayName' in detail.case, false);
  const page = await api.list(f.request(f.agentId), undefined, undefined, undefined, undefined);
  assert.equal('contactDisplayName' in page.items[0]!, false);
  assert.ok(!JSON.stringify({ detail, page }).includes('Chanpen'));
});

test('the real Customer 360 permission checker without a segment grant must not see the customer (fail closed)', async (t) => {
  const f = await setup(t);
  const opened = await f.controller(allowAll).open(f.request(f.agentId), {
    commandId: randomUUID(),
    interactionId: f.workId,
    subject: 'Refund follow-up',
    note: 'Note',
  });
  const detail = await f.controller().detail(f.request(f.agentId), opened.caseId);
  assert.equal(detail.customer, null);
});

test('Cases errors become an HTTP status with a code and correlationId', async (t) => {
  const f = await setup(t);
  const api = f.controller(denyAll);
  const opened = await api.open(f.request(f.agentId), {
    commandId: randomUUID(),
    interactionId: f.workId,
    subject: 'Test matter',
    note: 'Note',
  });

  await httpError(api.detail(f.request(f.outsiderId), opened.caseId), 404, 'CASE_NOT_FOUND');
  await httpError(
    api.addNote(f.request(f.agentId), opened.caseId, {
      commandId: randomUUID(),
      expectedVersion: 9,
      note: 'Nested',
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
    note: 'Called to follow up',
  });
  assert.equal(noted.version, 2);
  assert.deepEqual(
    (await api.teamAgents(f.request(f.agentId))).items.map((item) => item.displayName).sort(),
    ['Pakorn Srisuk', 'Somying Jaidee'].sort(),
  );
});

test('the customer permission check fails (e.g. a DB error): the case still opens and there is no customer data in the response', async (t) => {
  const f = await setup(t);
  const opened = await f.controller(allowAll).open(f.request(f.agentId), {
    commandId: randomUUID(),
    interactionId: f.workId,
    subject: 'Refund follow-up',
    note: 'Note',
  });
  const failing: CaseCustomerAccess = async () => {
    throw new Error('statement timeout');
  };
  const api = f.controller(failing);
  const detail = await api.detail(f.request(f.agentId), opened.caseId);
  assert.equal(detail.customer, null);
  assert.equal(detail.case.activities.length, 3);
  const page = await api.list(f.request(f.agentId), undefined, undefined, undefined, undefined);
  assert.equal(page.items.length, 1);
  assert.equal('contactDisplayName' in page.items[0]!, false);
});
