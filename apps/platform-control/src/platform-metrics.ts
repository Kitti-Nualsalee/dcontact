/**
 * Owner: Platform operations — metrics of Platform provisioning (A1.8 #413, #388 checkpoint 2)
 *
 * - Prometheus (prom-client) — decision of the work owner in #413
 * - labels are a closed set only: source/kind/step/code/status/queue/invariant — never tenant, request,
 *   email, domain or slug; a code that does not match the stable code format is replaced by `OTHER`
 * - backlog/queue age/invariants are computed from the DB at scrape time (short cache) because they are state, not events —
 *   so several workers can report the same value without aggregating it themselves
 */
import { createServer, type Server } from 'node:http';
import type { PrismaClient } from '@d-contact/db';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const STEPS = new Set([
  'TENANT_RECORD',
  'KEYCLOAK_ORGANIZATION',
  'PLAN_BOOTSTRAP',
  'FIRST_ADMIN',
  'INVITATION',
  'READINESS',
]);

export function metricCode(value: unknown): string {
  return typeof value === 'string' && CODE.test(value) ? value : 'OTHER';
}

function metricStep(value: unknown): string {
  return typeof value === 'string' && STEPS.has(value) ? value : 'none';
}

type WorkerSource = 'saga' | 'command' | 'activity';

/** worker loop event — every label comes from an enum/stable code */
export class PlatformWorkerMetrics {
  private readonly results: Counter<'source' | 'kind' | 'step' | 'code'>;
  private readonly errors: Counter<'source'>;
  private readonly duration: Histogram<'source' | 'kind'>;
  private readonly endToEnd: Histogram<string>;
  private readonly claims: Gauge<string>;

