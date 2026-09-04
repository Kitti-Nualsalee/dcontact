import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  createVoiceQueue,
  listDirectVoiceDestinations,
  listQueueAuditEvents,
  listTenantQueues,
  resolveDirectVoiceDestination,
  setDirectVoiceDestination,
  TenantQueueNotFoundError,
  updateVoiceQueue,
} from './tenant-queue.js';

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

test('API query uses service scoping and transaction-local RLS for dcontact_app', async (t) => {
  t.after(async () => Promise.all([owner.$disconnect(), application.$disconnect()]));
  const demo = await owner.tenant.findUniqueOrThrow({ where: { slug: 'demo' } });

  const visible = await listTenantQueues(application, demo.id);
  const hidden = await listTenantQueues(application, '00000000-0000-0000-0000-000000000000');

  assert.ok(visible.length > 0);
  assert.deepEqual(hidden, []);
  assert.ok(visible.every((queue) => !('tenantId' in queue)));
});

test('admin creates a voice queue and reads its metadata in the same tenant', async (t) => {
  const tenantId = randomUUID();
  const actorUserId = randomUUID();
  const name = `Voice Support ${tenantId.slice(0, 8)}`;

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Queue test ${tenantId}`,
      slug: `queue-test-${tenantId}`,
      sipDomain: `${tenantId}.queue.test`,
    },
  });
  t.after(async () => {
    await owner.queueAuditEvent.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
  });

  const created = await createVoiceQueue(application, {
    tenantId,
    actorUserId,
    name,
    slaThresholdSec: 30,
    maxWaitSec: 180,
    priority: 4,
  });

  assert.deepEqual(created, {
    id: created.id,
    name,
    channels: ['VOICE'],
    slaThresholdSec: 30,
    maxWaitSec: 180,
    priority: 4,
    isActive: true,
  });
  assert.deepEqual(await listTenantQueues(application, tenantId), [created]);
});

test('admin updates and disables only a queue in the authenticated tenant', async (t) => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actorUserId = randomUUID();

  await owner.tenant.createMany({
    data: [
      {
        id: tenantId,
        name: `Queue owner ${tenantId}`,
        slug: `queue-owner-${tenantId}`,
        sipDomain: `${tenantId}.queue-owner.test`,
      },
      {
        id: otherTenantId,
        name: `Other tenant ${otherTenantId}`,
        slug: `other-tenant-${otherTenantId}`,
        sipDomain: `${otherTenantId}.other-tenant.test`,
      },
    ],
  });
  t.after(async () => {
    await owner.queueAuditEvent.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await owner.queue.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
  });

  const queue = await createVoiceQueue(application, {
    tenantId,
    actorUserId,
    name: `Original ${tenantId.slice(0, 8)}`,
  });

  await assert.rejects(
    updateVoiceQueue(application, {
      tenantId: otherTenantId,
      actorUserId,
      queueId: queue.id,
      name: 'Cross-tenant mutation',
      isActive: false,
    }),
    TenantQueueNotFoundError,
  );

  const updated = await updateVoiceQueue(application, {
    tenantId,
    actorUserId,
    queueId: queue.id,
    name: `Updated ${tenantId.slice(0, 8)}`,
    slaThresholdSec: 45,
    maxWaitSec: 240,
    priority: 8,
    isActive: false,
  });

  assert.deepEqual(updated, {
    id: queue.id,
    name: `Updated ${tenantId.slice(0, 8)}`,
    channels: ['VOICE'],
    slaThresholdSec: 45,
    maxWaitSec: 240,
    priority: 8,
    isActive: false,
  });
});

test('admin maps a direct destination only to an active voice queue in the same tenant', async (t) => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actorUserId = randomUUID();
  const destination = `support-${tenantId.slice(0, 8)}`;

  await owner.tenant.createMany({
    data: [
      {
        id: tenantId,
        name: `Destination owner ${tenantId}`,
        slug: `destination-owner-${tenantId}`,
        sipDomain: `${tenantId}.destination-owner.test`,
      },
      {
        id: otherTenantId,
        name: `Destination other ${otherTenantId}`,
        slug: `destination-other-${otherTenantId}`,
        sipDomain: `${otherTenantId}.destination-other.test`,
      },
    ],
  });
  t.after(async () => {
    await owner.queueAuditEvent.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await owner.voiceDestination.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await owner.queue.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
  });

  const queue = await createVoiceQueue(application, {
    tenantId,
    actorUserId,
    name: `Direct queue ${tenantId.slice(0, 8)}`,
  });
  const otherQueue = await createVoiceQueue(application, {
    tenantId: otherTenantId,
    actorUserId,
    name: `Other queue ${otherTenantId.slice(0, 8)}`,
  });

  await assert.rejects(
    setDirectVoiceDestination(application, {
      tenantId,
      actorUserId,
      destination,
      queueId: otherQueue.id,
    }),
    TenantQueueNotFoundError,
  );

  const configured = await setDirectVoiceDestination(application, {
    tenantId,
    actorUserId,
    destination,
    queueId: queue.id,
  });

  assert.deepEqual(configured, {
    id: configured.id,
    destination,
    entryMode: 'DIRECT_QUEUE',
    queueId: queue.id,
    isActive: true,
  });
  assert.deepEqual(await listDirectVoiceDestinations(application, tenantId), [configured]);
});

test('queue metadata mutations append tenant-scoped audit events that admin can read back', async (t) => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actorUserId = randomUUID();

  await owner.tenant.createMany({
    data: [
      {
        id: tenantId,
        name: `Audit owner ${tenantId}`,
        slug: `audit-owner-${tenantId}`,
        sipDomain: `${tenantId}.audit-owner.test`,
      },
      {
        id: otherTenantId,
        name: `Audit other ${otherTenantId}`,
        slug: `audit-other-${otherTenantId}`,
        sipDomain: `${otherTenantId}.audit-other.test`,
      },
    ],
  });
  t.after(async () => {
    await owner.queueAuditEvent.deleteMany({ where: { tenantId } });
    await owner.voiceDestination.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
  });

  const queue = await createVoiceQueue(application, {
    tenantId,
    actorUserId,
    name: `Audited queue ${tenantId.slice(0, 8)}`,
  });
  await setDirectVoiceDestination(application, {
    tenantId,
    actorUserId,
    destination: `audit-${tenantId.slice(0, 8)}`,
    queueId: queue.id,
  });
  await updateVoiceQueue(application, {
    tenantId,
    actorUserId,
    queueId: queue.id,
    isActive: false,
  });

  const auditEvents = await listQueueAuditEvents(application, tenantId);
  assert.deepEqual(
    auditEvents.map((event) => event.action),
    ['QUEUE_CREATED', 'DIRECT_DESTINATION_SET', 'QUEUE_DISABLED'],
  );
  assert.ok(auditEvents.every((event) => event.actorUserId === actorUserId));
  assert.ok(auditEvents.every((event) => event.queueId === queue.id));
  assert.ok(auditEvents.every((event) => !('tenantId' in event)));
  assert.deepEqual(await listQueueAuditEvents(application, otherTenantId), []);
});

test('direct destination admission rejects new work after its queue is disabled', async (t) => {
  const tenantId = randomUUID();
  const actorUserId = randomUUID();
  const destination = `admission-${tenantId.slice(0, 8)}`;

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Admission ${tenantId}`,
      slug: `admission-${tenantId}`,
      sipDomain: `${tenantId}.admission.test`,
    },
  });
  t.after(async () => {
    await owner.queueAuditEvent.deleteMany({ where: { tenantId } });
    await owner.voiceDestination.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
  });

  const queue = await createVoiceQueue(application, {
    tenantId,
    actorUserId,
    name: `Admission queue ${tenantId.slice(0, 8)}`,
  });
  const configured = await setDirectVoiceDestination(application, {
    tenantId,
    actorUserId,
    destination,
    queueId: queue.id,
  });

  assert.deepEqual(await resolveDirectVoiceDestination(application, tenantId, destination), {
    status: 'ACCEPTED',
    entryMode: 'DIRECT_QUEUE',
    destinationId: configured.id,
    queueId: queue.id,
  });

  await updateVoiceQueue(application, {
    tenantId,
    actorUserId,
    queueId: queue.id,
    isActive: false,
  });

  assert.deepEqual(await resolveDirectVoiceDestination(application, tenantId, destination), {
    status: 'REJECTED',
    reason: 'QUEUE_DISABLED',
  });

  await updateVoiceQueue(application, {
    tenantId,
    actorUserId,
    queueId: queue.id,
    isActive: true,
  });

  assert.equal(
    (await resolveDirectVoiceDestination(application, tenantId, destination)).status,
    'ACCEPTED',
  );
});
