/**
 * S2.3 (#367) acceptance: durable control plane on real Postgres with the application role (RLS in effect)
 *
 * Covers `S2-LINE-AU01` (authority/approval/one-shot), `S2-LINE-CC01` (cap/concurrency/kill)
 * and the negative checks on the TI/RC/OB side: tenant isolation, restart, worker race, cap reservation,
 * kill latch, credential rotation and quota that fails closed
 *
 * No network, no LINE SDK, no credential value and no PII — every value is a synthetic fixture
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { DlLineCredentialRef, DlLineScopeGate } from '@d-contact/db';
import { LINE_PILOT_CAPS } from '@d-contact/cxa-contracts';
import {
  LineControlPlane,
  type LineControlActor,
  type LineControlOutcome,
  type LineRunResult,
} from './line-control-plane.js';
import { LineControlAuthorizationError, type LineQuotaSnapshot } from './line-control-policy.js';
import type { LineGateScope } from './line-control-repository.js';
import { assertRedactedPayload } from './line-credential-boundary.js';
import {
  createLinePersistenceFixture,
  digest,
  PILOT_CHANNEL_ACCOUNT_ID,
  type LinePersistenceFixture,
} from './line-persistence-fixture.js';

async function fixture(t: TestContext): Promise<LinePersistenceFixture> {
  const context = await createLinePersistenceFixture();
  t.after(() => context.dispose());
  return context;
}

const T0 = new Date('2026-09-22T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const DAY_MINUTES = 24 * 60;

const CONFIG_DIGEST = digest('s2.3-config-v1');
const CONTENT_DIGEST = digest('s2.3-content-v1');
const CONTENT_REF = 'fixture:service-notification/v1';

const operator: LineControlActor = { role: 'PLATFORM_OPERATOR', ref: 'platform-operator-1' };
const tenantAdmin: LineControlActor = { role: 'TENANT_ADMIN', ref: 'tenant-admin-1' };
const compliance: LineControlActor = { role: 'COMPLIANCE', ref: 'compliance-1' };

function quotaAt(minutes: number, totalUsage = 1): LineQuotaSnapshot {
  return { type: 'limited', targetLimit: 500, totalUsage, observedAt: at(minutes) };
}

/** Pulls the value out of an outcome that must succeed — failing here means the test's own precondition broke */
function applied<T>(outcome: LineControlOutcome<T>, label: string): T {
  assert.equal(outcome.status, 'APPLIED', `${label}: ${JSON.stringify(outcome)}`);
  return (outcome as { status: 'APPLIED'; value: T }).value;
}

function denial(result: LineRunResult | { status: string; code?: string }): string {
  assert.equal(result.status, 'DENIED', JSON.stringify(result));
  return (result as { code: string }).code;
}

interface Pilot {
  plane: LineControlPlane;
  scope: LineGateScope;
  gate: DlLineScopeGate;
  credential: DlLineCredentialRef;
  tenantId: string;
}

/**
 * Takes one scope from DISABLED all the way to CAPPED_PILOT using only real control plane commands
 * (no direct table writes) — this order is the deploy order of #358 §A/§E
 */
async function bootstrapPilot(
  context: LinePersistenceFixture,
  tenantId: string,
  options: {
    credentialVersion?: number;
    state?: 'DRY_RUN' | 'PROVIDER_CONFORMANCE' | 'CAPPED_PILOT';
  } = {},
): Promise<Pilot> {
  const plane = new LineControlPlane({ control: context.control, audit: context.audit });
  const scope = context.scope(tenantId);
  const target = options.state ?? 'CAPPED_PILOT';
  let gate = await plane.ensureScope(operator, scope);
  gate = applied(await plane.advanceState(compliance, gate, 'DRY_RUN', null, at(0)), 'DRY_RUN');
  if (target !== 'DRY_RUN') {
    gate = applied(
      await plane.advanceState(compliance, gate, 'PROVIDER_CONFORMANCE', CONFIG_DIGEST, at(0)),
      'PROVIDER_CONFORMANCE',
    );
  }
  if (target === 'CAPPED_PILOT') {
    gate = applied(
      await plane.advanceState(compliance, gate, 'CAPPED_PILOT', null, at(0)),
      'CAPPED_PILOT',
    );
  }
  gate = applied(await plane.setTechnicalSwitch(operator, gate, true, at(0)), 'switch');

  const candidate = await plane.registerCredential(
    operator,
    {
      tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
      version: options.credentialVersion ?? 1,
      keychainService: 'd-contact.line.2007056595',
      keychainAccount: 'channel-access-token',
      fingerprint: digest(`fingerprint-${tenantId}-${options.credentialVersion ?? 1}`),
      issuedAt: new Date('2026-09-22T00:00:00.000Z'),
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
    },
    at(0),
  );
  const credential = applied(
    await plane.verifyAndActivateCredential(
      operator,
      tenantId,
      candidate.id,
      { channelAccountId: PILOT_CHANNEL_ACCOUNT_ID, verifiedAt: at(0) },
      at(0),
    ),
    'activate',
  );
  return { plane, scope, gate, credential, tenantId };
}

