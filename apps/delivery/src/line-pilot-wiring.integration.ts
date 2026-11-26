/**
 * S2.6b (#403): production wiring of the LINE pilot on real Postgres/RLS with a provider double
 *
 * Threads every path S2.7 needs into a single test: enqueue through Governance → submit with a recipient from the
 * Keychain resolver → quoted reply through signed ingress → worker + production Touch port → Touch 1.
 * No network to LINE (#403 acceptance) and the Keychain is a synthetic source/writer
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import {
  actionKey as toActionKey,
  contactId as toContactId,
  reservationId as toReservationId,
  tenantId as toTenantId,
} from '@d-contact/cxa-contracts';
import { LineAuditRepository } from './line-audit-repository.js';
import { LineControlPlane, type LineControlActor } from './line-control-plane.js';
import {
  lineSecretFingerprint,
  type LineKeychainReference,
  type LineSecretSource,
} from './line-credential-boundary.js';
import { LineDeliveryEnqueue } from './line-delivery-enqueue.js';
import {
  captureLineRecipientFromWebhook,
  KeychainLineAccessTokenResolver,
  KeychainLineRecipientResolver,
  lineRecipientKeychainReference,
} from './line-keychain-resolvers.js';
import { KeychainLineSecretWriter } from './line-keychain-secret-source.js';
import { LineOutboundAdapter } from './line-outbound-adapter.js';
import {
  createLinePersistenceFixture,
  digest,
  PILOT_CHANNEL_ACCOUNT_ID,
  PILOT_SENDER,
} from './line-persistence-fixture.js';
import { lineContentDigest } from './line-push-request.js';
import type {
  LinePushRequest,
  LineProviderTransport,
  LineTransportResult,
} from './line-provider-transport.js';
import { runLineReplayProbe, runLineRollbackDrill } from './line-pilot-drills.js';
import { LineTouchGovernanceAdapter } from './line-touch-governance.js';
import { LineWebhookIngress } from './line-webhook-ingress.js';
import { EncryptedLineWebhookPayloadVault } from './line-webhook-payload-vault.js';
import { lineSignature } from './line-webhook-signature.js';
import { LineWebhookWorker, lineSourceFingerprint } from './line-webhook-worker.js';

const OPERATOR: LineControlActor = { role: 'PLATFORM_OPERATOR', ref: 'platform-operator-1' };
const COMPLIANCE: LineControlActor = { role: 'COMPLIANCE', ref: 'compliance-1' };
const FIXTURE_REF = 'fixture:service-notification/v1';
const CONFIG_DIGEST = digest('config-v1');
const SECRET = 's2-synthetic-channel-secret';
const DESTINATION = 'U1234567890abcdef1234567890abcdef';
const KEY_REF = 'd-contact.line.webhook-payload/v1';
const PAYLOAD_KEY = randomBytes(32);
const USER_ID = `U${'d'.repeat(32)}`;
const OTHER_USER_ID = `U${'e'.repeat(32)}`;
const SENT_MESSAGE_ID = '461230966842064897';

class RecordingTransport implements LineProviderTransport {
  readonly requests: LinePushRequest[] = [];
  readonly scripted: LineTransportResult[] = [];
  revoked = true;
  async push(request: LinePushRequest): Promise<LineTransportResult> {
    this.requests.push(request);
    return (
      this.scripted.shift() ?? {
        kind: 'RESPONSE',
        response: { httpStatus: 200, requestId: 'req-pilot-1', sentMessageIds: [SENT_MESSAGE_ID] },
      }
    );
  }
  async verifyToken() {
    return { valid: true };
  }
  async getQuota() {
    return { type: 'limited', value: 500 };
  }
  async getConsumption() {
    return { totalUsage: 1 };
  }
  async validatePush() {
    return { valid: true };
  }
  async getWebhookEndpoint() {
    return { endpoint: null, active: false };
  }
  async testWebhookEndpoint() {
    return { success: false, statusCode: null };
  }
  async revokeToken() {
    return { revoked: this.revoked, httpStatus: this.revoked ? 200 : 400 };
  }
}

/** Synthetic Keychain: a map of `service|account` → value */
class MapSecretSource implements LineSecretSource {
  constructor(private readonly values: Map<string, string>) {}
  async read(reference: LineKeychainReference): Promise<string> {
    const value = this.values.get(`${reference.keychainService}|${reference.keychainAccount}`);
    if (!value) throw new Error('missing');
    return value;
  }
}

