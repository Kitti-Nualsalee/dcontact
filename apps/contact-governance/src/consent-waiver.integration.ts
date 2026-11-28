import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  actionKey as actionKeyBrand,
  cg4SubjectId,
  reservationId as reservationIdBrand,
  tenantId as tenantIdBrand,
  type Cg4AuthorizationSubject,
  type Cg4Capability,
} from '@d-contact/cxa-contracts';
import { ContactGovernanceService } from './contact-governance-service.js';
import { Cg4ApprovalRepository } from './cg4-approval-repository.js';
import { buildCg4PolicyScopeKey, Cg4PolicyValidationError } from './cg4-policy-compiler.js';
import type { Cg4PolicyFixturePack } from './cg4-policy-fixtures.js';
import { Cg4PolicyLifecycleRepository } from './cg4-policy-lifecycle.js';
import { Cg4QuorumNotMetError } from './cg4-authorization-engine.js';

/**
 * #1065: a CG4 policy may stop requiring consent for one purpose on one channel. Runs through the application
 * role (RLS) and the real policy studio: the waiver is published with two checkers like any relaxation, and
 * only decides work while the tenant's rollout stage reads CG4 policies.
 *
 * 10:00 Asia/Bangkok, outside the policy's quiet hours, so only the consent gate decides.
 */

const NOW = new Date('2026-01-05T03:00:00.000Z');
const PINNED_TIME = '2026-01-05T00:00:00.000Z';
const PINNED_ZONE = 'Asia/Bangkok';
const VOICE_SERVICE = buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'SERVICE' });
const MAKER = 'consent-maker';

const TENANT_PACK: Cg4PolicyFixturePack = {
  packId: 'TENANT_SYNTHETIC',
  suiteVersion: 'TENANT_SYNTHETIC_V1',
  checks: [
    {
      id: 'tenant:quiet-hours-local-clock',
      kind: 'QUIET_HOURS_FOLLOW_LOCAL_CLOCK',
      timezone: PINNED_ZONE,
      fromInstant: PINNED_TIME,
      probeHours: 24,
      stepMinutes: 60,
    },
  ],
};

function content(consent?: Record<string, unknown>) {
  return {
    timezoneFallback: PINNED_ZONE,
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '22:00', endLocal: '06:00' }],
    callbackMode: 'NO_OVERRIDE',
    overridableRules: [],
    allowedOperationalRuleCodes: [],
    holidays: [],
    ...(consent ? { consent } : {}),
  };
}

