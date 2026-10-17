import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { Prisma, PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { AgentWorkspaceController, AGENT_WORKSPACE_DATABASE } from './agent-workspace-api.js';
import { AGENT_SIP_CREDENTIALS, type AgentSipCredentialService } from './agent-sip-credentials.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';

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

function claims(tenantId: string, userId: string): VerifiedOidcClaims {
  const tenantSlug = `tenant-${tenantId}`;
  return {
    tenant_id: tenantId,
    tenant_slug: tenantSlug,
    organization: { [tenantSlug]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: ['agent'] },
  };
}

test('Agent snapshot ใช้ tenant/user จาก token และคืน authoritative Interaction version', async (t) => {
  const applicationRole = await application.$queryRaw<
    { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  assert.deepEqual(applicationRole, [
    { rolname: 'dcontact_app', rolsuper: false, rolbypassrls: false },
  ]);
  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  const agentAId = randomUUID();
  const otherAgentAId = randomUUID();
  const agentBId = randomUUID();
  const queueAId = randomUUID();
  const queueBId = randomUUID();
  const interactionAId = randomUUID();
  const interactionBId = randomUUID();

  await owner.tenant.createMany({
    data: [
      {
        id: tenantAId,
        name: `Agent tenant A ${tenantAId}`,
        slug: `agent-a-${tenantAId}`,
        sipDomain: `${tenantAId}.agent.test`,
      },
      {
        id: tenantBId,
        name: `Agent tenant B ${tenantBId}`,
        slug: `agent-b-${tenantBId}`,
        sipDomain: `${tenantBId}.agent.test`,
      },
    ],
  });
  await owner.user.createMany({
    data: [
      {
        id: agentAId,
        tenantId: tenantAId,
        email: `agent-a-${tenantAId}@test.local`,
        passwordHash: 'test',
        displayName: 'Agent A',
        role: 'AGENT',
        extension: '5200',
      },
      {
        id: agentBId,
        tenantId: tenantBId,
        email: `agent-b-${tenantBId}@test.local`,
        passwordHash: 'test',
        displayName: 'Agent B',
        role: 'AGENT',
        extension: '6200',
      },
    ],
  });
  await owner.queue.createMany({
    data: [
      { id: queueAId, tenantId: tenantAId, name: 'บริการลูกค้า A', channels: ['VOICE'] },
      { id: queueBId, tenantId: tenantBId, name: 'บริการลูกค้า B', channels: ['VOICE'] },
    ],
  });
  await owner.user.create({
    data: {
      id: otherAgentAId,
      tenantId: tenantAId,
      email: `other-${otherAgentAId}@test.local`,
      passwordHash: 'test',
      displayName: 'Other Agent',
      role: 'AGENT',
    },
  });
  await owner.agentStateLog.createMany({
    data: [
      { tenantId: tenantAId, userId: agentAId, state: 'RESERVED' },
      { tenantId: tenantBId, userId: agentBId, state: 'BUSY' },
    ],
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id, agent_id, external_id, metadata, offer_expires_at)
      VALUES
      (
        ${interactionAId}::uuid,
        ${tenantAId}::uuid,
        'VOICE',
        'INBOUND',
        'ASSIGNED',
        ${queueAId}::uuid,
        ${agentAId}::uuid,
        ${`agent-a-${interactionAId}`},
        ${JSON.stringify({ caller: '0812345678', telephonyNodeId: 'fs-a' })}::jsonb,
        ${new Date('2026-09-06T10:00:20.000Z')}
      ),
      (
        ${interactionBId}::uuid,
        ${tenantBId}::uuid,
        'VOICE',
        'INBOUND',
        'ACTIVE',
        ${queueBId}::uuid,
        ${agentBId}::uuid,
        ${`agent-b-${interactionBId}`},
        ${JSON.stringify({ caller: '0899999999', telephonyNodeId: 'fs-b' })}::jsonb,
        NULL
      )`,
  );
  const interactionVersion = await owner.interactionEvent.create({
    data: {
      tenantId: tenantAId,
      interactionId: interactionAId,
      type: 'interaction.assigned',
      payload: { agentId: agentAId },
    },
  });

  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'agent-a-token') return claims(tenantAId, agentAId);
      if (token === 'agent-b-token') return claims(tenantBId, agentBId);
      if (token === 'other-agent-a-token') return claims(tenantAId, otherAgentAId);
      throw new Error('invalid token');
    },
  };
  const leaseRequests: Parameters<AgentSipCredentialService['issue']>[0][] = [];
  const sipLeaseId = randomUUID();
  const leaseProvider: AgentSipCredentialService = {
    issue: async (input) => {
      leaseRequests.push(input);
      return {
        leaseId: input.workSessionLeaseId,
        extension: '5200',
        authorizationUsername: '5200',
        authorizationPassword: 'one-time-sip-secret',
        sipDomain: `${tenantAId}.agent.test`,
        wssUrl: 'wss://fs-b.voice.test:7443',
        telephonyNodeId: 'fs-b',
        iceServers: [{ urls: ['turn:turn.voice.test:3478'] }],
        expiresAt: '2026-09-06T10:15:00.000Z',
      };
    },
    authenticateDirectoryRequest: () => 'fs-b',
    directory: async () => null,
  };

  @Module({
    controllers: [AgentWorkspaceController],
    providers: [
      { provide: AGENT_WORKSPACE_DATABASE, useValue: application },
      { provide: AGENT_SIP_CREDENTIALS, useValue: leaseProvider },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: ['error'] });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    for (const tenantId of [tenantAId, tenantBId]) {
      await owner.commandReceipt.deleteMany({ where: { tenantId } });
      await owner.$executeRaw`DELETE FROM interaction_wrapup_results WHERE tenant_id = ${tenantId}::uuid`;
      await owner.interactionEvent.deleteMany({ where: { tenantId } });
      await owner.interaction.deleteMany({ where: { tenantId } });
      await owner.agentStateLog.deleteMany({ where: { tenantId } });
      await owner.queue.deleteMany({ where: { tenantId } });
      await owner.user.deleteMany({ where: { tenantId } });
      await owner.tenant.delete({ where: { id: tenantId } });
    }
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const address = app.getHttpServer().address() as AddressInfo;
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/workspace/agent/snapshot?tenantId=${tenantBId}&userId=${agentBId}`,
    { headers: { authorization: 'Bearer agent-a-token' } },
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    capabilities: { voiceWrapupV1: 1 },
    agent: {
      id: agentAId,
      displayName: 'Agent A',
      extension: '5200',
      state: 'RESERVED',
    },
    interaction: {
      id: interactionAId,
      state: 'ASSIGNED',
      direction: 'INBOUND',
      voiceWrapupPolicy: 'LEGACY',
      version: interactionVersion.id.toString(),
      caller: '0812345678',
      queue: { id: queueAId, name: 'บริการลูกค้า A' },
      offerExpiresAt: '2026-09-06T10:00:20.000Z',
      answeredAt: null,
      endedAt: null,
    },
  });

  await owner.$executeRaw(
    Prisma.sql`UPDATE interactions SET state = 'WRAPUP', ended_at = ${new Date('2026-09-06T10:01:00.000Z')} WHERE id = ${interactionAId}::uuid`,
  );
  const unsupportedNote = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/workspace/agent/interactions/${interactionAId}/wrapup`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer agent-a-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        disposition: 'CUSTOMER_ASSISTED',
        commandId: randomUUID(),
        note: 'must not be silently discarded',
      }),
    },
  );
  assert.equal(unsupportedNote.status, 400);
  assert.equal(((await unsupportedNote.json()) as { code: string }).code, 'VALIDATION_FAILED');

  const wrapup = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/workspace/agent/interactions/${interactionAId}/wrapup`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer agent-a-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        disposition: 'CUSTOMER_ASSISTED',
        commandId: '04e5b24d-f298-4e5e-83d9-2cadfd7ed204',
      }),
    },
  );
  assert.equal(wrapup.status, 201);
  assert.deepEqual(await wrapup.json(), {
    interactionId: interactionAId,
    state: 'COMPLETED',
    disposition: 'CUSTOMER_ASSISTED',
  });
  const repeatedWrapup = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/workspace/agent/interactions/${interactionAId}/wrapup`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer agent-a-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        disposition: 'CUSTOMER_ASSISTED',
        commandId: '04e5b24d-f298-4e5e-83d9-2cadfd7ed204',
      }),
    },
  );
  assert.equal(repeatedWrapup.status, 201);
  assert.deepEqual(await repeatedWrapup.json(), {
    interactionId: interactionAId,
    state: 'COMPLETED',
    disposition: 'CUSTOMER_ASSISTED',
  });

  await owner.$executeRaw`UPDATE queues SET voice_wrapup_policy = 'VOICE_NOTE_V1' WHERE id = ${queueAId}::uuid`;
  const noteInteractionId = randomUUID();
  await owner.interaction.create({
    data: {
      id: noteInteractionId,
      tenantId: tenantAId,
      agentId: agentAId,
      queueId: queueAId,
      channel: 'VOICE',
      direction: 'INBOUND',
      state: 'WRAPUP',
    },
  });
  const noteCommandId = randomUUID();
  const noteUrl = `http://127.0.0.1:${address.port}/api/v1/workspace/agent/interactions/${noteInteractionId}`;
  const noteHeaders = { authorization: 'Bearer agent-a-token', 'content-type': 'application/json' };
  const noteInput = {
    commandId: noteCommandId,
    disposition: 'CUSTOMER_ASSISTED',
    note: '  สรุป 😀\r\nบรรทัดที่สอง  ',
  };
  const submitNote = (input = noteInput) =>
    fetch(`${noteUrl}/wrapup-v1`, {
      method: 'POST',
      headers: noteHeaders,
      body: JSON.stringify(input),
    });
  for (const note of ['', '  \r\n ', 'x'.repeat(2001), '\u0000', '\ud800']) {
    const invalidNote = await submitNote({ ...noteInput, note });
    assert.equal(invalidNote.status, 400);
    assert.equal(invalidNote.headers.get('cache-control'), 'no-store');
    const invalidBody = (await invalidNote.json()) as { field: string; correlationId: string };
    assert.equal(invalidBody.field, 'note');
    assert.equal(invalidBody.correlationId, invalidNote.headers.get('x-correlation-id'));
  }
  const legacyBypass = await fetch(`${noteUrl}/wrapup`, {
    method: 'POST',
    headers: noteHeaders,
    body: JSON.stringify({ commandId: randomUUID(), disposition: 'CUSTOMER_ASSISTED' }),
  });
  assert.equal(legacyBypass.status, 409);
  assert.equal(((await legacyBypass.json()) as { code: string }).code, 'WRAPUP_V1_REQUIRED');
  await assert.rejects(
    owner.interaction.update({
      where: { id: noteInteractionId },
      data: { state: 'COMPLETED', wrapUpCode: 'CUSTOMER_ASSISTED' },
    }),
    /WRAPUP_V1_REQUIRED/,
  );
  await application
    .$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;
      const affected =
        await transaction.$executeRaw`UPDATE interactions SET state = 'COMPLETED', wrap_up_code = 'CUSTOMER_ASSISTED' WHERE id = ${noteInteractionId}::uuid`;
      assert.equal(affected, 1);
      assert.equal(
        (await transaction.interaction.findUniqueOrThrow({ where: { id: noteInteractionId } }))
          .voiceWrapupPolicy,
        'VOICE_NOTE_V1',
      );
    })
    .catch((error: unknown) => assert.match(String(error), /WRAPUP_V1_REQUIRED/));
  assert.equal(
    (await owner.interaction.findUniqueOrThrow({ where: { id: noteInteractionId } })).state,
    'WRAPUP',
  );
  assert.equal(
    await owner.interactionWrapupResult.count({ where: { interactionId: noteInteractionId } }),
    0,
  );
  await assert.rejects(
    owner.interaction.update({
      where: { id: noteInteractionId },
      data: { voiceWrapupPolicy: 'LEGACY' },
    }),
    /WRAPUP_POLICY_IMMUTABLE/,
  );
  const [savedNote, initialReplay] = await Promise.all([submitNote(), submitNote()]);
  assert.equal(savedNote.status, 200, await savedNote.clone().text());
  assert.equal(savedNote.headers.get('cache-control'), 'no-store');
  const savedResult = (await savedNote.json()) as { recordedAt: string };
  assert.deepEqual(savedResult, {
    interactionId: noteInteractionId,
    policyVersion: 1,
    state: 'COMPLETED',
    disposition: 'CUSTOMER_ASSISTED',
    note: 'สรุป 😀\nบรรทัดที่สอง',
    recordedAt: savedResult.recordedAt,
    legacy: false,
  });
  assert.ok(Number.isFinite(Date.parse(savedResult.recordedAt)));
  assert.equal(initialReplay.status, 200);
  assert.deepEqual(await initialReplay.json(), savedResult);
  const replayNote = await submitNote();
  assert.equal(replayNote.status, 200);
  assert.deepEqual(await replayNote.json(), savedResult);
  const concurrentReplays = await Promise.all([submitNote(), submitNote(), submitNote()]);
  for (const response of concurrentReplays) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), savedResult);
  }
  const changedNote = await submitNote({ ...noteInput, note: 'different intent' });
  assert.equal(changedNote.status, 409);
  assert.equal(((await changedNote.json()) as { code: string }).code, 'COMMAND_PAYLOAD_MISMATCH');
  const readNote = await fetch(`${noteUrl}/wrapup-result`, { headers: noteHeaders });
  assert.equal(readNote.status, 200);
  assert.deepEqual(await readNote.json(), savedResult);
  const commandStatus = await fetch(`${noteUrl}/wrapup-commands/${noteCommandId}`, {
    headers: noteHeaders,
  });
  assert.equal(commandStatus.status, 200);
  const statusResult = (await commandStatus.json()) as { status: string };
  assert.equal(statusResult.status, 'COMMITTED');
  assert.equal(JSON.stringify(statusResult).includes('สรุป'), false);
  const otherTenantRead = await fetch(`${noteUrl}/wrapup-result`, {
    headers: { authorization: 'Bearer agent-b-token' },
  });
  assert.equal(otherTenantRead.status, 404);
  const otherOwnerRead = await fetch(`${noteUrl}/wrapup-result`, {
    headers: { authorization: 'Bearer other-agent-a-token' },
  });
  assert.equal(otherOwnerRead.status, 404);
  const otherOwnerCommand = await fetch(`${noteUrl}/wrapup-commands/${noteCommandId}`, {
    headers: { authorization: 'Bearer other-agent-a-token' },
  });
  assert.equal(otherOwnerCommand.status, 404);
  const legacyDetail = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/workspace/agent/interactions/${interactionAId}/wrapup-result`,
    { headers: noteHeaders },
  );
  assert.equal(legacyDetail.status, 200);
  const legacyResult = (await legacyDetail.json()) as {
    note: unknown;
    legacy: boolean;
    recordedAtSource: string;
  };
  assert.equal(legacyResult.note, null);
  assert.equal(legacyResult.legacy, true);
  assert.equal(legacyResult.recordedAtSource, 'LEGACY_EVENT');
  assert.equal(
    await owner.interactionEvent.count({
      where: { interactionId: noteInteractionId, type: 'interaction.wrapup_completed' },
    }),
    1,
  );
  for (const role of ['SUPERVISOR', 'ADMIN'] as const) {
    await owner.user.update({ where: { id: agentAId }, data: { role } });
    assert.equal((await fetch(`${noteUrl}/wrapup-result`, { headers: noteHeaders })).status, 403);
  }
  await owner.user.update({ where: { id: agentAId }, data: { role: 'AGENT' } });
  await owner.user.update({ where: { id: agentAId }, data: { isActive: false } });
  assert.equal((await fetch(`${noteUrl}/wrapup-result`, { headers: noteHeaders })).status, 403);
  await owner.user.update({ where: { id: agentAId }, data: { isActive: true } });
  const receiptWithoutNote = await owner.commandReceipt.findFirstOrThrow({
    where: { commandId: noteCommandId },
  });
  assert.equal(JSON.stringify(receiptWithoutNote.result).includes('สรุป'), false);
  assert.ok(receiptWithoutNote.payloadDigest);
  const resultWithoutTenant = await application.interactionWrapupResult.findMany();
  assert.equal(resultWithoutTenant.length, 0);
  await assert.rejects(
    application.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;
      await transaction.$executeRaw`UPDATE interaction_wrapup_results SET note = 'overwrite' WHERE interaction_id = ${noteInteractionId}::uuid`;
    }),
    /permission denied/,
  );
  const createNoteInteraction = () =>
    owner.interaction.create({
      data: {
        tenantId: tenantAId,
        agentId: agentAId,
        queueId: queueAId,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'WRAPUP',
      },
    });
  for (const note of ['😀', '😀'.repeat(2000)]) {
    const boundaryInteraction = await createNoteInteraction();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/workspace/agent/interactions/${boundaryInteraction.id}/wrapup-v1`,
      {
        method: 'POST',
        headers: noteHeaders,
        body: JSON.stringify({ disposition: 'CUSTOMER_ASSISTED', commandId: randomUUID(), note }),
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(((await response.json()) as { note: string }).note, note);
  }
  const freshNoteInteraction = await createNoteInteraction();
  const competingUrl = `http://127.0.0.1:${address.port}/api/v1/workspace/agent/interactions/${freshNoteInteraction.id}/wrapup-v1`;
  const competingResponses = await Promise.all(
    ['first', 'second'].map((note) =>
      fetch(competingUrl, {
        method: 'POST',
        headers: noteHeaders,
        body: JSON.stringify({ disposition: 'FOLLOW_UP_REQUIRED', commandId: randomUUID(), note }),
      }),
    ),
  );
  assert.deepEqual(competingResponses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(
    await owner.commandReceipt.count({ where: { resourceId: freshNoteInteraction.id } }),
    1,
  );
  assert.equal(
    await owner.interactionEvent.count({ where: { interactionId: freshNoteInteraction.id } }),
    1,
  );

  for (const table of [
    'interaction_wrapup_results',
    'interaction_events',
    'agent_state_logs',
    'command_receipts',
  ]) {
    const rollbackInteraction = await createNoteInteraction();
    const stateLogCount = await owner.agentStateLog.count({ where: { tenantId: tenantAId } });
    await owner.$executeRawUnsafe(
      `CREATE FUNCTION v700_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = '${tenantAId}'::uuid THEN RAISE EXCEPTION 'WRAPUP_TEST_FAILURE'; END IF; RETURN NEW; END $$`,
    );
    await owner.$executeRawUnsafe(
      `CREATE TRIGGER v700_fail_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION v700_fail_write()`,
    );
    try {
      const failedSave = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/workspace/agent/interactions/${rollbackInteraction.id}/wrapup-v1`,
        {
          method: 'POST',
          headers: noteHeaders,
          body: JSON.stringify({
            disposition: 'CUSTOMER_ASSISTED',
            commandId: randomUUID(),
            note: 'private rollback note',
          }),
        },
      );
      assert.equal(failedSave.status, 500);
      assert.equal((await failedSave.text()).includes('private rollback note'), false);
      assert.equal(
        (await owner.interaction.findUniqueOrThrow({ where: { id: rollbackInteraction.id } }))
          .state,
        'WRAPUP',
      );
      assert.equal(
        await owner.interactionWrapupResult.count({
          where: { interactionId: rollbackInteraction.id },
        }),
        0,
      );
      assert.equal(
        await owner.interactionEvent.count({ where: { interactionId: rollbackInteraction.id } }),
        0,
      );
      assert.equal(
        await owner.commandReceipt.count({ where: { resourceId: rollbackInteraction.id } }),
        0,
      );
      assert.equal(
        await owner.agentStateLog.count({ where: { tenantId: tenantAId } }),
        stateLogCount,
      );
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER v700_fail_write ON ${table}`);
      await owner.$executeRawUnsafe('DROP FUNCTION v700_fail_write()');
    }
  }

  const credentialsResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/workspace/agent/sip-credentials?tenantId=${tenantBId}&telephonyNodeId=fs-a`,
    {
      headers: {
        authorization: 'Bearer agent-a-token',
        'x-work-session-lease-id': sipLeaseId,
      },
    },
  );
  assert.equal(credentialsResponse.status, 200, await credentialsResponse.clone().text());
  assert.deepEqual(await credentialsResponse.json(), {
    leaseId: sipLeaseId,
    extension: '5200',
    authorizationUsername: '5200',
    authorizationPassword: 'one-time-sip-secret',
    sipDomain: `${tenantAId}.agent.test`,
    wssUrl: 'wss://fs-b.voice.test:7443',
    telephonyNodeId: 'fs-b',
    iceServers: [{ urls: ['turn:turn.voice.test:3478'] }],
    expiresAt: '2026-09-06T10:15:00.000Z',
  });
  assert.deepEqual(leaseRequests, [
    {
      tenantId: tenantAId,
      userId: agentAId,
      workSessionLeaseId: sipLeaseId,
    },
  ]);
});
