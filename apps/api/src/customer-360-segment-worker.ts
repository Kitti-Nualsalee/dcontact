import type { PrismaClient } from '@d-contact/db';
import {
  C360SegmentEvaluator,
  C360SegmentMembershipRelay,
  C360SegmentMembershipRepository,
  C360SegmentRepository,
  C360SegmentRuntime,
} from '@d-contact/customer-360';
import { DcExprEvaluator } from '@d-contact/expression';
import {
  IamTeamSegmentScopeRepository,
  createIamCustomerSegmentProjectionConsumer,
} from '@d-contact/iam';
import {
  createDlqPublisher,
  createProducer,
  type DcConsumer,
  type DcDlqPublisher,
  type DcProducer,
} from '@d-contact/kafka';
import { startBackgroundLoop, type BackgroundLoop } from './background-loop.js';

type Log = (entry: Record<string, unknown>) => void;
const defaultLog: Log = (entry) => console.log(JSON.stringify(entry));

/** jobs per tenant per round: bounds the time the loop holds the DB without needing a separate queue */
const EVALUATE_PER_TENANT = 100;
const PUBLISH_PER_TENANT = 200;

export interface C360SegmentKafka {
  producer: DcProducer;
  close(): Promise<void>;
}

export interface C360SegmentWorkerOptions {
  database: PrismaClient;
  env?: NodeJS.ProcessEnv;
  log?: Log;
  evaluateIntervalMs?: number;
  publishIntervalMs?: number;
  /** backoff before retrying the Kafka connection (ms) by number of failures */
  reconnectDelayMs?: (failures: number) => number;
  /** replaceable in tests; the default starts the IAM consumer (ready first) then the relay's producer */
  connectKafka?: () => Promise<C360SegmentKafka>;
  /** replaceable in tests */
  runtime?: Pick<C360SegmentRuntime, 'evaluatePending'>;
}

export interface C360SegmentWorker {
  evaluateOnce(): Promise<boolean>;
  /** false when there is no Kafka yet or that round failed */
  publishOnce(): Promise<boolean>;
  readonly kafkaConnected: boolean;
  stop(): Promise<void>;
}

const defaultReconnectDelayMs = (failures: number) => Math.min(2 ** failures * 5_000, 5 * 60_000);

async function connectDefaultKafka(
  database: PrismaClient,
  env: NodeJS.ProcessEnv,
): Promise<C360SegmentKafka> {
  let dlq: DcDlqPublisher | undefined;
  let consumer: DcConsumer | undefined;
  let producer: DcProducer | undefined;
  try {
    dlq = await createDlqPublisher('dcontact-api-iam-segment-dlq');
    consumer = await createIamCustomerSegmentProjectionConsumer({
      repository: new IamTeamSegmentScopeRepository(database),
      clientId: 'dcontact-api-iam-segment-projection',
      groupId: env.IAM_SEGMENT_PROJECTION_GROUP_ID ?? 'dcontact-iam-segment-projection-v1',
      dlq,
    });
    // the consumer must be ready before the relay sends the first event (a new group starts at the latest offset)
    await consumer.ready();
    producer = await createProducer('dcontact-api-c360-segment-relay');
  } catch (error) {
    await Promise.allSettled([consumer?.disconnect(), producer?.disconnect(), dlq?.disconnect()]);
    throw error;
  }
  const opened = { consumer, producer, dlq };
  return {
    producer,
    async close() {
      await Promise.allSettled([
        opened.consumer.disconnect(),
        opened.producer.disconnect(),
        opened.dlq.disconnect(),
      ]);
    },
  };
}

/**
 * #911: evaluate the system segment → outbox → Kafka `dc.customer.events` → IAM projection inside the API process
 * the evaluator uses only the DB so it starts at once, while Kafka (the relay + IAM consumer) connects with retry/backoff
 * every step may fail without making the API fail, and all of it is turned off with `C360_SEGMENT_WORKER=off`
 */
export function startC360SegmentWorker(
  options: C360SegmentWorkerOptions,
): C360SegmentWorker | undefined {
  const env = options.env ?? process.env;
  const log = options.log ?? defaultLog;
  if (env.C360_SEGMENT_WORKER === 'off') {
    log({ event: 'c360.segment_worker.disabled' });
    return undefined;
  }
  const { database } = options;
  const runtime =
    options.runtime ??
    (() => {
      const evaluator = new C360SegmentEvaluator(new DcExprEvaluator());
      return new C360SegmentRuntime(
        database,
        new C360SegmentRepository(database, evaluator),
        new C360SegmentMembershipRepository(database, evaluator),
      );
    })();
  const connectKafka = options.connectKafka ?? (() => connectDefaultKafka(database, env));
  const reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  const tenants = () => database.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } });

  let stopped = false;
  let kafka: C360SegmentKafka | undefined;
  let relay: C360SegmentMembershipRelay | undefined;
  let publishing: BackgroundLoop | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;

  const evaluation = startBackgroundLoop({
    name: 'c360.segment_evaluation',
    intervalMs: options.evaluateIntervalMs ?? 5_000,
    log,
    work: async () => {
      for (const tenant of await tenants()) {
        const result = await runtime.evaluatePending(tenant.id, EVALUATE_PER_TENANT);
        if (result.contacts > 0)
          log({ event: 'c360.segment_evaluation.batch', tenantId: tenant.id, ...result });
      }
    },
  });

  async function publishAll(): Promise<void> {
    if (!relay) throw new Error('kafka not connected');
    for (const tenant of await tenants()) {
      for (let handled = 0; handled < PUBLISH_PER_TENANT; handled += 1) {
        const attempt = await relay.publishNext(tenant.id);
        if (!attempt || attempt.state !== 'PUBLISHED') break;
      }
    }
  }

  async function connect(failures: number): Promise<void> {
    if (stopped) return;
    try {
      const opened = await connectKafka();
      if (stopped) {
        await opened.close();
        return;
      }
      kafka = opened;
      relay = new C360SegmentMembershipRelay(database, opened.producer);
      publishing = startBackgroundLoop({
        name: 'c360.segment_relay',
        intervalMs: options.publishIntervalMs ?? 2_000,
        log,
        work: publishAll,
      });
      log({ event: 'c360.segment_worker.kafka_connected', failures });
    } catch (error) {
      // the message is not logged: it may contain connection detail; the error name is enough for diagnosis
      log({
        event: 'c360.segment_worker.kafka_connect_failed',
        error: error instanceof Error ? error.name : 'Unknown',
        failures: failures + 1,
      });
      if (stopped) return;
      reconnect = setTimeout(() => void connect(failures + 1), reconnectDelayMs(failures + 1));
      reconnect.unref?.();
    }
  }
  void connect(0);
  log({ event: 'c360.segment_worker.started' });

  return {
    evaluateOnce: () => evaluation.runOnce(),
    publishOnce: async () => (publishing ? publishing.runOnce() : false),
    get kafkaConnected() {
      return !!kafka;
    },
    async stop() {
      stopped = true;
      evaluation.stop();
      publishing?.stop();
      if (reconnect) clearTimeout(reconnect);
      await kafka?.close();
    },
  };
}