const WAIVER = { requirement: 'NOT_REQUIRED', lawfulBasis: 'CONTRACT' };

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
      },
    },
  });
  const tenant = randomUUID();
  const contact = randomUUID();
  const identity = randomUUID();

  t.after(async () => {
    await owner.cg4RolloutState.deleteMany({ where: { tenantId: tenant } });
    await owner.cgReservation.updateMany({
      where: { tenantId: tenant },
      data: { authorizationDecisionId: null },
    });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId: tenant } });
    await owner.cgReservation.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyApproval.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyTestArtifact.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyActivationJob.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyScopeHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4Policy.deleteMany({ where: { tenantId: tenant } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId: tenant } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId: tenant } });
    await owner.cgCommandReceipt.deleteMany({ where: { tenantId: tenant } });
    await owner.cgContactStateHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cgConsent.deleteMany({ where: { tenantId: tenant } });
    await owner.contactIdentity.deleteMany({ where: { tenantId: tenant } });
    await owner.contact.deleteMany({ where: { tenantId: tenant } });
    await owner.tenant.deleteMany({ where: { id: tenant } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenant,
      name: `Consent ${tenant}`,
      slug: `consent-${tenant}`,
      sipDomain: `${tenant}.consent.test`,
    },
  });
  await owner.contact.create({ data: { id: contact, tenantId: tenant, displayName: 'Consent' } });
  await owner.contactIdentity.create({
    data: {
      id: identity,
      tenantId: tenant,
      contactId: contact,
      type: 'PHONE',
      value: `+6680${tenant.replace(/\D/g, '').slice(0, 7).padEnd(7, '0')}`,
    },
  });

  const subject = (
    id: string,
    capabilities: Cg4Capability[],
    scopeKey: string,
  ): Cg4AuthorizationSubject => ({
    subjectId: cg4SubjectId(id),
    tenantId: tenantIdBrand('00000000-0000-0000-0000-000000000000'),
    authenticationStrength: 'STANDARD',
    capabilities: capabilities.map((capability) => ({
      capability,
      scopeKey,
      source: 'DIRECT' as const,
    })),
    directComplianceAuthority: true,
    emergencyAuthority: false,
    authorizationEpoch: 1,
    scopeVersion: 1,
    evaluatedAt: NOW.toISOString(),
  });
  const lifecycle = new Cg4PolicyLifecycleRepository(application, { now: () => NOW });
  const approvals = new Cg4ApprovalRepository(application, { now: () => NOW });
  const service = new ContactGovernanceService(application, { now: () => NOW });
  const command = (actor: Cg4AuthorizationSubject) => ({
    actor,
    evidenceRef: 'evidence:consent',
    occurredAt: NOW.toISOString(),
    idempotencyKey: randomUUID(),
  });

  /** draft -> test -> submit -> approve by `checkers` -> publish; returns the diff class it needed */
  const publishPolicy = async (
    scopeKey: string,
    policyContent: Record<string, unknown>,
    checkers: string[],
    policyId?: string,
  ) => {
    const maker = subject(MAKER, ['cg.policy.draft'], scopeKey);
    const draft = await lifecycle.createDraft({
      tenantId: tenant,
      ...(policyId ? { policyId } : {}),
      scopeKey,
      content: policyContent,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      ...command(maker),
    });
    const tested = await lifecycle.runTests({
      tenantId: tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedContentDigest: draft.contentDigest,
      tenantPack: TENANT_PACK,
      pinnedEvaluationTime: PINNED_TIME,
      pinnedTimezone: PINNED_ZONE,
      ...command(maker),
    });
    assert.equal(tested.preview.tests.outcome, 'PASS');
    await lifecycle.submit({
      tenantId: tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedDraftRevision: draft.draftRevision,
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: tested.preview.artifactDigest,
      ...command(maker),
    });
    const diffClass = tested.preview.diffClass;
    for (const checker of checkers) {
      await approvals.recordPolicyApproval({
        tenantId: tenant,
        policyId: draft.policyId,
        expectedVersion: draft.version,
        expectedContentDigest: draft.contentDigest,
        diffClass,
        decision: 'APPROVE',
        evidenceRef: `evidence:approval:${checker}`,
        makerSubjectId: MAKER,
        scopeKey,
        checker: subject(
          checker,
          [diffClass === 'RELAXATION' ? 'cg.policy.publish.relaxation' : 'cg.policy.publish'],
          scopeKey,
        ),
        idempotencyKey: randomUUID(),
      });
    }
    const head = await lifecycle.preview({
      tenantId: tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedContentDigest: draft.contentDigest,
      tenantPack: TENANT_PACK,
      pinnedEvaluationTime: PINNED_TIME,
      pinnedTimezone: PINNED_ZONE,
    });
    await lifecycle.finalizeApproval({
      tenantId: tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: tested.preview.artifactDigest,
      expectedDiffClass: diffClass,
      expectedScopeHeadVersion: head.baseHeadVersion,
      expectedScopeHeadDigest: head.baseHeadDigest,
      activateAt: NOW.toISOString(),
      ...command(subject('consent-finalizer', ['cg.policy.draft'], scopeKey)),
    });
    const row = await owner.cg4Policy.findFirstOrThrow({
      where: { tenantId: tenant, policyId: draft.policyId, version: draft.version },
    });
    await lifecycle.publish({
      tenantId: tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: tested.preview.artifactDigest,
      expectedApprovalDigest: row.approvalDigest as string,
      expectedScopeHeadVersion: head.baseHeadVersion,
      expectedScopeHeadDigest: head.baseHeadDigest,
      ...command(subject('consent-publisher', ['cg.policy.publish'], scopeKey)),
    });
    return diffClass;
  };

  /** the rollout stage is the operator's switch (CG4.10); seeded directly, its transitions are tested elsewhere */
  const readCg4Policies = () =>
    owner.cg4RolloutState.create({
      data: {
        tenantId: tenant,
        stage: 'INTERNAL_ENABLED',
        version: 1,
        shadowStartedAt: NOW,
        switchedAt: NOW,
        updatedByRef: 'operator-consent',
        evidenceRef: 'evidence:rollout',
        updatedAt: NOW,
      },
    });

  const consent = (status: 'GRANTED' | 'REVOKED', expiresAt?: Date, identityId?: string) =>
    owner.cgConsent.create({
      data: {
        tenantId: tenant,
        contactId: contact,
        ...(identityId ? { identityId } : {}),
        purpose: 'SERVICE',
        channel: 'VOICE',
        status,
        lawfulBasis: 'CONSENT',
        evidence: { source: 'consent-waiver-test' },
        grantedAt: new Date('2025-12-01T00:00:00.000Z'),
        ...(status === 'REVOKED' ? { revokedAt: new Date('2026-01-01T00:00:00.000Z') } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
    });

  let actions = 0;
  const authorize = (purpose = 'SERVICE') => {
    const key = `consent:${tenant}:${++actions}`;
    return service
      .authorizeAndReserve(tenant, {
        contactId: contact,
        identityId: identity,
        channel: 'VOICE',
        purpose,
        source: 'AGENT',
        sourceId: 'consent-waiver-test',
        actionKey: key,
        policyVersion: 1,
      } as never)
      .then((outcome) => ({ outcome, key }));
  };

  const otherIdentity = randomUUID();
  await owner.contactIdentity.create({
    data: {
      id: otherIdentity,
      tenantId: tenant,
      contactId: contact,
      type: 'PHONE',
      value: `+6681${tenant.replace(/\D/g, '').slice(0, 7).padEnd(7, '0')}`,
    },
  });

  return {
    owner,
    tenant,
    contact,
    otherIdentity,
    service,
    publishPolicy,
    readCg4Policies,
    consent,
    authorize,
  };
}

const consentEntry = (trace: unknown) =>
  (trace as { gate: string; outcome: string; reasonCode?: string; lawfulBasis?: string }[]).find(
    (entry) => entry.gate === 'CONSENT',
  );

test('#1065 a policy that does not require consent needs two checkers, then lets work without a consent record through with its lawful basis pinned', async (t) => {
  const f = await fixture(t);
  await f.readCg4Policies();

  // one checker is not enough for a relaxation
  await assert.rejects(
    f.publishPolicy(VOICE_SERVICE, content(WAIVER), ['consent-checker-1']),
    (error: unknown) => error instanceof Cg4QuorumNotMetError,
  );
  await f.owner.cg4PolicyApproval.deleteMany({ where: { tenantId: f.tenant } });
  await f.owner.cg4PolicyTestArtifact.deleteMany({ where: { tenantId: f.tenant } });
  await f.owner.cg4Policy.deleteMany({ where: { tenantId: f.tenant } });

  const diffClass = await f.publishPolicy(VOICE_SERVICE, content(WAIVER), [
    'consent-checker-1',
    'consent-checker-2',
  ]);
  assert.equal(diffClass, 'RELAXATION');

  const { outcome, key } = await f.authorize();
  assert.equal(outcome.decision, 'ALLOW', JSON.stringify(outcome));
  assert.ok(outcome.reservationId);
  const log = await f.owner.cgDecisionLog.findFirstOrThrow({
    where: { tenantId: f.tenant, actionKey: key },
  });
  assert.deepEqual(consentEntry(log.trace), {
    gate: 'CONSENT',
    outcome: 'PASS',
    reasonCode: 'CONSENT_NOT_REQUIRED',
    lawfulBasis: 'CONTRACT',
  });
  // the decision pins the policy version that waived consent
  const policy = await f.owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.tenant, scopeKey: VOICE_SERVICE, status: 'ACTIVE' },
  });
  const pins = log.cg4 as { policy: { policyVersionId: string; policyContentDigest: string } };
  assert.equal(pins.policy.policyVersionId, policy.id);
  assert.equal(pins.policy.policyContentDigest, policy.contentDigest);

  // re-authorizing the same work after a contact event comes to the same answer
  await f.owner.cgContactStateHead.create({
    data: {
      tenantId: f.tenant,
      contactId: f.contact,
      aggregateVersion: 1,
      currentDigest: 'c'.repeat(64),
    },
  });
  const revalidated = await f.service.revalidateAuthorizedAction({
    tenantId: tenantIdBrand(f.tenant),
    reservationId: reservationIdBrand(outcome.reservationId!),
    actionKey: actionKeyBrand(key),
    correlationId: 'consent-revalidate',
    sourceAggregateType: 'CONTACT',
    sourceAggregateId: f.contact,
    sourceAggregateVersion: 1,
  });
  assert.equal(revalidated.decision, 'ALLOW', JSON.stringify(revalidated));
});

