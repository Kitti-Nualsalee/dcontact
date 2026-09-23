/**
 * S2.6b (#403): production wiring ของ LINE pilot บน Postgres/RLS จริงกับ provider double
 *
 * ร้อย path ที่ S2.7 ต้องใช้ครบในเทสต์เดียว: enqueue ผ่าน Governance → submit ด้วย recipient จาก
 * Keychain resolver → quoted reply ผ่าน signed ingress → worker + production Touch port → Touch 1
 * ไม่มี network ไป LINE (#403 acceptance) และ Keychain เป็น source/writer สังเคราะห์
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
  async push(request: LinePushRequest): Promise<LineTransportResult> {
    this.requests.push(request);
    return {
      kind: 'RESPONSE',
      response: { httpStatus: 200, requestId: 'req-pilot-1', sentMessageIds: [SENT_MESSAGE_ID] },
    };
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
    return { revoked: true, httpStatus: 200 };
  }
}

/** Keychain สังเคราะห์: map ของ `service|account` → ค่า */
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

  /** gate/allowlist/run ของ pilot ที่ recipient fingerprint = ผู้ใช้ LINE ที่จะตอบ */
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
      assert.equal(advanced.status, 'APPLIED', `advance ไป ${state}`);
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

  return {
    fixture,
    now,
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

test('S2-LINE-F04 production wiring: enqueue → accepted push → quoted reply → Touch 1 ผ่าน Governance', async (t) => {
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
  // replay actionKey เดิมคืน delivery/key เดิม ไม่ mint ใหม่ (#357)
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
      text: 'รับทราบ',
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

  // port ไม่ผูกข้าม tenant หรือข้าม channel แม้ message ID จะตรง
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

test('S2-LINE-TI01 recipient ใน Keychain ที่ไม่ตรง fingerprint ของ allowlist ถูกปฏิเสธก่อน barrier', async (t) => {
  const f = await setup(t);
  const tenantId = f.fixture.tenantA;
  const run = await f.approvedRun(tenantId);
  // Keychain item ถูกเปลี่ยนเป็นคนอื่น — ต้องไม่ส่งถึงใครเลย
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
  assert.equal(entry.state, 'QUEUED', 'ยังไม่ข้าม barrier');
});

test('S2-LINE-OB02 capture recipient จาก signed webhook เขียน Keychain ผ่าน stdin และคืนแค่ ref/fingerprint', async (t) => {
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
  assert.deepEqual(writes[0]!.arguments_, ['-i'], 'ค่าไม่อยู่ใน argv');
  assert.ok(writes[0]!.stdin.includes(`recipient.${captured.recipientProtectedRef}`));
  assert.ok(writes[0]!.stdin.includes(USER_ID));

  // tenant อื่นไม่มี webhook → ไม่มีอะไรให้ capture
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

test('S2-LINE-AU01 access token resolver ผ่าน credential boundary: fingerprint/version ต้องตรง', async (t) => {
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
