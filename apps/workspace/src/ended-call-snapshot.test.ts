import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentWorkspaceSnapshot } from './agent-api.js';
import { EndedCallSnapshotReconciler } from './ended-call-snapshot.js';

function snapshot(state: 'ACTIVE' | 'WRAPUP', id = 'call-1'): AgentWorkspaceSnapshot {
  return {
    agent: { id: 'agent-1', displayName: 'ทดสอบ', extension: '1103', state: 'BUSY' },
    interaction: {
      id,
      state,
      direction: 'INBOUND',
      version: '1',
      caller: null,
      queue: null,
      offerExpiresAt: null,
      answeredAt: '2026-10-15T11:00:00Z',
      endedAt: state === 'WRAPUP' ? '2026-10-15T11:01:00Z' : null,
    },
  };
}

test('checkpoint ก่อนรอ hangup ใช้ไม่ได้หลังมีสายใหม่หรือ cleanup', () => {
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => snapshot('WRAPUP'),
    apply: () => undefined,
    onExhausted: () => assert.fail('ไม่ควรเริ่ม request'),
  });
  const stillCurrent = reconciler.checkpoint();
  assert.equal(stillCurrent(), true);
  reconciler.cancel();
  assert.equal(stillCurrent(), false);
});

test('snapshot ACTIVE สองครั้งก่อน WRAPUP: ไม่แสดงผลเก่าและไม่สร้าง loop ซ้ำ', async () => {
  let requests = 0;
  const applied: AgentWorkspaceSnapshot[] = [];
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => snapshot(++requests < 3 ? 'ACTIVE' : 'WRAPUP'),
    apply: (value) => applied.push(value),
    onExhausted: () => assert.fail('ต้องพบ WRAPUP'),
    wait: async () => undefined,
  });
  const first = reconciler.start('call-1');
  assert.equal(reconciler.start('call-1'), first);
  await first;
  await reconciler.start('call-1');
  assert.equal(requests, 3);
  assert.deepEqual(
    applied.map((value) => value.interaction?.state),
    ['WRAPUP'],
  );
});

test('cancel ระหว่าง fetch: ไม่ทับสถานะสายใหม่และไม่ poll ต่อ', async () => {
  let finish!: (value: AgentWorkspaceSnapshot) => void;
  let requests = 0;
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: () => {
      requests += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    apply: () => assert.fail('ผลที่ยกเลิกห้ามถูกใช้'),
    onExhausted: () => assert.fail('ไม่ใช่ exhaustion'),
  });
  const pending = reconciler.start('call-1');
  reconciler.cancel();
  finish(snapshot('WRAPUP'));
  await pending;
  assert.equal(requests, 1);
});

test('error ต่อเนื่องหยุดตามจำนวนที่กำหนดและรายงานครั้งเดียว', async () => {
  let requests = 0;
  let exhausted = 0;
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => {
      requests += 1;
      throw new Error('temporary');
    },
    apply: () => assert.fail('ยังไม่มี snapshot'),
    onExhausted: () => {
      exhausted += 1;
    },
    attempts: 3,
    wait: async () => undefined,
  });
  await reconciler.start('call-1');
  assert.equal(requests, 3);
  assert.equal(exhausted, 1);
});

test('ACTIVE ไม่เปลี่ยนหลังครบจำนวน: ไม่วนไม่สิ้นสุดหรือ apply สถานะที่ยังไม่จบ', async () => {
  let requests = 0;
  let exhausted = 0;
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => {
      requests += 1;
      return snapshot('ACTIVE');
    },
    apply: () => assert.fail('ยังไม่จบสายที่ server'),
    onExhausted: () => {
      exhausted += 1;
    },
    attempts: 3,
    wait: async () => undefined,
  });
  await reconciler.start('call-1');
  assert.equal(requests, 3);
  assert.equal(exhausted, 1);
});

test('สายใหม่มาแทนขณะคำตอบเก่ายังรอ: ใช้เฉพาะผลของสายใหม่', async () => {
  let finish!: (value: AgentWorkspaceSnapshot) => void;
  let requests = 0;
  const applied: AgentWorkspaceSnapshot[] = [];
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => {
      requests += 1;
      if (requests === 1)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return snapshot('WRAPUP', 'call-2');
    },
    apply: (value) => applied.push(value),
    onExhausted: () => assert.fail('ต้องจบที่สายใหม่'),
  });
  const previous = reconciler.start('call-1');
  await reconciler.start('call-2');
  finish(snapshot('WRAPUP'));
  await previous;
  assert.deepEqual(
    applied.map((value) => value.interaction?.id),
    ['call-2'],
  );
});

test('server ไม่มีสายเดิมแล้ว: ใช้ snapshot ล่าสุดและหยุดทันที', async () => {
  const next = { ...snapshot('ACTIVE'), interaction: null };
  const applied: AgentWorkspaceSnapshot[] = [];
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => next,
    apply: (value) => applied.push(value),
    onExhausted: () => assert.fail('server จบสายแล้ว'),
    wait: () => {
      throw new Error('ไม่ต้อง poll');
    },
  });
  await reconciler.start('call-1');
  assert.deepEqual(applied, [next]);
});
