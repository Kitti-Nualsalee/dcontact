/**
 * #1044: the public side of web chat, used by the widget on a tenant's website. No sign-in: the visitor
 * is anonymous, names the tenant and widget in the URL and proves a session with its secret.
 *
 * - `widget.js` (loader on the host page), `frame`, `frame.js`, `frame.css` (the chat itself, in an iframe on
 *   this origin) and `demo` (a page on this origin that embeds the widget, for trying it out).
 * - Where the widget may be embedded is enforced by the browser: `frame` answers `frame-ancestors` with the
 *   widget's allowed origins, and the loader's `embed` check answers CORS only to those origins.
 * - A script can still call these routes directly, so every route is rate limited per address and per widget.
 * - A widget that is off, a missing one and an unknown tenant all answer 404 alike.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { GatewayPublic, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { WebchatError, webchatUuid } from './webchat-errors.js';
import { WebchatRateLimiter } from './webchat-rate-limit.js';
import type { WebchatService } from './webchat-service.js';

export const WEBCHAT_SERVICE = Symbol('WEBCHAT_SERVICE');
export const WEBCHAT_WIDGET_DIR = Symbol('WEBCHAT_WIDGET_DIR');
export const WEBCHAT_LONG_POLL_MS = 25_000;

export function defaultWebchatWidgetDir(): string {
  return (
    process.env.WEBCHAT_WIDGET_DIR ??
    join(dirname(require.resolve('@d-contact/webchat-widget/package.json')), 'dist')
  );
}

/** Turns a web chat failure into the HTTP answer the clients read: `{ code, field? }`. */
export async function webchatMapped<T>(response: ServerResponse | null, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof WebchatError)) throw error;
    if (error.detail.retryAfterSeconds && response)
      response.setHeader('retry-after', String(error.detail.retryAfterSeconds));
    throw new HttpException(
      { code: error.code, ...(error.detail.field ? { field: error.detail.field } : {}) },
      error.status,
    );
  }
}

const ASSETS = {
  'widget.js': 'text/javascript; charset=utf-8',
  'frame.js': 'text/javascript; charset=utf-8',
  'frame.css': 'text/css; charset=utf-8',
  'demo.js': 'text/javascript; charset=utf-8',
} as const;
type AssetName = keyof typeof ASSETS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function clientAddress(request: AuthenticatedGatewayRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || request.socket.remoteAddress || 'unknown';
}

/** Rejects ids that are not UUIDs before anything (like a rate-limit key) is built from them. */
function ids(
  tenantId: string,
  otherId: string,
  otherCode: 'NOT_FOUND' | 'SESSION_INVALID' = 'NOT_FOUND',
) {
  webchatUuid(tenantId);
  webchatUuid(otherId, otherCode);
}

function bearer(authorization: string | undefined): string {
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
}

