import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  ManagedVoiceRuntime,
  type ManagedVoiceDirectCommand,
  type ManagedVoiceEvent,
} from '@d-contact/router';
import type { FreeSwitchEvent } from './freeswitch-normalizer.js';
import {
  FreeSwitchManagedVoiceAdapter,
  type ManagedVoiceEslTransport,
  type ManagedVoiceSipDomainPurpose,
} from './managed-voice-adapter.js';
import { runManagedVoiceDue, runManagedVoiceReadiness } from './managed-voice-due.js';
import { normalizeManagedVoiceEvent } from './managed-voice-events.js';

/**
 * #979: managed routing v1 in the main telephony (`main.ts`), multi-tenant
 *
 * Enabled only with `TELEPHONY_MANAGED_VOICE_ENABLED=true`; if it is not set, `main.ts` works as legacy as before.
 * Wiring follows the `e1-sandbox-main.ts` model (heartbeat/readiness, tick, dispatch, background job)
 * but uses the SIP domain of each tenant (`tenants.sip_domain`) instead of the single `FREESWITCH_SIP_DOMAIN` value
 */
export function isManagedVoiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELEPHONY_MANAGED_VOICE_ENABLED === 'true';
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantSipDomainSource {
  tenant: {
    findMany(args: {
      where: { lifecycleStatus: 'ACTIVE' };
      select: { id: true; sipDomain: true };
    }): Promise<{ id: string; sipDomain: string }[]>;
    findUnique(args: {
      where: { id: string };
      select: { sipDomain: true; lifecycleStatus: true };
    }): Promise<{ sipDomain: string; lifecycleStatus: string } | null>;
  };
}

/**
 * The SIP domain of a tenant from `tenants.sip_domain`, cached briefly so it is not queried on every command.
 * originate works only for an ACTIVE tenant, while the channel check (bind) uses the domain even when the tenant is suspended
 * so cleanup commands of stuck calls still work
 */
export class TenantSipDomainDirectory {
  private readonly cache = new Map<
    string,
    { sipDomain: string | undefined; active: boolean; expiresAt: number }
  >();

