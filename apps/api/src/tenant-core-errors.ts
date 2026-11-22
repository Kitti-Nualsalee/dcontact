import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';

export function coreRequestId(request: AuthenticatedGatewayRequest): string | undefined {
  const supplied = request.headers['x-request-id'];
  return typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)
    ? supplied
    : request.correlationId;
}

export interface CoreErrorDetail {
  code: string;
  messageKey: string;
  retryable: boolean;
  fieldErrors?: Record<string, string>;
  currentRevision?: string;
  blockers?: { kind: string; count: number }[];
}
export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly detail: CoreErrorDetail,
  ) {
    super(detail.code);
  }
}
export function coreFail(
  code: string,
  status: number,
  extra: Partial<CoreErrorDetail> = {},
): never {
  throw new CoreError(status, {
    code,
    messageKey: `core.errors.${code}`,
    retryable: false,
    ...extra,
  });
}
/**
 * รหัสสำหรับ log ของ error ที่ไม่คาดไว้: Prisma code, SQLSTATE และรหัส EXCEPTION ของ trigger
 * (เช่น `CORE_TEAM_EFFECT_RECEIPT_REQUIRED`) เฉพาะเมื่อข้อความเป็นรหัสตัวพิมพ์ใหญ่ล้วน — ไม่คืนข้อความอิสระ
 */
export function unexpectedErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as { code?: unknown; meta?: { code?: unknown; message?: unknown } };
  const parts = [e.code, e.meta?.code].filter(
    (part): part is string => typeof part === 'string' && /^[A-Z0-9]{1,10}$/.test(part),
  );
  const raised =
    typeof e.meta?.message === 'string'
      ? /^ERROR:\s+([A-Z][A-Z0-9_]{2,80})$/.exec(e.meta.message)?.[1]
      : undefined;
  if (raised) parts.push(raised);
  return parts.length ? parts.join(':') : null;
}
export function coreBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; meta?: { code?: string } };
  return (
    ['55P03', '57014', '40P01', 'P2028', 'P2034'].includes(e.code ?? '') ||
    ['55P03', '57014', '40P01'].includes(e.meta?.code ?? '')
  );
}
@Catch()
export class TenantCoreErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<AuthenticatedGatewayRequest>();
    const response = host.switchToHttp().getResponse<ServerResponse>();
    let status = 500;
    let detail: CoreErrorDetail = {
      code: 'REQUEST_FAILED',
      messageKey: 'core.errors.REQUEST_FAILED',
      retryable: true,
    };
    if (error instanceof CoreError) {
      status = error.status;
      detail = error.detail;
    } else if (coreBusy(error)) {
      status = 409;
      detail = { code: 'CONFIG_BUSY', messageKey: 'core.errors.CONFIG_BUSY', retryable: true };
    } else if (error instanceof HttpException && [401, 403].includes(error.getStatus())) {
      status = error.getStatus();
      detail = {
        code: 'CORE_ACCESS_DENIED',
        messageKey: 'core.errors.CORE_ACCESS_DENIED',
        retryable: false,
      };
    }
    // 500 เดิมไม่มี log เลย จึงหาสาเหตุไม่ได้ (#977) — บันทึกเฉพาะชนิดและรหัส ไม่บันทึกข้อความที่อาจมีข้อมูลผู้ใช้
    if (status === 500)
      console.error(
        JSON.stringify({
          event: 'tenant_core.request_failed',
          requestId: coreRequestId(request) ?? null,
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode: unexpectedErrorCode(error),
        }),
      );
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (detail.retryable) response.setHeader('Retry-After', '1');
    const requestId = coreRequestId(request);
    if (requestId) response.setHeader('X-Request-Id', requestId);
    response.end(JSON.stringify({ error: detail, requestId }));
  }
}