const keychainKey = (reference: LineKeychainReference) =>
  `${reference.keychainService}|${reference.keychainAccount}`;

async function setup(t: TestContext) {
  const fixture = await createLinePersistenceFixture();
  t.after(() => fixture.dispose());
  const now = new Date();
  const control = new LineControlPlane({
    control: fixture.control,
    audit: new LineAuditRepository(fixture.application),
  });
  const governance = new ContactGovernanceService(fixture.application);
  const transport = new RecordingTransport();
  const keychain = new Map<string, string>();

  /** gate/allowlist/run of the pilot where the recipient fingerprint = the LINE user who will reply */
  const approvedRun = async (tenantId: string, userId = USER_ID) => {
    const recipientProtectedRef = `kc-recipient-${randomUUID()}`;
    const run = await fixture.seedApprovedRun(tenantId, `pilot-${randomUUID().slice(0, 8)}`, {
      contentDigest: lineContentDigest(FIXTURE_REF),
      proposedAt: now,
      recipientFingerprint: lineSourceFingerprint(PILOT_CHANNEL_ACCOUNT_ID, userId),
      recipientProtectedRef,
    });
    let gate = await fixture.control.findGate(fixture.scope(tenantId));
    for (const state of ['DRY_RUN', 'PROVIDER_CONFORMANCE', 'CAPPED_PILOT'] as const) {
      const advanced = await control.advanceState(COMPLIANCE, gate!, state, CONFIG_DIGEST, now);
      assert.equal(advanced.status, 'APPLIED', `advance to ${state}`);
      gate = advanced.status === 'APPLIED' ? advanced.value : gate;
    }
    assert.equal((await control.setTechnicalSwitch(OPERATOR, gate!, true, now)).status, 'APPLIED');
    const activated = await control.verifyAndActivateCredential(
      OPERATOR,
      tenantId,
      run.credential.id,
      { channelAccountId: PILOT_CHANNEL_ACCOUNT_ID, verifiedAt: now },
      now,
    );
    assert.equal(activated.status, 'APPLIED');
    return { ...run, recipientProtectedRef };
  };

  const enqueue = new LineDeliveryEnqueue(fixture.application, governance);
  const enqueueCommand = (reservation: Awaited<ReturnType<typeof fixture.seedReservation>>) => ({
    tenantId: toTenantId(reservation.tenantId),
    correlationId: `corr-${reservation.actionKey}`,
    reservationId: toReservationId(reservation.reservationId),
    actionKey: toActionKey(reservation.actionKey),
    contactId: toContactId(reservation.contactId),
    purpose: 'SERVICE_NOTIFICATION',
    source: 'JOURNEY',
    senderIdentityId: PILOT_SENDER,
    contentRef: FIXTURE_REF,
    leaseExpiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  });

  const adapter = new LineOutboundAdapter({
    database: fixture.application,
    governance,
    control,
    transport,
    recipients: new KeychainLineRecipientResolver(
      fixture.application,
      new MapSecretSource(keychain),
    ),
    credentials: { resolve: async () => ({ accessToken: 'synthetic-channel-access-token' }) },
    actor: OPERATOR,
    configDigest: CONFIG_DIGEST,
  });

  const send = async (tenantId: string, events: unknown[]) => {
    const rawBody = Buffer.from(JSON.stringify({ destination: DESTINATION, events }), 'utf8');
    return new LineWebhookIngress(fixture.application, {
      tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      destination: DESTINATION,
      channelSecret: SECRET,
      payloadKeyRef: KEY_REF,
      payloadKey: PAYLOAD_KEY,
    }).handle({ rawBody, signature: lineSignature(rawBody, SECRET), receivedAt: new Date() });
  };
  const vault = new EncryptedLineWebhookPayloadVault(fixture.application, {
    key: (ref) => (ref === KEY_REF ? PAYLOAD_KEY : undefined),
  });
  const touchPort = new LineTouchGovernanceAdapter(fixture.application, governance);
  const worker = new LineWebhookWorker({
    database: fixture.application,
    payloads: vault,
    governance: touchPort,
    leaseOwner: 'pilot-wiring-worker',
  });

  let sequence = 0;
  const messageEvent = (userId: string, message: Record<string, unknown>) => {
    sequence += 1;
    return {
      type: 'message',
      mode: 'active',
      webhookEventId: `01JP${String(sequence).padStart(6, '0')}${randomUUID().slice(0, 6)}`,
      deliveryContext: { isRedelivery: false },
      timestamp: Date.now(),
      source: { type: 'user', userId },
      message,
    };
  };

  /** one pilot message the provider already accepted — the starting point of the replay probe and rollback drill */
  const acceptedDelivery = async (tenantId: string) => {
    const run = await approvedRun(tenantId);
    keychain.set(
      keychainKey(
        lineRecipientKeychainReference(PILOT_CHANNEL_ACCOUNT_ID, run.recipientProtectedRef),
      ),
      USER_ID,
    );
    const queued = await enqueue.enqueue(
      enqueueCommand(await fixture.seedReservation(tenantId, now)),
    );
    assert.ok(queued.status === 'QUEUED', JSON.stringify(queued));
    const command = {
      tenantId,
      deliveryId: queued.deliveryId,
      scope: fixture.scope(tenantId),
      runAuthorizationId: run.run.id,
      recipientFingerprint: lineSourceFingerprint(PILOT_CHANNEL_ACCOUNT_ID, USER_ID),
      recipientProtectedRef: run.recipientProtectedRef,
      correlationId: `corr-${queued.deliveryId}`,
      quota: { type: 'limited' as const, targetLimit: 500, totalUsage: 1, observedAt: new Date() },
    };
    const submitted = await adapter.submit(command);
    assert.equal(submitted.status, 'ACCEPTED', JSON.stringify(submitted));
    return { run, queued, command };
  };
  const drillDeps = {
    database: fixture.application,
    control,
    transport,
    recipients: new KeychainLineRecipientResolver(
      fixture.application,
      new MapSecretSource(keychain),
    ),
    credentials: { resolve: async () => ({ accessToken: 'synthetic-channel-access-token' }) },
    actor: OPERATOR,
    configDigest: CONFIG_DIGEST,
  };

  return {
    fixture,
    now,
    acceptedDelivery,
    drillDeps,
    control,
    governance,
    transport,
    keychain,
    approvedRun,
    enqueue,
    enqueueCommand,
    adapter,
    send,
    vault,
    touchPort,
    worker,
    messageEvent,
  };
}

