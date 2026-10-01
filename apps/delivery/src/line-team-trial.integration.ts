/**
 * #567 — LINE team trial บน Postgres/RLS จริงกับ provider double
 *
 * ตอบกลับข้อความขาเข้า → Governance → outbox → adapter เดิม (gate/cap/barrier) → push text ไปหาผู้ส่ง
 * ครอบ: idempotency, ผู้รับนอก allowlist ของ trial, text ไม่ถูกต้อง, cap ต่อผู้รับ/24 ชม., kill จาก
 * Tenant Admin, เพดานของ DB และ authorization ของ S2 ที่ยังถูกบังคับแบบเดิม
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import { LINE_TEAM_TRIAL_CONTENT_CLASS } from '@d-contact/cxa-contracts';
import { LineAuditRepository } from './line-audit-repository.js';
import { LineControlPlane, type LineControlActor } from './line-control-plane.js';
import type { LineKeychainReference, LineSecretSource } from './line-credential-boundary.js';
import {
  KeychainLineRecipientResolver,
  lineRecipientKeychainReference,
} from './line-keychain-resolvers.js';
import { LineOutboundAdapter } from './line-outbound-adapter.js';
import {
  createLinePersistenceFixture,
  digest,
  PILOT_CHANNEL_ACCOUNT_ID,
} from './line-persistence-fixture.js';
import type {
  LinePushRequest,
  LineProviderTransport,
  LineTransportResult,
} from './line-provider-transport.js';
import {
  LineTeamTrialContentSource,
  LineTeamTrialReplies,
  lineTeamTrialContentDigest,
} from './line-team-trial.js';
import { LineWebhookIngress } from './line-webhook-ingress.js';
import { EncryptedLineWebhookPayloadVault } from './line-webhook-payload-vault.js';
import { lineSignature } from './line-webhook-signature.js';
import { lineSourceFingerprint } from './line-webhook-worker.js';

const OPERATOR: LineControlActor = { role: 'PLATFORM_OPERATOR', ref: 'platform-operator-1' };
const TENANT_ADMIN: LineControlActor = { role: 'TENANT_ADMIN', ref: 'tenant-admin-1' };
const COMPLIANCE: LineControlActor = { role: 'COMPLIANCE', ref: 'compliance-1' };
const CONFIG_DIGEST = digest('config-v1');
const SECRET = 's2-synthetic-channel-secret';
const DESTINATION = 'U1234567890abcdef1234567890abcdef';
const KEY_REF = 'd-contact.line.webhook-payload/v1';
const PAYLOAD_KEY = randomBytes(32);
const MEMBER = `U${'d'.repeat(32)}`;
const OUTSIDER = `U${'f'.repeat(32)}`;
const DAY = 86_400_000;

class RecordingTransport implements LineProviderTransport {
  readonly requests: LinePushRequest[] = [];
  async push(request: LinePushRequest): Promise<LineTransportResult> {
    this.requests.push(request);
    return {
      kind: 'RESPONSE',
      response: {
        httpStatus: 200,
        requestId: `req-${this.requests.length}`,
        sentMessageIds: [`${470_000_000_000 + this.requests.length}`],
      },
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

class MapSecretSource implements LineSecretSource {
  constructor(private readonly values: Map<string, string>) {}
  async read(reference: LineKeychainReference): Promise<string> {
    const value = this.values.get(`${reference.keychainService}|${reference.keychainAccount}`);
    if (!value) throw new Error('missing');
    return value;
  }
}

async function setup(t: TestContext, caps = { perRecipientPer24h: 3, per24h: 10, lifetime: 100 }) {
  const fixture = await createLinePersistenceFixture();
  t.after(() => fixture.dispose());
  const tenantId = fixture.tenantA;
  const scope = fixture.scope(tenantId);
  const now = new Date();
  const control = new LineControlPlane({
    control: fixture.control,
    audit: new LineAuditRepository(fixture.application),
  });

  let gate = await control.ensureScope(OPERATOR, scope);
  for (const state of ['DRY_RUN', 'PROVIDER_CONFORMANCE', 'CAPPED_PILOT'] as const) {
    const advanced = await control.advanceState(COMPLIANCE, gate, state, CONFIG_DIGEST, now);
    assert.equal(advanced.status, 'APPLIED', `advance ไป ${state}`);
    if (advanced.status === 'APPLIED') gate = advanced.value;
  }
  const switched = await control.setTechnicalSwitch(OPERATOR, gate, true, now);
  assert.equal(switched.status, 'APPLIED');
  if (switched.status === 'APPLIED') gate = switched.value;

  const credential = await fixture.control.registerCredentialRef({
    id: randomUUID(),
    tenantId,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    // v2.1 หมดอายุ ≤30 วันจึงครอบ trial 30 วันไม่ได้ — trial เต็มช่วงต้องใช้ long-lived พร้อม exception (#358)
    credentialKind: 'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
    longLivedExceptionRef: 'exception:line-team-trial-567',
    version: Number.parseInt(randomUUID().slice(0, 6), 16) + 1,
    keychainService: `d-contact.line.${PILOT_CHANNEL_ACCOUNT_ID}`,
    keychainAccount: 'channel-access-token',
    fingerprint: digest(`v5-${randomUUID()}`),
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 40 * DAY),
  });
  const activated = await control.verifyAndActivateCredential(
    OPERATOR,
    tenantId,
    credential.id,
    { channelAccountId: PILOT_CHANNEL_ACCOUNT_ID, verifiedAt: now },
    now,
  );
  assert.equal(activated.status, 'APPLIED');

  // ผู้รับของ trial: allowlist แบบ content class ครอบคลุม 31 วัน + recipient ใน protected store
  const keychain = new Map<string, string>();
  const recipientProtectedRef = `kc-recipient-${randomUUID()}`;
  const reference = lineRecipientKeychainReference(PILOT_CHANNEL_ACCOUNT_ID, recipientProtectedRef);
  keychain.set(`${reference.keychainService}|${reference.keychainAccount}`, MEMBER);
  const allowlist = await fixture.control.addAllowlistEntry({
    id: randomUUID(),
    ...scope,
    gateId: gate.id,
    recipientFingerprint: lineSourceFingerprint(PILOT_CHANNEL_ACCOUNT_ID, MEMBER),
    recipientProtectedRef,
    contentRef: LINE_TEAM_TRIAL_CONTENT_CLASS,
    contentDigest: lineTeamTrialContentDigest(),
    configDigest: CONFIG_DIGEST,
    validFrom: new Date(now.getTime() - DAY),
    validUntil: new Date(now.getTime() + 31 * DAY),
    approvalAuditRef: 'audit:allowlist:trial-member',
  });

  const trialRef = `trial-${randomUUID()}`;
  const proposed = await control.proposeTeamTrial(
    OPERATOR,
    {
      tenantId,
      gate,
      credential: (await fixture.control.findCredentialRef(tenantId, credential.id))!,
      recipients: [{ allowlistEntry: allowlist, contactId: fixture.contactIdOf(tenantId) }],
      trialRef,
      proposedAt: now,
      ttlDays: 30,
      caps,
    },
    now,
  );
  assert.equal(proposed.status, 'APPLIED');
  const runs = proposed.status === 'APPLIED' ? proposed.value : [];
  for (const run of runs) {
    assert.equal((await control.approveRun(TENANT_ADMIN, tenantId, run.id, now)).status, 'APPLIED');
    assert.equal((await control.approveRun(COMPLIANCE, tenantId, run.id, now)).status, 'APPLIED');
  }

  const ingress = new LineWebhookIngress(fixture.application, {
    tenantId,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    destination: DESTINATION,
    channelSecret: SECRET,
    payloadKeyRef: KEY_REF,
    payloadKey: PAYLOAD_KEY,
  });
  let sequence = 0;
  /** ข้อความขาเข้าแบบ one-to-one จากผู้ใช้หนึ่งคน → id ของแถว inbox */
  const inbound = async (userId: string) => {
    sequence += 1;
    const webhookEventId = `01JW567${randomUUID().slice(0, 8)}${sequence}`;
    const rawBody = Buffer.from(
      JSON.stringify({
        destination: DESTINATION,
        events: [
          {
            type: 'message',
            mode: 'active',
            webhookEventId,
            deliveryContext: { isRedelivery: false },
            timestamp: now.getTime(),
            source: { type: 'user', userId },
            message: { id: `${567_000_000_000 + sequence}`, type: 'text', text: 'ทดสอบ' },
          },
        ],
      }),
      'utf8',
    );
    const result = await ingress.handle({
      rawBody,
      signature: lineSignature(rawBody, SECRET),
      receivedAt: now,
    });
    assert.equal(result.status, 200);
    const entry = await fixture.owner.dlLineWebhookInboxEntry.findFirstOrThrow({
      where: { tenantId, webhookEventId },
    });
    return entry.id;
  };

  const keyring = { key: (ref: string) => (ref === KEY_REF ? PAYLOAD_KEY : undefined) };
  const vault = new EncryptedLineWebhookPayloadVault(fixture.application, keyring);
  const governance = new ContactGovernanceService(fixture.application);
  const transport = new RecordingTransport();
  let consent = true;
  const credentials = { resolve: async () => ({ accessToken: 'synthetic-v5-token' }) };
  const replies = new LineTeamTrialReplies({
    database: fixture.application,
    control,
    governance: {
      // policy ของ Governance ทดสอบที่ CG แล้ว — ที่นี่จำลองการอนุญาต/ปฏิเสธและจอง reservation จริงใน DB
      authorizeAndReserve: async (_tenant, input) => {
        // ผลแบบย่อของ AuthorizationOutcome — trial อ่านแค่ decision/reservationId/expiresAt
        if (!consent) return { decision: 'DENY', reasonCode: 'CONSENT_REQUIRED' } as never;
        const reservation = await fixture.seedReservation(
          tenantId,
          new Date(),
          String(input.actionKey),
        );
        return {
          decision: 'ALLOW',
          reservationId: reservation.reservationId,
          reservationExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        } as never;
      },
      claimReservationForDelivery: (...args) => governance.claimReservationForDelivery(...args),
    },
    adapter: (configDigest) =>
      new LineOutboundAdapter({
        database: fixture.application,
        governance,
        control,
        transport,
        recipients: new KeychainLineRecipientResolver(
          fixture.application,
          new MapSecretSource(keychain),
        ),
        credentials,
        actor: OPERATOR,
        configDigest,
        content: new LineTeamTrialContentSource(fixture.application, keyring),
      }),
    vault,
    payloadKey: { keyRef: KEY_REF, key: PAYLOAD_KEY },
    credentials,
    transport,
    scope,
    executor: OPERATOR,
  });
  return {
    fixture,
    tenantId,
    control,
    replies,
    transport,
    inbound,
    runs,
    gate,
    credential,
    allowlist,
    setConsent: (value: boolean) => {
      consent = value;
    },
  };
}

