import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { createJourneyFoundationPorts } from '@d-contact/journey-composition';
import type { InboundBusinessEvent } from '@d-contact/shared';
import { EventInboxService } from './event-inbox.js';
import { JourneyEventNotReadyError, JourneyProcessor } from './journey-processor.js';

async function createTenantFixture(t: TestContext) {
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
  const tenantId = randomUUID();

  t.after(async () => {
    await owner.jrAction.deleteMany({ where: { tenantId } });
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId } });
    await owner.cgConsent.deleteMany({ where: { tenantId } });
    await owner.cgRestriction.deleteMany({ where: { tenantId } });
    await owner.jrEventInbox.deleteMany({ where: { tenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Journey processor ${tenantId}`,
      slug: `journey-processor-${tenantId}`,
      sipDomain: `${tenantId}.journey-processor.test`,
    },
  });

  return { owner, application, tenantId };
}

test('CRM_ID ที่ resolve ไม่ได้ให้ REVIEW evidence โดยไม่สร้าง action และ retry ได้ผลเดิม', async (t) => {
  const { owner, application, tenantId } = await createTenantFixture(t);
  const receiptId = '10000000-0000-4000-8000-000000000001';
  const decisionId = '20000000-0000-4000-8000-000000000001';
  const event: InboundBusinessEvent = {
    source: 'billing',
    eventId: 'payment-failed-unmapped-001',
    type: 'payment.failed',
    occurredAt: '2026-09-08T01:00:00.000Z',
    schemaVersion: 1,
    contactRef: { kind: 'CRM_ID', value: 'crm-without-mapping' },
    payload: { invoiceId: 'invoice-unmapped-001' },
  };
  const inbox = new EventInboxService(application, {
    now: () => new Date('2026-09-08T01:01:00.000Z'),
    id: () => receiptId,
  });
  await inbox.accept(tenantId, event);
  await inbox.publishNext(tenantId, { publish: async () => undefined });

  const processor = new JourneyProcessor(
    application,
    createJourneyFoundationPorts(application, {
      contactGovernance: {
        now: () => new Date('2026-09-08T01:02:00.000Z'),
        id: () => decisionId,
      },
    }),
    {
      now: () => new Date('2026-09-08T01:03:00.000Z'),
    },
  );
  const input = {
    receiptId,
    journeyVersion: 3,
    stepId: 'notify-payment-failed',
    channel: 'EMAIL' as const,
    purpose: 'SERVICE_NOTIFICATION',
    policyVersion: 1,
  };

  const processed = await processor.processEvent(tenantId, input);
  const retried = await processor.processEvent(tenantId, input);

  assert.deepEqual(retried, processed);
  assert.deepEqual(processed, {
    receiptId,
    enrollmentId: receiptId,
    actionKey: `${receiptId}:3:notify-payment-failed`,
    decisionId,
    decision: 'REVIEW',
    reasonCode: 'IDENTITY_AMBIGUOUS',
  });
  assert.equal(await owner.cgDecisionLog.count({ where: { tenantId } }), 1);
  assert.equal(await owner.cgReservation.count({ where: { tenantId } }), 0);
  assert.equal(
    (await owner.jrEventInbox.findUniqueOrThrow({ where: { id: receiptId } })).state,
    'PROCESSED',
  );
});

test('identity ที่ไม่พบผ่าน Customer Context ให้ REVIEW evidence โดยไม่สร้าง action', async (t) => {
  const { owner, application, tenantId } = await createTenantFixture(t);
  const receiptId = randomUUID();
  const decisionId = randomUUID();
  const event: InboundBusinessEvent = {
    source: 'billing',
    eventId: 'payment-failed-not-found-001',
    type: 'payment.failed',
    occurredAt: '2026-09-08T01:30:00.000Z',
    schemaVersion: 1,
    contactRef: { kind: 'EMAIL', value: 'not-found@example.test' },
    payload: {},
  };
  const inbox = new EventInboxService(application, { id: () => receiptId });
  await inbox.accept(tenantId, event);
  await inbox.publishNext(tenantId, { publish: async () => undefined });

  const processor = new JourneyProcessor(
    application,
    createJourneyFoundationPorts(application, { contactGovernance: { id: () => decisionId } }),
  );
  const result = await processor.processEvent(tenantId, {
    receiptId,
    journeyVersion: 1,
    stepId: 'not-found',
    channel: 'EMAIL',
    purpose: 'SERVICE_NOTIFICATION',
    policyVersion: 1,
  });

  assert.deepEqual(result, {
    receiptId,
    enrollmentId: receiptId,
    actionKey: `${receiptId}:1:not-found`,
    decisionId,
    decision: 'REVIEW',
    reasonCode: 'IDENTITY_NOT_FOUND',
  });
  assert.equal(await owner.cgDecisionLog.count({ where: { tenantId } }), 1);
  assert.equal(await owner.cgReservation.count({ where: { tenantId } }), 0);
  assert.equal(await owner.jrAction.count({ where: { tenantId } }), 0);
});

test('event ที่ resolve contact ได้สร้าง action ที่เชื่อม decision และ reservation เดิมข้าม retry', async (t) => {
  const { owner, application, tenantId } = await createTenantFixture(t);
  const contactId = '30000000-0000-4000-8000-000000000001';
  const identityId = '40000000-0000-4000-8000-000000000001';
  const teamId = randomUUID();
  const receiptId = '50000000-0000-4000-8000-000000000001';
  const decisionId = '60000000-0000-4000-8000-000000000001';
  const reservationId = '70000000-0000-4000-8000-000000000001';
  await owner.contact.create({
    data: {
      id: contactId,
      tenantId,
      displayName: 'Resolved Journey contact',
      identities: {
        create: {
          id: identityId,
          tenantId,
          type: 'EMAIL',
          value: 'resolved@example.test',
        },
      },
      cgConsents: {
        create: {
          tenantId,
          identityId,
          purpose: 'MARKETING',
          channel: 'EMAIL',
          status: 'GRANTED',
          lawfulBasis: 'CONSENT',
          evidence: { source: 'journey-processor-integration' },
          grantedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      },
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Journey scope allow' } });
  const event: InboundBusinessEvent = {
    source: 'billing',
    eventId: 'payment-failed-resolved-001',
    type: 'payment.failed',
    occurredAt: '2026-09-08T02:00:00.000Z',
    schemaVersion: 1,
    contactRef: { kind: 'EMAIL', value: 'resolved@example.test' },
    payload: { invoiceId: 'invoice-resolved-001' },
  };
  const inbox = new EventInboxService(application, {
    now: () => new Date('2026-09-08T02:01:00.000Z'),
    id: () => receiptId,
  });
  await inbox.accept(tenantId, event);
  await inbox.publishNext(tenantId, { publish: async () => undefined });

  const ids = [decisionId, reservationId];
  const foundationPorts = createJourneyFoundationPorts(application, {
    contactGovernance: {
      now: () => new Date('2026-09-08T02:02:00.000Z'),
      id: () => ids.shift() ?? randomUUID(),
    },
  });
  const processor = new JourneyProcessor(application, {
    ...foundationPorts,
    teamContactScopeAuthorizer: {
      async authorize(input) {
        return { decision: 'ALLOW', scopeVersion: 1, evaluatedAt: input.at };
      },
    },
  });
  const input = {
    receiptId,
    journeyVersion: 4,
    stepId: 'notify-payment-failed',
    channel: 'EMAIL' as const,
    purpose: 'MARKETING',
    policyVersion: 1,
    teamId,
  };

  const processed = await processor.processEvent(tenantId, input);
  const retried = await processor.processEvent(tenantId, input);

  assert.deepEqual(retried, processed);
  assert.deepEqual(processed, {
    receiptId,
    enrollmentId: receiptId,
    actionKey: `${receiptId}:4:notify-payment-failed`,
    decisionId,
    decision: 'ALLOW',
    reasonCode: 'POLICY_PASSED',
    reservationId,
    action: {
      actionKey: `${receiptId}:4:notify-payment-failed`,
      contactId,
      identityId,
      decisionId,
      reservationId,
    },
  });
  const decision = await owner.cgDecisionLog.findUniqueOrThrow({ where: { id: decisionId } });
  assert.equal(decision.sourceId, receiptId);
  assert.equal(decision.reservationId, reservationId);
  assert.deepEqual(
    await owner.jrEnrollment.findUniqueOrThrow({
      where: { id: receiptId },
      select: {
        id: true,
        tenantId: true,
        eventInboxId: true,
        journeyVersion: true,
        contactId: true,
        decisionId: true,
        state: true,
      },
    }),
    {
      id: receiptId,
      tenantId,
      eventInboxId: receiptId,
      journeyVersion: 4,
      contactId,
      decisionId,
      state: 'AUTHORIZED',
    },
  );
  assert.deepEqual(
    await owner.jrAction.findUniqueOrThrow({
      where: { tenantId_actionKey: { tenantId, actionKey: processed.actionKey } },
      select: {
        tenantId: true,
        enrollmentId: true,
        actionKey: true,
        contactId: true,
        identityId: true,
        decisionId: true,
        reservationId: true,
      },
    }),
    {
      tenantId,
      enrollmentId: receiptId,
      actionKey: processed.actionKey,
      contactId,
      identityId,
      decisionId,
      reservationId,
    },
  );
  assert.equal(await owner.cgDecisionLog.count({ where: { tenantId } }), 1);
  assert.equal(await owner.cgReservation.count({ where: { tenantId } }), 1);
  assert.equal(await owner.jrEnrollment.count({ where: { tenantId } }), 1);
  assert.equal(await owner.jrAction.count({ where: { tenantId } }), 1);
});

test('scope ที่ปฏิเสธจบ Journey ก่อน Contact Governance และเก็บ inbox เป็นผลลัพธ์ terminal', async (t) => {
  const { owner, application, tenantId } = await createTenantFixture(t);
  const contactId = randomUUID();
  const identityId = randomUUID();
  const receiptId = randomUUID();
  const teamId = randomUUID();
  const event: InboundBusinessEvent = {
    source: 'billing',
    eventId: 'scope-denied-001',
    type: 'payment.failed',
    occurredAt: '2026-09-08T03:30:00.000Z',
    schemaVersion: 1,
    contactRef: { kind: 'EMAIL', value: 'scope-denied@example.test' },
    payload: {},
  };
  await owner.contact.create({
    data: {
      id: contactId,
      tenantId,
      identities: {
        create: { id: identityId, tenantId, type: 'EMAIL', value: event.contactRef.value },
      },
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Journey scope deny' } });
  const inbox = new EventInboxService(application, { id: () => receiptId });
  await inbox.accept(tenantId, event);
  await inbox.publishNext(tenantId, { publish: async () => undefined });

  const foundationPorts = createJourneyFoundationPorts(application);
  let governanceCalls = 0;
  const processor = new JourneyProcessor(application, {
    ...foundationPorts,
    contactAuthorizationPort: {
      async authorizeAndReserve(...args) {
        governanceCalls += 1;
        return foundationPorts.contactAuthorizationPort.authorizeAndReserve(...args);
      },
    },
  });

  const result = await processor.processEvent(tenantId, {
    receiptId,
    journeyVersion: 1,
    stepId: 'scope-check',
    channel: 'EMAIL',
    purpose: 'MARKETING',
    policyVersion: 1,
    teamId,
  });

  assert.deepEqual(result, {
    receiptId,
    enrollmentId: receiptId,
    actionKey: `${receiptId}:1:scope-check`,
    reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED',
    scopeDecision: 'DENY',
  });
  assert.equal(governanceCalls, 0);
  assert.equal(await owner.cgDecisionLog.count({ where: { tenantId } }), 0);
  assert.equal(await owner.cgReservation.count({ where: { tenantId } }), 0);
  assert.equal(await owner.jrAction.count({ where: { tenantId } }), 0);
  assert.equal(
    (await owner.jrEnrollment.findUniqueOrThrow({ where: { id: receiptId } })).state,
    'BLOCKED',
  );
  assert.equal(
    (await owner.jrEventInbox.findUniqueOrThrow({ where: { id: receiptId } })).state,
    'PROCESSED',
  );
});

test('สอง tenant ใช้ identity เดียวกันแต่ได้ policy ของตนเองและไม่ประมวลผล receipt ข้ามกัน', async (t) => {
  const tenantA = await createTenantFixture(t);
  const tenantB = await createTenantFixture(t);
  const email = 'shared-identity@example.test';
  const receiptA = '80000000-0000-4000-8000-000000000001';
  const receiptB = '80000000-0000-4000-8000-000000000002';

  async function seedContact(
    owner: PrismaClient,
    tenantId: string,
    suffix: string,
    status: 'GRANTED' | 'REVOKED',
  ) {
    await owner.contact.create({
      data: {
        id: `90000000-0000-4000-8000-0000000000${suffix}`,
        tenantId,
        identities: {
          create: {
            id: `a0000000-0000-4000-8000-0000000000${suffix}`,
            tenantId,
            type: 'EMAIL',
            value: email,
          },
        },
        cgConsents: {
          create: {
            tenantId,
            purpose: 'MARKETING',
            channel: 'EMAIL',
            status,
            lawfulBasis: 'CONSENT',
            evidence: { tenant: suffix },
            grantedAt: new Date('2026-09-01T00:00:00.000Z'),
            ...(status === 'REVOKED' ? { revokedAt: new Date('2026-09-07T00:00:00.000Z') } : {}),
          },
        },
      },
    });
  }

  await seedContact(tenantA.owner, tenantA.tenantId, '01', 'GRANTED');
  await seedContact(tenantB.owner, tenantB.tenantId, '02', 'REVOKED');
  const baseEvent = {
    source: 'billing',
    type: 'payment.failed',
    occurredAt: '2026-09-08T03:00:00.000Z',
    schemaVersion: 1,
    contactRef: { kind: 'EMAIL' as const, value: email },
    payload: { invoiceId: 'invoice-two-tenant' },
  };
  const inboxA = new EventInboxService(tenantA.application, { id: () => receiptA });
  const inboxB = new EventInboxService(tenantB.application, { id: () => receiptB });
  await inboxA.accept(tenantA.tenantId, { ...baseEvent, eventId: 'tenant-a-event' });
  await inboxB.accept(tenantB.tenantId, { ...baseEvent, eventId: 'tenant-b-event' });
  await inboxA.publishNext(tenantA.tenantId, { publish: async () => undefined });
  await inboxB.publishNext(tenantB.tenantId, { publish: async () => undefined });

  const processorA = new JourneyProcessor(
    tenantA.application,
    createJourneyFoundationPorts(tenantA.application),
  );
  const processorB = new JourneyProcessor(
    tenantB.application,
    createJourneyFoundationPorts(tenantB.application),
  );
  const commonInput = {
    journeyVersion: 1,
    stepId: 'send-reminder',
    channel: 'EMAIL' as const,
    purpose: 'MARKETING',
    policyVersion: 1,
  };

  const resultA = await processorA.processEvent(tenantA.tenantId, {
    ...commonInput,
    receiptId: receiptA,
  });
  const resultB = await processorB.processEvent(tenantB.tenantId, {
    ...commonInput,
    receiptId: receiptB,
  });

  assert.equal(resultA.decision, 'ALLOW');
  assert.ok(resultA.action);
  assert.ok(resultA.reservationId);
  assert.equal(resultB.decision, 'BLOCK');
  assert.equal(resultB.reasonCode, 'CONSENT_REVOKED');
  assert.equal(resultB.action, undefined);
  assert.equal(resultB.reservationId, undefined);
  await assert.rejects(
    () =>
      processorA.processEvent(tenantA.tenantId, {
        ...commonInput,
        receiptId: receiptB,
      }),
    (error: unknown) => error instanceof JourneyEventNotReadyError,
  );
});