/** allowlist + proposal + two-layer approval for one recipient */
async function approveRunFor(
  pilot: Pilot,
  label: string,
  recipientFingerprint: string,
  proposedAt: Date,
) {
  // A single tuple can have only one row per the unique index — the same recipient always reuses the same allowlist
  const allowlistEntry =
    (await pilot.plane.findAllowlistEntry(
      pilot.tenantId,
      pilot.gate.id,
      recipientFingerprint,
      CONTENT_DIGEST,
      CONFIG_DIGEST,
    )) ??
    (await pilot.plane.registerAllowlistEntry(
      tenantAdmin,
      {
        tenantId: pilot.tenantId,
        gateId: pilot.gate.id,
        scope: pilot.scope,
        recipientFingerprint,
        recipientProtectedRef: `prot:recipient:${randomUUID()}`,
        contentRef: CONTENT_REF,
        contentDigest: CONTENT_DIGEST,
        configDigest: CONFIG_DIGEST,
        validFrom: at(-60),
        validUntil: at(90 * DAY_MINUTES),
        approvalAuditRef: `audit:allowlist:${label}`,
      },
      proposedAt,
    ));
  const proposed = applied(
    await pilot.plane.proposeRun(
      operator,
      {
        tenantId: pilot.tenantId,
        gate: pilot.gate,
        allowlistEntry,
        credential: pilot.credential,
        proposalRef: `run-${label}`,
        proposedAt,
      },
      proposedAt,
    ),
    `propose ${label}`,
  );
  applied(
    await pilot.plane.approveRun(tenantAdmin, pilot.tenantId, proposed.id, proposedAt),
    `approve tenant ${label}`,
  );
  const run = applied(
    await pilot.plane.approveRun(compliance, pilot.tenantId, proposed.id, proposedAt),
    `approve compliance ${label}`,
  );
  return { allowlistEntry, run };
}

function beginCommand(
  pilot: Pilot,
  runAuthorizationId: string,
  deliveryId: string,
  recipientFingerprint: string,
  minutes: number,
) {
  return {
    tenantId: pilot.tenantId,
    scope: pilot.scope,
    runAuthorizationId,
    deliveryId,
    recipientFingerprint,
    contentDigest: CONTENT_DIGEST,
    configDigest: CONFIG_DIGEST,
    quota: quotaAt(minutes),
    at: at(minutes),
  };
}

// ── Rollout ladder (#358 §A) ─────────────────────────────────────────────────

test('ladder: each step opens one more layer of rights, and a scope with no gate always answers generically', async (t) => {
  const context = await fixture(t);
  const plane = new LineControlPlane({ control: context.control, audit: context.audit });

  // No gate yet: does not reveal whether this tenant/scope really exists
  assert.equal(
    denial(
      await plane.evaluate({
        scope: context.scope(context.tenantB),
        operation: 'LOCAL_VALIDATION',
        at: at(0),
      }),
    ),
    'LINE_GATE_SCOPE_NOT_ALLOWED',
  );

  const pilot = await bootstrapPilot(context, context.tenantA, { state: 'DRY_RUN' });
  const check = async (operation: 'LOCAL_VALIDATION' | 'TOKEN_VERIFY' | 'PUSH') =>
    plane.evaluate({
      scope: pilot.scope,
      operation,
      at: at(1),
      configDigest: CONFIG_DIGEST,
      quota: quotaAt(1),
    });

  assert.equal((await check('LOCAL_VALIDATION')).status, 'ALLOWED');
  assert.equal(denial(await check('TOKEN_VERIFY')), 'LINE_GATE_AUTHORIZATION_DENIED');
  assert.equal(denial(await check('PUSH')), 'LINE_GATE_AUTHORIZATION_DENIED');

  // DRY_RUN checks the real allowlist, differing only in having no network: a recipient not in the allowlist is rejected
  const dryRun = (recipientFingerprint: string) =>
    plane.evaluate({
      scope: pilot.scope,
      operation: 'LOCAL_VALIDATION',
      at: at(1),
      configDigest: CONFIG_DIGEST,
      recipientFingerprint,
      contentDigest: CONTENT_DIGEST,
    });
  const recipient = digest('r-ladder');
  assert.equal(denial(await dryRun(recipient)), 'LINE_GATE_SCOPE_NOT_ALLOWED');
  await plane.registerAllowlistEntry(
    tenantAdmin,
    {
      tenantId: pilot.tenantId,
      gateId: pilot.gate.id,
      scope: pilot.scope,
      recipientFingerprint: recipient,
      recipientProtectedRef: `prot:recipient:${randomUUID()}`,
      contentRef: CONTENT_REF,
      contentDigest: CONTENT_DIGEST,
      configDigest: CONFIG_DIGEST,
      validFrom: at(-60),
      validUntil: at(DAY_MINUTES),
      approvalAuditRef: 'audit:allowlist:ladder',
    },
    at(1),
  );
  assert.equal((await dryRun(recipient)).status, 'ALLOWED');
  assert.equal(denial(await dryRun(digest('r-ladder-other'))), 'LINE_GATE_SCOPE_NOT_ALLOWED');

  let gate = (await plane.findGate(pilot.scope))!;
  gate = applied(
    await plane.advanceState(compliance, gate, 'PROVIDER_CONFORMANCE', CONFIG_DIGEST, at(1)),
    'conformance',
  );
  assert.equal((await check('TOKEN_VERIFY')).status, 'ALLOWED');
  assert.equal(
    denial(await check('PUSH')),
    'LINE_GATE_AUTHORIZATION_DENIED',
    'conformance still must not push',
  );

  // Steps cannot be skipped, and once the switch is off everything goes back to closed immediately
  assert.equal(
    denial(await plane.advanceState(compliance, gate, 'DISABLED', null, at(2))),
    'LINE_GATE_INVALID_TRANSITION',
  );
  gate = applied(await plane.setTechnicalSwitch(operator, gate, false, at(2)), 'switch off');
  assert.equal(denial(await check('LOCAL_VALIDATION')), 'LINE_GATE_TECHNICAL_SWITCH_OFF');

  // CAS: writing over with an old version is impossible, must always re-read first
  const stale = await plane.setTechnicalSwitch(
    operator,
    { ...gate, version: gate.version - 1 },
    true,
    at(3),
  );
  assert.equal(stale.status, 'STALE');
});

