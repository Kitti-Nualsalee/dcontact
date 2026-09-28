import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@d-contact/db';
import { UatFixtureProvisioner, importJourneyDefinition } from '@d-contact/journey';

/**
 * U1.7 (#435): ข้อมูลสังเคราะห์ของ acceptance gate — ทำแบบเดียวกับที่ operator ทำใน UAT
 * (docs/u1-uat-deployment.md §5) ด้วย connection ของ owner แล้ว provision fixture pack ผ่าน
 * `UatFixtureProvisioner` จริง (preflight/digest ครบ) ไม่มีการเขียน run/Journey ตรง ๆ
 *
 * - tenant A = tenant ของ UAT: owner team, maker/reviewer (grant แบบ TEAM ตาม runbook), rollout, fixture pack
 *   maker ได้ `journey.review` เพิ่มเพื่อให้ negative self-approval ไปถึง guard maker-checker จริง
 *   (ไม่ใช่ถูกตัดตั้งแต่ capability check) — reviewer ยังเป็นคนละบัญชีตาม pack
 * - tenant B = tenant อื่นที่มีผู้ใช้ `foreign` ถือ grant แบบ TENANT ครบใน tenant ของตัวเอง ใช้พิสูจน์ว่า
 *   token ของ tenant อื่นแตะ run/Journey ของ tenant A ไม่ได้แม้มีสิทธิ์กว้างใน tenant ตัวเอง
 * - ทุก id สุ่มใหม่ต่อรอบของ gate จึงรันซ้ำบน DB เดิมได้โดยไม่ชนกัน
 */
const MAKER_CAPABILITIES = ['journey.read', 'journey.edit', 'journey.publish', 'journey.review'];
const REVIEWER_CAPABILITIES = ['journey.read', 'journey.review'];
const FOREIGN_CAPABILITIES = ['journey.read', 'journey.edit', 'journey.review', 'journey.publish'];

/** Journey ตั้งต้นของทุก run: EVENT_TRIGGER → SEND → EXIT (maker แทรก WAIT เองใน Console) */
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
          // ไม่มี login ผ่าน DB — ตัวตนมาจาก Keycloak เท่านั้น
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