test('#1065 consent the customer revoked, or that expired, still blocks under a policy that does not require it', async (t) => {
  const f = await fixture(t);
  await f.readCg4Policies();
  await f.publishPolicy(VOICE_SERVICE, content(WAIVER), ['consent-checker-1', 'consent-checker-2']);

  await f.consent('GRANTED', new Date('2026-01-02T00:00:00.000Z'));
  const expired = await f.authorize();
  assert.equal(expired.outcome.decision, 'BLOCK');
  assert.equal(expired.outcome.reasonCode, 'CONSENT_EXPIRED');

  await f.consent('REVOKED');
  const revoked = await f.authorize();
  assert.equal(revoked.outcome.decision, 'BLOCK');
  assert.equal(revoked.outcome.reasonCode, 'CONSENT_REVOKED');
});

test('#1065 the waiver decides nothing while the tenant still reads CG3 policies, nor outside its own purpose', async (t) => {
  const f = await fixture(t);
  await f.publishPolicy(VOICE_SERVICE, content(WAIVER), ['consent-checker-1', 'consent-checker-2']);

  // no rollout state: the tenant reads CG3 policies, which cannot waive consent
  const cg3 = await f.authorize();
  assert.equal(cg3.outcome.decision, 'BLOCK');
  assert.equal(cg3.outcome.reasonCode, 'CONSENT_REQUIRED');

  await f.readCg4Policies();
  const otherPurpose = await f.authorize('SUPPORT');
  assert.equal(otherPurpose.outcome.decision, 'BLOCK');
  assert.equal(otherPurpose.outcome.reasonCode, 'CONSENT_REQUIRED');
  assert.equal((await f.authorize()).outcome.decision, 'ALLOW');
});

