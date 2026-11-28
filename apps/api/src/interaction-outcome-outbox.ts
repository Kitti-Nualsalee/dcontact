/**
 * #1067 — the Interaction owner emits `interaction.outcome_recorded` (J2 contract, #120)
 *
 * The wrap-up transaction writes one outbox row next to the wrap-up result; a relay inside the API process
 * publishes it to `dc.interaction.events` at-least-once. The outbox row id is the Kafka eventId, so a re-publish
 * after a crash is the same event and Journey's receipt dedup (tenant, source, eventId) drops it.
 *
 * Off by default: nothing is written or published unless `INTERACTION_OUTCOME_EVENTS=on`.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  INTERACTION_OUTCOME_CODES,
  J2_EVENT_TYPES,
  assertInteractionOutcomeEnvelope,
  validateInteractionOutcomePayload,
} from '@d-contact/cxa-contracts';
import { createProducer, type DcProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { startBackgroundLoop, type BackgroundLoop } from './background-loop.js';

type Log = (entry: Record<string, unknown>) => void;
const defaultLog: Log = (entry) => console.log(JSON.stringify(entry));

const DISPOSITION_OUTCOME_TYPE = 'INTERACTION_DISPOSITION_RECORDED' as const;
const DISPOSITION_OUTCOME_CODES: readonly string[] =
  INTERACTION_OUTCOME_CODES[DISPOSITION_OUTCOME_TYPE];
const PUBLISH_PER_TENANT = 100;

export function resolveInteractionOutcomeEvents(env: NodeJS.ProcessEnv): boolean {
  return env.INTERACTION_OUTCOME_EVENTS === 'on';
}

export interface DispositionOutcomeInput {
  tenantId: string;
  interactionId: string;
  contactId: string | null;
  disposition: string;
  /** the wrap-up command that recorded the disposition — the root correlation of everything that follows */
  commandId: string;
  recordedAt: Date;
}

/**
 * Writes the outcome fact in the caller's transaction. One wrap-up result exists per interaction, so the
 * logical outcome id is the interaction id and the first recording is version 1.
 * A disposition outside the contract allowlist is not a canonical outcome and is skipped.
 */
export async function recordDispositionOutcome(
  transaction: Prisma.TransactionClient,
  input: DispositionOutcomeInput,
): Promise<boolean> {
  if (!DISPOSITION_OUTCOME_CODES.includes(input.disposition)) return false;
  const payload = validateInteractionOutcomePayload({
    contractVersion: 1,
    outcomeType: DISPOSITION_OUTCOME_TYPE,
    outcomeId: input.interactionId,
    outcomeVersion: 1,
    interactionId: input.interactionId,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    outcomeCode: input.disposition,
    effectiveAt: input.recordedAt.toISOString(),
  });
  await transaction.interactionOutcomeOutbox.create({
    data: {
      id: randomUUID(),
      tenantId: input.tenantId,
      interactionId: input.interactionId,
      outcomeType: payload.outcomeType,
      outcomeId: payload.outcomeId,
      outcomeVersion: payload.outcomeVersion,
      payload: payload as unknown as Prisma.InputJsonValue,
      correlationId: input.commandId,
    },
  });
  return true;
}

interface PendingRow {
  id: string;
  payload: unknown;
  correlation_id: string;
  created_at: Date;
  attempts: number;
}

export type InteractionOutcomePublishResult = 'SENT' | 'RETRY' | undefined;

export class InteractionOutcomeRelay {
  private readonly now: () => Date;
  private readonly retryDelayMs: number;