// ── Authority (#358 §E) — S2-LINE-AU01 ───────────────────────────────────────

test('authority: a wrong role is rejected before touching state, and the proposer cannot approve their own', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);

  await assert.rejects(
    pilot.plane.advanceState(operator, pilot.gate, 'DRY_RUN', null, at(1)),
    LineControlAuthorizationError,
  );
  await assert.rejects(
    pilot.plane.setTechnicalSwitch(compliance, pilot.gate, true, at(1)),
    LineControlAuthorizationError,
  );
  await assert.rejects(
    pilot.plane.registerAllowlistEntry(
      operator,
      {
        tenantId: pilot.tenantId,
        gateId: pilot.gate.id,
        scope: pilot.scope,
        recipientFingerprint: digest('r-authority'),
        recipientProtectedRef: `prot:recipient:${randomUUID()}`,
        contentRef: CONTENT_REF,
        contentDigest: CONTENT_DIGEST,
        configDigest: CONFIG_DIGEST,
        validFrom: at(-60),
        validUntil: at(DAY_MINUTES),
        approvalAuditRef: 'audit:allowlist:authority',
      },
      at(1),
    ),
    LineControlAuthorizationError,
  );

  const { run } = await approveRunFor(pilot, 'authority', digest('r-authority-2'), at(1));
  await assert.rejects(
    pilot.plane.approveRun(operator, pilot.tenantId, run.id, at(2)),
    LineControlAuthorizationError,
    'the executor has no right to approve',
  );
  await assert.rejects(
    pilot.plane.beginRun(compliance, beginCommand(pilot, run.id, 'dlv_none', digest('r'), 2)),
    LineControlAuthorizationError,
    'Compliance is not the executor',
  );

  // The proposer wearing the Tenant Admin hat cannot approve their own proposal
  const selfApproval = await pilot.plane.approveRun(
    { role: 'TENANT_ADMIN', ref: operator.ref },
    pilot.tenantId,
    run.id,
    at(2),
  );
  assert.equal(denial(selfApproval), 'LINE_GATE_AUTHORIZATION_DENIED');
});

test('authority: one person can hold two roles, but must confirm twice separately', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const allowlistEntry = await pilot.plane.registerAllowlistEntry(
    tenantAdmin,
    {
      tenantId: pilot.tenantId,
      gateId: pilot.gate.id,
      scope: pilot.scope,
      recipientFingerprint: digest('r-dual'),
      recipientProtectedRef: `prot:recipient:${randomUUID()}`,
      contentRef: CONTENT_REF,
      contentDigest: CONTENT_DIGEST,
      configDigest: CONFIG_DIGEST,
      validFrom: at(-60),
      validUntil: at(DAY_MINUTES),
      approvalAuditRef: 'audit:allowlist:dual',
    },
    at(1),
  );
  const run = applied(
    await pilot.plane.proposeRun(
      operator,
      {
        tenantId: pilot.tenantId,
        gate: pilot.gate,
        allowlistEntry,
        credential: pilot.credential,
        proposalRef: 'run-dual',
        proposedAt: at(1),
      },
      at(1),
    ),
    'propose',
  );

  const human = 'local-pilot-human';
  const first = applied(
    await pilot.plane.approveRun(
      { role: 'TENANT_ADMIN', ref: human },
      pilot.tenantId,
      run.id,
      at(2),
    ),
    'tenant admin',
  );
  assert.equal(first.state, 'PROPOSED', 'a single layer of approval is not enough');
  const second = applied(
    await pilot.plane.approveRun({ role: 'COMPLIANCE', ref: human }, pilot.tenantId, run.id, at(3)),
    'compliance',
  );
  assert.equal(second.state, 'APPROVED');
  // Confirming the same role again adds nothing
  assert.equal(
    (
      await pilot.plane.approveRun(
        { role: 'COMPLIANCE', ref: human },
        pilot.tenantId,
        run.id,
        at(4),
      )
    ).status,
    'DENIED',
  );
});

