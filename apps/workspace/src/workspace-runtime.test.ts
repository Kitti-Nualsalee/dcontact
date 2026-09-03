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
  const runtime = new WorkspaceRuntime(
    {
      start: () => false,
      heartbeat: () => true,
      claim: () => undefined,
      stop: () => undefined,
    } as never,
    () => {
      connections += 1;
      return { close: () => undefined };
    },
  );

  runtime.start();
  runtime.moveWorkingTabHere();
  runtime.heartbeat();

  assert.equal(connections, 1);
  runtime.stop();
});
