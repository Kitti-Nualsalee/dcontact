/**
 * E1.11 (#485): API ของ allowlist (`/api/v1/tenant/embed-origins`) และ HTML shell `/dphone/embed`
 *
 * - `ADMIN` แก้ได้, `SUPERVISOR` อ่านได้; envelope คงที่ `{ code, field?, reason? }`
 * - shell ส่ง `frame-ancestors` จาก allowlist ของ tenant (ไม่มี = `'none'`) + CSP เข้มงวด + `no-store`
 *   และฝัง allowlist ชุดเดียวกันเป็น JSON ใน document ให้ iframe ล็อก host origin (ไม่รับค่าจาก host)
 * - alias ที่ไม่มีอยู่ตอบเหมือน tenant ที่ปิดการฝัง (ไม่เผยว่ามี tenant ไหนบ้าง)
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { GatewayPublic, GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  EmbedOriginError,
  type EmbedOriginService,
  type EmbedShellPolicy,
} from './embed-origins.js';

export const EMBED_ORIGIN_SERVICE = Symbol('EMBED_ORIGIN_SERVICE');
export const DPHONE_EMBED_SHELL_OPTIONS = Symbol('DPHONE_EMBED_SHELL_OPTIONS');

export interface DphoneEmbedShellOptions {
  /** module entry ของ embed (Vite entry แยกใน apps/workspace) — ไม่ตั้ง = shell ว่าง */
  scriptUrl?: string;
  /** origin เพิ่มเติมของ connect-src (Keycloak, SIP WSS) — runtime ใน E1.13/E1.14 */
  connectSrc?: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALIAS = /^[a-z0-9][a-z0-9-]{0,62}$/i;

function actorOf(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return { tenantId: request.gatewayIdentity.tenantId, userId: request.gatewayIdentity.userId };
}

function idOf(value: string): string {
  if (!UUID.test(value)) throw new EmbedOriginError('NOT_FOUND');
  return value;
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof EmbedOriginError)) throw error;
    const body = { code: error.code, ...(error.field ?? {}) };
    if (error.code === 'VALIDATION_FAILED') throw new BadRequestException(body);
    if (error.code === 'NOT_FOUND') throw new NotFoundException(body);
    if (error.code === 'ENTITLEMENT_REQUIRED') throw new ForbiddenException(body);
    throw new ConflictException(body);
  }
}

@Controller('api/v1/tenant/embed-origins')
export class EmbedOriginsController {
  constructor(@Inject(EMBED_ORIGIN_SERVICE) private readonly origins: EmbedOriginService) {}

  @Get()
  @GatewayRoles('admin', 'supervisor')
  list(@Req() request: AuthenticatedGatewayRequest) {
    return mapped(() => this.origins.list(actorOf(request)));
  }

  @Post()
  @HttpCode(201)
  @GatewayRoles('admin')
  create(@Req() request: AuthenticatedGatewayRequest, @Body() body: Record<string, unknown>) {
    return mapped(() =>
      this.origins.create(
        actorOf(request),
        (body ?? {}) as { origin: unknown; label: unknown },
        request.correlationId ?? 'unavailable',
      ),
    );
  }

  @Patch(':id')
  @GatewayRoles('admin')
  update(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return mapped(() =>
      this.origins.update(
        actorOf(request),
        idOf(id),
        (body ?? {}) as { expectedRevision: unknown },
        request.correlationId ?? 'unavailable',
      ),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @GatewayRoles('admin')
  remove(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return mapped(() =>
      this.origins.remove(
        actorOf(request),
        idOf(id),
        (body ?? {}) as { expectedRevision: unknown },
        request.correlationId ?? 'unavailable',
      ),
    );
  }
}

/** `frame-ancestors` + CSP ของ shell — ไม่มี origin = `'none'` */
export function embedShellHeaders(
  policy: EmbedShellPolicy | null,
  options: DphoneEmbedShellOptions,
  nonce: string,
): Record<string, string> {
  const ancestors = policy?.origins.length ? policy.origins.join(' ') : "'none'";
  const scriptOrigin = options.scriptUrl ? new URL(options.scriptUrl).origin : null;
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'${scriptOrigin ? ` ${scriptOrigin}` : ''}`,
    `style-src 'self'${scriptOrigin ? ` ${scriptOrigin}` : ''}`,
    `connect-src 'self'${(options.connectSrc ?? []).map((origin) => ` ${origin}`).join('')}`,
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin',
  };
}

export function embedShellHtml(
  policy: EmbedShellPolicy | null,
  options: DphoneEmbedShellOptions,
  nonce: string,
): string {
  const config = {
    v: 1,
    tenant: policy?.tenantAlias ?? null,
    allowedHostOrigins: policy?.origins ?? [],
  };
  // JSON ใน <script type="application/json"> — escape `<` กันปิด tag ก่อนเวลา
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const script =
    options.scriptUrl && policy?.origins.length
      ? `<script type="module" nonce="${nonce}" src="${options.scriptUrl}"></script>`
      : '';
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dphone</title>
<script type="application/json" id="dphone-embed-config" nonce="${nonce}">${json}</script>
${script}
</head>
<body><div id="dphone-embed-root"></div></body>
</html>
`;
}

@Controller('dphone/embed')
export class DphoneEmbedController {
  constructor(
    @Inject(EMBED_ORIGIN_SERVICE) private readonly origins: EmbedOriginService,
    @Inject(DPHONE_EMBED_SHELL_OPTIONS) private readonly options: DphoneEmbedShellOptions,
  ) {}

  @Get()
  @GatewayPublic()
  async shell(@Query('tenant') tenant: string | undefined, @Res() response: ServerResponse) {
    const policy =
      typeof tenant === 'string' && ALIAS.test(tenant)
        ? await this.origins.shellPolicy(tenant)
        : null;
    const nonce = randomBytes(16).toString('base64');
    response.writeHead(200, embedShellHeaders(policy, this.options, nonce));
    response.end(embedShellHtml(policy, this.options, nonce));
  }
}
