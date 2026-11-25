import { teamWriterRace } from '@d-contact/db/testing/team-reference-races.js';
/**
 * J2.9 follow-up — proves crash recovery of the originate barrier:
 * a row stuck in `ORIGINATING` until the lease expires must be swept into `RECONCILING` without originating again
 * and without touching the Governance reservation at all
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import type { TeamContactScopeAuthorizer } from '@d-contact/cxa-contracts';
import { CampaignFixtures, openOriginateGate } from './campaign-fixtures.js';
import { DialerOriginateBarrier } from './dialer-originate-barrier.js';
import { DialerOriginateReconciler } from './dialer-originate-reconciler.js';
import { ScriptedTelephonyTransport } from './dialer-telephony-test-transport.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const allowAllScope: TeamContactScopeAuthorizer = {
  async authorize(input) {
    return { decision: 'ALLOW', scopeVersion: 1, evaluatedAt: input.at };
  },
};

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const contactId = randomUUID();
  const queueId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.9 reconcile ${suffix}`,
      slug: `j2-9-reconcile-${suffix}`,
      sipDomain: `${suffix}.j2-9-reconcile.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Dialer' } });
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'J2.9 contact' } });
  await owner.queue.create({
    data: { id: queueId, tenantId, name: 'Collections', channels: ['VOICE'] },
  });

  const fixtures = new CampaignFixtures(application);
  const campaignId = randomUUID();
  await fixtures.upsertCampaign({ tenantId, id: campaignId, key: 'campaign-1', status: 'ACTIVE' });

  t.after(async () => {
    await owner.cgReservationCommandReceipt.deleteMany({ where: { tenantId } });
    await owner.cgTouch.deleteMany({ where: { tenantId } });
    await owner.cgAttempt.deleteMany({ where: { tenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId } });
    await owner.obOriginateRolloutAudit.deleteMany({ where: { tenantId } });
    await owner.obOriginateRolloutScope.deleteMany({ where: { tenantId } });
    await owner.obOriginateRollout.deleteMany({ where: { tenantId } });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.cgConsent.deleteMany({ where: { tenantId } });
    await owner.obCampaignTarget.deleteMany({ where: { tenantId } });
    await owner.obCallback.deleteMany({ where: { tenantId } });
    await owner.obCampaignAdmissionPolicy.deleteMany({ where: { tenantId } });
    await owner.obCampaign.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  return { owner, application, tenantId, teamId, contactId, queueId, campaignId };
}

/** Simulates a crash: a row stuck in ORIGINATING whose lease has already expired */
function stuckTarget(f: Awaited<ReturnType<typeof fixture>>, leaseExpiresAt: Date) {
  return f.owner.obCampaignTarget.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      campaignId: f.campaignId,
      contactId: f.contactId,
      state: 'ORIGINATING',
      originateLeaseExpiresAt: leaseExpiresAt,
      sourceOwnerTeamId: f.teamId,
      targetOwnerTeamId: f.teamId,
      admissionPolicyVersion: 1,
    },
  });
}

function stuckCallback(f: Awaited<ReturnType<typeof fixture>>, leaseExpiresAt: Date) {
  return f.owner.obCallback.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      contactId: f.contactId,
      queueId: f.queueId,
      requestedFor: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60 * 60_000),
      state: 'ORIGINATING',
      originateLeaseExpiresAt: leaseExpiresAt,
      sourceOwnerTeamId: f.teamId,
      targetOwnerTeamId: f.teamId,
    },
  });
}

test('a target stuck in ORIGINATING until the lease expires is swept into RECONCILING and does not originate again', async (t) => {
  const f = await fixture(t);
  const target = await stuckTarget(f, new Date(Date.now() - 60_000));
  const reconciler = new DialerOriginateReconciler(f.application);

  const evidence = await reconciler.reconcileExpired(f.tenantId, 'corr-reconcile');

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.kind, 'campaign_target');
  assert.equal(evidence[0]!.recordId, target.id);

  const updated = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(updated.state, 'RECONCILING');
  assert.equal(updated.originateLeaseExpiresAt, null);
  // Must not touch Governance: no new reservation and no extra attempt/touch
  assert.equal(await f.owner.cgReservation.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await f.owner.cgAttempt.count({ where: { tenantId: f.tenantId } }), 0);
});

