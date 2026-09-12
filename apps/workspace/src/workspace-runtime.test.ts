import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceRuntime } from './workspace-runtime.js';

test('a non-working tab does not open the routing WebSocket', () => {
  let connections = 0;
  const runtime = new WorkspaceRuntime(
    {
      start: () => false,
      heartbeat: () => false,
      claim: () => undefined,
      stop: () => undefined,
    } as never,
    () => {
      connections += 1;
      return { close: () => undefined };
    },
  );

  runtime.start();

  assert.equal(connections, 0);
  runtime.stop();
});

test('moving work to a tab opens exactly one routing WebSocket', () => {
  let connections = 0;
  const modes: string[] = [];
  const runtime = new WorkspaceRuntime(
    {
      start: () => false,
      heartbeat: () => true,
      claim: () => undefined,
      stop: () => undefined,
    } as never,
    (mode) => {
      connections += 1;
      modes.push(mode);
      return { close: () => undefined };
    },
  );

  runtime.start();
  runtime.moveWorkingTabHere();
  runtime.heartbeat();

  assert.equal(connections, 1);
  assert.deepEqual(modes, ['claim']);
  runtime.stop();
});

test('the working tab exposes a routing offer to the workspace', () => {
  let receive: ((event: unknown) => void) | undefined;
  const offers: unknown[] = [];
  const runtime = new WorkspaceRuntime(
    {
      start: () => true,
      heartbeat: () => true,
      claim: () => undefined,
      stop: () => undefined,
    } as never,
    (_mode, onEvent) => {
      receive = onEvent;
      return { close: () => undefined };
    },
    (offer) => offers.push(offer),
  );
  runtime.start();
  receive?.({
    type: 'routing.offered',
    tenantId: 'tenant-demo',
    userId: 'agent-1000',
    interactionId: 'interaction-1',
  });
  assert.deepEqual(offers, [
    {
      type: 'routing.offered',
      tenantId: 'tenant-demo',
      userId: 'agent-1000',
      interactionId: 'interaction-1',
    },
  ]);
  runtime.stop();
});

test('a sequence gap refreshes the REST snapshot before applying later live events', async () => {
  let receive: ((event: unknown) => void) | undefined;
  let snapshotRefreshes = 0;
  const liveEvents: unknown[] = [];
  const runtime = new WorkspaceRuntime(
    {
      start: () => true,
      heartbeat: () => true,
      claim: () => undefined,
      stop: () => undefined,
    } as never,
    (_mode, onEvent) => {
      receive = onEvent;
      return { close: () => undefined };
    },
    undefined,
    async () => {
      snapshotRefreshes += 1;
      return { sequence: 4 };
    },
    (event) => liveEvents.push(event),
  );

  runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  receive?.({ type: 'workspace.live', sequence: 5, payload: { queueId: 'queue-1' } });
  receive?.({ type: 'workspace.live', sequence: 7, payload: { queueId: 'queue-2' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(snapshotRefreshes, 2);
  assert.deepEqual(liveEvents, [
    { type: 'workspace.live', sequence: 5, payload: { queueId: 'queue-1' } },
  ]);
  runtime.stop();
});

test('a late snapshot cannot move the live sequence backwards after reconnect', async () => {
  let receive: ((event: unknown) => void) | undefined;
  let resolveSnapshot: ((snapshot: { sequence: number }) => void) | undefined;
  const liveEvents: unknown[] = [];
  const runtime = new WorkspaceRuntime(
    {
      start: () => true,
      heartbeat: () => true,
      claim: () => undefined,
      stop: () => undefined,
    } as never,
    (_mode, onEvent) => {
      receive = onEvent;
      return { close: () => undefined };
    },
    undefined,
    () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    (event) => liveEvents.push(event),
  );

  runtime.start();
  receive?.({ type: 'workspace.live', sequence: 1, payload: { queueId: 'queue-1' } });
  resolveSnapshot?.({ sequence: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  receive?.({ type: 'workspace.live', sequence: 2, payload: { queueId: 'queue-1' } });

  assert.deepEqual(liveEvents, [
    { type: 'workspace.live', sequence: 1, payload: { queueId: 'queue-1' } },
    { type: 'workspace.live', sequence: 2, payload: { queueId: 'queue-1' } },
  ]);
  runtime.stop();
});

test('governance invalidation ของ owner-local live stream บล็อก outbound จนยืนยัน canonical version', () => {
  let receive: ((event: unknown) => void) | undefined;
  const alerts: unknown[] = [];
  const runtime = new WorkspaceRuntime(
    {
      start: () => true,
      heartbeat: () => true,
      claim: () => undefined,
      stop: () => undefined,
    } as never,
    (_mode, onEvent) => {
      receive = onEvent;
      return { close: () => undefined };
    },
    undefined,
    undefined,
    undefined,
    (alert) => alerts.push(alert),
  );
  runtime.start();
  receive?.({
    type: 'workspace.live',
    sequence: 1,
    payload: {
      event: 'contact_governance.invalidated',
      aggregateVersion: 9,
      action: 'BLOCK_NEXT_OUTBOUND',
    },
  });
  runtime.confirmGovernanceVersion(9);

  assert.deepEqual(
    alerts.map((alert) => (alert as { state: string }).state),
    ['BLOCK_NEXT_OUTBOUND', 'READY'],
  );
  runtime.stop();
});