export function webchatFrameCsp(ancestors: readonly string[] | 'self'): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors === 'self' ? "'self'" : ancestors.length ? ancestors.join(' ') : "'none'"}`,
  ].join('; ');
}

@Controller('api/v1/webchat')
@GatewayPublic()
export class WebchatPublicController {
  private readonly limiter = new WebchatRateLimiter();
  private readonly assets = new Map<AssetName, { body: Buffer; etag: string }>();

  constructor(
    @Inject(WEBCHAT_SERVICE) private readonly webchat: WebchatService,
    @Inject(WEBCHAT_WIDGET_DIR) private readonly widgetDir: string,
  ) {}

  private limit(key: string, limit: number, windowMs = 60_000) {
    const retryAfterSeconds = this.limiter.consume(key, limit, windowMs);
    if (retryAfterSeconds) throw new WebchatError('RATE_LIMITED', { retryAfterSeconds });
  }

  private async asset(name: AssetName) {
    const cached = this.assets.get(name);
    if (cached && process.env.NODE_ENV === 'production') return cached;
    const body = await readFile(join(this.widgetDir, name));
    const loaded = {
      body,
      etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`,
    };
    this.assets.set(name, loaded);
    return loaded;
  }

  private async sendAsset(
    name: AssetName,
    request: AuthenticatedGatewayRequest,
    response: ServerResponse,
  ) {
    let asset: { body: Buffer; etag: string };
    try {
      asset = await this.asset(name);
    } catch {
      response.writeHead(404, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    const headers = {
      'content-type': ASSETS[name],
      // short cache + ETag: a new release reaches every embedding site within minutes
      'cache-control': 'public, max-age=300',
      etag: asset.etag,
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
      ...(name === 'widget.js' ? { 'access-control-allow-origin': '*' } : {}),
    };
    if (request.headers['if-none-match'] === asset.etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, headers);
    response.end(asset.body);
  }

  @Get('widget.js')
  loader(@Req() request: AuthenticatedGatewayRequest, @Res() response: ServerResponse) {
    return this.sendAsset('widget.js', request, response);
  }

  @Get('frame.js')
  frameScript(@Req() request: AuthenticatedGatewayRequest, @Res() response: ServerResponse) {
    return this.sendAsset('frame.js', request, response);
  }

  @Get('frame.css')
  frameStyle(@Req() request: AuthenticatedGatewayRequest, @Res() response: ServerResponse) {
    return this.sendAsset('frame.css', request, response);
  }

  @Get('demo.js')
  demoScript(@Req() request: AuthenticatedGatewayRequest, @Res() response: ServerResponse) {
    return this.sendAsset('demo.js', request, response);
  }

  private async html(
    request: AuthenticatedGatewayRequest,
    response: ServerResponse,
    tenant: unknown,
    widget: unknown,
    page: (
      ids: { tenantId: string; widgetId: string },
      allowedOrigins: string[],
    ) => { csp: string; body: string },
  ) {
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    };
    const notFound = () => {
      response.writeHead(404, { ...headers, 'content-security-policy': webchatFrameCsp([]) });
      response.end();
    };
    if (
      typeof tenant !== 'string' ||
      typeof widget !== 'string' ||
      !UUID.test(tenant) ||
      !UUID.test(widget)
    )
      return notFound();
    try {
      this.limit(`page:${clientAddress(request)}`, 120);
    } catch {
      response.writeHead(429, { ...headers, 'retry-after': '60' });
      response.end();
      return;
    }
    const policy = await this.webchat.embedPolicy(tenant, widget).catch(() => null);
    if (!policy) return notFound();
    const rendered = page(
      { tenantId: tenant.toLowerCase(), widgetId: widget.toLowerCase() },
      policy.allowedOrigins,
    );
    response.writeHead(200, { ...headers, 'content-security-policy': rendered.csp });
    response.end(rendered.body);
  }

  /** The chat document. `preview=1` is the demo page on this origin; otherwise only allowed origins may frame it. */
  @Get('frame')
  frame(
    @Req() request: AuthenticatedGatewayRequest,
    @Res() response: ServerResponse,
    @Query('tenant') tenant: unknown,
    @Query('widget') widget: unknown,
    @Query('preview') preview: unknown,
  ) {
    return this.html(
      request,
      response,
      tenant,
      widget,
      ({ tenantId, widgetId }, allowedOrigins) => ({
        csp: webchatFrameCsp(preview === '1' ? 'self' : allowedOrigins),
        body:
          '<!doctype html><html><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>Chat</title><link rel="stylesheet" href="frame.css"></head><body>' +
          `<div id="dcw-root" data-tenant="${tenantId}" data-widget="${widgetId}" data-preview="${preview === '1' ? '1' : '0'}"></div>` +
          '<script src="frame.js"></script></body></html>',
      }),
    );
  }

  /** A page on this origin that embeds the widget, so an Admin can try it without their own website. */
  @Get('demo')
  demo(
    @Req() request: AuthenticatedGatewayRequest,
    @Res() response: ServerResponse,
    @Query('tenant') tenant: unknown,
    @Query('widget') widget: unknown,
  ) {
    return this.html(request, response, tenant, widget, ({ tenantId, widgetId }) => ({
      csp: [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        "frame-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      body:
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Web chat</title><link rel="stylesheet" href="frame.css"></head>' +
        '<body class="dcw-demo"><main id="dcw-demo"></main><script src="demo.js"></script>' +
        `<script src="widget.js" data-tenant="${tenantId}" data-widget="${widgetId}" data-preview="1"></script>` +
        '</body></html>',
    }));
  }

  /** The loader asks this before drawing anything; CORS is answered only to an allowed origin. */
  @Get('public/:tenantId/:widgetId/embed')
  async embed(
    @Req() request: AuthenticatedGatewayRequest,
    @Res() response: ServerResponse,
    @Param('tenantId') tenantId: string,
    @Param('widgetId') widgetId: string,
  ) {
    const origin = request.headers.origin;
    const headers: Record<string, string> = { 'cache-control': 'no-store', vary: 'Origin' };
    const deny = (status: number) => {
      // drop the API-wide CORS header so no other origin (not even an opaque `null` one) can read the answer
      response.removeHeader('access-control-allow-origin');
      response.writeHead(status, headers);
      response.end();
    };
    if (this.limiter.consume(`embed:${clientAddress(request)}`, 120, 60_000)) return deny(429);
    const policy =
      typeof origin === 'string'
        ? await this.webchat.embedPolicy(tenantId, widgetId).catch(() => null)
        : null;
    if (!policy || typeof origin !== 'string' || !policy.allowedOrigins.includes(origin))
      return deny(404);
    response.writeHead(200, {
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': origin,
    });
    response.end(JSON.stringify({ enabled: true, tenantName: policy.tenantName }));
  }

  @Get('public/:tenantId/:widgetId/bootstrap')
  @Header('Cache-Control', 'no-store')
  bootstrap(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('tenantId') tenantId: string,
    @Param('widgetId') widgetId: string,
  ) {
    return webchatMapped(response, async () => {
      ids(tenantId, widgetId);
      this.limit(`bootstrap:${clientAddress(request)}`, 120);
      return this.webchat.bootstrap(tenantId, widgetId);
    });
  }

  @Post('public/:tenantId/:widgetId/sessions')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  startSession(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('tenantId') tenantId: string,
    @Param('widgetId') widgetId: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return webchatMapped(response, async () => {
      ids(tenantId, widgetId);
      this.limit(`session:${clientAddress(request)}`, 20);
      // A ceiling for the whole widget too, set well above real traffic: it bounds a flood from many
      // addresses without letting a handful of them lock real visitors out.
      this.limit(`session-widget:${tenantId}:${widgetId}`, 600);
      const origin = typeof body?.origin === 'string' ? body.origin : 'unknown';
      return this.webchat.startSession(tenantId, widgetId, { origin, locale: body?.locale });
    });
  }

  @Get('public/:tenantId/sessions/:sessionId')
  @Header('Cache-Control', 'no-store')
  state(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('tenantId') tenantId: string,
    @Param('sessionId') sessionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Query('after') after: unknown,
    @Query('known') known: unknown,
  ) {
    return webchatMapped(response, async () => {
      ids(tenantId, sessionId, 'SESSION_INVALID');
      this.limit(`state:${tenantId}:${sessionId}`, 120);
      const abort = new AbortController();
      request.once('close', () => abort.abort());
      return this.webchat.sessionState(tenantId, sessionId, bearer(authorization), {
        after,
        known,
        waitMs: typeof known === 'string' && known ? WEBCHAT_LONG_POLL_MS : 0,
        signal: abort.signal,
      });
    });
  }

  @Post('public/:tenantId/sessions/:sessionId/messages')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  send(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('tenantId') tenantId: string,
    @Param('sessionId') sessionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    return webchatMapped(response, async () => {
      ids(tenantId, sessionId, 'SESSION_INVALID');
      this.limit(`send:${tenantId}:${sessionId}`, 30);
      this.limit(`send-address:${clientAddress(request)}`, 120);
      return this.webchat.visitorSend(tenantId, sessionId, bearer(authorization), body);
    });
  }

  @Post('public/:tenantId/sessions/:sessionId/end')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  end(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('tenantId') tenantId: string,
    @Param('sessionId') sessionId: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return webchatMapped(response, async () => {
      ids(tenantId, sessionId, 'SESSION_INVALID');
      this.limit(`end:${clientAddress(request)}`, 60);
      return this.webchat.visitorEnd(tenantId, sessionId, bearer(authorization));
    });
  }
}
