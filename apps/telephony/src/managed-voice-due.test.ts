import assert from 'node:assert/strict';
import test from 'node:test';
import { runManagedVoiceDue, runManagedVoiceReadiness } from './managed-voice-due.js';

test('ESL down และ clear-readiness error ไม่หยุด DB deadline/intent และไม่ส่ง heartbeat', async () => {
  const calls: string[] = [];
  await runManagedVoiceReadiness({
    ready: async () => {
      throw new Error('ESL down');
    },
    setPortReady: (ready) => calls.push(`ready:${ready}`),
    clearReadiness: async () => {
      calls.push('clear');
      throw new Error('DB transient');
    },
    tenantIds: async () => ['tenant-a', 'tenant-b'],
    heartbeat: async () => {
      calls.push('heartbeat');
    },
    onError: () => {},
  });
  await runManagedVoiceDue({
    tenantIds: async () => ['tenant-a', 'tenant-b'],
    tick: async (tenantId) => {
      calls.push(tenantId);
      if (tenantId === 'tenant-a') throw new Error('tenant transient');
    },
    onError: () => {},
  });
  assert.deepEqual(calls, ['ready:false', 'clear', 'tenant-a', 'tenant-b']);
});

test('probe ผ่านจึง heartbeat; heartbeat error ไม่หยุด tick', async () => {
  const calls: string[] = [];
  await runManagedVoiceReadiness({
    ready: async () => true,
    setPortReady: (ready) => calls.push(`ready:${ready}`),
    clearReadiness: async () => {
      calls.push('clear');
    },
    tenantIds: async () => ['tenant'],
    heartbeat: async () => {
      calls.push('heartbeat');
      throw new Error('heartbeat failure');
    },
    onError: () => {},
  });
  await runManagedVoiceDue({
    tenantIds: async () => ['tenant'],
    tick: async () => {
      calls.push('tick');
    },
    onError: () => {},
  });
  assert.deepEqual(calls, ['ready:true', 'heartbeat', 'tick']);
});

test('probe ที่ยังไม่ตอบไม่ขวาง DB deadline รอบใหม่', async () => {
  let releaseProbe: (ready: boolean) => void = () => {};
  const probe = new Promise<boolean>((resolve) => {
    releaseProbe = resolve;
  });
  const calls: string[] = [];
  const readiness = runManagedVoiceReadiness({
    ready: () => probe,
    setPortReady: () => {},
    clearReadiness: async () => {},
    tenantIds: async () => ['tenant'],
    heartbeat: async () => {
      calls.push('heartbeat');
    },
    onError: () => {},
  });
  for (const round of [1, 2])
    await runManagedVoiceDue({
      tenantIds: async () => ['tenant'],
      tick: async () => {
        calls.push(`tick:${round}`);
      },
      onError: () => {},
    });
  assert.deepEqual(calls, ['tick:1', 'tick:2']);
  releaseProbe(false);
  await readiness;
});
