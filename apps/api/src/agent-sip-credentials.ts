import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { GatewayPublic } from './gateway-auth.js';

export const AGENT_SIP_CREDENTIALS = Symbol('AGENT_SIP_CREDENTIALS');

export interface AgentSipCredentialLease {
  leaseId: string;
  extension: string;
  authorizationUsername: string;
  authorizationPassword: string;
  sipDomain: string;
  wssUrl: string;
  telephonyNodeId: string;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  expiresAt: string;
}

export interface AgentSipCredentialService {
  issue(input: {
    tenantId: string;
    userId: string;
    workSessionLeaseId: string;
  }): Promise<AgentSipCredentialLease>;
  authenticateDirectoryRequest(authorization: string | undefined): string;
  directory(input: { telephonyNodeId: string; extension: string; sipDomain: string }): Promise<{
    extension: string;
    sipDomain: string;
    a1Hash: string;
    displayName: string;
    workSessionLeaseId: string;
  } | null>;
}

interface BrowserTelephonyNode {
  telephonyNodeId: string;
  wssUrl: string;
  directoryPassword: string;
}

export class DatabaseAgentSipCredentialService implements AgentSipCredentialService {
  private cursor = 0;

  constructor(
    private readonly database: PrismaClient,
    private readonly nodes: readonly BrowserTelephonyNode[],
    private readonly iceServers: AgentSipCredentialLease['iceServers'],
    private readonly now: () => Date = () => new Date(),
    private readonly password: () => string = () => randomBytes(32).toString('base64url'),
  ) {}

  async issue(input: {
    tenantId: string;
    userId: string;
    workSessionLeaseId: string;
  }): Promise<AgentSipCredentialLease> {
    if (this.nodes.length === 0) {
      throw new ServiceUnavailableException('browser telephony nodes are not configured');
    }
    const issuedAt = this.now();
    const authorizationPassword = this.password();
    const issued = await withTenantDatabaseTransaction(
      this.database,
      input.tenantId,
      async (tx) => {
        const lease = await tx.agentWorkSessionLease.findFirst({
          where: {
            id: input.workSessionLeaseId,
            tenantId: input.tenantId,
            userId: input.userId,
            releasedAt: null,
          },
          select: { id: true, expiresAt: true },
        });
        if (!lease) throw new ForbiddenException('work-session lease is not active');
        const busy =
          (await tx.interaction.count({
            where: {
              tenantId: input.tenantId,
              agentId: input.userId,
              state: { in: ['ACTIVE', 'WRAPUP'] },
            },
          })) > 0;
        if (lease.expiresAt <= issuedAt && !busy) {
          throw new ForbiddenException('work-session lease is not active');
        }
        const agent = await tx.user.findFirst({
          where: {
            id: input.userId,
            tenantId: input.tenantId,
            role: 'AGENT',
            isActive: true,
          },
          select: { extension: true, tenant: { select: { sipDomain: true } } },
        });
        if (!agent?.extension) throw new ForbiddenException('agent has no SIP extension');

        const existing = await tx.agentSipCredential.findUnique({
          where: { workSessionLeaseId: lease.id },
          select: { telephonyNodeId: true },
        });
        const node = existing
          ? this.nodes.find((candidate) => candidate.telephonyNodeId === existing.telephonyNodeId)
          : this.nodes[this.cursor++ % this.nodes.length];
        if (!node) throw new ServiceUnavailableException('assigned telephony node is unavailable');
        const a1Hash = digestA1(agent.extension, agent.tenant.sipDomain, authorizationPassword);
        await tx.agentSipCredential.upsert({
          where: { workSessionLeaseId: lease.id },
          create: {
            workSessionLeaseId: lease.id,
            tenantId: input.tenantId,
            userId: input.userId,
            extension: agent.extension,
            sipDomain: agent.tenant.sipDomain,
            telephonyNodeId: node.telephonyNodeId,
            a1Hash,
            issuedAt,
          },
          update: { a1Hash, issuedAt, revokedAt: null },
        });
        return {
          lease,
          extension: agent.extension,
          sipDomain: agent.tenant.sipDomain,
          node,
        };
      },
    );

    return {
      leaseId: issued.lease.id,
      extension: issued.extension,
      authorizationUsername: issued.extension,
      authorizationPassword,
      sipDomain: issued.sipDomain,
      wssUrl: issued.node.wssUrl,
      telephonyNodeId: issued.node.telephonyNodeId,
      iceServers: this.iceServers.map((server) => ({ ...server, urls: [...server.urls] })),
      expiresAt: issued.lease.expiresAt.toISOString(),
    };
  }

  authenticateDirectoryRequest(authorization: string | undefined): string {
    if (!authorization?.startsWith('Basic ')) throw new UnauthorizedException();
    let decoded: string;
    try {
      decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
    } catch {
      throw new UnauthorizedException();
    }
    const separator = decoded.indexOf(':');
    if (separator < 1) throw new UnauthorizedException();
    const telephonyNodeId = decoded.slice(0, separator);
    const suppliedPassword = decoded.slice(separator + 1);
    const node = this.nodes.find((candidate) => candidate.telephonyNodeId === telephonyNodeId);
    if (!node || !sameSecret(suppliedPassword, node.directoryPassword)) {
      throw new UnauthorizedException();
    }
    return node.telephonyNodeId;
  }

