import assert from 'node:assert/strict';
import test from 'node:test';
import { E1SandboxVoiceRollout } from './e1-sandbox-voice-rollout.js';
import type { VoiceRolloutAuthority } from './voice-rollout-control.js';

test('E1 sandbox ไม่ authorize tenant/node อื่นหรือ CAPPED_PILOT แม้ authority เดิมอนุญาต', async () => {
  let evaluations = 0;
  let authorizations = 0;
  let state: 'SANDBOX' | 'CAPPED_PILOT' = 'SANDBOX';
  const authority: VoiceRolloutAuthority = {
    evaluate: async () => {
      evaluations += 1;
      return { status: 'ALLOWED', state, replay: false };
    },
    authorize: async () => {
      authorizations += 1;
      return { status: 'ALLOWED', state, replay: true };
    },
  };
  const scope = { tenantId: 'test-tenant', telephonyNodeId: 'e1-uat-sandbox' };
  const rollout = new E1SandboxVoiceRollout(authority, scope);
  const input = {
    ...scope,
    deliveryId: 'delivery-1',
    agentUserId: 'agent-1',
    targetIdentityId: 'target-1',
    at: new Date(),
  };
  assert.equal((await rollout.authorize({ ...input, tenantId: 'other-tenant' })).status, 'DENIED');
  assert.equal(
    (await rollout.authorize({ ...input, telephonyNodeId: 'other-node' })).status,
    'DENIED',
  );
  assert.equal(evaluations, 0);
  assert.equal(authorizations, 0);
  state = 'CAPPED_PILOT';
  assert.equal((await rollout.authorize(input)).status, 'DENIED');
  assert.equal(authorizations, 0);
  state = 'SANDBOX';
  assert.deepEqual(await rollout.authorize(input), {
    status: 'ALLOWED',
    state: 'SANDBOX',
    replay: true,
  });
  assert.equal(authorizations, 1);
});