test('#1065 the policy studio refuses a waiver for marketing or for a scope without a purpose and a channel', async (t) => {
  const f = await fixture(t);
  for (const scope of [
    buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'MARKETING' }),
    buildCg4PolicyScopeKey({ channel: 'VOICE' }),
    buildCg4PolicyScopeKey({ purpose: 'SERVICE' }),
  ]) {
    await assert.rejects(
      f.publishPolicy(scope, content(WAIVER), ['consent-checker-1', 'consent-checker-2']),
      (error: unknown) =>
        error instanceof Cg4PolicyValidationError && error.code === 'SCOPE_INVALID',
      scope,
    );
  }
});

test('#1065 a consent the customer revoked on another of their numbers still blocks under the waiver', async (t) => {
  const f = await fixture(t);
  await f.readCg4Policies();
  await f.publishPolicy(VOICE_SERVICE, content(WAIVER), ['consent-checker-1', 'consent-checker-2']);
  await f.consent('REVOKED', undefined, f.otherIdentity);
  const revoked = await f.authorize();
  assert.equal(revoked.outcome.decision, 'BLOCK');
  assert.equal(revoked.outcome.reasonCode, 'CONSENT_REVOKED');
});

test('#1065 without a consent record, a policy head that cannot be read means REVIEW, not BLOCK', async (t) => {
  const f = await fixture(t);
  await f.readCg4Policies();
  await f.publishPolicy(VOICE_SERVICE, content(WAIVER), ['consent-checker-1', 'consent-checker-2']);
  const policy = await f.owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.tenant, scopeKey: VOICE_SERVICE, status: 'ACTIVE' },
  });
  // a scheduled activation that is due but the worker has not activated yet
  await f.owner.cg4PolicyActivationJob.create({
    data: {
      tenantId: f.tenant,
      policyId: policy.policyId,
      policyVersion: policy.version,
      scopeKey: VOICE_SERVICE,
      scheduledFor: new Date(NOW.getTime() - 60_000),
    },
  });
  const { outcome, key } = await f.authorize();
  assert.equal(outcome.decision, 'REVIEW');
  assert.equal(outcome.reasonCode, 'POLICY_ACTIVATION_PENDING');
  const log = await f.owner.cgDecisionLog.findFirstOrThrow({
    where: { tenantId: f.tenant, actionKey: key },
  });
  assert.equal(consentEntry(log.trace), undefined);
});

test('#1065 once the policy requires consent again, work allowed by the waiver no longer revalidates', async (t) => {
  const f = await fixture(t);
  await f.readCg4Policies();
  await f.publishPolicy(VOICE_SERVICE, content(WAIVER), ['consent-checker-1', 'consent-checker-2']);
  const { outcome, key } = await f.authorize();
  assert.equal(outcome.decision, 'ALLOW');
  const waived = await f.owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.tenant, scopeKey: VOICE_SERVICE, status: 'ACTIVE' },
  });
  const diffClass = await f.publishPolicy(
    VOICE_SERVICE,
    content(),
    ['consent-checker-1'],
    waived.policyId,
  );
  assert.equal(diffClass, 'TIGHTENING');
  await f.owner.cgContactStateHead.create({
    data: {
      tenantId: f.tenant,
      contactId: f.contact,
      aggregateVersion: 1,
      currentDigest: 'c'.repeat(64),
    },
  });
  const revalidated = await f.service.revalidateAuthorizedAction({
    tenantId: tenantIdBrand(f.tenant),
    reservationId: reservationIdBrand(outcome.reservationId!),
    actionKey: actionKeyBrand(key),
    correlationId: 'consent-revalidate-tightened',
    sourceAggregateType: 'CONTACT',
    sourceAggregateId: f.contact,
    sourceAggregateVersion: 1,
  });
  assert.equal(revalidated.decision, 'BLOCK');
  assert.equal(revalidated.reasonCode, 'CONSENT_REQUIRED');
});