  async directory(input: {
    telephonyNodeId: string;
    extension: string;
    sipDomain: string;
  }): Promise<{
    extension: string;
    sipDomain: string;
    a1Hash: string;
    displayName: string;
    workSessionLeaseId: string;
  } | null> {
    const tenant = await this.database.tenant.findUnique({
      where: { sipDomain: input.sipDomain },
      select: { id: true },
    });
    if (!tenant) return null;
    return withTenantDatabaseTransaction(this.database, tenant.id, async (tx) => {
      const credential = await tx.agentSipCredential.findFirst({
        where: {
          tenantId: tenant.id,
          extension: input.extension,
          sipDomain: input.sipDomain,
          telephonyNodeId: input.telephonyNodeId,
          revokedAt: null,
          user: { isActive: true, role: 'AGENT' },
          workSessionLease: { releasedAt: null },
        },
        select: {
          a1Hash: true,
          workSessionLeaseId: true,
          workSessionLease: { select: { expiresAt: true, userId: true } },
          user: { select: { displayName: true } },
        },
      });
      if (!credential) return null;
      const busy =
        (await tx.interaction.count({
          where: {
            tenantId: tenant.id,
            agentId: credential.workSessionLease.userId,
            state: { in: ['ACTIVE', 'WRAPUP'] },
          },
        })) > 0;
      if (credential.workSessionLease.expiresAt <= this.now() && !busy) return null;
      return {
        extension: input.extension,
        sipDomain: input.sipDomain,
        a1Hash: credential.a1Hash,
        displayName: credential.user.displayName,
        workSessionLeaseId: credential.workSessionLeaseId,
      };
    });
  }
}

export function configuredAgentSipCredentialService(
  database: PrismaClient,
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseAgentSipCredentialService {
  if (environment.NODE_ENV === 'production' && environment.SIP_BROWSER_FIXED_PASSWORD) {
    throw new Error('SIP_BROWSER_FIXED_PASSWORD is forbidden in production');
  }
  const directoryPassword =
    environment.FREESWITCH_DIRECTORY_PASSWORD ??
    (environment.NODE_ENV === 'production' ? undefined : 'dcontact-xml-curl-dev-only');
  const nodes = parseJson<
    Array<Omit<BrowserTelephonyNode, 'directoryPassword'> & { directoryPassword?: string }>
  >(environment.SIP_BROWSER_NODES_JSON, []).map((node) => ({
    ...node,
    directoryPassword: node.directoryPassword ?? directoryPassword ?? '',
  }));
  const iceServers = parseJson<AgentSipCredentialLease['iceServers']>(
    environment.SIP_ICE_SERVERS_JSON,
    [],
  );
  if (
    !nodes.every(
      (node) =>
        typeof node.telephonyNodeId === 'string' &&
        /^[A-Za-z0-9_.-]{1,128}$/.test(node.telephonyNodeId) &&
        typeof node.wssUrl === 'string' &&
        isBrowserSipWebSocketUrl(node.wssUrl) &&
        typeof node.directoryPassword === 'string' &&
        node.directoryPassword.length >= 16,
    )
  ) {
    throw new Error(
      'SIP_BROWSER_NODES_JSON requires telephonyNodeId, browser WebSocket URL and directoryPassword (at least 16 characters)',
    );
  }
  const fixedPassword = environment.SIP_BROWSER_FIXED_PASSWORD;
  return new DatabaseAgentSipCredentialService(
    database,
    nodes,
    iceServers,
    () => new Date(),
    fixedPassword ? () => fixedPassword : undefined,
  );
}

@Controller('internal/v1/freeswitch')
export class FreeSwitchDirectoryController {
  constructor(
    @Inject(AGENT_SIP_CREDENTIALS) private readonly credentials: AgentSipCredentialService,
  ) {}

  @Post('directory')
  @GatewayPublic()
  async directory(
    @Req() request: IncomingMessage,
    @Body() body: Record<string, unknown>,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const telephonyNodeId = this.credentials.authenticateDirectoryRequest(
      typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
    );
    const extension = typeof body.user === 'string' ? body.user : undefined;
    const sipDomain = typeof body.domain === 'string' ? body.domain : undefined;
    const found =
      body.section === 'directory' && extension && sipDomain
        ? await this.credentials.directory({ telephonyNodeId, extension, sipDomain })
        : null;
    response.writeHead(200, {
      'content-type': 'text/xml; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(found ? directoryXml(found) : DIRECTORY_NOT_FOUND_XML);
  }
}

const DIRECTORY_NOT_FOUND_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<document type="freeswitch/xml"><section name="result"><result status="not found"/></section></document>`;

function directoryXml(input: {
  extension: string;
  sipDomain: string;
  a1Hash: string;
  displayName: string;
  workSessionLeaseId: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<document type="freeswitch/xml"><section name="directory"><domain name="${xml(input.sipDomain)}"><params><param name="dial-string" value="{^^:sip_invite_domain=\${dialed_domain}:presence_id=\${dialed_user}@\${dialed_domain}}\${sofia_contact(*/\${dialed_user}@\${dialed_domain})}"/></params><groups><group name="default"><users><user id="${xml(input.extension)}"><params><param name="a1-hash" value="${input.a1Hash}"/></params><variables><variable name="user_context" value="default"/><variable name="effective_caller_id_name" value="${xml(input.displayName)}"/><variable name="effective_caller_id_number" value="${xml(input.extension)}"/><variable name="dcontact_work_session_lease_id" value="${xml(input.workSessionLeaseId)}"/></variables></user></users></group></groups></domain></section></document>`;
}

function digestA1(username: string, realm: string, password: string): string {
  return createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
}

function sameSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function isBrowserSipWebSocketUrl(value: string): boolean {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol === 'wss:') return true;
    return (
      endpoint.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
}