// ── Exact allowlist (#358 §B) ────────────────────────────────────────────────

test('allowlist: a mismatching recipient/content is rejected and kills the scope immediately', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-exact');
  const { run } = await approveRunFor(pilot, 'exact', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);

  const wrongRecipient = await pilot.plane.beginRun(operator, {
    ...beginCommand(pilot, run.id, delivery.deliveryId, digest('r-other'), 2),
  });
  assert.equal(denial(wrongRecipient), 'LINE_GATE_SCOPE_NOT_ALLOWED');
  const killed = (await pilot.plane.findGate(pilot.scope))!;
  assert.equal(killed.killed, true);
  assert.equal(killed.killReason, 'ALLOWLIST_BINDING_MISMATCH');
  assert.equal(killed.technicalSwitchOn, false, 'kill turns the switch off in the same row');

  // The authorization has not been used: the binding fails before consume
  const stillApproved = await context.control.findRun(pilot.tenantId, run.id);
  assert.equal(stillApproved?.state, 'APPROVED');
});

test('allowlist: revoke or expiry = generic rejection without a kill', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-revoke');
  const { allowlistEntry, run } = await approveRunFor(pilot, 'revoke', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);

  assert.equal(
    await pilot.plane.revokeAllowlistEntry(
      compliance,
      pilot.tenantId,
      allowlistEntry.id,
      'PILOT_ROLLBACK',
      at(2),
    ),
    true,
  );
  const result = await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 3),
  );
  assert.equal(denial(result), 'LINE_GATE_SCOPE_NOT_ALLOWED');
  assert.equal(
    (await pilot.plane.findGate(pilot.scope))!.killed,
    false,
    'a normal revoke is not a kill',
  );
  // Cannot revoke twice, and an approved tuple cannot be edited
  assert.equal(
    await pilot.plane.revokeAllowlistEntry(
      compliance,
      pilot.tenantId,
      allowlistEntry.id,
      'PILOT_ROLLBACK',
      at(4),
    ),
    false,
  );
});

// ── One-shot run authorization — S2-LINE-AU01 ────────────────────────────────

test('one-shot: five workers racing for one authorization yield exactly one winner', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-race');
  const { run } = await approveRunFor(pilot, 'race', recipient, at(1));
  const deliveries = await Promise.all(
    Array.from({ length: 5 }, () => context.seedDelivery(pilot.tenantId)),
  );

  const results = await Promise.all(
    deliveries.map((delivery) =>
      pilot.plane.beginRun(
        operator,
        beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2),
      ),
    ),
  );
  const authorized = results.filter((result) => result.status === 'AUTHORIZED');
  assert.equal(authorized.length, 1);
  for (const result of results.filter((item) => item.status === 'DENIED')) {
    assert.equal(denial(result), 'RUN_AUTHORIZATION_CONSUMED');
  }

  const consumed = await context.control.findRun(pilot.tenantId, run.id);
  assert.equal(consumed?.state, 'CONSUMED');
  assert.equal(
    consumed?.consumedDeliveryId,
    (authorized[0] as { logicalDelivery: { deliveryId: string } }).logicalDelivery.deliveryId,
  );
  // The ledger has the logical delivery unit of only the single winner
  const ledger = await context.control.listActiveCapEntries(
    pilot.tenantId,
    pilot.gate.id,
    'LOGICAL_DELIVERY',
  );
  assert.equal(ledger.length, 1);
});

test('restart: a new instance replays the same delivery with the same result, without consuming again or reserving more', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-restart');
  const { run } = await approveRunFor(pilot, 'restart', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);

  const first = await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2),
  );
  assert.equal(first.status, 'AUTHORIZED');

  // New process: all state must come from Postgres, nothing lingering in the old instance memory
  const restarted = new LineControlPlane({ control: context.control, audit: context.audit });
  const replay = await restarted.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 5),
  );
  assert.equal(replay.status, 'AUTHORIZED');
  assert.equal((replay as { barrier: string }).barrier, 'PRE');
  assert.equal(
    (await context.control.listActiveCapEntries(pilot.tenantId, pilot.gate.id, 'LOGICAL_DELIVERY'))
      .length,
    1,
    'replay must not reserve additional units',
  );

  // Cross the barrier then restart again: gets the same entitlement but it is a POST — must reconcile, not resend
  assert.equal(await restarted.commitDelivery(pilot.tenantId, delivery.deliveryId, at(6)), true);
  const afterBarrier = await restarted.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 7),
  );
  assert.equal(afterBarrier.status, 'AUTHORIZED');
  assert.equal((afterBarrier as { barrier: string }).barrier, 'POST');
  assert.equal((afterBarrier as { concurrencySlot?: unknown }).concurrencySlot, undefined);
});