  constructor(
    private readonly database: TenantSipDomainSource,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async activeTenantIds(): Promise<string[]> {
    const tenants = await this.database.tenant.findMany({
      where: { lifecycleStatus: 'ACTIVE' },
      select: { id: true, sipDomain: true },
    });
    const expiresAt = this.now() + this.ttlMs;
    for (const tenant of tenants)
      this.cache.set(tenant.id, { sipDomain: tenant.sipDomain, active: true, expiresAt });
    return tenants.map((tenant) => tenant.id);
  }

  async sipDomain(
    tenantId: string,
    purpose: ManagedVoiceSipDomainPurpose = 'originate',
  ): Promise<string | undefined> {
    let entry = this.cache.get(tenantId);
    if (!entry || entry.expiresAt <= this.now()) {
      if (!uuidPattern.test(tenantId)) return undefined;
      const tenant = await this.database.tenant.findUnique({
        where: { id: tenantId },
        select: { sipDomain: true, lifecycleStatus: true },
      });
      entry = {
        sipDomain: tenant?.sipDomain,
        active: tenant?.lifecycleStatus === 'ACTIVE',
        expiresAt: this.now() + this.ttlMs,
      };
      this.cache.set(tenantId, entry);
    }
    return purpose === 'bind' || entry.active ? entry.sipDomain : undefined;
  }
}

/**
 * A queue that orders work per key: the same key runs one job at a time in order, different keys run concurrently.
 * main.ts uses it to order events of the same call (managed must get offer → answer → bridge → hangup in order)
 * without letting slow work of one call (e.g. the audio archive of a legacy call, or a slow Kafka) block other calls
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly onError: (error: unknown) => void) {}

  run(key: string, work: () => Promise<void>): Promise<void> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(work).catch(this.onError);
    this.tails.set(key, next);
    void next.then(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  get size() {
    return this.tails.size;
  }
}

/** The event key: the customer-side call (a managed Agent leg has `dcontact_call_uuid` pointing at the customer call) */
export function managedEventKey(event: FreeSwitchEvent | undefined): string {
  if (!event) return 'control';
  if (event['Event-Name'] === 'BACKGROUND_JOB') return 'background-job';
  return callerUuid(event) ?? 'control';
}

export type ManagedVoiceRoute = 'managed' | 'legacy' | 'ignored';

export interface ManagedVoiceRouting {
  nodeId: string;
  /** The customer-side call (A-leg) that the managed runtime holds */
  calls: Set<string>;
  handle(event: ManagedVoiceEvent): Promise<unknown>;
  onError(error: unknown): void;
  /**
   * Called when the runtime did not take a new call: `call.created` failed on both attempts, or it returned no call
   * (e.g. the destination is inactive or not in this node's `destination_pool`). Returns true when the destination
   * belongs to a managed v1 queue and the caller was hung up: legacy rejects such calls (`VOICE_CONFIG_V1_REQUIRED`)
   * and the caller would stay parked with no wait limit. Returns false (or throws) to keep the call on legacy as before
   */
  rejectUnroutedCall?(event: ManagedVoiceEvent): Promise<boolean>;
  /**
   * Customer calls hung up by `rejectUnroutedCall`: their later events (PARK, HANGUP) are ignored so a PARK is not
   * turned into another `call.created` for a channel that is already being killed
   */
  rejected?: Set<string>;
}

const rejectedCallsLimit = 1000;

/** A leg the managed runtime originates to an Agent (B-leg) always has `dcontact_offer_id`; it must not be sent to legacy */
export function isManagedOfferLeg(source: FreeSwitchEvent): boolean {
  return typeof source.variable_dcontact_offer_id === 'string';
}

function callerUuid(source: FreeSwitchEvent): string | undefined {
  const value =
    source.variable_dcontact_call_uuid ??
    (source['Event-Name'] === 'CHANNEL_BRIDGE'
      ? source['Bridge-A-Unique-ID']
      : source['Unique-ID']);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Events with an offer: the B-leg and the A-leg after the adapter sets the offer before bridge
 * Uses the tenant the adapter set on the channel at originate/bindCaller
 */
export async function routeManagedOfferLeg(
  source: FreeSwitchEvent,
  routing: ManagedVoiceRouting,
): Promise<ManagedVoiceRoute> {
  const tenantId = source.variable_dcontact_tenant_id;
  if (typeof tenantId !== 'string' || !uuidPattern.test(tenantId)) return 'ignored';
  const event = normalizeManagedVoiceEvent(source, tenantId, routing.nodeId);
  if (event) {
    try {
      await routing.handle(event);
    } finally {
      if (event.type === 'call.hangup' && !event.offerId) routing.calls.delete(event.callUuid);
    }
  }
  return 'managed';
}

/**
 * Splits events of the customer-side call: the managed runtime takes calls whose destination number is bound to a managed v1 queue.
 * The rest (legacy queues, outbound delivery, DTMF of legacy calls) goes back to the legacy router via Kafka as before.
 * If the managed runtime fails on an unknown call, legacy continues, so existing queues are not broken by managed
 */
export async function routeManagedCall(
  source: FreeSwitchEvent,
  tenantId: string,
  routing: ManagedVoiceRouting,
): Promise<ManagedVoiceRoute> {
  if (source.variable_dcontact_delivery_id !== undefined) return 'legacy';
  const callUuid = callerUuid(source);
  if (callUuid !== undefined && routing.rejected?.has(callUuid)) {
    if (source['Event-Name'] === 'CHANNEL_HANGUP_COMPLETE' && source['Unique-ID'] === callUuid)
      routing.rejected.delete(callUuid);
    return 'ignored';
  }
  const known = callUuid !== undefined && routing.calls.has(callUuid);
  let event: ManagedVoiceEvent | undefined;
  let handled: unknown = null;
  try {
    event = normalizeManagedVoiceEvent(source, tenantId, routing.nodeId);
    if (event) {
      try {
        handled = await routing.handle(event);
      } catch (error) {
        // A new call that went the wrong way never comes back to managed (the next PARK is not converted to CREATE), so retry once
        if (event.type !== 'call.created') throw error;
        routing.onError(error);
        handled = await routing.handle(event);
      }
    }
  } catch (error) {
    routing.onError(error);
    if (!known && event?.type === 'call.created' && (await rejectUnroutedCall(event, routing)))
      return 'ignored';
    if (
      known &&
      source['Event-Name'] === 'CHANNEL_HANGUP_COMPLETE' &&
      source['Unique-ID'] === callUuid
    )
      routing.calls.delete(callUuid);
    return known ? 'ignored' : 'legacy';
  }
  if (event && handled) {
    if (event.type === 'call.hangup') routing.calls.delete(event.callUuid);
    else routing.calls.add(event.callUuid);
    return 'managed';
  }
  if (!known && event?.type === 'call.created' && (await rejectUnroutedCall(event, routing)))
    return 'ignored';
  if (known) {
    if (source['Event-Name'] === 'CHANNEL_HANGUP_COMPLETE' && source['Unique-ID'] === callUuid)
      routing.calls.delete(callUuid);
    return 'ignored';
  }
  // legacy did not subscribe to CHANNEL_ANSWER before — it is there because managed must know that the Agent accepted the offer
  if (source['Event-Name'] === 'CHANNEL_ANSWER') return 'ignored';
  return 'legacy';
}

async function rejectUnroutedCall(
  event: ManagedVoiceEvent,
  routing: ManagedVoiceRouting,
): Promise<boolean> {
  if (!routing.rejectUnroutedCall) return false;
  try {
    if (!(await routing.rejectUnroutedCall(event))) return false;
    if (routing.rejected) {
      if (routing.rejected.size >= rejectedCallsLimit)
        routing.rejected.delete(routing.rejected.values().next().value!);
      routing.rejected.add(event.callUuid);
    }
    return true;
  } catch (error) {
    routing.onError(error);
    return false;
  }
}

export interface ManagedVoiceTelephonyOptions {
  nodeId: string;
  database: PrismaClient;
  dispatchDatabase: PrismaClient;
  esl: ManagedVoiceEslTransport;
  directory: TenantSipDomainDirectory;
  log?: (message: string, error?: unknown) => void;
}

/** Heartbeat/tick/dispatch of the managed runtime for every ACTIVE tenant on this node */
export class ManagedVoiceTelephony {
  readonly calls = new Set<string>();
  readonly rejectedCalls = new Set<string>();
  private readonly adapter: FreeSwitchManagedVoiceAdapter;
  private readonly runtime: ManagedVoiceRuntime;
  private readonly tenants = new Set<string>();
  private readonly backgroundJobs = new Set<string>();
  private readonly failedCommands = new Map<string, string>();
  private readonly log: (message: string, error?: unknown) => void;
  private subscribed = false;
  private portReady = false;
  private timers: NodeJS.Timeout[] = [];
  private tasks: Promise<void>[] = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
  private busy = [false, false, false];

  constructor(private readonly options: ManagedVoiceTelephonyOptions) {
    this.log = options.log ?? ((message, error) => console.error(`[telephony] ${message}`, error));
    this.adapter = new FreeSwitchManagedVoiceAdapter(
      options.esl,
      options.nodeId,
      (tenantId, purpose) => options.directory.sipDomain(tenantId, purpose),
    );
    this.runtime = new ManagedVoiceRuntime(
      options.database,
      {
        readback: async (command: ManagedVoiceDirectCommand) => {
          if (!this.portReady) throw new Error('MANAGED_VOICE_PORT_UNAVAILABLE');
          return this.adapter.readback(command);
        },
        execute: async (command: ManagedVoiceDirectCommand) => {
          if (!this.portReady) throw new Error('MANAGED_VOICE_PORT_UNAVAILABLE');
          try {
            await this.adapter.bindCaller(command.tenantId, command.callUuid);
            return await this.adapter.execute(command);
          } catch (error) {
            // the runtime keeps only DIRECT_PORT_UNCONFIRMED, so log the real cause once per command
            const reason = error instanceof Error ? error.message : String(error);
            if (this.failedCommands.get(command.commandId) !== reason) {
              if (this.failedCommands.size >= 1000)
                this.failedCommands.delete(this.failedCommands.keys().next().value!);
              this.failedCommands.set(command.commandId, reason);
              this.log(`managed command ${command.type} ${command.commandId} unconfirmed`, reason);
            }
            throw error;
          }
        },
      },
      options.dispatchDatabase,
    );
  }

  get routing(): ManagedVoiceRouting {
    return {
      nodeId: this.options.nodeId,
      calls: this.calls,
      handle: (event) => this.runtime.handle(event),
      onError: (error) => this.log('managed event failed', error),
      rejectUnroutedCall: (event) => this.rejectUnroutedCall(event),
      rejected: this.rejectedCalls,
    };
  }

  /** Hangs up a new caller whose destination is bound to a managed v1 queue when the runtime did not take the call */
  private async rejectUnroutedCall(event: ManagedVoiceEvent): Promise<boolean> {
    if (!event.destination || !uuidPattern.test(event.callUuid)) return false;
    const destination = event.destination;
    const managed = await withTenantDatabaseTransaction(
      this.options.database,
      event.tenantId,
      (transaction) =>
        transaction.voiceDestination.findFirst({
          where: { tenantId: event.tenantId, destination, queue: { voiceConfigVersion: 1 } },
          select: { id: true },
        }),
    );
    if (!managed) return false;
    const reply = await this.options.esl.request(
      `api uuid_kill ${event.callUuid} NORMAL_TEMPORARY_FAILURE`,
    );
    if (!reply.trim().startsWith('+OK')) {
      // -ERR usually means the caller already hung up; if the channel is still there, keep the legacy fallback
      const exists = await this.options.esl.request(`api uuid_exists ${event.callUuid}`);
      if (exists.trim() !== 'false')
        throw new Error(`MANAGED_VOICE_REJECT_KILL_FAILED: ${reply.trim()}`);
      this.log(`managed runtime did not take caller ${event.callUuid}; it was already gone`);
      return true;
    }
    this.log(
      `managed runtime did not take caller ${event.callUuid} to a managed number; hung up instead of legacy`,
    );
    return true;
  }

  isKnownCall(callUuid: string): boolean {
    return this.calls.has(callUuid) || this.rejectedCalls.has(callUuid);
  }

  /** Readiness may be announced only after ESL confirms `events plain ...` */
  setSubscribed(subscribed: boolean) {
    this.subscribed = subscribed;
    if (!subscribed) this.portReady = false;
  }

  backgroundJob(jobUuid: string) {
    if (uuidPattern.test(jobUuid)) this.backgroundJobs.add(jobUuid);
  }

  /**
   * Reloads the customer calls this node still holds (QUEUED/ASSIGNED/ACTIVE) after a restart, so their DTMF/speech
   * and other events are not sent to legacy (which rejects managed calls) while the set in memory is empty.
   * Runs per ACTIVE tenant under RLS; returns how many calls were restored
   */
  async restoreCalls(): Promise<number> {
    let restored = 0;
    for (const tenantId of await this.activeTenantIds()) {
      const rows = await withTenantDatabaseTransaction(
        this.options.database,
        tenantId,
        (transaction) => transaction.$queryRaw<{ callUuid: string }[]>`
          SELECT c.call_uuid AS "callUuid" FROM voice_managed_calls c
          JOIN interactions i ON i.tenant_id=c.tenant_id AND i.id=c.interaction_id
          WHERE c.tenant_id=${tenantId}::uuid AND c.telephony_node_id=${this.options.nodeId}
            AND i.state IN ('QUEUED','ASSIGNED','ACTIVE')`,
      );
      for (const row of rows) {
        if (!this.calls.has(row.callUuid)) restored++;
        this.calls.add(row.callUuid);
      }
    }
    return restored;
  }

  start() {
    void this.restoreCalls()
      .then((restored) => {
        if (restored) this.log(`managed calls restored after start: ${restored}`);
      })
      .catch((error: unknown) => this.log('managed call restore failed', error));
    const every = (index: number, work: () => Promise<void>) => {
      const timer = setInterval(() => {
        if (this.busy[index]) return;
        this.busy[index] = true;
        this.tasks[index] = work()
          .catch((error: unknown) => this.log('managed background work failed', error))
          .finally(() => {
            this.busy[index] = false;
          });
      }, 1_000);
      timer.unref();
      this.timers.push(timer);
    };
    every(0, () => this.readiness());
    every(1, () =>
      runManagedVoiceDue({
        // A tenant that was ACTIVE keeps ticking so stuck calls reach their deadline and are hung up even if the tenant is suspended mid-call
        tenantIds: async () => {
          await this.activeTenantIds();
          return [...this.tenants];
        },
        tick: (tenantId) => this.runtime.tick(tenantId, this.options.nodeId),
        onError: (error) => this.log('managed due-work failed', error),
      }),
    );
    every(2, () => this.dispatch());
  }

  /** Stops the timers, waits for pending work, then withdraws readiness of every tenant at once (without waiting for the TTL) */
  async stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.setSubscribed(false);
    await Promise.allSettled(this.tasks);
    await this.clearReadiness();
  }

  private async activeTenantIds() {
    const tenantIds = await this.options.directory.activeTenantIds();
    for (const tenantId of tenantIds) this.tenants.add(tenantId);
    return tenantIds;
  }

  private readiness() {
    return runManagedVoiceReadiness({
      ready: () => (this.subscribed ? this.adapter.ready() : Promise.resolve(false)),
      setPortReady: (ready) => {
        this.portReady = ready && this.subscribed;
      },
      clearReadiness: () => this.clearReadiness(),
      tenantIds: () => this.activeTenantIds(),
      heartbeat: (tenantId) =>
        this.subscribed && this.portReady
          ? this.runtime.heartbeat(tenantId, this.options.nodeId)
          : this.clearReadiness(),
      onError: (error) => this.log('managed readiness failed', error),
    }).catch(async (error: unknown) => {
      this.portReady = false;
      this.log('managed readiness failed', error);
      await this.clearReadiness();
    });
  }

  private async dispatch() {
    if (!this.portReady) return;
    for (const jobUuid of [...this.backgroundJobs].slice(0, 4)) {
      await this.adapter.backgroundJob(jobUuid);
      this.backgroundJobs.delete(jobUuid);
    }
    const tenantIds = [...this.tenants];
    for (let offset = 0; offset < tenantIds.length; offset += 4) {
      const results = await Promise.allSettled(
        tenantIds
          .slice(offset, offset + 4)
          .map((tenantId) => this.runtime.flushCommands(tenantId, this.options.nodeId)),
      );
      for (const result of results)
        if (result.status === 'rejected') this.log('managed dispatch failed', result.reason);
    }
  }

  async clearReadiness() {
    const nodeId = this.options.nodeId;
    for (const tenantId of this.tenants) {
      await withTenantDatabaseTransaction(
        this.options.database,
        tenantId,
        (transaction) =>
          transaction.$executeRaw`UPDATE voice_managed_runtime_readiness
          SET direct_wired=false,expires_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=${tenantId}::uuid AND telephony_node_id=${nodeId}`,
      ).catch((error: unknown) =>
        this.log('managed readiness clear failed; TTL expiry required', error),
      );
    }
  }
}
