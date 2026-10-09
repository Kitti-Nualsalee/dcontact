import assert from 'node:assert/strict';
import test from 'node:test';
import { runE1VoiceControl } from './e1-voice-control.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const agentId = '00000000-0000-4000-8000-000000000002';
const targetId = '00000000-0000-4000-8000-000000000003';

test('operator เตรียม SANDBOX ผ่าน control plane, caps และ allowlist 30 นาที แต่ยังปิด switch', async () => {
  const calls: unknown[][] = [];
  let state = 'DISABLED';
  let slug = 'dcontact-uat';
  let target = '1102';
  let busy = 0;
  let prepared = false;
  const transaction = {
    $executeRawUnsafe: async () => undefined,
    dlVoiceScopeGate: {
      findFirst: async () => ({
        businessState: state,
        killed: false,
        capPerMinute: prepared ? 2 : null,
        capPerDay: prepared ? 10 : null,
        agentCapPerMinute: prepared ? 1 : null,
        agentCapPerDay: prepared ? 10 : null,
      }),
    },
    user: { findFirst: async () => ({ extension: '1101' }) },
    contactIdentity: { findFirst: async () => ({ value: target }) },
    interaction: { count: async () => busy },
  };
  const database = {
    tenant: { findUnique: async () => ({ slug, lifecycleStatus: 'ACTIVE' }) },
    $transaction: async (work: (transaction: object) => Promise<unknown>) => work(transaction),
  };
  const control = {
    ensureScope: async () => ({ businessState: state }),
    setTechnicalSwitch: async (...args: unknown[]) => calls.push(['switch', ...args]),
    advanceState: async (_scope: unknown, next: string) => {
      calls.push(['advance', next]);
      state = next;
      return { businessState: state };
    },
    configureCaps: async (...args: unknown[]) => {
      prepared = true;
      calls.push(['caps', ...args]);
    },
    allow: async (...args: unknown[]) => calls.push(['allow', ...args]),
  };
  const run = (args: string[]) =>
    runE1VoiceControl(
      database as never,
      args,
      tenantId,
      'e1-uat-sandbox',
      control as never,
      new Date('2026-10-09T10:00:00.000Z'),
    );
  assert.equal((await run(['status'])).businessState, 'DISABLED');
  assert.equal(calls.length, 0);
  assert.equal((await run(['idle'])).status, 'IDLE');
  busy = 1;
  await assert.rejects(run(['idle']), /VOICE_WORK_STILL_ACTIVE/);
  busy = 0;
  await assert.rejects(run(['on', 'operator:test']), /NOT_PREPARED/);
  slug = 'customer-tenant';
  await assert.rejects(run(['prepare', 'operator:test', agentId, targetId]), /TEST_TENANT/);
  slug = 'dcontact-uat';
  target = '0812345678';
  await assert.rejects(run(['prepare', 'operator:test', agentId, targetId]), /INTERNAL_SYNTHETIC/);
  target = '1101';
  await assert.rejects(run(['prepare', 'operator:test', agentId, targetId]), /INTERNAL_SYNTHETIC/);
  target = '1102';
  assert.equal(calls.length, 0);
  assert.equal(
    (await run(['prepare', 'operator:test', agentId, targetId])).status,
    'PREPARED_DEFAULT_OFF',
  );
  assert.equal(state, 'SANDBOX');
  assert.deepEqual(
    calls.filter((call) => call[0] === 'advance'),
    [
      ['advance', 'DRY_RUN'],
      ['advance', 'SANDBOX'],
    ],
  );
  assert.equal(calls.find((call) => call[0] === 'switch')?.[2], false);
  const allowed = calls.find((call) => call[0] === 'allow')?.[1] as {
    validFrom: Date;
    validUntil: Date;
  };
  assert.equal(allowed.validUntil.getTime() - allowed.validFrom.getTime(), 30 * 60_000);
  assert.equal((await run(['on', 'operator:test'])).status, 'SANDBOX_ENABLED');
  assert.equal((await run(['off', 'operator:test'])).status, 'DISABLED');
  calls.length = 0;
  state = 'CAPPED_PILOT';
  await assert.rejects(run(['prepare', 'operator:test', agentId, targetId]), /SANDBOX_SCOPE/);
  await assert.rejects(run(['on', 'operator:test']), /SANDBOX_SCOPE/);
  assert.equal(calls.length, 0);
  await assert.rejects(run(['off', 'untrusted actor']), /ARGUMENTS_INVALID/);
});
