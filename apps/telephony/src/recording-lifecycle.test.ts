import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@d-contact/db';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';
import {
  TelephonyRecordingLifecycle,
  type RecordingArchive,
  type TelephonyRecordingLifecycleOptions,
} from './recording-lifecycle.js';

const tenantA = '7f6b4b3e-1d0f-4c38-9a8c-9d5b0c6e2a11';
const tenantB = '0c1f4a52-6f4b-4e0a-9c55-2f0f8d3b7e22';
const nodeId = 'fs-uat-solo';

interface FakeRecording {
  id: string;
  tenantId: string;
  storageKey: string;
  telephonyPath: string;
  endedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
  legalHold?: boolean;
}

/** Fakes only the part of Prisma that retryPendingArchives uses */
function fakeDatabase(recordings: FakeRecording[], failures: { findManyForTenant?: string } = {}) {
  const audits: Record<string, unknown>[] = [];
  const findManyCalls: { tenantId: string; excluded: string[] }[] = [];
  const transaction = {
    $executeRawUnsafe: async () => 0,
    recording: {
      // hangup: this call has a single recording in the fake
      findFirst: async ({ where }: { where: Record<string, any> }) => {
        const found = recordings.find((candidate) => candidate.tenantId === where.tenantId);
        return found ? { ...found, startedAt: new Date(found.endedAt!.getTime() - 60_000) } : null;
      },
      findMany: async ({ where }: { where: Record<string, any> }) => {
        const excluded: string[] = where.id?.notIn ?? [];
        findManyCalls.push({ tenantId: where.tenantId, excluded });
        if (failures.findManyForTenant === where.tenantId) throw new Error('database timeout');
        return recordings
          .filter(
            (row) =>
              row.tenantId === where.tenantId &&
              row.endedAt &&
              !row.archivedAt &&
              !row.deletedAt &&
              !excluded.includes(row.id),
          )
          .sort((left, right) => left.endedAt!.getTime() - right.endedAt!.getTime())
          .map(({ id, storageKey, telephonyPath, endedAt }) => ({
            id,
            storageKey,
            telephonyPath,
            endedAt,
          }));
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, any>;
        data: Partial<FakeRecording>;
      }) => {
        const rows = recordings.filter(
          (row) =>
            row.id === where.id &&
            row.tenantId === where.tenantId &&
            (where.archivedAt !== null || row.archivedAt === null) &&
            (where.deletedAt !== null || row.deletedAt === null) &&
            !(where.legalHolds && row.legalHold),
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    recordingAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
  };
  const database = {
    tenant: { findMany: async () => [{ id: tenantA }, { id: tenantB }] },
    $transaction: async (work: (client: typeof transaction) => Promise<unknown>) =>
      work(transaction),
  } as unknown as PrismaClient;
  return { database, audits, findManyCalls };
}

function row(id: string, tenantId: string, endedAt: string): FakeRecording {
  return {
    id,
    tenantId,
    storageKey: `recordings/${tenantId}/${id}.wav`,
    telephonyPath: `/var/lib/freeswitch/recordings/${tenantId}/${id}.wav`,
    endedAt: new Date(endedAt),
    archivedAt: null,
    deletedAt: null,
  };
}

function missingFile(path: string) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
    code: 'ENOENT',
  });
}

function lifecycle(
  database: PrismaClient,
  archive: RecordingArchive['archive'],
  options: TelephonyRecordingLifecycleOptions & { clock: { now: Date } },
) {
  const logs: { message: string; details: Record<string, unknown> }[] = [];
  const subject = new TelephonyRecordingLifecycle(
    database,
    { handle: async () => undefined },
    { prepare: async () => undefined, archive },
    '/var/lib/freeswitch/recordings',
    {
      missingFileGraceMs: 30 * 60_000,
      retryBackoffInitialMs: 5_000,
      retryBackoffMaxMs: 60_000,
      ...options,
      now: () => options.clock.now,
      log: (message, details) => logs.push({ message, details }),
    },
  );
  return { subject, logs };
}