// ── Caps (#358 §C) — S2-LINE-CC01 ────────────────────────────────────────────

test('cap: 1/recipient/24h and 3/24h are counted from the ledger and the allowance returns once the window passes', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);

  const send = async (label: string, recipient: string, minutes: number) => {
    const { run } = await approveRunFor(pilot, label, recipient, at(minutes));
    const delivery = await context.seedDelivery(pilot.tenantId);
    const result = await pilot.plane.beginRun(
      operator,
      beginCommand(pilot, run.id, delivery.deliveryId, recipient, minutes),
    );
    if (result.status === 'AUTHORIZED') {
      await pilot.plane.commitDelivery(pilot.tenantId, delivery.deliveryId, at(minutes));
    }
    return result;
  };

  const first = digest('r-window-1');
  assert.equal((await send('w1', first, 1)).status, 'AUTHORIZED');
  // The same recipient within 24 hours is rejected before the daily cap
  assert.equal(denial(await send('w1b', first, 2)), 'CONTACT_WINDOW_CAP_EXCEEDED');

  assert.equal((await send('w2', digest('r-window-2'), 3)).status, 'AUTHORIZED');
  assert.equal((await send('w3', digest('r-window-3'), 4)).status, 'AUTHORIZED');
  assert.equal(
    denial(await send('w4', digest('r-window-4'), 5)),
    'SUBMISSION_WINDOW_CAP_EXCEEDED',
    `exceeds ${LINE_PILOT_CAPS.logicalDeliveriesPer24h}/24h`,
  );

  // After 24 hours the window slides: the same recipient can be sent to again
  assert.equal((await send('w5', first, DAY_MINUTES + 10)).status, 'AUTHORIZED');
});

test('cap: lifetime 10 per profile is a hard stop even when the daily window is free', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const lifetime = LINE_PILOT_CAPS.logicalDeliveriesLifetime;

  const results: string[] = [];
  for (let index = 0; index <= lifetime; index += 1) {
    const minutes = index * DAY_MINUTES + 1;
    const recipient = digest(`r-life-${index}`);
    const { run } = await approveRunFor(pilot, `life-${index}`, recipient, at(minutes));
    const delivery = await context.seedDelivery(pilot.tenantId);
    const result = await pilot.plane.beginRun(
      operator,
      beginCommand(pilot, run.id, delivery.deliveryId, recipient, minutes),
    );
    results.push(result.status === 'AUTHORIZED' ? 'AUTHORIZED' : denial(result));
    if (result.status === 'AUTHORIZED') {
      await pilot.plane.commitDelivery(pilot.tenantId, delivery.deliveryId, at(minutes));
    }
  }

  assert.deepEqual(results, [...Array(lifetime).fill('AUTHORIZED'), 'LIFETIME_CAP_EXCEEDED']);
});

test('cap: concurrency 1 — the second one is rejected and the unit it just reserved is returned', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const firstRecipient = digest('r-conc-1');
  const secondRecipient = digest('r-conc-2');
  const { run: runA } = await approveRunFor(pilot, 'conc-a', firstRecipient, at(1));
  const { run: runB } = await approveRunFor(pilot, 'conc-b', secondRecipient, at(1));
  const deliveryA = await context.seedDelivery(pilot.tenantId);
  const deliveryB = await context.seedDelivery(pilot.tenantId);

  assert.equal(
    (
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runA.id, deliveryA.deliveryId, firstRecipient, 2),
      )
    ).status,
    'AUTHORIZED',
  );
  const blocked = await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, runB.id, deliveryB.deliveryId, secondRecipient, 2),
  );
  assert.equal(denial(blocked), 'CONCURRENT_SUBMISSION_CAP_EXCEEDED');

  // The unit of the rejected one must not linger and eat the daily budget
  const active = await context.control.listActiveCapEntries(
    pilot.tenantId,
    pilot.gate.id,
    'LOGICAL_DELIVERY',
  );
  assert.deepEqual(
    active.map((entry) => entry.deliveryId),
    [deliveryA.deliveryId],
  );
  // The one-shot was burned on purpose: must propose/approve again
  assert.equal((await context.control.findRun(pilot.tenantId, runB.id))?.state, 'CONSUMED');

  await pilot.plane.commitDelivery(pilot.tenantId, deliveryA.deliveryId, at(3));
  const { run: runC } = await approveRunFor(pilot, 'conc-c', secondRecipient, at(4));
  const deliveryC = await context.seedDelivery(pilot.tenantId);
  assert.equal(
    (
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runC.id, deliveryC.deliveryId, secondRecipient, 4),
      )
    ).status,
    'AUTHORIZED',
    'the slot is free after commit',
  );

  // Cannot wake a delivery that was already released — the cap counting is untrustworthy, so kill
  const resurrect = await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, runB.id, deliveryB.deliveryId, secondRecipient, 5),
  );
  assert.equal(denial(resurrect), 'CAP_ACCOUNTING_INCONSISTENCY');
  assert.equal(
    (await pilot.plane.findGate(pilot.scope))!.killReason,
    'CAP_ACCOUNTING_INCONSISTENCY',
  );
});

