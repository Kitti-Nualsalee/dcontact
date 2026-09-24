/**
 * Owner: IAM + Platform edge — authorization boundary ของ Platform API (A1.2 #407)
 *
 * Authority: #387 enforcement invariants, Phase Contract #388
 *
 * - global guard แบบ deny by default: route ต้องประกาศ `@RequirePlatformCapability(...)` หรือ
 *   `@PlatformPublic()` อย่างใดอย่างหนึ่ง — route ที่ลืมประกาศถูกปฏิเสธ (403) ไม่ใช่เปิดโล่ง
 * - token ต้องผ่าน verifier (signature/issuer/audience/expiry) และ `toVerifiedPlatformIdentity`
 *   (ไม่มี tenant context, มี MFA, มี platform role) — ไม่ผ่านข้อใด = 401
 * - มี identity แต่ role ไม่ครอบ capability = 403
 * - error body เป็น envelope เดียวกันทุกกรณี ไม่บอกเหตุผลเชิงลึกกับ client; เหตุผลจริงไปที่ diagnostics
 *   ซึ่งห้ามมี token หรือ claim ที่เป็น PII (email/ชื่อ)
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Catch,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type ArgumentsHost,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformProvisioningError, type PlatformProvisioningErrorCode } from '@d-contact/shared';
import {
  PlatformIdentityError,
  toVerifiedPlatformIdentity,
  type PlatformCapability,
  type PlatformIdentityRejection,
  type VerifiedPlatformIdentity,
} from './platform-identity.js';
import type { PlatformAccessTokenVerifier } from './platform-verifier.js';

export const PLATFORM_ACCESS_TOKEN_VERIFIER = Symbol('PLATFORM_ACCESS_TOKEN_VERIFIER');
export const PLATFORM_AUTH_DIAGNOSTICS = Symbol('PLATFORM_AUTH_DIAGNOSTICS');
export const PLATFORM_CLOCK = Symbol('PLATFORM_CLOCK');
const PLATFORM_CAPABILITY = Symbol('PLATFORM_CAPABILITY');
const PLATFORM_PUBLIC = Symbol('PLATFORM_PUBLIC');

export interface AuthenticatedPlatformRequest extends IncomingMessage {
  platformIdentity?: VerifiedPlatformIdentity;
  correlationId?: string;
  /** provisioning request ที่ route resolve แล้ว — ใส่ใน error envelope ได้ (ไม่ใช่กรณี 404) */
  platformRequestId?: string;
}

export type PlatformAuthDenialReason =
  | 'MISSING_BEARER'
  | 'TOKEN_INVALID'
  | PlatformIdentityRejection
  | 'CAPABILITY_NOT_GRANTED'
  | 'ROUTE_UNDECLARED';

export interface PlatformAuthDiagnostic {
  event: 'platform.request.authorized' | 'platform.request.denied';
  correlationId: string;
  reason?: PlatformAuthDenialReason;
  capability?: PlatformCapability;
  /** Keycloak subject (opaque UUID) — ไม่ใช่ email/username */
  subject?: string;
}

export interface PlatformAuthDiagnosticSink {
  write(diagnostic: PlatformAuthDiagnostic): void;
}

export const RequirePlatformCapability = (capability: PlatformCapability) =>
  SetMetadata(PLATFORM_CAPABILITY, capability);
/** เฉพาะ liveness/readiness ที่ไม่คืนข้อมูล control plane */
export const PlatformPublic = () => SetMetadata(PLATFORM_PUBLIC, true);

function requestCorrelationId(request: IncomingMessage): string {
  const supplied = request.headers['x-correlation-id'];
  if (typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied;
  return randomUUID();
}

@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    @Inject(PLATFORM_ACCESS_TOKEN_VERIFIER)
    private readonly verifier: PlatformAccessTokenVerifier,
    @Inject(PLATFORM_AUTH_DIAGNOSTICS)
    private readonly diagnostics: PlatformAuthDiagnosticSink,
    @Inject(PLATFORM_CLOCK)
    private readonly clock: () => Date,
    @Inject(Reflector)
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedPlatformRequest>();
    const response = context.switchToHttp().getResponse<ServerResponse>();
    const correlationId = requestCorrelationId(request);
    request.correlationId = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_PUBLIC, targets) === true) return true;
    const capability = this.reflector.getAllAndOverride<PlatformCapability>(
      PLATFORM_CAPABILITY,
      targets,
    );

    const deny = (reason: PlatformAuthDenialReason, status: 401 | 403, subject?: string): never => {
      this.diagnostics.write({
        event: 'platform.request.denied',
        correlationId,
        reason,
        ...(capability ? { capability } : {}),
        ...(subject ? { subject } : {}),
      });
      throw status === 401 ? new UnauthorizedException() : new ForbiddenException();
    };

    const authorization = request.headers.authorization;
    const accessToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
    if (!accessToken) return deny('MISSING_BEARER', 401);

    let claims: Record<string, unknown>;
    try {
      claims = await this.verifier.verifyAccessToken(accessToken);
    } catch {
      return deny('TOKEN_INVALID', 401);
    }
    let identity: VerifiedPlatformIdentity;
    try {
      identity = toVerifiedPlatformIdentity(claims, this.clock());
    } catch (error) {
      return deny(error instanceof PlatformIdentityError ? error.reason : 'TOKEN_INVALID', 401);
    }
    if (!capability) return deny('ROUTE_UNDECLARED', 403, identity.subject);
    if (!identity.capabilities.includes(capability)) {
      return deny('CAPABILITY_NOT_GRANTED', 403, identity.subject);
    }

    request.platformIdentity = identity;
    this.diagnostics.write({
      event: 'platform.request.authorized',
      correlationId,
      capability,
      subject: identity.subject,
    });
    return true;
  }
}

