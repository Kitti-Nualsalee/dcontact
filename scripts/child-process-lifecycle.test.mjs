import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { observeChildExit, stopChild } from './child-process-lifecycle.mjs';

test('records the close result of a SIPp child that ends before the media check step', async () => {
  const child = new EventEmitter();
  const exit = observeChildExit(child);

  child.emit('close', 0);

  assert.equal(await exit, 0);
});

test('stops waiting for a SIPp child that does not close within the allotted time', async () => {
  const child = new EventEmitter();
  child.kill = (signal) => {
    child.killedWith = signal;
  };

  await assert.rejects(
    observeChildExit(child, { timeoutMs: 5, label: 'SIPp caller' }),
    /SIPp caller did not exit within 5ms/,
  );
  assert.equal(child.killedWith, 'SIGTERM');
});

test('cleanup closes child streams before stopping the process so acceptance does not hang', () => {
  const child = new EventEmitter();
  child.stdout = { destroy: () => (child.stdoutDestroyed = true) };
  child.stderr = { destroy: () => (child.stderrDestroyed = true) };
  child.kill = (signal) => {
    child.killedWith = signal;
  };

  stopChild(child);

  assert.deepEqual(
    [child.stdoutDestroyed, child.stderrDestroyed, child.killedWith],
    [true, true, 'SIGTERM'],
  );
});