test('one missing file does not stop later recordings or the next tenant from archiving', async () => {
  const recordings = [
    row('a-missing', tenantA, '2026-11-22T10:00:00.000Z'),
    row('a-ready', tenantA, '2026-11-22T10:01:00.000Z'),
    row('b-ready', tenantB, '2026-11-22T10:02:00.000Z'),
  ];
  const { database } = fakeDatabase(recordings);
  const archived: string[] = [];
  const clock = { now: new Date('2026-11-22T10:03:00.000Z') };
  const { subject, logs } = lifecycle(
    database,
    async (input) => {
      if (input.telephonyPath.includes('a-missing')) throw missingFile(input.telephonyPath);
      archived.push(input.storageKey);
    },
    { clock },
  );

  assert.deepEqual(await subject.retryPendingArchives(nodeId), ['a-ready', 'b-ready']);
  assert.deepEqual(archived, [
    `recordings/${tenantA}/a-ready.wav`,
    `recordings/${tenantB}/b-ready.wav`,
  ]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.message, '[telephony] recording archive retry failed');
  assert.equal(logs[0]?.details.recordingId, 'a-missing');
  assert.equal(logs[0]?.details.errorCode, 'ENOENT');
  assert.equal(logs[0]?.details.nextRetryInSec, 5);
  assert.equal(JSON.stringify(logs[0]?.details).includes('secret'), false);
});

test('a failing recording backs off instead of logging every 5 seconds', async () => {
  const recordings = [row('a-missing', tenantA, '2026-11-22T10:00:00.000Z')];
  const { database, findManyCalls } = fakeDatabase(recordings);
  let attempts = 0;
  const clock = { now: new Date('2026-11-22T10:00:10.000Z') };
  const { subject, logs } = lifecycle(
    database,
    async (input) => {
      attempts += 1;
      throw missingFile(input.telephonyPath);
    },
    { clock },
  );

  await subject.retryPendingArchives(nodeId); // fails the 1st time → wait 5 seconds
  clock.now = new Date('2026-11-22T10:00:13.000Z');
  await subject.retryPendingArchives(nodeId); // not time yet, the file is not touched
  assert.equal(attempts, 1);
  assert.deepEqual(findManyCalls.at(-2)?.excluded, ['a-missing']);

  clock.now = new Date('2026-11-22T10:00:16.000Z');
  await subject.retryPendingArchives(nodeId); // fails the 2nd time → wait 10 seconds
  assert.equal(attempts, 2);
  assert.deepEqual(
    logs.map((log) => log.details.nextRetryInSec),
    [5, 10],
  );
});

test('a file that never appeared is abandoned with audit evidence once storage is proven visible', async () => {
  const recordings = [row('hung-up-early', tenantA, '2026-11-22T10:00:00.000Z')];
  const { database, audits } = fakeDatabase(recordings);
  let missingAttempts = 0;
  const clock = { now: new Date('2026-11-22T10:29:59.000Z') };
  const { subject, logs } = lifecycle(
    database,
    async (input) => {
      if (input.telephonyPath.includes('hung-up-early')) {
        missingAttempts += 1;
        throw missingFile(input.telephonyPath);
      }
    },
    { clock },
  );

  await subject.retryPendingArchives(nodeId); // 30 minutes after hangup have not passed yet
  assert.equal(recordings[0]?.deletedAt, null);

  // A new call archived successfully: storage is visible, but the file has not been seen missing for 10 minutes yet
  recordings.push(row('later-call', tenantA, '2026-11-22T10:34:00.000Z'));
  clock.now = new Date('2026-11-22T10:35:00.000Z');
  await subject.retryPendingArchives(nodeId);
  assert.ok(recordings[1]?.archivedAt);
  assert.equal(recordings[0]?.deletedAt, null);

  clock.now = new Date('2026-11-22T10:40:05.000Z');
  await subject.retryPendingArchives(nodeId);

  assert.deepEqual(recordings[0]?.deletedAt, clock.now);
  assert.equal(recordings[0]?.archivedAt, null);
  assert.deepEqual(audits, [
    {
      tenantId: tenantA,
      recordingId: 'hung-up-early',
      action: 'ARCHIVE_ABANDONED',
      reason: 'SOURCE_FILE_MISSING',
      details: {
        errorCode: 'ENOENT',
        telephonyNodeId: nodeId,
        endedAt: '2026-11-22T10:00:00.000Z',
        missingForSec: 2405,
        attempts: 3,
      },
    },
  ]);
  assert.equal(
    logs.at(-1)?.message,
    '[telephony] recording archive abandoned: source file missing',
  );

  clock.now = new Date('2026-11-22T11:00:00.000Z');
  await subject.retryPendingArchives(nodeId);
  assert.equal(missingAttempts, 3, 'a row that has stopped is not retried');
});