test('cap: provider attempts do not exceed 4 per delivery, then automatic kill', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-attempt');
  const { run } = await approveRunFor(pilot, 'attempt', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);
  const command = beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2);
  assert.equal((await pilot.plane.beginRun(operator, command)).status, 'AUTHORIZED');

  const gate = (await pilot.plane.findGate(pilot.scope))!;
  for (
    let attemptNo = 1;
    attemptNo <= LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery;
    attemptNo += 1
  ) {
    const reserved = await pilot.plane.reserveProviderAttempt(
      operator,
      command,
      gate,
      run,
      attemptNo,
    );
    assert.equal(reserved.status, 'APPLIED', `attempt ${attemptNo}`);
  }
  const exhausted = await pilot.plane.reserveProviderAttempt(
    operator,
    command,
    gate,
    run,
    LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery + 1,
  );
  assert.equal(denial(exhausted), 'PROVIDER_ATTEMPT_CAP_EXCEEDED');
  const killed = (await pilot.plane.findGate(pilot.scope))!;
  assert.equal(killed.killReason, 'PROVIDER_ATTEMPTS_EXHAUSTED');
  // A killed scope cannot reserve anything more
  assert.equal(
    denial(await pilot.plane.reserveProviderAttempt(operator, command, killed, run, 1)),
    'LINE_GATE_KILLED',
  );
});

test('unknown-reconciling: one stuck = pause new work for the whole scope, but the old one can still reconcile', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const firstRecipient = digest('r-unknown-1');
  const secondRecipient = digest('r-unknown-2');
  const { run: runA } = await approveRunFor(pilot, 'unknown-a', firstRecipient, at(1));
  const deliveryA = await context.seedDelivery(pilot.tenantId);
  const commandA = beginCommand(pilot, runA.id, deliveryA.deliveryId, firstRecipient, 2);
  assert.equal((await pilot.plane.beginRun(operator, commandA)).status, 'AUTHORIZED');
  await pilot.plane.commitDelivery(pilot.tenantId, deliveryA.deliveryId, at(3));

  const gate = (await pilot.plane.findGate(pilot.scope))!;
  assert.equal(
    (await pilot.plane.enterUnknownReconciling(commandA, gate.id, runA.id)).status,
    'APPLIED',
  );

  const { run: runB } = await approveRunFor(pilot, 'unknown-b', secondRecipient, at(4));
  const deliveryB = await context.seedDelivery(pilot.tenantId);
  assert.equal(
    denial(
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runB.id, deliveryB.deliveryId, secondRecipient, 4),
      ),
    ),
    'CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED',
  );
  // The stuck one can still reserve an attempt to reconcile with the same key
  assert.equal(
    (await pilot.plane.reserveProviderAttempt(operator, commandA, gate, runA, 1)).status,
    'APPLIED',
  );

  assert.equal(
    await pilot.plane.exitUnknownReconciling(pilot.tenantId, deliveryA.deliveryId, at(5)),
    true,
  );
  const { run: runC } = await approveRunFor(pilot, 'unknown-c', secondRecipient, at(6));
  const deliveryC = await context.seedDelivery(pilot.tenantId);
  assert.equal(
    (
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runC.id, deliveryC.deliveryId, secondRecipient, 6),
      )
    ).status,
    'AUTHORIZED',
  );
});

// ── Kill / rollback (#358 §F) ────────────────────────────────────────────────

test('kill: the latch beats every state, survives restart and can be lifted only by Compliance with a new ref', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);

  const killed = await pilot.plane.killByActor(operator, pilot.gate, at(1));
  assert.equal(killed.killReason, 'OPERATOR_KILL');
  assert.equal(killed.technicalSwitchOn, false);

  const restarted = new LineControlPlane({ control: context.control, audit: context.audit });
  assert.equal(
    denial(
      await restarted.evaluate({
        scope: pilot.scope,
        operation: 'LOCAL_VALIDATION',
        at: at(2),
        configDigest: CONFIG_DIGEST,
        quota: quotaAt(2),
      }),
    ),
    'LINE_GATE_KILLED',
  );
  assert.equal(
    denial(await restarted.setTechnicalSwitch(operator, killed, true, at(2))),
    'LINE_GATE_KILLED',
  );
  assert.equal(
    denial(await restarted.advanceState(compliance, killed, 'DRY_RUN', null, at(2))),
    'LINE_GATE_KILLED',
  );

  await assert.rejects(
    restarted.clearWithApproval(operator, killed, 'approval:kill-clear:0001', at(3)),
    LineControlAuthorizationError,
  );
  const cleared = applied(
    await restarted.clearWithApproval(compliance, killed, 'approval:kill-clear:0001', at(3)),
    'clear',
  );
  assert.equal(cleared.killed, false);
  assert.equal(
    cleared.businessState,
    'DISABLED',
    'after lifting the kill must start over from DISABLED',
  );
  assert.equal(cleared.technicalSwitchOn, false);

  // The next kill must always use a new ref, reusing the old ref is impossible
  const again = await restarted.kill(compliance, cleared, 'PILOT_ROLLBACK', at(4));
  assert.equal(
    denial(await restarted.clearWithApproval(compliance, again, 'approval:kill-clear:0001', at(5))),
    'LINE_GATE_AUTHORIZATION_DENIED',
  );
});

