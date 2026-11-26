import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentWorkspaceSnapshot } from './agent-api.js';
import { EndedCallSnapshotReconciler } from './ended-call-snapshot.js';

function snapshot(state: 'ACTIVE' | 'WRAPUP', id = 'call-1'): AgentWorkspaceSnapshot {
  return {
    agent: { id: 'agent-1', displayName: 'Test', extension: '1103', state: 'BUSY' },
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

test('checkpoint before waiting for hangup is unusable after a new call or cleanup', () => {
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => snapshot('WRAPUP'),
    apply: () => undefined,
    onExhausted: () => assert.fail('should not start a request'),
  });
  const stillCurrent = reconciler.checkpoint();
  assert.equal(stillCurrent(), true);
  reconciler.cancel();
  assert.equal(stillCurrent(), false);
});

test('two ACTIVE snapshots before WRAPUP: do not show the old result and do not create another loop', async () => {
  let requests = 0;
  const applied: AgentWorkspaceSnapshot[] = [];
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => snapshot(++requests < 3 ? 'ACTIVE' : 'WRAPUP'),
    apply: (value) => applied.push(value),
    onExhausted: () => assert.fail('must find WRAPUP'),
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

test('cancel during fetch: does not overwrite the state of a new call and does not keep polling', async () => {
  let finish!: (value: AgentWorkspaceSnapshot) => void;
  let requests = 0;
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: () => {
      requests += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    apply: () => assert.fail('a cancelled result must not be used'),
    onExhausted: () => assert.fail('not an exhaustion'),
  });
  const pending = reconciler.start('call-1');
  reconciler.cancel();
  finish(snapshot('WRAPUP'));
  await pending;
  assert.equal(requests, 1);
});

test('continuous errors stop at the configured count and report once', async () => {
  let requests = 0;
  let exhausted = 0;
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => {
      requests += 1;
      throw new Error('temporary');
    },
    apply: () => assert.fail('no snapshot yet'),
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

test('ACTIVE unchanged after the count is reached: no endless loop and no applying a state that has not ended', async () => {
  let requests = 0;
  let exhausted = 0;
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => {
      requests += 1;
      return snapshot('ACTIVE');
    },
    apply: () => assert.fail('the server has not ended the call yet'),
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

test('a new call replaces it while the old answer is pending: use only the result of the new call', async () => {
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
    onExhausted: () => assert.fail('must end at the new call'),
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

test('the server no longer has the old call: use the latest snapshot and stop immediately', async () => {
  const next = { ...snapshot('ACTIVE'), interaction: null };
  const applied: AgentWorkspaceSnapshot[] = [];
  const reconciler = new EndedCallSnapshotReconciler({
    snapshot: async () => next,
    apply: (value) => applied.push(value),
    onExhausted: () => assert.fail('the server ended the call'),
    wait: () => {
      throw new Error('no need to poll');
    },
  });
  await reconciler.start('call-1');
  assert.deepEqual(applied, [next]);
});