test('a missing mount (every file ENOENT, nothing archives) never abandons recordings', async () => {
  const recordings = [
    row('call-1', tenantA, '2026-11-22T08:00:00.000Z'),
    row('call-2', tenantB, '2026-11-22T08:05:00.000Z'),
  ];
  const { database, audits } = fakeDatabase(recordings);
  const clock = { now: new Date('2026-11-22T10:00:00.000Z') };
  const { subject } = lifecycle(
    database,
    async (input) => {
      throw missingFile(input.telephonyPath);
    },
    { clock },
  );

  for (let minute = 0; minute <= 120; minute += 5) {
    clock.now = new Date(Date.parse('2026-11-22T10:00:00.000Z') + minute * 60_000);
    await subject.retryPendingArchives(nodeId);
  }

  assert.deepEqual(audits, []);
  assert.deepEqual(
    recordings.map((recording) => recording.deletedAt),
    [null, null],
  );
});

test('a recording under legal hold is not abandoned', async () => {
  const recordings = [
    { ...row('held', tenantA, '2026-11-22T09:00:00.000Z'), legalHold: true },
    row('ready', tenantA, '2026-11-22T09:59:00.000Z'),
  ];
  const { database, audits } = fakeDatabase(recordings);
  const clock = { now: new Date('2026-11-22T10:00:00.000Z') };
  const { subject, logs } = lifecycle(
    database,
    async (input) => {
      if (input.telephonyPath.includes('held')) throw missingFile(input.telephonyPath);
    },
    { clock, missingFileObservationMs: 0 },
  );

  await subject.retryPendingArchives(nodeId); // held fails, then ready succeeds
  clock.now = new Date('2026-11-22T10:01:00.000Z');
  await subject.retryPendingArchives(nodeId);

  assert.equal(recordings[0]?.deletedAt, null);
  assert.deepEqual(audits, []);
  assert.ok(
    logs.some(
      (log) =>
        log.message ===
        '[telephony] recording archive not abandoned: legal hold or already handled',
    ),
  );
});

test('an archive that hangs times out so later retry runs are not blocked', async () => {
  const recordings = [row('hung-nfs', tenantA, '2026-11-22T10:00:00.000Z')];
  const { database } = fakeDatabase(recordings);
  const clock = { now: new Date('2026-11-22T10:01:00.000Z') };
  const { subject, logs } = lifecycle(database, () => new Promise<void>(() => undefined), {
    clock,
    archiveTimeoutMs: 20,
  });

  assert.deepEqual(await subject.retryPendingArchives(nodeId), []);
  assert.equal(logs[0]?.details.errorCode, 'ETIMEDOUT');
  clock.now = new Date('2026-11-22T10:02:00.000Z');
  await subject.retryPendingArchives(nodeId);
  assert.equal(logs.length, 2, 'the next round still runs and does not stick at the first round');
});

test('errors other than a missing file keep retrying even after the grace period', async () => {
  const recordings = [row('storage-down', tenantA, '2026-11-22T09:00:00.000Z')];
  const { database, audits } = fakeDatabase(recordings);
  const clock = { now: new Date('2026-11-22T10:00:00.000Z') };
  const { subject } = lifecycle(
    database,
    async () => {
      throw Object.assign(new Error('Stale file handle'), { code: 'ESTALE' });
    },
    { clock },
  );

  await subject.retryPendingArchives(nodeId);

  assert.equal(recordings[0]?.deletedAt, null);
  assert.deepEqual(audits, []);
});

test('a database failure for one tenant does not skip the other tenants', async () => {
  const recordings = [row('b-ready', tenantB, '2026-11-22T10:00:00.000Z')];
  const { database } = fakeDatabase(recordings, { findManyForTenant: tenantA });
  const clock = { now: new Date('2026-11-22T10:01:00.000Z') };
  const { subject, logs } = lifecycle(database, async () => undefined, { clock });

  assert.deepEqual(await subject.retryPendingArchives(nodeId), ['b-ready']);
  assert.equal(logs[0]?.message, '[telephony] recording archive retry skipped tenant');
  assert.equal(logs[0]?.details.tenantId, tenantA);
});

