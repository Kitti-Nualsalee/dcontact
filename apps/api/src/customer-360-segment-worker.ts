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

/** จำนวนงานต่อ tenant ต่อรอบ: จำกัดเวลาที่ loop ถือ DB โดยไม่ต้องมีคิวแยก */
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
  /** backoff ก่อนลองเชื่อม Kafka ใหม่ (ms) ตามจำนวนครั้งที่ล้ม */
  reconnectDelayMs?: (failures: number) => number;
  /** แทนที่ได้ใน test; ค่าเริ่มต้นเปิด IAM consumer (พร้อมก่อน) แล้ว producer ของ relay */
  connectKafka?: () => Promise<C360SegmentKafka>;
  /** แทนที่ได้ใน test */
  runtime?: Pick<C360SegmentRuntime, 'evaluatePending'>;
}

export interface C360SegmentWorker {
  evaluateOnce(): Promise<boolean>;
  /** false เมื่อยังไม่มี Kafka หรือรอบนั้นล้ม */
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
    // consumer ต้องพร้อมก่อน relay ส่ง event แรก (group ใหม่เริ่มที่ offset ล่าสุด)
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
 * #911: ประเมิน segment ระบบ → outbox → Kafka `dc.customer.events` → IAM projection ใน process ของ API
 * evaluator ใช้แค่ DB จึงเริ่มทันที ส่วน Kafka (relay + IAM consumer) เชื่อมแบบ retry/backoff
 * ทุกขั้นล้มได้โดยไม่ทำให้ API ล้ม ปิดทั้งหมดด้วย `C360_SEGMENT_WORKER=off`
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
      // ไม่ log message: อาจมี connection detail; ชื่อ error พอสำหรับวินิจฉัย
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