test('a callback stuck in ORIGINATING until the lease expires is likewise swept into RECONCILING', async (t) => {
  const f = await fixture(t);
  const callback = await stuckCallback(f, new Date(Date.now() - 60_000));
  const reconciler = new DialerOriginateReconciler(f.application);

  const evidence = await reconciler.reconcileExpired(f.tenantId, 'corr-reconcile');

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.kind, 'callback');

  const updated = await f.owner.obCallback.findUniqueOrThrow({ where: { id: callback.id } });
  assert.equal(updated.state, 'RECONCILING');
  assert.equal(updated.originateLeaseExpiresAt, null);
});

test('a row whose lease has not expired (originate is really in progress) must not be touched', async (t) => {
  const f = await fixture(t);
  const target = await stuckTarget(f, new Date(Date.now() + 60_000));
  const reconciler = new DialerOriginateReconciler(f.application);

  const evidence = await reconciler.reconcileExpired(f.tenantId, 'corr-reconcile');

  assert.equal(evidence.length, 0);
  const unchanged = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(unchanged.state, 'ORIGINATING');
});

test('running the sweeper again is a replay, not a second settle', async (t) => {
  const f = await fixture(t);
  const target = await stuckTarget(f, new Date(Date.now() - 60_000));
  const reconciler = new DialerOriginateReconciler(f.application);

  const first = await reconciler.reconcileExpired(f.tenantId, 'corr-1');
  const second = await reconciler.reconcileExpired(f.tenantId, 'corr-2');

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);

  const updated = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(updated.state, 'RECONCILING');
  // The version moves only once (1 -> 2); the second round does not write again
  assert.equal(updated.version, 2);
});

test('the sweeper does not cross tenants — stuck rows of another tenant are not swept', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const mine = await stuckTarget(f, new Date(Date.now() - 60_000));
  const theirs = await stuckTarget(other, new Date(Date.now() - 60_000));
  const reconciler = new DialerOriginateReconciler(f.application);

  const evidence = await reconciler.reconcileExpired(f.tenantId, 'corr-1');

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.recordId, mine.id);
  const untouched = await other.owner.obCampaignTarget.findUniqueOrThrow({
    where: { id: theirs.id },
  });
  assert.equal(untouched.state, 'ORIGINATING');
});

test('a normally successful originate clears the lease, so the sweeper does not sweep it later', async (t) => {
  const f = await fixture(t);
  await f.owner.cgConsent.create({
    data: {
      tenantId: f.tenantId,
      contactId: f.contactId,
      purpose: 'CAMPAIGN_OUTREACH',
      channel: 'VOICE',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
  });
  const gate = await openOriginateGate(f.application, f.tenantId, 'SCOPED_INTERNAL_ENABLED', {
    campaigns: [f.campaignId],
  });
  const barrier = new DialerOriginateBarrier(
    f.application,
    new ContactGovernanceService(f.application),
    allowAllScope,
    gate,
    { transport: new ScriptedTelephonyTransport() },
  );
  const target = await f.owner.obCampaignTarget.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      campaignId: f.campaignId,
      contactId: f.contactId,
      state: 'ADMITTED',
      sourceOwnerTeamId: f.teamId,
      targetOwnerTeamId: f.teamId,
      admissionPolicyVersion: 1,
    },
  });

  assert.equal(
    await barrier.originateCampaignTarget(f.tenantId, target.id, 'corr-1'),
    'ORIGINATED',
  );

  const settled = await f.owner.obCampaignTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(settled.state, 'CONSUMED');
  assert.equal(settled.originateLeaseExpiresAt, null);

  const evidence = await new DialerOriginateReconciler(f.application).reconcileExpired(
    f.tenantId,
    'corr-2',
  );
  assert.deepEqual(evidence, []);
});

for (const kind of ['campaign', 'callback'] as const)
  for (const order of ['writer-first', 'deactivate-first'] as const)
    test(`Core Team fence: actual ${kind} originate reconcile ${order}`, async (t) => {
      const f = await fixture(t);
      if (kind === 'campaign') await stuckTarget(f, new Date(Date.now() - 60000));
      else await stuckCallback(f, new Date(Date.now() - 60000));
      await teamWriterRace({
        owner: f.owner,
        tenantId: f.tenantId,
        teamId: f.teamId,
        table: kind === 'campaign' ? 'ob_campaign_targets' : 'ob_callbacks',
        order,
        existingReferences: true,
        write: () =>
          new DialerOriginateReconciler(f.application).reconcileExpired(f.tenantId, randomUUID()),
      });
    });