  constructor(
    private readonly database: PrismaClient,
    private readonly producer: Pick<DcProducer, 'send'>,
    options: { now?: () => Date; retryDelayMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
  }

  /**
   * Publishes at most one due row. The row stays locked (SKIP LOCKED) until the broker acks, so two API
   * instances never publish the same row at once; SENT is committed only after the ack.
   * A failed send leaves the row PENDING with a later `available_at` — the error name is kept, never the message.
   */
  async publishNext(tenantId: string): Promise<InteractionOutcomePublishResult> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const [row] = await transaction.$queryRaw<PendingRow[]>(Prisma.sql`
        SELECT id, payload, correlation_id, created_at, attempts
        FROM interaction_outcome_outbox
        WHERE tenant_id = ${tenantId}::uuid AND state = 'PENDING' AND available_at <= ${this.now()}
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      if (!row) return undefined;
      try {
        const payload = validateInteractionOutcomePayload(row.payload);
        const envelope = assertInteractionOutcomeEnvelope({
          schemaVersion: 2,
          eventKind: 'CANONICAL',
          eventId: row.id,
          type: J2_EVENT_TYPES.INTERACTION_OUTCOME_RECORDED,
          tenantId,
          occurredAt: row.created_at.toISOString(),
          correlationId: row.correlation_id,
          orderingKey: payload.interactionId,
          aggregateType: 'interaction_outcome',
          aggregateId: payload.outcomeId,
          aggregateVersion: payload.outcomeVersion,
          payload,
        });
        await this.producer.send(
          KAFKA_TOPICS.INTERACTION_EVENTS,
          envelope as unknown as Parameters<DcProducer['send']>[1],
        );
      } catch (error) {
        await transaction.interactionOutcomeOutbox.update({
          where: { id: row.id },
          data: {
            attempts: { increment: 1 },
            availableAt: new Date(
              this.now().getTime() + this.retryDelayMs * Math.min(2 ** row.attempts, 64),
            ),
            lastError: error instanceof Error ? error.name : 'Unknown',
          },
        });
        return 'RETRY';
      }
      await transaction.interactionOutcomeOutbox.update({
        where: { id: row.id },
        data: {
          state: 'SENT',
          sentAt: this.now(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      return 'SENT';
    });
  }
}

export interface InteractionOutcomeWorkerOptions {
  database: PrismaClient;
  env?: NodeJS.ProcessEnv;
  log?: Log;
  intervalMs?: number;
  reconnectDelayMs?: (failures: number) => number;
  /** replaceable in tests */
  connectProducer?: () => Promise<DcProducer>;
}

export interface InteractionOutcomeWorker {
  publishOnce(): Promise<boolean>;
  stop(): Promise<void>;
}

/**
 * Starts the relay inside the API process without blocking boot. Kafka connects with backoff; until it does,
 * rows simply wait in the outbox.
 */
export function startInteractionOutcomeWorker(
  options: InteractionOutcomeWorkerOptions,
): InteractionOutcomeWorker | undefined {
  const env = options.env ?? process.env;
  const log = options.log ?? defaultLog;
  if (!resolveInteractionOutcomeEvents(env)) {
    log({ event: 'interaction.outcome_events.readiness', status: 'DISABLED' });
    return undefined;
  }
  const { database } = options;
  const connectProducer =
    options.connectProducer ?? (() => createProducer('dcontact-api-interaction-outcomes'));
  const reconnectDelayMs =
    options.reconnectDelayMs ??
    ((failures: number) => Math.min(2 ** failures * 5_000, 5 * 60_000));

  let stopped = false;
  let producer: DcProducer | undefined;
  let loop: BackgroundLoop | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;

  async function publishAll(relay: InteractionOutcomeRelay): Promise<void> {
    const tenants = await database.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    for (const tenant of tenants) {
      for (let handled = 0; handled < PUBLISH_PER_TENANT; handled += 1) {
        if ((await relay.publishNext(tenant.id)) !== 'SENT') break;
      }
    }
  }

  async function connect(failures: number): Promise<void> {
    if (stopped) return;
    try {
      const opened = await connectProducer();
      if (stopped) {
        await opened.disconnect();
        return;
      }
      producer = opened;
      const relay = new InteractionOutcomeRelay(database, opened);
      loop = startBackgroundLoop({
        name: 'interaction.outcome_relay',
        intervalMs: options.intervalMs ?? 1_000,
        log,
        work: () => publishAll(relay),
      });
      log({ event: 'interaction.outcome_events.kafka_connected', failures });
    } catch (error) {
      log({
        event: 'interaction.outcome_events.kafka_connect_failed',
        error: error instanceof Error ? error.name : 'Unknown',
        failures: failures + 1,
      });
      if (stopped) return;
      reconnect = setTimeout(() => void connect(failures + 1), reconnectDelayMs(failures + 1));
      reconnect.unref?.();
    }
  }
  void connect(0);
  log({ event: 'interaction.outcome_events.readiness', status: 'ENABLED' });

  return {
    publishOnce: async () => (loop ? loop.runOnce() : false),
    async stop() {
      stopped = true;
      loop?.stop();
      if (reconnect) clearTimeout(reconnect);
      await producer?.disconnect();
    },
  };
}