test('S2-LINE-F04 production wiring: enqueue → accepted push → quoted reply → Touch 1 through Governance', async (t) => {
  const f = await setup(t);
  const tenantId = f.fixture.tenantA;
  const run = await f.approvedRun(tenantId);
  f.keychain.set(
    keychainKey(
      lineRecipientKeychainReference(PILOT_CHANNEL_ACCOUNT_ID, run.recipientProtectedRef),
    ),
    USER_ID,
  );

  const reservation = await f.fixture.seedReservation(tenantId, f.now);
  const command = f.enqueueCommand(reservation);
  const queued = await f.enqueue.enqueue(command);
  assert.ok(queued.status === 'QUEUED', JSON.stringify(queued));
  // replaying the same actionKey returns the same delivery/key, never minting a new one (#357)
  assert.deepEqual(await f.enqueue.enqueue(command), { ...queued, status: 'REPLAYED' });
  assert.deepEqual(await f.enqueue.enqueue({ ...command, purpose: 'MARKETING' }), {
    status: 'ERROR',
    code: 'IDEMPOTENCY_CONFLICT',
  });

  const submitted = await f.adapter.submit({
    tenantId,
    deliveryId: queued.deliveryId,
    scope: f.fixture.scope(tenantId),
    runAuthorizationId: run.run.id,
    recipientFingerprint: lineSourceFingerprint(PILOT_CHANNEL_ACCOUNT_ID, USER_ID),
    recipientProtectedRef: run.recipientProtectedRef,
    correlationId: `corr-${queued.deliveryId}`,
    quota: { type: 'limited', targetLimit: 500, totalUsage: 1, observedAt: new Date() },
  });
  assert.equal(submitted.status, 'ACCEPTED', JSON.stringify(submitted));
  assert.equal(f.transport.requests.length, 1);
  assert.equal(f.transport.requests[0]!.to, USER_ID);
  assert.equal(f.transport.requests[0]!.retryKey, queued.providerRequestKey);

  await f.send(tenantId, [
    f.messageEvent(USER_ID, {
      id: '600000000001',
      type: 'text',
      text: 'Acknowledged',
      quotedMessageId: SENT_MESSAGE_ID,
    }),
  ]);
  const result = await f.worker.runOnce(tenantId);
  assert.deepEqual([result.touches, result.quarantined], [1, 0]);

  const where = { where: { tenantId } };
  assert.equal(await f.fixture.owner.cgAttempt.count(where), 1);
  assert.equal(await f.fixture.owner.cgTouch.count(where), 1);
  const settled = await f.fixture.owner.cgReservation.findUniqueOrThrow({
    where: { id: reservation.reservationId },
  });
  assert.deepEqual([settled.terminalOutcome, settled.refundedAt], ['PROVIDER_ACCEPTED', null]);

  // the port does not bind across tenants or across channels even when the message ID matches
  assert.equal(
    await f.touchPort.findAcceptedAttemptByMessage({
      tenantId: f.fixture.tenantB,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      providerMessageId: SENT_MESSAGE_ID,
    }),
    null,
  );
  assert.equal(
    await f.touchPort.findAcceptedAttemptByMessage({
      tenantId,
      channelAccountId: '1234567890',
      providerMessageId: SENT_MESSAGE_ID,
    }),
    null,
  );
});

