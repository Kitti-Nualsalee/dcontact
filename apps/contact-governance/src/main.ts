import { PrismaClient } from '@d-contact/db';
import { createDlqPublisher, createProducer } from '@d-contact/kafka';
import { Redis } from 'ioredis';
import { createCg3AcknowledgementConsumer } from './cg3-acknowledgement-consumer.js';
import { Cg4Cache } from './cg4-cache.js';
import { Cg4EventRelay } from './cg4-event-relay.js';
import { Cg4PolicyLifecycleRepository } from './cg4-policy-lifecycle.js';
import { Cg4ActivationWorker, Cg4ExpirySweeper } from './cg4-workers.js';
import { Cg5ExportLifecycleService } from './cg5-export-lifecycle.js';
import { Cg5ExportRunner } from './cg5-export-runner.js';
import { PrismaCg5CanonicalExportReader } from './cg5-prisma-export-reader.js';
import { MinioGovernanceExportStorage } from './minio-governance-export-storage.js';

const database = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const cache = new Cg4Cache(redis);
const producer = await createProducer('dcontact-contact-governance-publisher');
const dlq = await createDlqPublisher('dcontact-contact-governance-dlq');
// CG4.6 (#189): one relay drains cg_event_outbox. Cg4EventRelay is a superset of the CG3
// one (lease recovery, contract quarantine, CG4 cache keys), so running both would
// double-publish — this replaces it rather than joining it.
const relay = new Cg4EventRelay(database, producer, {
  cache,
  onQuarantine: ({ tenantId, outboxId, eventType, reason }) =>
    console.error(
      JSON.stringify({
        event: 'contact_governance.outbox.quarantined',
        tenantId,
        outboxId,
        eventType,
        reason,
      }),
    ),
});
const activation = new Cg4ActivationWorker(database, new Cg4PolicyLifecycleRepository(database));
const expiry = new Cg4ExpirySweeper(database);
const exportStorage = new MinioGovernanceExportStorage();
const exportRunner = new Cg5ExportRunner(
  database,
  exportStorage,
  new PrismaCg5CanonicalExportReader(database),
);
const exportLifecycle = new Cg5ExportLifecycleService(database, exportStorage);
const consumer = await createCg3AcknowledgementConsumer({
  database,
  clientId: 'dcontact-contact-governance-consumer',
  groupId: process.env.CG3_ACKNOWLEDGEMENT_CONSUMER_GROUP_ID ?? 'dcontact-cg3-acknowledgements-v1',
  dlq,
});

let draining = false;
let stopping = false;

function reportFailure(event: string, error: unknown): void {
  console.error(
    JSON.stringify({ event, message: error instanceof Error ? error.message : String(error) }),
  );
}

async function drainOutbox(): Promise<void> {
  if (draining || stopping) return;
  draining = true;
  try {
    const tenants = await database.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      await relay.recoverExpiredLeases(tenant.id);
      for (let handled = 0; handled < 100; handled += 1) {
        const result = await relay.publishNext(tenant.id);
        if (!result || result.state === 'FAILED') break;
      }
    }
  } catch (error) {
    reportFailure('contact_governance.outbox.publish_failed', error);
  } finally {
    draining = false;
  }
}

let sweeping = false;

/**
 * Activation and expiry are availability mechanisms, not safety ones (#176 §4): a scope
 * whose activation has not run fails closed at evaluation, so a failure here is logged
 * and retried rather than escalated inline.
 */
async function runWorkers(): Promise<void> {
  if (sweeping || stopping) return;
  sweeping = true;
  try {
    const tenants = await database.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      for (let handled = 0; handled < 20; handled += 1) {
        const result = await activation.runNext(tenant.id);
        if (!result || result.outcome !== 'ACTIVATED') break;
      }
      await expiry.sweep(tenant.id);
      await exportLifecycle.expireDue(tenant.id);
      await exportRunner.runNext(tenant.id);
    }
  } catch (error) {
    reportFailure('contact_governance.workers.failed', error);
  } finally {
    sweeping = false;
  }
}

const outboxTimer = setInterval(() => void drainOutbox(), 1_000);
const workerTimer = setInterval(() => void runWorkers(), 5_000);
void drainOutbox();
void runWorkers();

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(outboxTimer);
  clearInterval(workerTimer);
  await Promise.all([
    consumer.disconnect(),
    producer.disconnect(),
    dlq.disconnect(),
    database.$disconnect(),
    redis.quit(),
  ]);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