test('kill: before the barrier units can be released, after the barrier they cannot be', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipientA = digest('r-barrier-1');
  const recipientB = digest('r-barrier-2');
  const { run: runA } = await approveRunFor(pilot, 'barrier-a', recipientA, at(1));
  const deliveryA = await context.seedDelivery(pilot.tenantId);
  assert.equal(
    (
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runA.id, deliveryA.deliveryId, recipientA, 2),
      )
    ).status,
    'AUTHORIZED',
  );
  assert.equal(
    await pilot.plane.releaseDelivery(pilot.tenantId, deliveryA.deliveryId, at(3)),
    true,
  );
  assert.equal(
    (await context.control.listActiveCapEntries(pilot.tenantId, pilot.gate.id, 'LOGICAL_DELIVERY'))
      .length,
    0,
  );

  const { run: runB } = await approveRunFor(pilot, 'barrier-b', recipientB, at(4));
  const deliveryB = await context.seedDelivery(pilot.tenantId);
  assert.equal(
    (
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, runB.id, deliveryB.deliveryId, recipientB, 4),
      )
    ).status,
    'AUTHORIZED',
  );
  assert.equal(await pilot.plane.commitDelivery(pilot.tenantId, deliveryB.deliveryId, at(5)), true);
  assert.equal(
    await pilot.plane.releaseDelivery(pilot.tenantId, deliveryB.deliveryId, at(6)),
    false,
    'a committed unit cannot be returned',
  );
  await pilot.plane.killByActor(compliance, pilot.gate, at(7));
  const ledger = await context.owner.dlLineCapLedgerEntry.findMany({
    where: {
      tenantId: pilot.tenantId,
      deliveryId: deliveryB.deliveryId,
      capKind: 'LOGICAL_DELIVERY',
    },
  });
  assert.equal(
    ledger[0]?.state,
    'COMMITTED',
    'kill does not rewind evidence that already crossed the barrier',
  );
});

// ── Credential (#358 §G) ─────────────────────────────────────────────────────

test('credential: rotation stops a run that pinned the old version from crossing the barrier', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-rotate');
  const { run } = await approveRunFor(pilot, 'rotate', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);

  const candidate = await pilot.plane.registerCredential(
    operator,
    {
      tenantId: pilot.tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
      version: 2,
      keychainService: 'd-contact.line.2007056595',
      keychainAccount: 'channel-access-token',
      fingerprint: digest('fingerprint-rotated'),
      issuedAt: new Date('2026-09-22T00:00:00.000Z'),
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
    },
    at(2),
  );
  const rotated = applied(
    await pilot.plane.verifyAndActivateCredential(
      operator,
      pilot.tenantId,
      candidate.id,
      { channelAccountId: PILOT_CHANNEL_ACCOUNT_ID, verifiedAt: at(2) },
      at(2),
    ),
    'rotate',
  );
  assert.equal(rotated.version, 2);
  assert.equal(
    (await context.control.findCredentialRef(pilot.tenantId, pilot.credential.id))?.status,
    'RETIRED',
    'the old version must be retired in the same transaction',
  );

  assert.equal(
    denial(
      await pilot.plane.beginRun(
        operator,
        beginCommand(pilot, run.id, delivery.deliveryId, recipient, 3),
      ),
    ),
    'CREDENTIAL_VERSION_MISMATCH',
  );

  // After revoke no ACTIVE remains: every operation that touches the provider is closed
  assert.equal(
    await pilot.plane.revokeCredential(operator, pilot.tenantId, rotated.id, at(4)),
    true,
  );
  assert.equal(
    denial(
      await pilot.plane.evaluate({
        scope: pilot.scope,
        operation: 'TOKEN_VERIFY',
        at: at(5),
        configDigest: CONFIG_DIGEST,
        quota: quotaAt(5),
      }),
    ),
    'CREDENTIAL_UNAVAILABLE',
  );
});

test('credential: client_id not matching the Channel ID = does not activate and is an auth failure signal', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const candidate = await pilot.plane.registerCredential(
    operator,
    {
      tenantId: pilot.tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
      version: 9,
      keychainService: 'd-contact.line.2007056595',
      keychainAccount: 'channel-access-token',
      fingerprint: digest('fingerprint-wrong-account'),
      issuedAt: new Date('2026-09-22T00:00:00.000Z'),
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
    },
    at(1),
  );
  const result = await pilot.plane.verifyAndActivateCredential(
    operator,
    pilot.tenantId,
    candidate.id,
    { channelAccountId: '1000000000', verifiedAt: at(1) },
    at(1),
  );
  assert.equal(denial(result), 'CREDENTIAL_UNAVAILABLE');
  assert.equal((result as { signal?: string }).signal, 'AUTH_FAILURE');
  assert.equal(
    (await context.control.findCredentialRef(pilot.tenantId, candidate.id))?.status,
    'CANDIDATE',
  );
});

