/**
 * Owner: Platform control plane — process ของ worker (A1.6 #411)
 *
 * รวม saga worker (step ของ provisioning) กับ operator command worker (preview/recovery/resend ที่ API
 * บันทึกไว้) ไว้ใน process เดียวที่ถือ Keycloak credential — Platform API ไม่มี credential นี้
 * (decision ใน #388)
 *
 * - DB สอง role: `dcontact_platform` (control plane) และ `dcontact_provisioner` (bootstrap rows)
 * - log เป็น structured JSON ที่มีแค่ id/code/kind — ไม่มี email, token หรือ payload
 * - A1.8 (#413): `platformProvisioning.enabled` ปิด = ไม่รับ lease/command ใหม่ (rollback) โดยไม่แตะ
 *   state ที่ค้างอยู่ — เปิดอีกครั้งแล้ว lease ที่หมดอายุถูก adopt และทำต่อตาม saga
 */
import type { PrismaClient } from '@d-contact/db';
import { FirstAdminActivityReconciler } from './first-admin-activity.js';
import {
  InvitationOutbox,
  mailpitDeliveryProbe,
  NO_DELIVERY_PROBE,
  type InvitationDeliveryProbe,
} from './invitation-outbox.js';
import { KeycloakAdminClient } from './keycloak-admin.js';
import { FirstAdminPort, KeycloakOrganizationPort } from './keycloak-provisioning-ports.js';
import type { TenantConsoleContext } from './tenant-console-context.js';
import { TenantConsoleRedirects } from './tenant-console-redirects.js';
import { OperatorCommandWorker } from './operator-commands.js';
import type { PlatformWorkerMetrics } from './platform-metrics.js';
import type { PlatformRollout } from './platform-rollout.js';
import { ProvisioningRecoveryService } from './provisioning-recovery.js';
import { ProvisioningSagaWorker, type ProvisioningStepPorts } from './provisioning-saga.js';
import { TenantBootstrapPort, TenantReadinessPort } from './tenant-bootstrap.js';

export interface PlatformWorkerConfig {
  workerId: string;
  platform: PrismaClient;
  provisioner: PrismaClient;
  keycloak: KeycloakAdminClient;
  sipBaseDomain: string;
  /** #901: issuer/client ของ tenant Console ที่ binding ของ first admin ผูกไว้ */
  tenantConsole: TenantConsoleContext;
  rollout: PlatformRollout;
  metrics?: PlatformWorkerMetrics;
  probe?: InvitationDeliveryProbe;
  log?: (event: Record<string, unknown>) => void;
}

/** ส่วนที่ loop ต้องใช้ — แยกจาก adapter จริงเพื่อให้ rollback drill ใช้ fake ports ได้ */
export interface PlatformWorkerLoopConfig {
  workerId: string;
  saga: Pick<ProvisioningSagaWorker, 'runOnce'>;
  commands: Pick<OperatorCommandWorker, 'runOnce'>;
  /** A1.8: reconcile เหตุการณ์ของ first admin จาก Keycloak ลง timeline */
  activity?: Pick<FirstAdminActivityReconciler, 'runOnce'>;
  rollout: PlatformRollout;
  metrics?: PlatformWorkerMetrics;
  log?: (event: Record<string, unknown>) => void;
  /** เพดานของ backoff ตอนรอบล้มติดกัน (ค่าเริ่ม 30 วินาที) */
  maxBackoffMs?: number;
  /** ฉีดได้ใน test — ค่าเริ่ม Math.random */
  random?: () => number;
  /** ฉีดได้ใน test — ค่าเริ่มคือรอแบบยกเลิกได้ด้วย signal */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * หน่วงหลังรอบที่ล้มติดกัน `failures` ครั้ง: exponential จาก `baseMs` มีเพดาน `maxMs` และ equal jitter
 * (ครึ่งหนึ่งคงที่ อีกครึ่งสุ่ม) เพื่อไม่ให้ worker หลายตัวกลับมาพร้อมกันตอน DB กลับมา
 */
export function computeBackoffMs(
  failures: number,
  options: { baseMs: number; maxMs: number; random?: () => number },
): number {
  const base = Math.max(1, options.baseMs);
  const exponent = Math.min(Math.max(0, failures - 1), 30);
  const ceiling = Math.min(options.maxMs, base * 2 ** exponent);
  const random = options.random ?? Math.random;
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    // ถอด listener ทุกรอบ — loop ที่รันยาวต้องไม่สะสม listener บน signal เดียว
    const wake = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    signal.addEventListener('abort', wake, { once: true });
  });
}

