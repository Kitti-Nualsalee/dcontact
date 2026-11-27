import assert from 'node:assert/strict';
import test from 'node:test';
import { WebchatHub } from './webchat-hub.js';

test('a waiting session wakes on its own notice only, and a timeout reports no change', async () => {
  const hub = new WebchatHub({ holdProcess: true });
  const mine = hub.waitForSession('t1', 's1', 5_000);
  const other = hub.waitForSession('t1', 's2', 20);
  const otherTenant = hub.waitForSession('t2', 's1', 20);
  hub.publish({ tenantId: 't1', sessionIds: ['s1'] });
  assert.equal(await mine, true);
  assert.equal(await other, false);
  assert.equal(await otherTenant, false);
});

test('an aborted wait resolves at once and leaves nothing behind', async () => {
  const hub = new WebchatHub({ holdProcess: true });
  const controller = new AbortController();
  const waiting = hub.waitForSession('t1', 's1', 5_000, controller.signal);
  controller.abort();
  assert.equal(await waiting, false);
  // a later notice has nobody to wake and must not throw
  hub.publish({ tenantId: 't1', sessionIds: ['s1'] });
});

test('Agents are told once each, and a failing listener does not stop the next one', () => {
  const hub = new WebchatHub({ holdProcess: true });
  const seen: string[][] = [];
  hub.onAgents(() => {
    throw new Error('listener failed');
  });
  hub.onAgents((tenantId, agentIds) => seen.push([tenantId, ...agentIds]));
  hub.publish({ tenantId: 't1', agentIds: ['a1', 'a1', 'a2'] });
  hub.publish({ tenantId: 't1', sessionIds: ['s1'] });
  assert.deepEqual(seen, [['t1', 'a1', 'a2']]);
});
