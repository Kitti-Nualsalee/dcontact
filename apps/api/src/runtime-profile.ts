/**
 * Owner: API bootstrap — the runtime profile of the tenant API (U1.2 #430)
 *
 * Authority: Phase Contract #374, real-vs-simulated boundary #378, UAT environment #373
 *
 * `uat` is the UAT first slice: Journey authoring/review/publish on real state but with no path to any external
 * side effect — no Kafka consumer/publisher, LINE webhook, provider credential, voice or Journey runtime
 * (the `apps/journey` worker is not deployed) the closing is structural: the UAT entry does not create those clients and does not
 * mount other controllers, rather than hiding buttons or turning flags on one by one
 *
 * config that contradicts the profile fails the boot (fail closed) instead of partially enabling
 *
 * `uat-line` (#565, ADR-031) is only the `line-webhook` service of the `uat-line` overlay: it receives the LINE webhook
 * only, no Kafka and no internet egress — the `uat` profile is unchanged
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const API_RUNTIME_PROFILES = [
  'default',
  'uat',
  'uat-e1',
  'uat-workspace',
  'uat-line',
] as const;
export type ApiRuntimeProfileName = (typeof API_RUNTIME_PROFILES)[number];

export interface ApiRuntimeProfile {
  readonly name: ApiRuntimeProfileName;
  readonly kafka: 'ENABLED' | 'DISABLED';
  readonly lineWebhook: 'ENABLED' | 'DISABLED';
  readonly providerEgress: 'ALLOWED' | 'BLOCKED';
  /** the route prefix this profile mounts; `null` = every controller of the original composition root */
  readonly allowedRoutePrefixes: readonly string[] | null;
}

export const API_PROFILE_ENV = 'DCONTACT_API_PROFILE';

/** the only routes the UAT first slice needs (#374 §1): Journey authoring/template, UAT run + the profile report */
export const UAT_ALLOWED_ROUTE_PREFIXES = Object.freeze([
  '/api/v1/journey-authoring',
  '/api/v1/uat-runs',
  '/api/v1/runtime-profile',
]);

/** E1.16: the acceptance surface is separate from the UAT first slice; no Journey/provider ingress */
export const UAT_E1_ALLOWED_ROUTE_PREFIXES = Object.freeze([
  '/api/v1/runtime-profile',
  '/api/v1/tenant/embed-origins',
  '/api/v1/me/work-session',
  '/api/v1/workspace/agent',
]);

/** #684: the full UI on the E1 sandbox; adds no Journey/provider runtime */
export const UAT_WORKSPACE_ALLOWED_ROUTE_PREFIXES = Object.freeze([
  ...UAT_E1_ALLOWED_ROUTE_PREFIXES,
  '/api/v1/me/navigation',
  '/api/v1/tenant/navigation',
  '/api/v1/tenant/locale-defaults',
  '/api/v1/workspace/supervisor',
  '/api/v1/tenant/core-settings/capabilities',
  '/api/v1/tenant/core-settings/organization',
  '/api/v1/tenant/core-settings/teams',
  '/api/v1/tenant/core-settings/not-ready-reasons',
  '/api/v1/tenant/core-settings/commands',
  '/api/v1/tenant-voice/capabilities',
  '/api/v1/tenant-voice/teams',
  '/api/v1/tenant-voice/queues',
  '/api/v1/tenant-voice/skills',
  '/api/v1/tenant-voice/commands',
  '/api/v1/tenant-voice/people',
  '/api/v1/tenant-voice/operations',
  '/api/v1/tenant-voice/extension-pool',
  '/api/v1/tenant-voice/eligibility',
  '/api/v1/tenant-voice/destinations',
]);

/**
 * env that means someone is trying to connect UAT to an external system — presence = config contradicting the profile
 * (LINE provider/webhook, a Kafka broker that would carry events to the runtime/delivery, voice/SIP)
 */
const UAT_FORBIDDEN_ENV: readonly RegExp[] = [/^LINE_/, /^KAFKA_BROKERS$/, /^SIP_/];

/** the prefix under `/api/` of `uat-line` — the webhook is at `/webhook/line` outside `/api/` */
export const UAT_LINE_ALLOWED_ROUTE_PREFIXES = Object.freeze([
  '/api/v1/runtime-profile',
  // #566: read-only for the pilot (OIDC + role admin)
  '/api/v1/line-pilot',
]);

/** the `LINE_*` that `line-webhook` accepts — references/modes only, no secret (#362 §9) */
export const UAT_LINE_ALLOWED_ENV = Object.freeze([
  'LINE_CREDENTIAL_DIR',
  // #567: team trial (sending replies) and a continuous worker — values are modes/refs/paths, not secrets
  'LINE_PILOT_SENDER_IDENTITY_ID',
  'LINE_PILOT_STATE_DIR',
  'LINE_TEAM_TRIAL',
  'LINE_WEBHOOK_WORKER',
  'LINE_WEBHOOK_CHANNEL_ACCOUNT_ID',
  'LINE_WEBHOOK_DESTINATION',
  'LINE_WEBHOOK_PAYLOAD_KEY_REF',
  'LINE_WEBHOOK_SECRET_SOURCE',
  'LINE_WEBHOOK_TENANT_ID',
]);

export class ApiRuntimeProfileError extends Error {
  constructor(
    readonly code: 'UNKNOWN_PROFILE' | 'CONFLICTING_CONFIGURATION' | 'WRONG_ENTRYPOINT',
    /** env names only — never put a value, since it may be a secret */
    readonly variables: readonly string[] = [],
  ) {
    super(
      variables.length > 0
        ? `api runtime profile ${code}: ${variables.join(', ')}`
        : `api runtime profile ${code}`,
    );
    this.name = 'ApiRuntimeProfileError';
  }
}