test('S2-LINE-TI01 a recipient in the Keychain whose fingerprint does not match the allowlist is rejected before the barrier', async (t) => {
  const f = await setup(t);
  const tenantId = f.fixture.tenantA;
  const run = await f.approvedRun(tenantId);
  // the Keychain item was swapped to someone else — must send to no one at all
  f.keychain.set(
    keychainKey(
      lineRecipientKeychainReference(PILOT_CHANNEL_ACCOUNT_ID, run.recipientProtectedRef),
    ),
    OTHER_USER_ID,
  );
  const reservation = await f.fixture.seedReservation(tenantId, f.now);
  const queued = await f.enqueue.enqueue(f.enqueueCommand(reservation));
  assert.ok(queued.status === 'QUEUED');

  const submitted = await f.adapter.submit({
    tenantId,
    deliveryId: queued.deliveryId,
    scope: f.fixture.scope(tenantId),
    runAuthorizationId: run.run.id,
    recipientFingerprint: lineSourceFingerprint(PILOT_CHANNEL_ACCOUNT_ID, USER_ID),
    recipientProtectedRef: run.recipientProtectedRef,
    correlationId: `corr-${queued.deliveryId}`,
    quota: { type: 'limited', targetLimit: 500, totalUsage: 1, observedAt: new Date() },
  });
  assert.deepEqual(submitted, { status: 'DENIED', code: 'LINE_CREDENTIAL_UNAVAILABLE' });
  assert.equal(f.transport.requests.length, 0);
  const entry = await f.fixture.owner.dlOutboxEntry.findFirstOrThrow({
    where: { tenantId, deliveryId: queued.deliveryId },
  });
  assert.equal(entry.state, 'QUEUED', 'has not crossed the barrier');
});

test('S2-LINE-OB02 capture recipient from a signed webhook writes the Keychain through stdin and returns only ref/fingerprint', async (t) => {
  const f = await setup(t);
  const tenantId = f.fixture.tenantA;
  const since = new Date(Date.now() - 1_000);
  await f.send(tenantId, [
    f.messageEvent(USER_ID, { id: '600000000002', type: 'text', text: 'hi' }),
  ]);

  const writes: Array<{ file: string; arguments_: readonly string[]; stdin: string }> = [];
  const writer = new KeychainLineSecretWriter(async (file, arguments_, stdin) => {
    writes.push({ file, arguments_, stdin });
  }, 'darwin');
  const captured = await captureLineRecipientFromWebhook({
    database: f.fixture.application,
    vault: f.vault,
    writer,
    tenantId,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    since,
  });
  assert.ok(captured);
  assert.match(captured.recipientProtectedRef, /^kc-recipient-/);
  assert.equal(
    captured.recipientFingerprint,
    lineSourceFingerprint(PILOT_CHANNEL_ACCOUNT_ID, USER_ID),
  );
  assert.ok(!JSON.stringify(captured).includes(USER_ID));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.arguments_, ['-i'], 'the value is not in argv');
  assert.ok(writes[0]!.stdin.includes(`recipient.${captured.recipientProtectedRef}`));
  assert.ok(writes[0]!.stdin.includes(USER_ID));

  // another tenant has no webhook → nothing to capture
  assert.equal(
    await captureLineRecipientFromWebhook({
      database: f.fixture.application,
      vault: f.vault,
      writer,
      tenantId: f.fixture.tenantB,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      since,
    }),
    null,
  );
});

