import assert from 'node:assert/strict';
import test from 'node:test';
import { PHASE_ONE_TENANT_IDENTITIES } from './phase-one-tenants.mjs';

test('Phase 1 identity baseline defines two distinct Keycloak Organizations', () => {
  assert.deepEqual(
    PHASE_ONE_TENANT_IDENTITIES.map(({ slug, agentEmail, organizationScope }) => ({
      slug,
      agentEmail,
      organizationScope,
    })),
    [
      {
        slug: 'demo',
        agentEmail: 'agent1000@demo.local',
        organizationScope: 'organization:demo',
      },
      {
        slug: 'demo-two',
        agentEmail: 'agent2000@demo-two.local',
        organizationScope: 'organization:demo-two',
      },
    ],
  );
});
