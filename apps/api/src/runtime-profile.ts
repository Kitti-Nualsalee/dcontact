/**
 * Owner: API bootstrap — runtime profile ของ tenant API (U1.2 #430)
 *
 * Authority: Phase Contract #374, real-vs-simulated boundary #378, UAT environment #373
 *
 * `uat` คือ UAT first slice: Journey authoring/review/publish บน state จริง แต่ไม่มีเส้นทางไป side effect
 * ภายนอกเลย — ไม่มี Kafka consumer/publisher, LINE webhook, provider credential, voice หรือ Journey runtime
 * (ไม่ deploy `apps/journey` worker) การปิดทำด้วยโครงสร้าง: entry ของ UAT ไม่สร้าง client เหล่านั้นและไม่
 * mount controller อื่น ไม่ใช่การซ่อนปุ่มหรือเปิด flag ทีละตัว
 *
 * config ที่ขัดกับ profile ทำให้บูตไม่ผ่าน (fail closed) แทนการเปิดบางส่วน
 *
 * `uat-line` (#565, ADR-031) คือ service `line-webhook` ของ overlay `uat-line` เท่านั้น: รับ LINE webhook
 * อย่างเดียว ไม่มี Kafka และไม่ออก internet — profile `uat` ไม่เปลี่ยน
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const API_RUNTIME_PROFILES = ['default', 'uat', 'uat-line'] as const;
export type ApiRuntimeProfileName = (typeof API_RUNTIME_PROFILES)[number];

export interface ApiRuntimeProfile {
  readonly name: ApiRuntimeProfileName;
  readonly kafka: 'ENABLED' | 'DISABLED';
  readonly lineWebhook: 'ENABLED' | 'DISABLED';
  readonly providerEgress: 'ALLOWED' | 'BLOCKED';
  /** prefix ของ route ที่ profile นี้ mount; `null` = ทุก controller ของ composition root เดิม */
  readonly allowedRoutePrefixes: readonly string[] | null;
}

export const API_PROFILE_ENV = 'DCONTACT_API_PROFILE';

/** route ที่ UAT first slice ต้องใช้เท่านั้น (#374 §1): Journey authoring/template, UAT run + รายงาน profile */
export const UAT_ALLOWED_ROUTE_PREFIXES = Object.freeze([
  '/api/v1/journey-authoring',
  '/api/v1/uat-runs',
  '/api/v1/runtime-profile',
]);

/**
 * env ที่แปลว่ามีคนพยายามต่อ UAT เข้ากับระบบภายนอก — มีอยู่ = config ขัดกับ profile
 * (LINE provider/webhook, Kafka broker ที่จะพา event ไป runtime/delivery, voice/SIP)
 */
const UAT_FORBIDDEN_ENV: readonly RegExp[] = [/^LINE_/, /^KAFKA_BROKERS$/, /^SIP_/];

/** prefix ใต้ `/api/` ของ `uat-line` — webhook อยู่ที่ `/webhook/line` นอก `/api/` */
export const UAT_LINE_ALLOWED_ROUTE_PREFIXES = Object.freeze([
  '/api/v1/runtime-profile',
  // #566: read-only ของ pilot (OIDC + role admin)
  '/api/v1/line-pilot',
]);

/** `LINE_*` ที่ `line-webhook` รับได้ — เป็น reference/โหมดเท่านั้น ไม่มี secret (#362 §9) */
export const UAT_LINE_ALLOWED_ENV = Object.freeze([
  'LINE_CREDENTIAL_DIR',
  // #567: team trial (ส่งตอบกลับ) และ worker ต่อเนื่อง — ค่าเป็นโหมด/ref/path ไม่ใช่ secret
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
    /** ชื่อ env เท่านั้น — ห้ามใส่ค่า เพราะอาจเป็น secret */
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
    // secret บน UAT มาจากไฟล์ Compose `secrets` เท่านั้น — keychain/disabled แปลว่า deploy ผิด
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

/** แต่ละ entrypoint รับได้ profile เดียว — รัน composition root ผิดตัวต้องล้มตั้งแต่บูต */
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
  /** ส่วนแรกหลัง `/api/v1/` เท่านั้น — path เต็มอาจมี id */
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
 * express middleware ของ profile ที่จำกัด route: request ใต้ `/api/` ที่ไม่อยู่ใน allowlist ถูกตอบ 404
 * พร้อม stable code และนับ/บันทึกเป็นหลักฐานว่ามีคนพยายามใช้เส้นทางที่ UAT ปิดไว้
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
