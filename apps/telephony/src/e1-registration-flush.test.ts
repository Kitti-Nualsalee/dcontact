import assert from 'node:assert/strict';
import test from 'node:test';
import { E1RegistrationFlusher, type E1RegistrationFlushInput } from './e1-registration-flush.js';

const input: E1RegistrationFlushInput = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  command: {
    type: 'sip.registration.flush',
    vendor: 'freeswitch',
    telephonyNodeId: 'e1-uat-sandbox',
    extension: '1101',
    sipDomain: 'dcontact-uat.sip.internal',
    workSessionLeaseId: '00000000-0000-4000-8000-000000000002',
  },
};

test('flush ตรวจ revoked/released binding, ปกป้อง credential ใหม่ และ audit หลัง ESL reply เท่านั้น', async () => {
  let revoked = false;
  let active = 0;
  let completed = false;
  let fail = false;
  let commands = 0;
  let locked = false;
  const transaction = {
    $executeRawUnsafe: async () => undefined,
    $queryRaw: async () => {
      locked = true;
      return [];
    },
    agentSipCredential: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        assert.equal(where.tenantId, input.tenantId);
        assert.equal(where.workSessionLeaseId, input.command.workSessionLeaseId);
        assert.equal(where.extension, input.command.extension);
        assert.equal(where.telephonyNodeId, input.command.telephonyNodeId);
        assert.deepEqual(where.revokedAt, { not: null });
        assert.deepEqual(where.workSessionLease, { releasedAt: { not: null } });
        return revoked ? { userId: '00000000-0000-4000-8000-000000000003' } : null;
      },
      count: async () => active,
    },
    dlVoiceAuditEvent: {
      findFirst: async () => (completed ? {} : null),
      create: async () => {
        assert.equal(commands, 2);
        completed = true;
      },
    },
  };
  const database = {
    $transaction: async (work: (transaction: object) => Promise<unknown>) => work(transaction),
  };
  const flusher = new E1RegistrationFlusher(database as never, {
    handle: async (command, tenantId) => {
      assert.equal(locked, true);
      assert.deepEqual(command, input.command);
      assert.equal(tenantId, input.tenantId);
      commands += 1;
      if (fail) throw new Error('ESL unconfirmed');
    },
  });
  assert.equal(await flusher.flush(input), false);
  assert.equal(commands, 0);
  revoked = true;
  active = 1;
  assert.equal(await flusher.flush(input), false);
  assert.equal(commands, 0);
  active = 0;
  fail = true;
  await assert.rejects(flusher.flush(input), /unconfirmed/);
  assert.equal(completed, false);
  fail = false;
  assert.equal(await flusher.flush(input), true);
  assert.equal(await flusher.flush(input), true);
  assert.equal(commands, 2);
});
