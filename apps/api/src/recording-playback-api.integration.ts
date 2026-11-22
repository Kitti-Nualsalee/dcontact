/** #967: HTTP → PostgreSQL ด้วย application role ที่ไม่ bypass RLS; storage เป็น in-memory ที่เก็บ WAV จริง */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { Prisma, PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import {
  RecordingController,
  RECORDING_DATABASE,
  RECORDING_STORAGE,
  RECORDING_SUPERVISOR_PLAYBACK,
  TELEPHONY_COMMAND_PUBLISHER,
} from './recording-api.js';
import {
  RECORDING_PLAYBACK_STORAGE,
  RecordingPlaybackController,
} from './recording-playback-api.js';
import { parseWavHeader, wavChunk } from './recording-wav.js';

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
test.after(() => Promise.all([owner.$disconnect(), application.$disconnect()]));

const RATE = 8000;
const SECONDS = 5;

/** stereo 5 วินาที: ค่าของแต่ละ sample บอกตำแหน่ง frame เพื่อพิสูจน์ว่าได้ช่วงที่ขอจริง */
function sourceWav(): Buffer {
  const pcm = Buffer.alloc(RATE * SECONDS * 4);
  for (let frame = 0; frame < RATE * SECONDS; frame++) {
    pcm.writeInt16LE(frame % 30000, frame * 4);
    pcm.writeInt16LE(-(frame % 30000), frame * 4 + 2);
  }
  return wavChunk({ sampleRate: RATE, channels: 2 }, pcm);
}

type Role = 'agent' | 'supervisor' | 'admin';

async function fixture(t: TestContext, enabled: boolean) {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const ids = {
    teamA: randomUUID(),
    teamB: randomUUID(),
    supervisorA: randomUUID(),
    secondSupervisorA: randomUUID(),
    supervisorB: randomUUID(),
    agentA: randomUUID(),
    agentB: randomUUID(),
    admin: randomUUID(),
    queue: randomUUID(),
    foreignSupervisor: randomUUID(),
    foreignTeam: randomUUID(),
  };
  const objects = new Map<string, Buffer>();
  const tokens = new Map<string, VerifiedOidcClaims>();
  const token = (tenant: string, userId: string, role: Role) => {
    const value = `token-${randomUUID()}`;
    tokens.set(value, {
      tenant_id: tenant,
      tenant_slug: `tenant-${tenant}`,
      organization: { [`tenant-${tenant}`]: { tenant_id: [tenant] } },
      dc_user_id: userId,
      sid: `session-${userId}`,
      exp: 2_000_000_000,
      realm_access: { roles: [role] },
    });
    return value;
  };

  for (const [id, label] of [
    [tenantId, 'home'],
    [foreignTenantId, 'foreign'],
  ] as const) {
    await owner.tenant.create({
      data: {
        id,
        name: `Playback ${label} ${id}`,
        slug: `playback-${id}`,
        sipDomain: `${id}.test`,
      },
    });
  }
  await owner.team.createMany({
    data: [
      { id: ids.teamA, tenantId, name: 'Team A' },
      { id: ids.teamB, tenantId, name: 'Team B' },
      { id: ids.foreignTeam, tenantId: foreignTenantId, name: 'Team A' },
    ],
  });
  const user = (
    id: string,
    tenant: string,
    role: 'AGENT' | 'SUPERVISOR' | 'ADMIN',
    teamId: string | null,
    displayName: string,
  ) => ({
    id,
    tenantId: tenant,
    email: `${id}@test.local`,
    passwordHash: 'test',
    displayName,
    role,
    teamId,
  });
  await owner.user.createMany({
    data: [
      user(ids.supervisorA, tenantId, 'SUPERVISOR', ids.teamA, 'Supervisor A'),
      user(ids.secondSupervisorA, tenantId, 'SUPERVISOR', ids.teamA, 'Supervisor A2'),
      user(ids.supervisorB, tenantId, 'SUPERVISOR', ids.teamB, 'Supervisor B'),
      user(ids.agentA, tenantId, 'AGENT', ids.teamA, 'Agent A'),
      user(ids.agentB, tenantId, 'AGENT', ids.teamB, 'Agent B'),
      user(ids.admin, tenantId, 'ADMIN', null, 'Admin'),
      user(ids.foreignSupervisor, foreignTenantId, 'SUPERVISOR', ids.foreignTeam, 'Foreign'),
    ],
  });
  await owner.queue.create({
    data: { id: ids.queue, tenantId, name: 'Support', channels: ['VOICE'], recordingEnabled: true },
  });

  /** สายที่จบแล้วพร้อมเสียง; `team` คือทีมที่ Router บันทึกตอนรับสาย (undefined = สายเก่าไม่มีหลักฐาน) */
  async function call(input: {
    agentId: string;
    team?: string;
    archived?: boolean;
    state?: 'COMPLETED' | 'WRAPUP';
    startedAt: string;
    bytes?: Buffer;
  }) {
    const interactionId = randomUUID();
    const recordingId = randomUUID();
    const storageKey = `recordings/${tenantId}/${interactionId}.wav`;
    await owner.$executeRaw(
      Prisma.sql`INSERT INTO interactions (id, tenant_id, channel, direction, state, queue_id, agent_id, external_id)
        VALUES (${interactionId}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND',
          ${input.state ?? 'COMPLETED'}::"InteractionStateType", ${ids.queue}::uuid,
          ${input.agentId}::uuid, ${`call-${interactionId}`})`,
    );
    if (input.team) {
      await owner.voiceInteractionHandlingAttribution.create({
        data: {
          tenantId,
          interactionId,
          agentId: input.agentId,
          teamId: input.team,
          acceptedAt: new Date(input.startedAt),
          sourceEventId: `test:${interactionId}`,
        },
      });
    }
    const startedAt = new Date(input.startedAt);
    await owner.recording.create({
      data: {
        id: recordingId,
        tenantId,
        interactionId,
        storageKey,
        telephonyPath: `/var/recordings/${tenantId}/${interactionId}.wav`,
        startedAt,
        endedAt: new Date(startedAt.getTime() + SECONDS * 1000),
        durationSec: SECONDS,
        archivedAt: input.archived === false ? null : new Date(startedAt.getTime() + 6000),
      },
    });
    if (input.archived !== false) objects.set(storageKey, input.bytes ?? sourceWav());
    return recordingId;
  }

  const hooks: { beforeRead?: () => Promise<void>; failRead?: boolean } = {};
  const reads: { start: number; endInclusive: number }[] = [];

  @Module({
    controllers: [RecordingPlaybackController, RecordingController],
    providers: [
      { provide: RECORDING_DATABASE, useValue: application },
      { provide: RECORDING_SUPERVISOR_PLAYBACK, useValue: enabled },
      {
        provide: RECORDING_PLAYBACK_STORAGE,
        useValue: {
          readRange: async (input: {
            tenantId: string;
            storageKey: string;
            start: number;
            endInclusive: number;
          }) => {
            await hooks.beforeRead?.();
            if (hooks.failRead) throw new Error('s3://internal-bucket/secret-path unreachable');
            assert.ok(input.storageKey.startsWith(`recordings/${input.tenantId}/`));
            const object = objects.get(input.storageKey);
            if (!object) throw new Error('missing object');
            reads.push({ start: input.start, endInclusive: input.endInclusive });
            return {
              bytes: object.subarray(input.start, input.endInclusive + 1),
              objectBytes: object.length,
            };
          },
        },
      },
      { provide: TELEPHONY_COMMAND_PUBLISHER, useValue: { publish: async () => undefined } },
      {
        provide: RECORDING_STORAGE,
        useValue: {
          presignPlayback: async () => ({
            url: 'https://storage.test/signed',
            expiresAt: new Date(Date.now() + 300_000),
          }),
          deleteObject: async () => undefined,
        },
      },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: {
          verifyAccessToken: async (value: string) => {
            const found = tokens.get(value);
            if (!found) throw new Error('invalid token');
            return found;
          },
        },
      },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    for (const tenant of [tenantId, foreignTenantId]) {
      await owner.recordingPlaybackSession.deleteMany({ where: { tenantId: tenant } });
      await owner.recordingAuditEvent.deleteMany({ where: { tenantId: tenant } });
      await owner.recording.deleteMany({ where: { tenantId: tenant } });
      await owner.interaction.deleteMany({ where: { tenantId: tenant } });
      await owner.queue.deleteMany({ where: { tenantId: tenant } });
      await owner.user.deleteMany({ where: { tenantId: tenant } });
      await owner.team.deleteMany({ where: { tenantId: tenant } });
      await owner.tenant.delete({ where: { id: tenant } });
    }
  });
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/recordings`;
  const http = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const isJson = response.headers.get('content-type')?.includes('json');
    return {
      status: response.status,
      headers: response.headers,
      bytes,
      json: (isJson && bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined) as
        Record<string, any> | undefined,
    };
  };
  return {
    tenantId,
    foreignTenantId,
    ids,
    call,
    hooks,
    reads,
    http,
    tokens: {
      supervisorA: token(tenantId, ids.supervisorA, 'supervisor'),
      secondSupervisorA: token(tenantId, ids.secondSupervisorA, 'supervisor'),
      supervisorB: token(tenantId, ids.supervisorB, 'supervisor'),
      agentA: token(tenantId, ids.agentA, 'agent'),
      admin: token(tenantId, ids.admin, 'admin'),
      foreignSupervisor: token(foreignTenantId, ids.foreignSupervisor, 'supervisor'),
    },
  };
}

const chunks = (recordingId: string, sessionId: string) =>
  `/${recordingId}/playback-sessions/${sessionId}/chunks`;

test('a supervisor lists and plays only recordings of calls their own team answered', async (t) => {
  const f = await fixture(t, true);
  const own = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    startedAt: '2026-11-20T03:00:00Z',
  });
  const pending = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    archived: false,
    startedAt: '2026-11-20T04:00:00Z',
  });
  const otherTeam = await f.call({
    agentId: f.ids.agentB,
    team: f.ids.teamB,
    startedAt: '2026-11-20T05:00:00Z',
  });
  // Agent อยู่ทีม A ตอนนี้ แต่ไม่มีหลักฐานว่าทีมไหนรับสาย จึงไม่เปิดให้ใคร
  const legacy = await f.call({ agentId: f.ids.agentA, startedAt: '2026-11-20T06:00:00Z' });
  const wrapUp = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    state: 'WRAPUP',
    startedAt: '2026-11-20T07:00:00Z',
  });
  const range = '?from=2026-11-01T00:00:00Z&to=2026-11-21T00:00:00Z';

  const history = await f.http(f.tokens.supervisorA, 'GET', `/history${range}`);
  assert.equal(history.status, 200);
  assert.equal(history.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    history.json!.items.map((item: { recordingId: string }) => item.recordingId),
    [pending, own],
  );
  assert.deepEqual(history.json!.items[1], {
    recordingId: own,
    interactionId: history.json!.items[1].interactionId,
    status: 'READY',
    startedAt: '2026-11-20T03:00:00.000Z',
    endedAt: '2026-11-20T03:00:05.000Z',
    durationSec: SECONDS,
    channelLayout: 'STEREO',
    queueName: 'Support',
    agentName: 'Agent A',
    capabilities: { play: true },
  });
  assert.deepEqual(history.json!.items[0].capabilities, { play: false });
  assert.equal(history.json!.nextCursor, null);
  assert.doesNotMatch(JSON.stringify(history.json), /storageKey|recordings\/|telephony/);

  const firstPage = await f.http(f.tokens.supervisorA, 'GET', `/history${range}&limit=1`);
  assert.deepEqual(
    firstPage.json!.items.map((item: any) => item.recordingId),
    [pending],
  );
  const secondPage = await f.http(
    f.tokens.supervisorA,
    'GET',
    `/history${range}&limit=1&cursor=${firstPage.json!.nextCursor}`,
  );
  assert.deepEqual(
    secondPage.json!.items.map((item: any) => item.recordingId),
    [own],
  );
  assert.equal(secondPage.json!.nextCursor, null);
  for (const bad of [
    '?from=2026-01-01T00:00:00Z&to=2026-11-21T00:00:00Z',
    `${range}&limit=101`,
    `${range}&cursor=x`,
  ]) {
    assert.equal((await f.http(f.tokens.supervisorA, 'GET', `/history${bad}`)).status, 400);
  }
  assert.deepEqual(
    (await f.http(f.tokens.supervisorB, 'GET', `/history${range}`)).json!.items.map(
      (item: any) => item.recordingId,
    ),
    [otherTeam],
  );
  assert.deepEqual(
    (await f.http(f.tokens.foreignSupervisor, 'GET', `/history${range}`)).json!.items,
    [],
  );

  assert.equal((await f.http(f.tokens.supervisorA, 'GET', `/${own}`)).json!.status, 'READY');
  for (const hidden of [otherTeam, legacy, wrapUp, randomUUID(), 'not-a-uuid']) {
    const detail = await f.http(f.tokens.supervisorA, 'GET', `/${hidden}`);
    assert.equal(detail.status, 404);
    assert.deepEqual(detail.json, { code: 'RESOURCE_NOT_FOUND' });
    assert.equal(
      (await f.http(f.tokens.supervisorA, 'POST', `/${hidden}/playback-sessions`)).status,
      404,
    );
  }
  for (const outsider of [f.tokens.supervisorB, f.tokens.foreignSupervisor]) {
    assert.equal((await f.http(outsider, 'GET', `/${own}`)).status, 404);
    assert.equal((await f.http(outsider, 'POST', `/${own}/playback-sessions`)).status, 404);
  }
  for (const role of [f.tokens.agentA, f.tokens.admin]) {
    assert.equal((await f.http(role, 'GET', `/history${range}`)).status, 403);
    assert.equal((await f.http(role, 'POST', `/${own}/playback-sessions`)).status, 403);
  }
  const notReady = await f.http(f.tokens.supervisorA, 'POST', `/${pending}/playback-sessions`);
  assert.equal(notReady.status, 409);
  assert.deepEqual(notReady.json, { code: 'RECORDING_NOT_READY' });

  const session = await f.http(f.tokens.supervisorA, 'POST', `/${own}/playback-sessions`);
  assert.equal(session.status, 201);
  assert.deepEqual(session.json!.format, {
    sampleRate: RATE,
    channels: 2,
    bitsPerSample: 16,
    totalFrames: RATE * SECONDS,
    maxChunkFrames: RATE * 2,
  });
  assert.equal(session.json!.transport, 'API_CHUNKS');
  assert.doesNotMatch(JSON.stringify(session.json), /https?:|storageKey|signature/i);
  const path = chunks(own, session.json!.sessionId);

  const first = await f.http(f.tokens.supervisorA, 'POST', path, {
    startFrame: 100,
    frameCount: RATE * 2,
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'audio/wav');
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(parseWavHeader(first.bytes, first.bytes.length), {
    dataOffset: 44,
    sampleRate: RATE,
    channels: 2,
    totalFrames: RATE * 2,
  });
  assert.equal(first.bytes.readInt16LE(44), 100);
  assert.equal(first.bytes.readInt16LE(46), -100);
  assert.equal(first.bytes.readInt16LE(first.bytes.length - 4), 100 + RATE * 2 - 1);
  // storage ถูกอ่านเฉพาะช่วงที่ขอ ไม่เกิน 2 วินาที
  assert.deepEqual(f.reads.at(-1), { start: 44 + 400, endInclusive: 44 + 400 + RATE * 2 * 4 - 1 });

  const tail = await f.http(f.tokens.supervisorA, 'POST', path, {
    startFrame: RATE * SECONDS - 10,
    frameCount: RATE,
  });
  assert.equal(parseWavHeader(tail.bytes, tail.bytes.length).totalFrames, 10);
  for (const body of [
    { startFrame: 0, frameCount: RATE * 2 + 1 },
    { startFrame: RATE * SECONDS, frameCount: 1 },
    { startFrame: -1, frameCount: 1 },
    { startFrame: 0.5, frameCount: 1 },
    { startFrame: 0 },
    { startFrame: '0', frameCount: 1, storageKey: 'recordings/x' },
  ]) {
    assert.equal((await f.http(f.tokens.supervisorA, 'POST', path, body)).status, 400);
  }

  const audits = await owner.recordingAuditEvent.findMany({
    where: { tenantId: f.tenantId, recordingId: own },
    select: { action: true, actorUserId: true, details: true },
  });
  assert.deepEqual(audits, [
    {
      action: 'PLAYBACK_ACCESSED',
      actorUserId: f.ids.supervisorA,
      details: { transport: 'API_CHUNKS', sessionId: session.json!.sessionId },
    },
  ]);
  // route presign เดิมปิดเมื่อเปิดฟังผ่าน API ไม่เหลือทางออก URL
  const legacyRoute = await f.http(f.tokens.admin, 'POST', `/${own}/playback`, { download: false });
  assert.equal(legacyRoute.status, 403);
  assert.deepEqual(legacyRoute.json, { code: 'PLAYBACK_ACCESS_DENIED' });
});

test('every chunk rechecks the current team, account and session owner', async (t) => {
  const f = await fixture(t, true);
  const own = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    startedAt: '2026-11-20T03:00:00Z',
  });
  const open = async (bearer = f.tokens.supervisorA) =>
    (await f.http(bearer, 'POST', `/${own}/playback-sessions`)).json!.sessionId as string;
  const play = (sessionId: string, bearer = f.tokens.supervisorA) =>
    f.http(bearer, 'POST', chunks(own, sessionId), { startFrame: 0, frameCount: RATE });
  const supervisor = (data: Prisma.UserUncheckedUpdateInput) =>
    owner.user.update({ where: { id: f.ids.supervisorA }, data });

  let sessionId = await open();
  assert.equal((await play(sessionId)).status, 200);

  // ย้ายทีมระหว่างฟัง: chunk ถัดไปไม่ออก แม้ token และ session ยังไม่หมดอายุ
  await supervisor({ teamId: f.ids.teamB });
  const moved = await play(sessionId);
  assert.equal(moved.status, 404);
  assert.equal(moved.bytes.includes(Buffer.from('RIFF')), false);
  await supervisor({ teamId: f.ids.teamA });
  assert.equal((await play(sessionId)).status, 200);

  await supervisor({ isActive: false });
  assert.deepEqual((await play(sessionId)).json, { code: 'PLAYBACK_ACCESS_DENIED' });
  await supervisor({ isActive: true, role: 'AGENT' });
  assert.equal((await play(sessionId)).status, 403);
  await supervisor({ role: 'SUPERVISOR', teamId: null });
  assert.equal((await play(sessionId)).status, 403);
  await supervisor({ teamId: f.ids.teamA });

  // สิทธิ์ถูกถอนระหว่างที่ API อ่าน storage: byte ที่อ่านมาแล้วต้องไม่ถูกส่ง
  f.hooks.beforeRead = async () => {
    await supervisor({ teamId: f.ids.teamB });
  };
  const raced = await play(sessionId);
  assert.equal(raced.status, 404);
  assert.equal(raced.bytes.includes(Buffer.from('RIFF')), false);
  f.hooks.beforeRead = undefined;
  await supervisor({ teamId: f.ids.teamA });

  // session ไม่ใช่สิทธิ์ และใช้ข้ามผู้ใช้ในทีมเดียวกันไม่ได้
  assert.equal((await play(sessionId, f.tokens.secondSupervisorA)).status, 404);
  assert.equal((await play(sessionId, f.tokens.supervisorB)).status, 404);
  assert.equal((await play(randomUUID())).status, 404);

  // เปิดใหม่แล้ว session เดิมของผู้ใช้คนเดียวกันถูกปิด
  const replacement = await open();
  assert.deepEqual((await play(sessionId)).json, { code: 'PLAYBACK_SESSION_EXPIRED' });
  assert.equal((await play(replacement)).status, 200);
  const colleague = await open(f.tokens.secondSupervisorA);
  assert.equal((await play(replacement)).status, 200);
  assert.equal((await play(colleague, f.tokens.secondSupervisorA)).status, 200);

  await owner.recordingPlaybackSession.update({
    where: { id: replacement },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await play(replacement)).status, 409);

  sessionId = await open();
  const closePath = `/${own}/playback-sessions/${sessionId}/close`;
  // คนอื่นปิด session ของเราไม่ได้
  assert.equal((await f.http(f.tokens.secondSupervisorA, 'POST', closePath)).status, 204);
  assert.equal((await play(sessionId)).status, 200);
  assert.equal((await f.http(f.tokens.supervisorA, 'POST', closePath)).status, 204);
  assert.equal((await f.http(f.tokens.supervisorA, 'POST', closePath)).status, 204);
  assert.equal((await play(sessionId)).status, 409);

  // เสียงถูกลบตาม retention ระหว่างฟัง
  sessionId = await open();
  await owner.recording.update({ where: { id: own }, data: { deletedAt: new Date() } });
  assert.equal((await play(sessionId)).status, 404);
  await owner.recording.update({ where: { id: own }, data: { deletedAt: null } });

  f.hooks.failRead = true;
  const unavailable = await play(sessionId);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.json, { code: 'STORAGE_UNAVAILABLE' });
  f.hooks.failRead = false;

  const unsupported = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    startedAt: '2026-11-20T08:00:00Z',
    bytes: Buffer.from('ID3 this is an mp3, not a wav file'),
  });
  const rejected = await f.http(f.tokens.supervisorA, 'POST', `/${unsupported}/playback-sessions`);
  assert.equal(rejected.status, 422);
  assert.deepEqual(rejected.json, { code: 'RECORDING_FORMAT_UNSUPPORTED' });
});

test('with the switch off the new routes are denied and the existing playback route is unchanged', async (t) => {
  const f = await fixture(t, false);
  const own = await f.call({
    agentId: f.ids.agentA,
    team: f.ids.teamA,
    startedAt: '2026-11-20T03:00:00Z',
  });
  for (const [method, path] of [
    ['GET', '/history'],
    ['GET', `/${own}`],
    ['POST', `/${own}/playback-sessions`],
    ['POST', chunks(own, randomUUID())],
    ['POST', `/${own}/playback-sessions/${randomUUID()}/close`],
  ] as const) {
    const response = await f.http(f.tokens.supervisorA, method, path, {
      startFrame: 0,
      frameCount: 1,
    });
    assert.equal(response.status, 403, path);
    assert.deepEqual(response.json, { code: 'PLAYBACK_ACCESS_DENIED' });
  }
  assert.equal(f.reads.length, 0);
  const legacy = await f.http(f.tokens.admin, 'POST', `/${own}/playback`, { download: false });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.json!.url, 'https://storage.test/signed');
});