test('#567 ตอบกลับ: push text ไปหาผู้ส่งผ่าน adapter เดิม, text เข้ารหัสใน DB และ idempotent', async (t) => {
  const { fixture, tenantId, replies, transport, inbound } = await setup(t);
  const inboxEntryId = await inbound(MEMBER);
  const text = 'สวัสดีครับ ทีมรับข้อความแล้ว\nบรรทัดที่สอง';
  const sent = await replies.reply({
    inboxEntryId,
    text: `  ${text}  `,
    idempotencyKey: 'reply-key-0001',
    actorRef: 'admin-user-1',
  });
  assert.equal(sent.status, 'SENT', JSON.stringify(sent));
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.to, MEMBER);
  assert.deepEqual(transport.requests[0]?.messages, [{ type: 'text', text }]);

  const row = await fixture.owner.dlLineTrialSend.findFirstOrThrow({ where: { tenantId } });
  assert.ok(!row.ciphertext.toString('utf8').includes('สวัสดี'));
  assert.equal(row.actorRef, 'admin-user-1');

  // key เดิม + text เดิม = ผลเดิมโดยไม่ push ซ้ำ; text ต่าง = conflict
  const replay = await replies.reply({
    inboxEntryId,
    text,
    idempotencyKey: 'reply-key-0001',
    actorRef: 'admin-user-1',
  });
  assert.equal(replay.status, 'SENT');
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(
    await replies.reply({
      inboxEntryId,
      text: 'ข้อความอื่น',
      idempotencyKey: 'reply-key-0001',
      actorRef: 'admin-user-1',
    }),
    { status: 'FAILED', code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('#567 ตอบกลับ: text ผิด, ผู้ส่งนอก allowlist ของ trial และ consent ไม่ผ่าน = ไม่ส่ง', async (t) => {
  const { replies, transport, inbound, setConsent } = await setup(t);
  const member = await inbound(MEMBER);
  for (const text of ['', '   ', 'x'.repeat(501), 'bell\u0007', 42]) {
    assert.deepEqual(
      await replies.reply({
        inboxEntryId: member,
        text,
        idempotencyKey: `bad-${randomUUID()}`,
        actorRef: 'admin-user-1',
      }),
      { status: 'FAILED', code: 'TEXT_INVALID' },
    );
  }
  assert.equal(
    (
      await replies.reply({
        inboxEntryId: member,
        text: 'ก'.repeat(500),
        idempotencyKey: `max-${randomUUID()}`,
        actorRef: 'admin-user-1',
      })
    ).status,
    'SENT',
  );

  const outsider = await inbound(OUTSIDER);
  assert.deepEqual(
    await replies.reply({
      inboxEntryId: outsider,
      text: 'hi',
      idempotencyKey: `out-${randomUUID()}`,
      actorRef: 'admin-user-1',
    }),
    { status: 'FAILED', code: 'RECIPIENT_NOT_ALLOWLISTED' },
  );
  assert.deepEqual(
    await replies.reply({
      inboxEntryId: randomUUID(),
      text: 'hi',
      idempotencyKey: `nf-${randomUUID()}`,
      actorRef: 'admin-user-1',
    }),
    { status: 'FAILED', code: 'INBOUND_NOT_FOUND' },
  );
  setConsent(false);
  assert.deepEqual(
    await replies.reply({
      inboxEntryId: member,
      text: 'hi',
      idempotencyKey: `cg-${randomUUID()}`,
      actorRef: 'admin-user-1',
    }),
    { status: 'FAILED', code: 'CONSENT_DENIED' },
  );
  assert.equal(transport.requests.length, 1);
});

test('#567 cap ต่อผู้รับต่อ 24 ชม. มาจาก authorization ของ trial และ kill ของ Tenant Admin หยุดทันที', async (t) => {
  const { fixture, tenantId, replies, transport, inbound } = await setup(t);
  const member = await inbound(MEMBER);
  const send = () =>
    replies.reply({
      inboxEntryId: member,
      text: 'ping',
      idempotencyKey: `cap-${randomUUID()}`,
      actorRef: 'admin-user-1',
    });
  for (let index = 0; index < 3; index += 1) assert.equal((await send()).status, 'SENT');
  const fourth = await send();
  assert.equal(fourth.status, 'FAILED');
  assert.equal(fourth.status === 'FAILED' ? fourth.code : '', 'CAP_EXCEEDED');
  assert.equal(transport.requests.length, 3);

  const before = await replies.status();
  assert.equal(before.active, true);
  assert.equal(before.recipients, 1);
  assert.equal(before.last24h, 3);
  assert.equal(before.perRecipientPer24h, 3);

  assert.deepEqual(await replies.kill('admin-user-2'), { killed: true });
  const killed = await send();
  assert.equal(killed.status === 'FAILED' ? killed.code : '', 'KILLED');
  assert.equal((await replies.status()).killed, true);
  const audit = await fixture.owner.dlLineAuditEvent.findFirst({
    where: { tenantId, category: 'KILL' },
  });
  assert.equal(audit?.actorKind, 'TENANT_ADMIN');
  assert.equal(audit?.actorRef, 'admin-user-2');
});

test('#567 เพดานของ trial และ S2 ถูกบังคับทั้งที่ control plane และ DB', async (t) => {
  const { fixture, tenantId, control, gate, credential, allowlist } = await setup(t);
  const now = new Date();
  const fresh = (await fixture.control.findCredentialRef(tenantId, credential.id))!;
  const propose = (caps: { perRecipientPer24h: number; per24h: number; lifetime: number }) =>
    control.proposeTeamTrial(
      OPERATOR,
      {
        tenantId,
        gate,
        credential: fresh,
        recipients: [{ allowlistEntry: allowlist, contactId: fixture.contactIdOf(tenantId) }],
        trialRef: `trial-${randomUUID()}`,
        proposedAt: now,
        ttlDays: 30,
        caps,
      },
      now,
    );
  for (const caps of [
    { perRecipientPer24h: 21, per24h: 10, lifetime: 100 },
    { perRecipientPer24h: 3, per24h: 101, lifetime: 100 },
    { perRecipientPer24h: 3, per24h: 10, lifetime: 3001 },
    { perRecipientPer24h: 0, per24h: 10, lifetime: 100 },
  ]) {
    assert.equal((await propose(caps)).status, 'DENIED', JSON.stringify(caps));
  }

  const base = {
    tenantId,
    gateId: gate.id,
    allowlistEntryId: allowlist.id,
    credentialRefId: fresh.id,
    credentialVersion: fresh.version,
    configDigest: CONFIG_DIGEST,
    capProviderAttempts: 4,
    proposedBy: 'platform-operator-1',
    proposedAt: now,
  };
  // DB: trial เกิน 30 วัน / เกินเพดาน และ S2 ที่พยายามใช้ cap ของ trial = constraint ปฏิเสธ
  const rejects = (data: Record<string, unknown>) =>
    assert.rejects(
      fixture.owner.dlLineRunAuthorization.create({
        data: {
          id: randomUUID(),
          proposalDigest: digest(randomUUID()),
          ...base,
          ...data,
        } as never,
      }),
      /check constraint/i,
    );
  const trial = {
    profile: 'S2_LINE_TEAM_TRIAL_V1',
    capLogicalDeliveries: 60,
    capRecipientPer24h: 20,
    capPer24h: 100,
    capLifetime: 3000,
    trialRef: `trial-${randomUUID()}`,
    contactId: fixture.contactIdOf(tenantId),
  };
  await rejects({ ...trial, expiresAt: new Date(now.getTime() + 31 * DAY) });
  await rejects({ ...trial, capRecipientPer24h: 21, expiresAt: new Date(now.getTime() + DAY) });
  await rejects({ ...trial, contactId: null, expiresAt: new Date(now.getTime() + DAY) });
  await rejects({ capLogicalDeliveries: 2, expiresAt: new Date(now.getTime() + 10 * 60_000) });
  await rejects({
    capLogicalDeliveries: 1,
    capRecipientPer24h: 20,
    expiresAt: new Date(now.getTime() + 10 * 60_000),
  });
  await rejects({ capLogicalDeliveries: 1, expiresAt: new Date(now.getTime() + 31 * 60_000) });
});