export function resolveApiRuntimeProfile(
  environment: NodeJS.ProcessEnv = process.env,
): ApiRuntimeProfile {
  const requested = environment[API_PROFILE_ENV]?.trim() || 'default';
  if (!(API_RUNTIME_PROFILES as readonly string[]).includes(requested)) {
    throw new ApiRuntimeProfileError('UNKNOWN_PROFILE', [API_PROFILE_ENV]);
  }
  if (requested === 'default') {
    return {
      name: 'default',
      kafka: 'ENABLED',
      lineWebhook: 'ENABLED',
      providerEgress: 'ALLOWED',
      allowedRoutePrefixes: null,
    };
  }
  const present = Object.keys(environment).filter(
    (name) => environment[name] !== undefined && environment[name] !== '',
  );
  if (requested === 'uat-line') {
    const conflicting = present
      .filter((name) => UAT_FORBIDDEN_ENV.some((pattern) => pattern.test(name)))
      .filter((name) => !UAT_LINE_ALLOWED_ENV.includes(name));
    // the secret on UAT comes only from the Compose `secrets` file — keychain/disabled means a wrong deploy
    if (environment.LINE_WEBHOOK_SECRET_SOURCE !== 'file') {
      conflicting.push('LINE_WEBHOOK_SECRET_SOURCE');
    }
    if (conflicting.length > 0) {
      throw new ApiRuntimeProfileError('CONFLICTING_CONFIGURATION', conflicting.sort());
    }
    return {
      name: 'uat-line',
      kafka: 'DISABLED',
      lineWebhook: 'ENABLED',
      providerEgress: 'BLOCKED',
      allowedRoutePrefixes: UAT_LINE_ALLOWED_ROUTE_PREFIXES,
    };
  }
  if (requested === 'uat-e1' || requested === 'uat-workspace') {
    const conflicting = present
      .filter((name) => [/^LINE_/, /^KAFKA_BROKERS$/].some((pattern) => pattern.test(name)))
      .sort();
    if (conflicting.length > 0) {
      throw new ApiRuntimeProfileError('CONFLICTING_CONFIGURATION', conflicting);
    }
    return {
      name: requested,
      kafka: 'DISABLED',
      lineWebhook: 'DISABLED',
      providerEgress: 'BLOCKED',
      allowedRoutePrefixes:
        requested === 'uat-workspace'
          ? UAT_WORKSPACE_ALLOWED_ROUTE_PREFIXES
          : UAT_E1_ALLOWED_ROUTE_PREFIXES,
    };
  }
  const conflicting = present
    .filter((name) => UAT_FORBIDDEN_ENV.some((pattern) => pattern.test(name)))
    .sort();
  if (conflicting.length > 0) {
    throw new ApiRuntimeProfileError('CONFLICTING_CONFIGURATION', conflicting);
  }
  return {
    name: 'uat',
    kafka: 'DISABLED',
    lineWebhook: 'DISABLED',
    providerEgress: 'BLOCKED',
    allowedRoutePrefixes: UAT_ALLOWED_ROUTE_PREFIXES,
  };
}

/** each entrypoint accepts exactly one profile — running the wrong composition root must fail at boot */
export function assertEntrypointProfile(
  expected: ApiRuntimeProfileName,
  environment: NodeJS.ProcessEnv = process.env,
): ApiRuntimeProfile {
  const profile = resolveApiRuntimeProfile(environment);
  if (profile.name !== expected) {
    throw new ApiRuntimeProfileError('WRONG_ENTRYPOINT', [API_PROFILE_ENV]);
  }
  return profile;
}

export interface RuntimeProfileDiagnostic {
  event: 'api.runtime_profile.route_blocked';
  profile: ApiRuntimeProfileName;
  /** only the first segment after `/api/v1/` — the full path may contain an id */
  routeFamily: string;
  method: string;
}

export interface RuntimeProfileDiagnosticSink {
  write(diagnostic: RuntimeProfileDiagnostic): void;
}

function routeFamily(path: string): string {
  const [, , version, family] = path.split('/');
  const safe = (value: string | undefined) =>
    value && /^[a-z0-9-]{1,64}$/.test(value) ? value : 'unknown';
  return version === 'v1' ? safe(family) : safe(version);
}

/**
 * express middleware of a profile that restricts routes: a request under `/api/` that is not in the allowlist is answered 404
 * with a stable code and is counted/recorded as evidence that someone tried a route UAT closed
 */
export class RuntimeProfileRouteGuard {
  private blocked = 0;

  constructor(
    private readonly profile: ApiRuntimeProfile,
    private readonly sink: RuntimeProfileDiagnosticSink,
  ) {}

  blockedRequests(): number {
    return this.blocked;
  }

  isAllowed(path: string): boolean {
    const prefixes = this.profile.allowedRoutePrefixes;
    if (prefixes === null || !path.startsWith('/api/')) return true;
    return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  }

  readonly middleware = (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): void => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (this.isAllowed(path)) {
      next();
      return;
    }
    this.blocked += 1;
    this.sink.write({
      event: 'api.runtime_profile.route_blocked',
      profile: this.profile.name,
      routeFamily: routeFamily(path),
      method: request.method ?? 'UNKNOWN',
    });
    response.statusCode = 404;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        status: 404,
        code: 'ROUTE_NOT_AVAILABLE_IN_PROFILE',
        title: 'Route is not available in this environment',
        retryable: false,
      }),
    );
  };
}
