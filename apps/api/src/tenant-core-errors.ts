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
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (detail.retryable) response.setHeader('Retry-After', '1');
    const requestId = coreRequestId(request);
    if (requestId) response.setHeader('X-Request-Id', requestId);
    response.end(JSON.stringify({ error: detail, requestId }));
  }
}