test('overlapping retry runs are skipped while the previous run is still archiving', async () => {
  const recordings = [row('slow', tenantA, '2026-11-22T10:00:00.000Z')];
  const { database } = fakeDatabase(recordings);
  let release!: () => void;
  let attempts = 0;
  const clock = { now: new Date('2026-11-22T10:01:00.000Z') };
  const { subject } = lifecycle(
    database,
    async () => {
      attempts += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    { clock },
  );

  const first = subject.retryPendingArchives(nodeId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await subject.retryPendingArchives(nodeId), []);
  release();
  assert.deepEqual(await first, ['slow']);
  assert.equal(attempts, 1);
});

test('retry does not archive a recording the hangup path is still archiving', async () => {
  const recordings = [row('in-flight', tenantA, '2026-11-22T10:00:00.000Z')];
  const { database } = fakeDatabase(recordings);
  let release!: () => void;
  let attempts = 0;
  const clock = { now: new Date('2026-11-22T10:00:01.000Z') };
  const { subject } = lifecycle(
    database,
    async () => {
      attempts += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    { clock },
  );

  const hangup = subject.finishForHungupCall(hangupEvent());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.deepEqual(await subject.retryPendingArchives(nodeId), []);
  assert.equal(attempts, 1);
  release();
  await hangup;
  assert.ok(recordings[0]?.archivedAt);
});

test('recording start gives up when storage prepare hangs, and discards the row', async () => {
  const created: string[] = [];
  const deleted: unknown[] = [];
  const commands: unknown[] = [];
  const transaction = {
    $executeRawUnsafe: async () => 0,
    interaction: {
      findFirst: async () => ({
        id: 'interaction-1',
        queue: {
          recordingEnabled: true,
          recordingAnnouncement: null,
          recordingAnnouncementLanguage: null,
          recordingChannelLayout: 'STEREO',
        },
      }),
    },
    recording: {
      findFirst: async () => null,
      create: async ({ data }: { data: { telephonyPath: string } }) => {
        created.push(data.telephonyPath);
        return { id: 'recording-1', telephonyPath: data.telephonyPath, channelLayout: 'STEREO' };
      },
      deleteMany: async ({ where }: { where: { id: string } }) => {
        deleted.push(where);
        return { count: 1 };
      },
    },
  };
  const database = {
    $transaction: async (work: (client: typeof transaction) => Promise<unknown>) =>
      work(transaction),
  } as unknown as PrismaClient;
  const subject = new TelephonyRecordingLifecycle(
    database,
    { handle: async (command) => void commands.push(command) },
    { prepare: () => new Promise<void>(() => undefined), archive: async () => undefined },
    '/var/lib/freeswitch/recordings',
    { prepareTimeoutMs: 20, log: () => undefined },
  );

  await assert.rejects(
    () => subject.startForAnsweredCall({ ...hangupEvent(), type: 'call.answered' }),
    (error: NodeJS.ErrnoException) =>
      error.code === 'ETIMEDOUT' && /prepare timed out/.test(error.message),
  );
  assert.equal(created.length, 1);
  // Deletable even when hangup already set endedAt while waiting for storage (no endedAt condition)
  assert.deepEqual(deleted, [{ id: 'recording-1', tenantId: tenantA, archivedAt: null }]);
  assert.deepEqual(commands, [], 'uuid_record is not sent when storage preparation is not in time');
});

function hangupEvent(): KafkaEventEnvelope<TelephonyCallEvent> {
  return {
    eventId: 'event-hangup',
    type: 'call.hangup',
    tenantId: tenantA,
    occurredAt: '2026-11-22T10:00:00.000Z',
    correlationId: 'call-1',
    orderingKey: 'call-1',
    payload: {
      callUuid: 'call-1',
      vendor: 'freeswitch',
      telephonyNodeId: nodeId,
      caller: '1002',
      destination: '2000',
    },
  } as KafkaEventEnvelope<TelephonyCallEvent>;
}