export function createPlatformWorker(config: PlatformWorkerConfig) {
  const organizations = new KeycloakOrganizationPort(config.keycloak);
  const firstAdmin = new FirstAdminPort(
    config.keycloak,
    config.provisioner,
    organizations,
    new TenantConsoleRedirects(config.keycloak, config.provisioner, config.tenantConsole),
  );
  const invitations = new InvitationOutbox(config.platform, config.keycloak, firstAdmin, {
    probe: config.probe ?? NO_DELIVERY_PROBE,
  });
  const ports: ProvisioningStepPorts = {
    KEYCLOAK_ORGANIZATION: organizations,
    PLAN_BOOTSTRAP: new TenantBootstrapPort(config.platform, config.provisioner),
    FIRST_ADMIN: firstAdmin,
    INVITATION: invitations.port(),
    READINESS: new TenantReadinessPort(
      config.platform,
      config.provisioner,
      async (context) => (await firstAdmin.find(context)).status === 'FOUND',
    ),
  };
  const saga = new ProvisioningSagaWorker(config.platform, ports, {
    workerId: config.workerId,
    sipBaseDomain: config.sipBaseDomain,
    tenantConsole: config.tenantConsole,
  });
  const commands = new OperatorCommandWorker(
    config.platform,
    {
      recovery: new ProvisioningRecoveryService(config.platform, ports, {
        sipBaseDomain: config.sipBaseDomain,
      }),
      invitations,
    },
    { workerId: config.workerId },
  );
  return {
    saga,
    commands,
    ...createPlatformWorkerLoop({
      workerId: config.workerId,
      saga,
      commands,
      activity: new FirstAdminActivityReconciler(config.platform, config.keycloak),
      rollout: config.rollout,
      ...(config.metrics ? { metrics: config.metrics } : {}),
      ...(config.log ? { log: config.log } : {}),
    }),
  };
}

export function createPlatformWorkerLoop(config: PlatformWorkerLoopConfig) {
  const { saga, commands, activity } = config;
  const log = config.log ?? (() => undefined);

  let paused: boolean | null = null;
  const sleep = config.sleep ?? abortableSleep;
  const maxBackoffMs = config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  /** หนึ่งรอบ: ทำ step หนึ่งหน่วยและ command หนึ่งคำสั่ง — คืน true ถ้ามีงานทำ */
  async function tick(): Promise<boolean> {
    return (await round()).busy;
  }

  /** เหมือน tick แต่บอกด้วยว่ามี source ไหนล้มในรอบนี้ — run ใช้ตัดสินว่าต้อง backoff */
  async function round(): Promise<{ busy: boolean; failed: boolean }> {
    const enabled = config.rollout.claimsEnabled();
    config.metrics?.claimsEnabled(enabled);
    if (paused !== !enabled) {
      paused = !enabled;
      log({
        event: enabled ? 'platform.worker.claims_enabled' : 'platform.worker.claims_paused',
        workerId: config.workerId,
      });
    }
    // rollback: ไม่ claim อะไรเลย — ไม่ใช่ claim แล้วปล่อย (ไม่เพิ่ม attempt/lease churn)
    if (!enabled) return { busy: false, failed: false };
    let busy = false;
    let failed = false;
    for (const [source, work] of [
      ['saga', () => saga.runOnce()],
      ['command', () => commands.runOnce()],
      ...(activity ? [['activity', () => activity.runOnce()] as const] : []),
    ] as const) {
      const started = performance.now();
      try {
        const result = await work();
        if (result.kind !== 'IDLE') {
          busy = true;
          await config.metrics
            ?.observe(source, result, (performance.now() - started) / 1000)
            .catch(() => undefined);
          log({
            event: `platform.worker.${source}`,
            workerId: config.workerId,
            ...summarize(result),
          });
        }
      } catch (error) {
        busy = true;
        failed = true;
        config.metrics?.error(source);
        log({
          event: 'platform.worker.error',
          workerId: config.workerId,
          source,
          error: error instanceof Error ? error.name : 'Unknown',
          code: (error as { code?: unknown }).code ?? null,
        });
      }
    }
    return { busy, failed };
  }

  /**
   * รอบที่ล้ม (เช่น DB หาย P1001/P1017) ต้องไม่วนทันที — เดิมเกิด `platform.worker.error` หลายหมื่นครั้ง
   * ในไม่กี่วินาทีตอน db-relay ถูกสร้างใหม่ (#901) จึง backoff แบบ exponential + jitter มีเพดาน
   * และ reset เมื่อรอบถัดไปไม่มี error
   */
  async function run(signal: AbortSignal, pollMs = 1_000) {
    let failures = 0;
    while (!signal.aborted) {
      const outcome = await round();
      if (outcome.failed) {
        failures += 1;
        const delayMs = computeBackoffMs(failures, {
          baseMs: pollMs,
          maxMs: maxBackoffMs,
          ...(config.random ? { random: config.random } : {}),
        });
        log({
          event: 'platform.worker.backoff',
          workerId: config.workerId,
          failures,
          delayMs,
        });
        await sleep(delayMs, signal);
        continue;
      }
      if (failures > 0) {
        log({ event: 'platform.worker.recovered', workerId: config.workerId, failures });
        failures = 0;
      }
      if (!outcome.busy) await sleep(pollMs, signal);
    }
  }

  return { tick, run };
}

/** เก็บเฉพาะ field ที่ไม่ใช่ PII จากผลของ worker */
function summarize(result: object): Record<string, unknown> {
  const allowed = [
    'kind',
    'requestId',
    'tenantId',
    'stepKey',
    'code',
    'commandId',
    'state',
    'errorCode',
    'adopted',
    'recorded',
  ];
  return Object.fromEntries(Object.entries(result).filter(([key]) => allowed.includes(key)));
}

export function deliveryProbeFromEnv(env: NodeJS.ProcessEnv): InvitationDeliveryProbe {
  // mailpit มีเฉพาะ dev/test — production ไม่มี lookup (ambiguous → operator)
  return env.MAILPIT_URL ? mailpitDeliveryProbe(env.MAILPIT_URL) : NO_DELIVERY_PROBE;
}
