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
import {
  InvitationOutbox,
  mailpitDeliveryProbe,
  NO_DELIVERY_PROBE,
  type InvitationDeliveryProbe,
} from './invitation-outbox.js';
import { KeycloakAdminClient } from './keycloak-admin.js';
import { FirstAdminPort, KeycloakOrganizationPort } from './keycloak-provisioning-ports.js';
import { OperatorCommandWorker } from './operator-commands.js';
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
  rollout: PlatformRollout;
  probe?: InvitationDeliveryProbe;
  log?: (event: Record<string, unknown>) => void;
}

/** ส่วนที่ loop ต้องใช้ — แยกจาก adapter จริงเพื่อให้ rollback drill ใช้ fake ports ได้ */
export interface PlatformWorkerLoopConfig {
  workerId: string;
  saga: Pick<ProvisioningSagaWorker, 'runOnce'>;
  commands: Pick<OperatorCommandWorker, 'runOnce'>;
  rollout: PlatformRollout;
  log?: (event: Record<string, unknown>) => void;
}

export function createPlatformWorker(config: PlatformWorkerConfig) {
  const organizations = new KeycloakOrganizationPort(config.keycloak);
  const firstAdmin = new FirstAdminPort(config.keycloak, config.provisioner, organizations);
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
      rollout: config.rollout,
      ...(config.log ? { log: config.log } : {}),
    }),
  };
}

export function createPlatformWorkerLoop(config: PlatformWorkerLoopConfig) {
  const { saga, commands } = config;
  const log = config.log ?? (() => undefined);

  let paused: boolean | null = null;

  /** หนึ่งรอบ: ทำ step หนึ่งหน่วยและ command หนึ่งคำสั่ง — คืน true ถ้ามีงานทำ */
  async function tick(): Promise<boolean> {
    const enabled = config.rollout.claimsEnabled();
    if (paused !== !enabled) {
      paused = !enabled;
      log({
        event: enabled ? 'platform.worker.claims_enabled' : 'platform.worker.claims_paused',
        workerId: config.workerId,
      });
    }
    // rollback: ไม่ claim อะไรเลย — ไม่ใช่ claim แล้วปล่อย (ไม่เพิ่ม attempt/lease churn)
    if (!enabled) return false;
    let busy = false;
    for (const [source, work] of [
      ['saga', () => saga.runOnce()],
      ['command', () => commands.runOnce()],
    ] as const) {
      try {
        const result = await work();
        if (result.kind !== 'IDLE') {
          busy = true;
          log({
            event: `platform.worker.${source}`,
            workerId: config.workerId,
            ...summarize(result),
          });
        }
      } catch (error) {
        busy = true;
        log({
          event: 'platform.worker.error',
          workerId: config.workerId,
          source,
          error: error instanceof Error ? error.name : 'Unknown',
          code: (error as { code?: unknown }).code ?? null,
        });
      }
    }
    return busy;
  }

  async function run(signal: AbortSignal, pollMs = 1_000) {
    while (!signal.aborted) {
      if (!(await tick())) {
        await new Promise<void>((resolve) => {
          // ถอด listener ทุกรอบ — loop ที่รันยาวต้องไม่สะสม listener บน signal เดียว
          const wake = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', wake);
            resolve();
          };
          const timer = setTimeout(wake, pollMs);
          signal.addEventListener('abort', wake, { once: true });
        });
      }
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
  ];
  return Object.fromEntries(Object.entries(result).filter(([key]) => allowed.includes(key)));
}

export function deliveryProbeFromEnv(env: NodeJS.ProcessEnv): InvitationDeliveryProbe {
  // mailpit มีเฉพาะ dev/test — production ไม่มี lookup (ambiguous → operator)
  return env.MAILPIT_URL ? mailpitDeliveryProbe(env.MAILPIT_URL) : NO_DELIVERY_PROBE;
}