  constructor(
    readonly registry: Registry,
    /** used to find the accepted → terminal time of a request that just reached COMPLETED */
    private readonly database?: Pick<PrismaClient, 'pfProvisioningRequest'>,
  ) {
    this.results = new Counter({
      name: 'dcontact_platform_worker_results_total',
      help: 'Outcome of a worker per unit of work (saga step or operator command)',
      labelNames: ['source', 'kind', 'step', 'code'],
      registers: [registry],
    });
    this.errors = new Counter({
      name: 'dcontact_platform_worker_errors_total',
      help: 'Errors that escaped from the saga/command worker',
      labelNames: ['source'],
      registers: [registry],
    });
    this.duration = new Histogram({
      name: 'dcontact_platform_worker_unit_duration_seconds',
      help: 'Duration of one unit of worker work',
      labelNames: ['source', 'kind'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [registry],
    });
    this.endToEnd = new Histogram({
      name: 'dcontact_platform_provisioning_duration_seconds',
      help: 'Time from accepting the request until the request is SUCCEEDED',
      buckets: [5, 15, 30, 60, 120, 300, 600, 1800, 3600],
      registers: [registry],
    });
    this.claims = new Gauge({
      name: 'dcontact_platform_worker_claims_enabled',
      help: '1 = the worker takes new work (platformProvisioning.enabled), 0 = rollback',
      registers: [registry],
    });
  }

  claimsEnabled(enabled: boolean) {
    this.claims.set(enabled ? 1 : 0);
  }

  async observe(source: WorkerSource, result: Record<string, unknown>, seconds: number) {
    const kind = metricCode(result.kind);
    const code =
      kind === 'LEASE_LOST'
        ? 'LEASE_LOST'
        : result.code !== undefined
          ? metricCode(result.code)
          : result.errorCode
            ? metricCode(result.errorCode)
            : result.state !== undefined
              ? metricCode(result.state)
              : 'none';
    this.results.inc({ source, kind, step: metricStep(result.stepKey), code });
    this.duration.observe({ source, kind }, seconds);
    if (kind === 'COMPLETED' && this.database && typeof result.requestId === 'string') {
      const request = await this.database.pfProvisioningRequest.findUnique({
        where: { id: result.requestId },
        select: { acceptedAt: true, terminalAt: true },
      });
      if (request?.terminalAt) {
        this.endToEnd.observe(
          Math.max(0, (request.terminalAt.getTime() - request.acceptedAt.getTime()) / 1000),
        );
      }
    }
  }

  error(source: WorkerSource) {
    this.errors.inc({ source });
  }
}

/**
 * invariants that must never occur (#393 non-waivable) — a value > 0 = critical alert
 * queried with role `dcontact_platform`, which sees only `tenants` (some columns) and `pf_*`
 */
export const PLATFORM_INVARIANTS = {
  /** a tenant is ACTIVE although the A1 request has not SUCCEEDED */
  premature_active: `
    SELECT count(*)::int AS n FROM tenants t
    JOIN pf_provisioning_requests r ON r.tenant_id = t.id
    WHERE t.lifecycle_status = 'ACTIVE' AND r.status <> 'SUCCEEDED'`,
  /** a tenant is ACTIVE although the readiness step did not pass */
  readiness_bypass: `
    SELECT count(*)::int AS n FROM tenants t
    JOIN pf_provisioning_steps s ON s.tenant_id = t.id AND s.step_key = 'READINESS'
    WHERE t.lifecycle_status = 'ACTIVE' AND s.state <> 'SUCCEEDED'`,
  /** a single external resource is recorded as belonging to more than one request */
  duplicate_ownership: `
    SELECT count(*)::int AS n FROM (
      SELECT step_key, external_ref_hash FROM pf_provisioning_step_receipts
      WHERE external_ref_hash IS NOT NULL
      GROUP BY step_key, external_ref_hash HAVING count(DISTINCT request_id) > 1
    ) duplicated`,
  /** child rows that reference a different tenant from their request */
  cross_tenant_reference: `
    SELECT (
      (SELECT count(*) FROM pf_action_history h JOIN pf_provisioning_requests r ON r.id = h.request_id
        WHERE h.tenant_id <> r.tenant_id) +
      (SELECT count(*) FROM pf_operator_commands c JOIN pf_provisioning_requests r ON r.id = c.request_id
        WHERE c.tenant_id <> r.tenant_id) +
      (SELECT count(*) FROM pf_invitations i JOIN pf_provisioning_requests r ON r.id = i.request_id
        WHERE i.tenant_id <> r.tenant_id)
    )::int AS n`,
  /**
   * state without a matching audit: a request has no REQUEST_ACCEPTED or a step succeeded without STEP_SUCCEEDED
   * (TENANT_RECORD succeeds in the same transaction that accepts the request — its audit is REQUEST_ACCEPTED)
   */
  audit_gap: `
    SELECT (
      (SELECT count(*) FROM pf_provisioning_requests r WHERE NOT EXISTS (
        SELECT 1 FROM pf_action_history h
        WHERE h.request_id = r.id AND h.action = 'REQUEST_ACCEPTED')) +
      (SELECT count(*) FROM pf_provisioning_steps s
        WHERE s.state = 'SUCCEEDED' AND s.step_key <> 'TENANT_RECORD' AND NOT EXISTS (
        SELECT 1 FROM pf_action_history h
        WHERE h.request_id = s.request_id AND h.step_key = s.step_key
          AND h.action = 'STEP_SUCCEEDED'))
    )::int AS n`,
} as const;

const QUEUE_AGES = {
  pending_request: `SELECT min(accepted_at) AS at FROM pf_provisioning_requests WHERE status = 'PENDING'`,
  action_required: `SELECT min(updated_at) AS at FROM pf_provisioning_requests WHERE status = 'ACTION_REQUIRED'`,
  invitation_outbox: `SELECT min(created_at) AS at FROM pf_invitations
    WHERE state IN ('INTENT', 'AMBIGUOUS') AND superseded_at IS NULL`,
  operator_command: `SELECT min(created_at) AS at FROM pf_operator_commands WHERE state = 'QUEUED'`,
} as const;

/** raw queries only — a PrismaClient with role `dcontact_platform` can be used directly */
export interface HealthDatabase {
  $queryRawUnsafe(sql: string): PromiseLike<unknown[]>;
}

interface HealthSnapshot {
  requests: { status: string; n: number }[];
  invitations: { state: string; n: number }[];
  ages: Record<keyof typeof QUEUE_AGES, number>;
  invariants: Record<keyof typeof PLATFORM_INVARIANTS, number>;
}

/** state from the DB at scrape time: backlog, queue age and invariants — cached for `minIntervalMs` to limit DB load */
export class PlatformHealthCollector {
  private cached: { at: number; snapshot: Promise<HealthSnapshot> } | null = null;

