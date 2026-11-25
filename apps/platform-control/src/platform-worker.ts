/**
 * Owner: Platform control plane — the worker process (A1.6 #411)
 *
 * Combines the saga worker (provisioning steps) with the operator command worker (preview/recovery/resend that the API
 * records) in one process that holds the Keycloak credential — the Platform API does not have this credential
 * (decision in #388)
 *
 * - two DB roles: `dcontact_platform` (control plane) and `dcontact_provisioner` (bootstrap rows)
 * - logs are structured JSON with only id/code/kind — no email, token or payload
 * - A1.8 (#413): `platformProvisioning.enabled` off = no new lease/command (rollback) without touching the
 *   pending state — once turned on again, expired leases are adopted and continue per the saga
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
  /** #901: issuer/client of the tenant Console that the first admin's binding is tied to */
  tenantConsole: TenantConsoleContext;
  rollout: PlatformRollout;
  metrics?: PlatformWorkerMetrics;
  probe?: InvitationDeliveryProbe;
  log?: (event: Record<string, unknown>) => void;
}

/** what the loop needs — kept separate from the real adapters so the rollback drill can use fake ports */
export interface PlatformWorkerLoopConfig {
  workerId: string;
  saga: Pick<ProvisioningSagaWorker, 'runOnce'>;
  commands: Pick<OperatorCommandWorker, 'runOnce'>;
  /** A1.8: reconcile first admin events from Keycloak into the timeline */
  activity?: Pick<FirstAdminActivityReconciler, 'runOnce'>;
  rollout: PlatformRollout;
  metrics?: PlatformWorkerMetrics;
  log?: (event: Record<string, unknown>) => void;
  /** cap of the backoff when rounds fail consecutively (default 30 seconds) */
  maxBackoffMs?: number;
  /** injectable in tests — default Math.random */
  random?: () => number;
  /** injectable in tests — default is a wait that a signal can cancel */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * delay after `failures` consecutive failed rounds: exponential from `baseMs` capped at `maxMs` with equal jitter
 * (half fixed, half random) so several workers do not come back at once when the DB returns
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
    // remove the listener every round — a long-running loop must not accumulate listeners on one signal
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

  /** one round: do one unit of step work and one command — returns true if there was work */
  async function tick(): Promise<boolean> {
    return (await round()).busy;
  }

  /** like tick but also says which source failed in this round — run uses it to decide whether to back off */
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
    // rollback: claim nothing at all — not claim-then-release (no attempt/lease churn increase)
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
   * a failed round (e.g. DB lost P1001/P1017) must not spin immediately — it used to produce tens of thousands of `platform.worker.error`
   * within seconds when the db-relay was recreated (#901), so it backs off exponentially + jitter with a cap
   * and resets when the next round has no error
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

/** keeps only non-PII fields from the worker result */
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
  // mailpit exists only in dev/test — production has no lookup (ambiguous → operator)
  return env.MAILPIT_URL ? mailpitDeliveryProbe(env.MAILPIT_URL) : NO_DELIVERY_PROBE;
}
