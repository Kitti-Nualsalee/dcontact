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
