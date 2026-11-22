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
} from './managed-voice-adapter.js';
import { runManagedVoiceDue, runManagedVoiceReadiness } from './managed-voice-due.js';
import { normalizeManagedVoiceEvent } from './managed-voice-events.js';

/**
 * #979: managed routing v1 ใน telephony หลัก (`main.ts`) แบบหลาย tenant
 *
 * เปิดด้วย `TELEPHONY_MANAGED_VOICE_ENABLED=true` เท่านั้น ถ้าไม่ตั้ง `main.ts` ทำงานแบบ legacy ตามเดิม
 * wiring ตามต้นแบบ `e1-sandbox-main.ts` (heartbeat/readiness, tick, dispatch, background job)
 * แต่ใช้ SIP domain ของแต่ละ tenant (`tenants.sip_domain`) แทน `FREESWITCH_SIP_DOMAIN` ค่าเดียว
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

/** tenant ที่ ACTIVE พร้อม SIP domain จาก `tenants.sip_domain` แคชสั้น ๆ เพื่อไม่ query ทุกคำสั่ง */
export class TenantSipDomainDirectory {
  private readonly cache = new Map<string, { sipDomain: string | undefined; expiresAt: number }>();

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
      this.cache.set(tenant.id, { sipDomain: tenant.sipDomain, expiresAt });
    return tenants.map((tenant) => tenant.id);
  }

  async sipDomain(tenantId: string): Promise<string | undefined> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > this.now()) return cached.sipDomain;
    if (!uuidPattern.test(tenantId)) return undefined;
    const tenant = await this.database.tenant.findUnique({
      where: { id: tenantId },
      select: { sipDomain: true, lifecycleStatus: true },
    });
    const sipDomain = tenant?.lifecycleStatus === 'ACTIVE' ? tenant.sipDomain : undefined;
    this.cache.set(tenantId, { sipDomain, expiresAt: this.now() + this.ttlMs });
    return sipDomain;
  }
}

export type ManagedVoiceRoute = 'managed' | 'legacy' | 'ignored';

export interface ManagedVoiceRouting {
  nodeId: string;
  /** สายฝั่งลูกค้า (A-leg) ที่ managed runtime ถืออยู่ */
  calls: Set<string>;
  handle(event: ManagedVoiceEvent): Promise<unknown>;
  onError(error: unknown): void;
}

/** ขาที่ managed runtime originate ไปหา Agent (B-leg) มี `dcontact_offer_id` เสมอ ห้ามส่งให้ legacy */
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
 * event ที่มี offer: B-leg และ A-leg หลัง adapter ตั้ง offer ก่อน bridge
 * ใช้ tenant ที่ adapter ตั้งไว้บนช่องสายตอน originate/bindCaller
 */
export async function routeManagedOfferLeg(
  source: FreeSwitchEvent,
  routing: ManagedVoiceRouting,
): Promise<ManagedVoiceRoute> {
  const tenantId = source.variable_dcontact_tenant_id;
  if (typeof tenantId !== 'string' || !uuidPattern.test(tenantId)) return 'ignored';
  const event = normalizeManagedVoiceEvent(source, tenantId, routing.nodeId);
  if (event) {
    await routing.handle(event);
    if (event.type === 'call.hangup' && !event.offerId) routing.calls.delete(event.callUuid);
  }
  return 'managed';
}

/**
 * แยก event ของสายฝั่งลูกค้า: managed runtime รับสายที่เบอร์ปลายทางผูกคิว managed v1
 * ที่เหลือ (คิว legacy, outbound delivery, DTMF ของสาย legacy) กลับไป legacy router ผ่าน Kafka ตามเดิม
 * ถ้า managed runtime ล้มกับสายที่ไม่รู้จัก ให้ legacy ทำต่อ เพื่อไม่ให้คิวเดิมเสียเพราะ managed
 */
export async function routeManagedCall(
  source: FreeSwitchEvent,
  tenantId: string,
  routing: ManagedVoiceRouting,
): Promise<ManagedVoiceRoute> {
  if (source.variable_dcontact_delivery_id !== undefined) return 'legacy';
  const callUuid = callerUuid(source);
  const known = callUuid !== undefined && routing.calls.has(callUuid);
  let event: ManagedVoiceEvent | undefined;
  let handled: unknown = null;
  try {
    event = normalizeManagedVoiceEvent(source, tenantId, routing.nodeId);
    if (event) handled = await routing.handle(event);
  } catch (error) {
    routing.onError(error);
    return known ? 'ignored' : 'legacy';
  }
  if (event && handled) {
    if (event.type === 'call.hangup') routing.calls.delete(event.callUuid);
    else routing.calls.add(event.callUuid);
    return 'managed';
  }
  if (known) {
    if (source['Event-Name'] === 'CHANNEL_HANGUP_COMPLETE' && source['Unique-ID'] === callUuid)
      routing.calls.delete(callUuid);
    return 'ignored';
  }
  // legacy ไม่ได้ subscribe CHANNEL_ANSWER มาก่อน — มีเพราะ managed ต้องรู้ว่า Agent รับ offer
  if (source['Event-Name'] === 'CHANNEL_ANSWER') return 'ignored';
  return 'legacy';
}

export interface ManagedVoiceTelephonyOptions {
  nodeId: string;
  database: PrismaClient;
  dispatchDatabase: PrismaClient;
  esl: ManagedVoiceEslTransport;
  directory: TenantSipDomainDirectory;
  log?: (message: string, error?: unknown) => void;
}

/** heartbeat/tick/dispatch ของ managed runtime ต่อทุก tenant ที่ ACTIVE บน node นี้ */
export class ManagedVoiceTelephony {
  readonly calls = new Set<string>();
  private readonly adapter: FreeSwitchManagedVoiceAdapter;
  private readonly runtime: ManagedVoiceRuntime;
  private readonly tenants = new Set<string>();
  private readonly backgroundJobs = new Set<string>();
  private readonly log: (message: string, error?: unknown) => void;
  private subscribed = false;
  private portReady = false;
  private timers: NodeJS.Timeout[] = [];
  private tasks: Promise<void>[] = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
  private busy = [false, false, false];

  constructor(private readonly options: ManagedVoiceTelephonyOptions) {
    this.log = options.log ?? ((message, error) => console.error(`[telephony] ${message}`, error));
    this.adapter = new FreeSwitchManagedVoiceAdapter(options.esl, options.nodeId, (tenantId) =>
      options.directory.sipDomain(tenantId),
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
          await this.adapter.bindCaller(command.tenantId, command.callUuid);
          return this.adapter.execute(command);
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
    };
  }

  isKnownCall(callUuid: string): boolean {
    return this.calls.has(callUuid);
  }

  /** ESL ยืนยัน `events plain ...` แล้วเท่านั้นจึงประกาศ readiness ได้ */
  setSubscribed(subscribed: boolean) {
    this.subscribed = subscribed;
    if (!subscribed) this.portReady = false;
  }

  backgroundJob(jobUuid: string) {
    if (uuidPattern.test(jobUuid)) this.backgroundJobs.add(jobUuid);
  }

  start() {
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
        tenantIds: () => this.activeTenantIds(),
        tick: (tenantId) => this.runtime.tick(tenantId, this.options.nodeId),
        onError: (error) => this.log('managed due-work failed', error),
      }),
    );
    every(2, () => this.dispatch());
  }

  /** หยุด timer รองานที่ค้าง แล้วถอน readiness ทุก tenant ทันที (ไม่รอ TTL) */
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