test('S2-LINE-AU01 access token resolver through the credential boundary: fingerprint/version must match', async (t) => {
  const f = await setup(t);
  const tenantId = f.fixture.tenantA;
  const token = 'synthetic-keychain-access-token-value';
  const credential = await f.control.registerCredential(
    OPERATOR,
    {
      tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
      version: 900_001,
      keychainService: `d-contact.line.${PILOT_CHANNEL_ACCOUNT_ID}`,
      keychainAccount: 'channel-access-token',
      fingerprint: lineSecretFingerprint(token),
      issuedAt: f.now,
      expiresAt: new Date(f.now.getTime() + 20 * 86_400_000),
    },
    f.now,
  );
  const activated = await f.control.verifyAndActivateCredential(
    OPERATOR,
    tenantId,
    credential.id,
    { channelAccountId: PILOT_CHANNEL_ACCOUNT_ID, verifiedAt: f.now },
    f.now,
  );
  assert.equal(activated.status, 'APPLIED', JSON.stringify(activated));

  const source = (value: string) =>
    new MapSecretSource(
      new Map([[`d-contact.line.${PILOT_CHANNEL_ACCOUNT_ID}|channel-access-token`, value]]),
    );
  const resolved = await new KeychainLineAccessTokenResolver(
    f.fixture.application,
    source(token),
  ).resolve({ tenantId, credentialRefId: credential.id, version: credential.version });
  assert.deepEqual(resolved, { accessToken: token });
  assert.equal(
    await new KeychainLineAccessTokenResolver(
      f.fixture.application,
      source('rotated-token'),
    ).resolve({ tenantId, credentialRefId: credential.id, version: credential.version }),
    null,
  );
  assert.equal(
    await new KeychainLineAccessTokenResolver(f.fixture.application, source(token)).resolve({
      tenantId,
      credentialRefId: credential.id,
      version: credential.version + 1,
    }),
    null,
  );
  assert.equal(
    await new KeychainLineAccessTokenResolver(f.fixture.application, source(token)).resolve({
      tenantId: f.fixture.tenantB,
      credentialRefId: credential.id,
      version: credential.version,
    }),
    null,
  );
});

test('S2-LINE-PR02 replay probe: the exact original request gets 409 + the original accepted/message ID and adds no Attempt', async (t) => {
  const f = await setup(t);
  const tenantId = f.fixture.tenantA;
  const { command, queued } = await f.acceptedDelivery(tenantId);
  f.transport.scripted.push({
    kind: 'RESPONSE',
    response: {
      httpStatus: 409,
      requestId: 'req-pilot-2',
      acceptedRequestId: 'req-pilot-1',
      sentMessageIds: [SENT_MESSAGE_ID],
    },
  });

  const probe = await runLineReplayProbe(f.drillDeps, command);
  assert.equal(probe.status, 'PASS', JSON.stringify(probe));
  assert.deepEqual(
    [probe.pushStatus, probe.replayStatus, probe.acceptedRequestIdMatches, probe.messageIdsMatch],
    [200, 409, true, true],
  );
  // fire again with the request byte for byte the same: same key and recipient
  assert.equal(f.transport.requests.length, 2);
  assert.equal(f.transport.requests[1]!.retryKey, queued.providerRequestKey);
  assert.deepEqual(f.transport.requests[1]!.messages, f.transport.requests[0]!.messages);
  assert.equal(f.transport.requests[1]!.to, f.transport.requests[0]!.to);
  assert.ok(!JSON.stringify(probe).includes(USER_ID));

  const where = { where: { tenantId } };
  assert.equal(await f.fixture.owner.cgAttempt.count(where), 1);
  assert.equal(await f.fixture.owner.dlProviderSubmissionAttempt.count(where), 1);
  const audit = await f.fixture.owner.dlLineAuditEvent.findMany({
    where: { tenantId, code: 'PROVIDER_REPLAY_PROBE' },
  });
  assert.deepEqual(
    audit.map((row) => [row.category, row.deliveryId, row.evidenceDigest]),
    [['PROVIDER', queued.deliveryId, probe.evidenceDigest]],
  );
});

