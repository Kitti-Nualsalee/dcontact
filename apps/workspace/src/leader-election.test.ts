import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WorkspaceTabLeaderElection,
  type WorkspaceLeaderChannel,
  type WorkspaceLeaderLease,
  type WorkspaceLeaderStorage,
} from './leader-election.js';

function harness() {
  let lease: WorkspaceLeaderLease | undefined;
  const listeners = new Set<(lease: WorkspaceLeaderLease) => void>();
  const storage: WorkspaceLeaderStorage = {
    read: () => lease,
    write: (next) => {
      lease = next;
    },
    remove: (tabId) => {
      if (lease?.tabId === tabId) lease = undefined;
    },
  };
  const channel: WorkspaceLeaderChannel = {
    announce: (next) => {
      for (const listener of listeners) listener(next);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { storage, channel };
}

test('only one browser tab owns the routing WebSocket lease', () => {
  const shared = harness();
  const first = new WorkspaceTabLeaderElection(
    'tab-a',
    shared.storage,
    shared.channel,
    () => 1_000,
  );
  const second = new WorkspaceTabLeaderElection(
    'tab-b',
    shared.storage,
    shared.channel,
    () => 1_000,
  );

  assert.equal(first.start(), true);
  assert.equal(second.start(), false);
  assert.equal(first.isWorkingTab(), true);
  assert.equal(second.isWorkingTab(), false);
});

test('a tab can explicitly move the working lease without two leaders', () => {
  const shared = harness();
  const first = new WorkspaceTabLeaderElection(
    'tab-a',
    shared.storage,
    shared.channel,
    () => 1_000,
  );
  const second = new WorkspaceTabLeaderElection(
    'tab-b',
    shared.storage,
    shared.channel,
    () => 1_000,
  );
  first.start();
  second.start();

  second.claim();

  assert.equal(first.isWorkingTab(), false);
  assert.equal(second.isWorkingTab(), true);
});

test('a stale heartbeat lets another tab recover the routing lease', () => {
  const shared = harness();
  let now = 1_000;
  const first = new WorkspaceTabLeaderElection('tab-a', shared.storage, shared.channel, () => now);
  const second = new WorkspaceTabLeaderElection('tab-b', shared.storage, shared.channel, () => now);
  first.start();
  now = 7_000;

  assert.equal(second.start(), true);
  assert.equal(first.isWorkingTab(), false);
});
