import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Module, type Type } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims, OidcAccessTokenVerifier } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { TenantCoreSettingsController, TENANT_CORE_DATABASE } from './tenant-core-api.js';
import { TenantVoiceCatalogController, TENANT_VOICE_DATABASE } from './tenant-voice-catalog-api.js';

interface CoreTestBody {
  id: string;
  displayName: string;
  revision: string;
  state: string;
  readbackRequired: boolean;
  requestId: string;
  organization: { read: boolean; write: boolean };
  teamScope: string;
  error: { code: string; retryable: boolean };
  configuration: { reasons: string[] };
  command: {
    id: string;
    outcome: string;
    committedRevision: string | null;
    resourceSnapshot: { id: string; displayName: string; revision: string };
  };
}
export async function coreFixture(
  extraControllers: Type[] = [],
  verifier?: OidcAccessTokenVerifier,
) {
  const owner = new PrismaClient();
  const db = new PrismaClient({
    datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
  });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: { id, name: `Core ${id}`, slug: `core-${id}`, sipDomain: `${id}.core.test` },
    });
  }
  const teamId = randomUUID();
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Core care' } });
  const actors = new Map<string, { id: string; role: string; tenantId: string }>();
  for (const [token, role, scope] of [
    ['admin', 'ADMIN', tenantId],
    ['admin-two', 'ADMIN', tenantId],
    ['supervisor', 'SUPERVISOR', tenantId],
    ['agent', 'AGENT', tenantId],
    ['unbound', 'ADMIN', tenantId],
    ['disabled', 'ADMIN', tenantId],
    ['foreign', 'ADMIN', otherTenantId],
  ] as const) {
    const id = randomUUID();
    await owner.user.create({
      data: {
        id,
        tenantId: scope,
        keycloakId: id,
        role,
        email: `${id}@core.test`,
        displayName: token,
        passwordHash: '!keycloak-managed',
        isActive: token !== 'disabled',
        teamId: scope === tenantId ? teamId : null,
      },
    });
    actors.set(token, { id, role, tenantId: scope });
    if (token !== 'unbound') {
      await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings
        (tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,
         source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active)
        VALUES (${scope}::uuid,${id}::uuid,'https://core-idp.test/realms/dcontact',${id},
        'dcontact-console',${`core-${scope}`},${scope}::uuid,'TENANT_USER','VERIFIED_ENROLLMENT',
        'isolated-core-fixture',${'a'.repeat(64)},'isolated-test-operator',now(),1,true)`;
    }
  }
  const claims = async (
    token: string,
  ): Promise<VerifiedOidcClaims & { iss: string; organization: unknown }> => {
    const actor = actors.get(token);
    if (!actor) throw Error('invalid fixture token');
    return {
      iss: 'https://core-idp.test/realms/dcontact',
      sub: actor.id,
      azp: 'dcontact-console',
      tenant_id: actor.tenantId,
      tenant_slug: `core-${actor.tenantId}`,
      organization: { [`core-${actor.tenantId}`]: { tenant_id: [actor.tenantId] } },
      dc_user_id: actor.id,
      sid: `core-${actor.id}`,
      exp: 2_000_000_000,
      realm_access: { roles: [actor.role.toLowerCase()] },
    };
  };
  @Module({
    controllers: [TenantCoreSettingsController, TenantVoiceCatalogController, ...extraControllers],
    providers: [
      { provide: TENANT_CORE_DATABASE, useValue: db },
      { provide: TENANT_VOICE_DATABASE, useValue: db },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier ?? { verifyAccessToken: claims } },
      {
        provide: TENANT_LIFECYCLE,
        useValue: {
          isActive: async (id: string) =>
            !!(await db.tenant.findFirst({
              where: { id, lifecycleStatus: 'ACTIVE' },
              select: { id: true },
            })),
        },
      },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class CoreTestModule {}
  const app = await NestFactory.create(CoreTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return {
    owner,
    db,
    tenantId,
    otherTenantId,
    teamId,
    actors,
    async request(
      path: string,
      token = 'admin',
      body?: unknown,
      method = body ? 'POST' : 'GET',
      extraHeaders: Record<string, string> = {},
    ) {
      const response = await fetch(`${base}/api/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        headers: { get: (name: string): string | null => response.headers.get(name) },
        body: (await response.json()) as CoreTestBody,
      };
    },
    async close() {
      await app.close();
      await db.$disconnect();
      await owner.$disconnect();
    },
  };
}