export interface PlatformErrorEnvelope {
  status: number;
  /** stable machine code — auth ใช้ชุดทั่วไป, domain ใช้ `PlatformProvisioningErrorCode` */
  code: string;
  title: string;
  correlationId: string | null;
  requestId?: string;
  retryable: boolean;
  fieldErrors?: Readonly<Record<string, string>>;
}

const ENVELOPES: Record<number, Pick<PlatformErrorEnvelope, 'code' | 'title'>> = {
  400: { code: 'BAD_REQUEST', title: 'คำขอไม่ถูกต้อง' },
  401: { code: 'UNAUTHENTICATED', title: 'ต้องเข้าสู่ระบบ Platform Console ใหม่' },
  403: { code: 'FORBIDDEN', title: 'ไม่มีสิทธิ์ทำรายการนี้' },
  404: { code: 'NOT_FOUND', title: 'ไม่พบรายการ' },
};

/** #388 checkpoint 1: status + title ที่ปลอดภัยของ domain error แต่ละ code */
const DOMAIN_ERRORS: Record<PlatformProvisioningErrorCode, { status: number; title: string }> = {
  VALIDATION_FAILED: { status: 400, title: 'ข้อมูลไม่ถูกต้อง' },
  NOT_FOUND: { status: 404, title: 'ไม่พบรายการ' },
  TENANT_SLUG_CONFLICT: { status: 409, title: 'slug นี้ถูกใช้แล้ว' },
  TENANT_DOMAIN_CONFLICT: { status: 409, title: 'โดเมนนี้ถูกใช้แล้ว' },
  FIRST_ADMIN_EMAIL_CONFLICT: { status: 409, title: 'อีเมลผู้ดูแลคนแรกถูกใช้แล้ว' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, title: 'Idempotency-Key นี้ใช้กับคำขออื่นแล้ว' },
  REVISION_CONFLICT: { status: 409, title: 'ข้อมูลเปลี่ยนไปแล้ว กรุณาโหลดใหม่' },
  INVALID_STATE_TRANSITION: { status: 409, title: 'สถานะปัจจุบันทำรายการนี้ไม่ได้' },
  BOOTSTRAP_TEMPLATE_UNAVAILABLE: { status: 409, title: 'bootstrap template นี้ใช้ไม่ได้แล้ว' },
  PLAN_UNAVAILABLE: { status: 409, title: 'plan นี้ใช้ไม่ได้แล้ว' },
  PREVIEW_STALE: { status: 409, title: 'ผล preview เก่าแล้ว กรุณา preview ใหม่' },
  RECOVERY_PRECONDITION_FAILED: { status: 409, title: 'เงื่อนไขของรายการนี้ไม่ผ่าน' },
  FIELD_LOCKED: { status: 409, title: 'ข้อมูลนี้แก้ไม่ได้แล้ว' },
  COMMAND_IN_PROGRESS: { status: 409, title: 'มีคำสั่งอื่นของคำขอนี้กำลังทำงาน' },
  INVITATION_RESEND_LIMITED: { status: 429, title: 'ส่งคำเชิญซ้ำเกินจำนวนที่กำหนด' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'ระบบไม่พร้อมชั่วคราว กรุณาลองใหม่' },
};

/** Prisma ต่อ/commit ไม่ได้ = control plane ไม่พร้อม (503) — ไม่ใช่ dependency หลังรับคำขอ */
function databaseUnavailable(exception: unknown): boolean {
  const name = (exception as { name?: string } | null)?.name ?? '';
  const code = (exception as { code?: string } | null)?.code ?? '';
  return (
    name === 'PrismaClientInitializationError' ||
    (name === 'PrismaClientKnownRequestError' &&
      ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(code))
  );
}

/**
 * envelope เดียวกันทุก error — ไม่ส่ง message/stack ของ Nest, raw dependency error หรือเหตุผล
 * ภายในของการปฏิเสธ auth ออกไป (#388 checkpoint 1)
 */
@Catch()
export class PlatformErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<AuthenticatedPlatformRequest>();
    const response = host.switchToHttp().getResponse<ServerResponse>();
    const correlationId = request.correlationId ?? null;
    let body: PlatformErrorEnvelope;
    if (exception instanceof PlatformProvisioningError) {
      const mapped = DOMAIN_ERRORS[exception.code];
      body = {
        status: mapped.status,
        code: exception.code,
        title: mapped.title,
        correlationId,
        ...(request.platformRequestId && mapped.status !== 404
          ? { requestId: request.platformRequestId }
          : {}),
        retryable: mapped.status === 503 || mapped.status === 429,
        ...(exception.fieldErrors ? { fieldErrors: exception.fieldErrors } : {}),
      };
      const retryAfter = (exception as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (mapped.status === 429 && retryAfter)
        response.setHeader('retry-after', String(retryAfter));
    } else if (databaseUnavailable(exception)) {
      body = {
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        title: DOMAIN_ERRORS.SERVICE_UNAVAILABLE.title,
        correlationId,
        retryable: true,
      };
    } else {
      const status = exception instanceof HttpException ? exception.getStatus() : 500;
      const known = ENVELOPES[status];
      body = {
        status: known ? status : 500,
        code: known?.code ?? 'INTERNAL',
        title: known?.title ?? 'เกิดข้อผิดพลาดภายใน',
        correlationId,
        retryable: !known,
      };
    }
    response.statusCode = body.status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify(body));
  }
}