test('S2-LINE-PR02 replay probe: a repeated 200 or a mismatched accepted ID is FAIL (the recipient may see duplicates)', async (t) => {
  const f = await setup(t);
  const { command } = await f.acceptedDelivery(f.fixture.tenantA);
  f.transport.scripted.push({
    kind: 'RESPONSE',
    response: { httpStatus: 200, requestId: 'req-dup', sentMessageIds: ['999'] },
  });
  const duplicated = await runLineReplayProbe(f.drillDeps, command);
  assert.deepEqual([duplicated.status, duplicated.failure], ['FAIL', 'NOT_409']);

  f.transport.scripted.push({
    kind: 'RESPONSE',
    response: {
      httpStatus: 409,
      requestId: 'req-3',
      acceptedRequestId: 'req-other',
      sentMessageIds: [SENT_MESSAGE_ID],
    },
  });
  const mismatched = await runLineReplayProbe(f.drillDeps, command);
  assert.deepEqual(
    [mismatched.status, mismatched.failure],
    ['FAIL', 'ACCEPTED_REQUEST_ID_MISMATCH'],
  );
});

test('S2-LINE-RB01 rollback drill: switch off + kill + revoke then a new send is rejected before I/O', async (t) => {
  const f = await setup(t);
  const tenantId = f.fixture.tenantA;
  const { run, command } = await f.acceptedDelivery(tenantId);
  const pushesBefore = f.transport.requests.length;

  const evidence = await runLineRollbackDrill(f.drillDeps, OPERATOR, {
    scope: f.fixture.scope(tenantId),
    runAuthorizationId: run.run.id,
    credentialRefId: run.credential.id,
    recipientFingerprint: command.recipientFingerprint,
    contentRef: FIXTURE_REF,
    revocation: async () => ({
      credentialKind: 'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
      accessToken: 'synthetic-channel-access-token',
    }),
    quota: command.quota,
  });
  assert.equal(evidence.status, 'PASS', JSON.stringify(evidence));
  assert.deepEqual(
    [evidence.technicalSwitchOn, evidence.killLatched, evidence.unresolvedDeliveries],
    [false, true, 0],
  );
  assert.equal(evidence.freshSendDenialCode, 'LINE_GATE_KILLED');
  assert.equal(f.transport.requests.length, pushesBefore);
  const credential = await f.fixture.owner.dlLineCredentialRef.findUniqueOrThrow({
    where: { id: run.credential.id },
  });
  assert.equal(credential.status, 'REVOKED');
  const gate = await f.fixture.owner.dlLineScopeGate.findFirstOrThrow({ where: { tenantId } });
  assert.equal(gate.killReason, 'PILOT_ROLLBACK');
});

test('S2-LINE-RB01 a failed revoke at the provider = FAIL but the scope stays closed and the metadata stays revoked', async (t) => {
  const f = await setup(t);
  const tenantId = f.fixture.tenantA;
  const { run, command } = await f.acceptedDelivery(tenantId);
  f.transport.revoked = false;

  const evidence = await runLineRollbackDrill(f.drillDeps, OPERATOR, {
    scope: f.fixture.scope(tenantId),
    runAuthorizationId: run.run.id,
    credentialRefId: run.credential.id,
    recipientFingerprint: command.recipientFingerprint,
    contentRef: FIXTURE_REF,
    revocation: async () => ({
      credentialKind: 'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
      accessToken: 'synthetic-channel-access-token',
    }),
  });
  assert.equal(evidence.status, 'FAIL');
  assert.deepEqual(
    [evidence.providerRevoked, evidence.metadataRevoked, evidence.credentialRevoked],
    [false, true, false],
  );
  assert.deepEqual([evidence.killLatched, evidence.technicalSwitchOn], [true, false]);
});