  constructor(
    private readonly database: HealthDatabase,
    registry: Registry,
    private readonly options: { minIntervalMs?: number; now?: () => Date } = {},
  ) {
    const snapshot = () => this.snapshot();
    const collectors: Array<
      [string, string, string[], (gauge: Gauge<string>, s: HealthSnapshot) => void]
    > = [
      [
        'dcontact_platform_requests',
        'Number of provisioning requests by status',
        ['status'],
        (gauge, s) => s.requests.forEach(({ status, n }) => gauge.set({ status }, n)),
      ],
      [
        'dcontact_platform_invitations',
        'Number of invitation generations by state',
        ['state'],
        (gauge, s) => s.invitations.forEach(({ state, n }) => gauge.set({ state }, n)),
      ],
      [
        'dcontact_platform_oldest_age_seconds',
        'Age of the oldest item in each queue (0 = queue empty)',
        ['queue'],
        (gauge, s) => Object.entries(s.ages).forEach(([queue, age]) => gauge.set({ queue }, age)),
      ],
      [
        'dcontact_platform_invariant_violations',
        'Number of rows violating an invariant that must never occur (#393) — must always be 0',
        ['invariant'],
        (gauge, s) =>
          Object.entries(s.invariants).forEach(([invariant, n]) => gauge.set({ invariant }, n)),
      ],
    ];
    // each gauge awaits the snapshot of the same scrape (the promise is cached) — values are never a round behind each other
    new Gauge({
      name: 'dcontact_platform_health_scrape_success',
      help: '1 = the state was read from the DB successfully in this scrape',
      registers: [registry],
      async collect() {
        this.set(
          await snapshot().then(
            () => 1,
            () => 0,
          ),
        );
      },
    });
    for (const [name, help, labelNames, fill] of collectors) {
      new Gauge({
        name,
        help,
        labelNames,
        registers: [registry],
        async collect() {
          this.reset();
          // DB down = no series for this gauge (stale values are not reported) — alert from health_scrape_success instead
          await snapshot().then(
            (value) => fill(this, value),
            () => undefined,
          );
        },
      });
    }
  }

  private snapshot(): Promise<HealthSnapshot> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < (this.options.minIntervalMs ?? 15_000)) {
      return this.cached.snapshot;
    }
    const snapshot = this.read();
    this.cached = { at: now, snapshot };
    // errors are not cached — the next scrape tries again
    snapshot.catch(() => {
      if (this.cached?.snapshot === snapshot) this.cached = null;
    });
    return snapshot;
  }

  private async read(): Promise<HealthSnapshot> {
    const query = async <T>(sql: string) => (await this.database.$queryRawUnsafe(sql)) as T[];
    const now = (this.options.now ?? (() => new Date()))().getTime();
    const ages = {} as HealthSnapshot['ages'];
    for (const [queue, sql] of Object.entries(QUEUE_AGES) as [keyof typeof QUEUE_AGES, string][]) {
      const [row] = await query<{ at: Date | null }>(sql);
      ages[queue] = row?.at ? Math.max(0, (now - row.at.getTime()) / 1000) : 0;
    }
    const invariants = {} as HealthSnapshot['invariants'];
    for (const [invariant, sql] of Object.entries(PLATFORM_INVARIANTS) as [
      keyof typeof PLATFORM_INVARIANTS,
      string,
    ][]) {
      invariants[invariant] = (await query<{ n: number }>(sql))[0]?.n ?? 0;
    }
    return {
      requests: await query(
        `SELECT status::text AS status, count(*)::int AS n FROM pf_provisioning_requests GROUP BY status`,
      ),
      invitations: await query(
        `SELECT state::text AS state, count(*)::int AS n FROM pf_invitations
         WHERE superseded_at IS NULL GROUP BY state`,
      ),
      ages,
      invariants,
    };
  }
}

/**
 * `/metrics` on a port separate from the public API — must not be exposed through the ingress/hostname of the Platform Console
 * answers only GET /metrics; any other path 404
 */
export function startMetricsServer(
  registry: Registry,
  options: { port: number; host?: string },
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.statusCode = 404;
      response.end();
      return;
    }
    registry.metrics().then(
      (body) => {
        response.setHeader('content-type', registry.contentType);
        response.end(body);
      },
      () => {
        response.statusCode = 500;
        response.end();
      },
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => resolve(server));
  });
}
