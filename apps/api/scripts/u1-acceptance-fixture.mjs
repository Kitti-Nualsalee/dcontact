import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@d-contact/db';
import { UatFixtureProvisioner, importJourneyDefinition } from '@d-contact/journey';

/**
 * U1.7 (#435): synthetic data for the acceptance gate — done the same way an operator does in UAT
 * (docs/u1-uat-deployment.md §5) with the owner connection, then provisions the fixture pack through the real
 * `UatFixtureProvisioner` (full preflight/digest) with no direct run/Journey writes
 *
 * - tenant A = the UAT tenant: owner team, maker/reviewer (TEAM-style grants per the runbook), rollout, fixture pack
 *   the maker gets `journey.review` in addition so the negative self-approval reaches the real maker-checker guard
 *   (not being cut at the capability check) — the reviewer is still a different account per the pack
 * - tenant B = another tenant with a `foreign` user holding a full TENANT-style grant in its own tenant, used to prove that
 *   a token of another tenant cannot touch the run/Journey of tenant A even with broad permission in its own tenant
 * - every id is regenerated each gate round so it can be rerun on the same DB without colliding
 */
const MAKER_CAPABILITIES = ['journey.read', 'journey.edit', 'journey.publish', 'journey.review'];
const REVIEWER_CAPABILITIES = ['journey.read', 'journey.review'];
const FOREIGN_CAPABILITIES = ['journey.read', 'journey.edit', 'journey.review', 'journey.publish'];

/** the starting Journey of every run: EVENT_TRIGGER → SEND → EXIT (the maker inserts WAIT themselves in the Console) */
function baselineSource(ownerTeamId) {
  return {
    name: 'U1 gate synthetic journey',
    ownerTeamId,
    purpose: 'SERVICE',
    senderIdentityId: 'sender-synthetic-u1',
    trigger: { kind: 'EVENT', eventType: 'synthetic.u1.started' },
    graph: {
      entryStepId: 'send-1',
      steps: [
        {
          id: 'send-1',
          type: 'SEND',
          channel: 'LINE',
          contentRef: 'content-synthetic-u1',
          next: 'done',
        },
        { id: 'done', type: 'EXIT', reason: 'COMPLETED' },
      ],
    },
    goal: { kind: 'EVENT', eventType: 'synthetic.u1.goal' },
    exitRules: [{ kind: 'GOAL' }],
    maxDurationDays: 7,
  };
}

export async function provisionU1AcceptanceFixture({
  ownerDatabaseUrl,
  buildSha,
  environment = 'uat',
  packVersion,
  steps,
  simulationFixture,
}) {
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl } } });
  try {
    const tag = randomUUID().slice(0, 8);
    const tenants = {
      a: { id: randomUUID(), slug: `u1g-${tag}-a`, teamId: randomUUID() },
      b: { id: randomUUID(), slug: `u1g-${tag}-b`, teamId: randomUUID() },
    };
    const users = {
      maker: { id: randomUUID(), tenant: 'a' },
      reviewer: { id: randomUUID(), tenant: 'a' },
      foreign: { id: randomUUID(), tenant: 'b' },
    };
    for (const [key, tenant] of Object.entries(tenants)) {
      await owner.tenant.create({
        data: {
          id: tenant.id,
          name: `U1 gate ${tag} ${key.toUpperCase()}`,
          slug: tenant.slug,
          sipDomain: `${tenant.slug}.u1-gate.invalid`,
          lifecycleStatus: 'ACTIVE',
        },
      });
      await owner.team.create({
        data: { id: tenant.teamId, tenantId: tenant.id, name: `u1-gate-owner-${key}` },
      });
      await owner.jrAuthoringRolloutState.create({
        data: {
          tenantId: tenant.id,
          stage: 'INTERNAL_SYNTHETIC',
          canvasWriteEnabled: true,
          publishUiEnabled: true,
          updatedByRef: 'u1-gate-operator',
          evidenceRef: `u1-gate-${tag}`,
        },
      });
    }
    for (const [role, user] of Object.entries(users)) {
      const tenant = tenants[user.tenant];
      await owner.user.create({
        data: {
          id: user.id,
          tenantId: tenant.id,
          email: `${role}.${tag}@u1-gate.invalid`,
          // no login through the DB — identity comes only from Keycloak
          passwordHash: '!',
          displayName: `U1 gate ${role}`,
          role: 'ADMIN',
          teamId: tenant.teamId,
        },
      });
      await owner.iamAuthoringSubject.create({
        data: { tenantId: tenant.id, subjectId: user.id, authenticationStrength: 'STANDARD' },
      });
    }
    const grant = (user, capability, scopeKind, scopeId) =>
      owner.iamAuthoringCapabilityGrant.create({
        data: {
          tenantId: tenants[user.tenant].id,
          subjectId: user.id,
          capability,
          scopeKind,
          scopeId,
          grantedByRef: 'u1-gate-iam-admin',
        },
      });
    for (const capability of MAKER_CAPABILITIES) {
      await grant(users.maker, capability, 'TEAM', tenants.a.teamId);
    }
    for (const capability of REVIEWER_CAPABILITIES) {
      await grant(users.reviewer, capability, 'TEAM', tenants.a.teamId);
    }
    for (const capability of FOREIGN_CAPABILITIES) {
      await grant(users.foreign, capability, 'TENANT', tenants.b.id);
    }

    const manifest = {
      schema: 'UatFixturePackV1',
      environment,
      packVersion,
      buildSha,
      tenantId: tenants.a.id,
      ownerTeamId: tenants.a.teamId,
      makerSubjectId: users.maker.id,
      reviewerSubjectId: users.reviewer.id,
      senderRef: 'sender-synthetic-u1',
      contentRef: 'content-synthetic-u1',
      baselineDocument: importJourneyDefinition(baselineSource(tenants.a.teamId)),
      simulationFixture,
      steps,
    };
    const pack = await new UatFixtureProvisioner(owner).provision(manifest);
    return {
      tag,
      tenants,
      users,
      fixturePack: { environment, packVersion, digest: pack.digest, status: pack.status },
    };
  } finally {
    await owner.$disconnect();
  }
}