// ── Quota advisory (#358 §D) ─────────────────────────────────────────────────

test('quota: no snapshot = closed, quota exhausted = automatic kill, and it does not replace the durable cap', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-quota');
  const { run } = await approveRunFor(pilot, 'quota', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);

  assert.equal(
    denial(
      await pilot.plane.evaluate({
        scope: pilot.scope,
        operation: 'TOKEN_VERIFY',
        at: at(2),
        configDigest: CONFIG_DIGEST,
      }),
    ),
    'LINE_GATE_AUTHORIZATION_DENIED',
    'cannot read quota = fail closed',
  );

  const exhausted = await pilot.plane.beginRun(operator, {
    ...beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2),
    quota: { type: 'limited', targetLimit: 500, totalUsage: 500, observedAt: at(2) },
  });
  assert.equal(denial(exhausted), 'LINE_GATE_AUTHORIZATION_DENIED');
  assert.equal((await pilot.plane.findGate(pilot.scope))!.killReason, 'QUOTA_EXHAUSTED');
  assert.equal(
    (await context.control.findRun(pilot.tenantId, run.id))?.state,
    'APPROVED',
    'quota closes before the one-shot so the authorization is not burned',
  );
});

// ── Tenant isolation and audit ───────────────────────────────────────────────

test('tenant isolation: the control plane of another tenant is invisible and answers without revealing information', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-isolation');
  const { run } = await approveRunFor(pilot, 'isolation', recipient, at(1));
  const guard = await bootstrapPilot(context, context.tenantB, { credentialVersion: 1 });
  const guardDelivery = await context.seedDelivery(context.tenantB);

  // Tenant B cannot use the ID of a run on side A, and the answer does not reveal that the ID really exists
  const crossTenant = await guard.plane.beginRun(operator, {
    ...beginCommand(guard, run.id, guardDelivery.deliveryId, recipient, 2),
    tenantId: context.tenantB,
  });
  assert.equal(denial(crossTenant), 'RUN_AUTHORIZATION_MISSING');
  assert.equal(await context.control.findRun(context.tenantB, run.id), null);
  assert.equal(await context.control.findCredentialRef(context.tenantB, pilot.credential.id), null);
  assert.equal((await context.control.findRun(pilot.tenantId, run.id))?.state, 'APPROVED');
});

test('audit: every command has an append-only row, replay adds no row, and there is no forbidden field', async (t) => {
  const context = await fixture(t);
  const pilot = await bootstrapPilot(context, context.tenantA);
  const recipient = digest('r-audit');
  const { run } = await approveRunFor(pilot, 'audit', recipient, at(1));
  const delivery = await context.seedDelivery(pilot.tenantId);
  await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2),
  );

  const events = await context.audit.list(pilot.tenantId);
  const codes = events.map((event) => event.code);
  for (const expected of [
    'GATE_ADVANCED_DRY_RUN',
    'GATE_ADVANCED_PROVIDER_CONFORMANCE',
    'GATE_ADVANCED_CAPPED_PILOT',
    'GATE_TECHNICAL_SWITCH_ON',
    'CREDENTIAL_REGISTERED',
    'CREDENTIAL_ACTIVATED',
    'ALLOWLIST_REGISTERED',
    'RUN_PROPOSED',
    'RUN_APPROVED_TENANT_ADMIN',
    'RUN_APPROVED_COMPLIANCE',
    'RUN_CONSUMED',
    'CAP_RESERVED',
  ]) {
    assert.ok(codes.includes(expected), `missing audit ${expected}`);
  }
  assert.deepEqual([...new Set(events.map((event) => event.actorKind))].sort(), [
    'COMPLIANCE',
    'PLATFORM_OPERATOR',
    'TENANT_ADMIN',
  ]);
  for (const event of events) {
    assert.match(event.eventId, /^s2\.3\.[a-z_]+:[^:]+:[a-f0-9]{16}$/);
    assert.doesNotThrow(() => assertRedactedPayload(event));
  }

  // Replaying the same command with the same values: audit must not grow
  const before = events.length;
  await pilot.plane.beginRun(
    operator,
    beginCommand(pilot, run.id, delivery.deliveryId, recipient, 2),
  );
  assert.equal((await context.audit.list(pilot.tenantId)).length, before);

  // Evidence cannot be edited retroactively even by the application role
  await assert.rejects(
    context.asApplication(
      pilot.tenantId,
      `UPDATE dl_line_audit_events SET code = 'TAMPERED' WHERE tenant_id = '${pilot.tenantId}'`,
    ),
    /permission denied/,
  );
});
