import { findTenantConfigurationActor } from './tenant-config-identity.js';
import { findCatalogActor } from './tenant-voice-catalog.js';
import { voiceCatalogCaller, type VoiceCaller } from './tenant-voice-identity.js';
/**
 * D1.12 (#451): the Navigation API of the app shell (Phase Contract D1.8 #428, D1.2 #422)
 *
 * - `GET  /api/v1/me/navigation`                the visible apps + the effective pins
 * - `PUT  /api/v1/me/navigation/pins`            the user's pins (≤15, only visible apps, expectedRevision)
 * - `PUT  /api/v1/tenant/navigation/default-pins` the tenant's starter set (ADMIN only + audit)
 *
 * tenant/actor/role come only from the bearer token and every query runs in a tenant transaction (RLS, ADR-005)
 * the same error envelope as other APIs: `{ code, safeParams? }`
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { findActiveAgent } from './active-agent.js';
import {
  CUSTOMER_360_TAG_RUNTIME,
  type C360TagCatalogRuntime,
} from './customer-360-tag-runtime.js';
import {
  MAX_PINS,
  NAVIGATION_APPS,
  NAVIGATION_GROUPS,
  effectivePins,
  pinValidationError,
  tenantAvailableApps,
  visibleApps,
  visibleAreas,
  type EffectiveEntitlements,
  type NavigationAppDefinition,
  type NavigationHostApp,
  type PinSource,
} from './navigation-registry.js';

export const NAVIGATION_DATABASE = Symbol('NAVIGATION_DATABASE');
export const NAVIGATION_REGISTRY = Symbol('NAVIGATION_REGISTRY');

export interface NavigationV1 {
  groups: { id: string; labelKey: string }[];
  apps: {
    id: string;
    groupId: string;
    labelKey: string;
    hostApp: NavigationHostApp;
    path: string;
  }[];
  /** #651: work areas on the rail + submenu (items refer to apps by `appId` in `apps`) — already filtered by role/plan, empty areas are not sent */
  areas: {
    id: string;
    labelKey: string;
    sections: {
      id: string;
      labelKey: string;
      items: { appId: string; pages?: { id: string; labelKey: string; path: string }[] }[];
    }[];
  }[];
  pins: { appIds: string[]; source: PinSource; revision: number };
  /** only for callers who are ADMIN — used to set expectedRevision of the starter set */
  tenantDefaultPins?: { appIds: string[]; revision: number };
  limits: { maxPins: number };
  /** D1.13 (#452): a tenant-level UI flag — the platform operator changes it; read only when the page loads */
  features: { shellV2: boolean };
}

export const SHELL_V2_FLAG = 'ui.shell.v2';

type NavigationErrorCode =
  'REQUEST_MALFORMED' | 'PIN_LIMIT_EXCEEDED' | 'APP_NOT_AVAILABLE' | 'REVISION_CONFLICT';

function fail(code: NavigationErrorCode, status: number, safeParams?: Record<string, unknown>) {
  return new HttpException({ code, ...(safeParams ? { safeParams } : {}) }, status);
}

const APP_ID = /^[a-z][a-z0-9-]{1,47}$/;

/** a strict body: only `appIds` and `expectedRevision` */
export function parsePinsBody(body: unknown): { appIds: string[]; expectedRevision: number } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw fail('REQUEST_MALFORMED', 400, { field: 'body' });
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => key !== 'appIds' && key !== 'expectedRevision');
  if (extra) throw fail('REQUEST_MALFORMED', 400, { field: extra });
  const { appIds, expectedRevision } = record;
  // limit the size before per-item checks — 422 only for a length over the cap, while an abnormally large payload is 400
  if (
    !Array.isArray(appIds) ||
    appIds.length > 256 ||
    !appIds.every((id) => typeof id === 'string' && APP_ID.test(id)) ||
    new Set(appIds).size !== appIds.length
  ) {
    throw fail('REQUEST_MALFORMED', 400, { field: 'appIds' });
  }
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw fail('REQUEST_MALFORMED', 400, { field: 'expectedRevision' });
  }
  return { appIds: appIds as string[], expectedRevision };
}

function identityOf(request: AuthenticatedGatewayRequest) {
  const identity = request.gatewayIdentity;
  if (!identity) throw new UnauthorizedException();
  return identity;
}

type Transaction = Prisma.TransactionClient;

const M1_APPS = new Set([
  'customer-tags',
  'customer-overview',
  'customer-rules',
  'customer-activity',
]);

async function domainVisibleApps(
  tx: Transaction,
  actor: { tenantId: string; userId: string; roles: readonly string[] },
  entitlements: EffectiveEntitlements,
  registry: readonly NavigationAppDefinition[],
  caller?: VoiceCaller,
) {
  let apps = visibleApps({ roles: actor.roles, entitlements }, registry);
  if (apps.some((app) => app.id === 'voice-routing')) {
    const allowed = await findCatalogActor(tx, { ...actor, caller });
    if (!allowed) apps = apps.filter((app) => app.id !== 'voice-routing');
  }
  if (
    apps.some((app) => app.id === 'core-settings') &&
    !(await findTenantConfigurationActor(tx, { ...actor, caller }))
  )
    apps = apps.filter((app) => app.id !== 'core-settings');
  if (
    apps.some((app) => M1_APPS.has(app.id)) &&
    (await findTenantConfigurationActor(tx, { ...actor, caller }))?.role !== 'ADMIN'
  )
    apps = apps.filter((app) => !M1_APPS.has(app.id));
  if (!apps.some((app) => app.id === 'agent-history')) return apps;
  const agent = await findActiveAgent(tx, actor);
  return agent ? apps : apps.filter((app) => app.id !== 'agent-history');
}

export async function loadEntitlements(
  tx: Transaction,
  tenantId: string,
): Promise<EffectiveEntitlements> {
  const binding = await tx.tenantPlanBinding.findUnique({
    where: { tenantId },
    select: { entitlements: true },
  });
  if (!binding) return null;
  const value = binding.entitlements;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Controller('api/v1')
export class NavigationController {
  constructor(
    @Inject(NAVIGATION_DATABASE) private readonly database: PrismaClient,
    @Inject(NAVIGATION_REGISTRY) private readonly registry: readonly NavigationAppDefinition[],
    @Optional()
    @Inject(CUSTOMER_360_TAG_RUNTIME)
    private readonly tagRuntime?: C360TagCatalogRuntime,
  ) {}

  private get availableRegistry() {
    return this.tagRuntime?.ready
      ? this.registry
      : this.registry.filter((app) => !M1_APPS.has(app.id));
  }

  @Get('me/navigation')
  async navigation(@Req() request: AuthenticatedGatewayRequest): Promise<NavigationV1> {
    const { tenantId, userId, roles } = identityOf(request);
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const entitlements = await loadEntitlements(tx, tenantId);
      const visible = await domainVisibleApps(
        tx,
        { tenantId, userId, roles },
        entitlements,
        this.availableRegistry,
        voiceCatalogCaller(request),
      );
      const [userRow, tenantRow, shellFlag] = await Promise.all([
        tx.navigationUserPins.findUnique({ where: { tenantId_userId: { tenantId, userId } } }),
        tx.navigationTenantDefaultPins.findUnique({ where: { tenantId } }),
        tx.tenantUiFlag.findUnique({
          where: { tenantId_flagKey: { tenantId, flagKey: SHELL_V2_FLAG } },
          select: { enabled: true },
        }),
      ]);
      const pins = effectivePins({
        visible,
        userPins: userRow?.appIds ?? null,
        tenantPins: tenantRow?.appIds ?? null,
      });
      const usedGroups = new Set(visible.map((app) => app.group));
      return {
        groups: NAVIGATION_GROUPS.filter((id) => usedGroups.has(id)).map((id) => ({
          id,
          labelKey: `navigation.groups.${id}`,
        })),
        apps: visible.map((app) => ({
          id: app.id,
          groupId: app.group,
          labelKey: app.labelKey,
          hostApp: app.hostApp,
          path: app.path,
        })),
        areas: visibleAreas(visible).map((area) => ({
          id: area.id,
          labelKey: `navigation.areas.${area.id}`,
          sections: area.sections.map((section) => ({
            id: section.id,
            labelKey: `navigation.sections.${section.id}`,
            items: section.items,
          })),
        })),
        pins: { ...pins, revision: userRow?.revision ?? 0 },
        ...(roles.includes('admin')
          ? {
              tenantDefaultPins: {
                appIds: (tenantRow?.appIds ?? []).filter((id) =>
                  tenantAvailableApps(entitlements, this.availableRegistry).some(
                    (app) => app.id === id,
                  ),
                ),
                revision: tenantRow?.revision ?? 0,
              },
            }
          : {}),
        limits: { maxPins: MAX_PINS },
        // no row = off (Phase Contract: the flag is off by default)
        features: { shellV2: shellFlag?.enabled === true },
      };
    });
  }

  @Put('me/navigation/pins')
  @HttpCode(200)
  async putUserPins(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const { tenantId, userId, roles } = identityOf(request);
    const { appIds, expectedRevision } = parsePinsBody(body);
    try {
      return await withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
        const visible = await domainVisibleApps(
          tx,
          { tenantId, userId, roles },
          await loadEntitlements(tx, tenantId),
          this.availableRegistry,
          voiceCatalogCaller(request),
        );
        const invalid = pinValidationError(appIds, visible);
        if (invalid === 'PIN_LIMIT_EXCEEDED') throw fail(invalid, 422, { limit: MAX_PINS });
        if (invalid) throw fail(invalid, 422, { field: 'appIds' });

        const revision = expectedRevision + 1;
        if (expectedRevision === 0) {
          // create the first row: colliding with a concurrent request gets a unique violation → REVISION_CONFLICT
          await tx.navigationUserPins.create({ data: { tenantId, userId, appIds, revision } });
        } else {
          const updated = await tx.navigationUserPins.updateMany({
            where: { tenantId, userId, revision: expectedRevision },
            data: { appIds, revision, updatedAt: new Date() },
          });
          if (updated.count === 0) {
            const current = await tx.navigationUserPins.findUnique({
              where: { tenantId_userId: { tenantId, userId } },
              select: { revision: true },
            });
            throw fail('REVISION_CONFLICT', 409, { currentRevision: current?.revision ?? 0 });
          }
        }
        return { appIds, revision };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw await this.userConflict(tenantId, userId);
      throw error;
    }
  }

  @Put('tenant/navigation/default-pins')
  @GatewayRoles('admin')
  @HttpCode(200)
  async putTenantDefaultPins(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const { tenantId, userId } = identityOf(request);
    const { appIds, expectedRevision } = parsePinsBody(body);
    try {
      return await withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
        const available = tenantAvailableApps(
          await loadEntitlements(tx, tenantId),
          this.availableRegistry,
        );
        const invalid = pinValidationError(appIds, available);
        if (invalid === 'PIN_LIMIT_EXCEEDED') throw fail(invalid, 422, { limit: MAX_PINS });
        if (invalid) throw fail(invalid, 422, { field: 'appIds' });

        const revision = expectedRevision + 1;
        const before = await tx.navigationTenantDefaultPins.findUnique({ where: { tenantId } });
        if (expectedRevision === 0) {
          await tx.navigationTenantDefaultPins.create({
            data: { tenantId, appIds, revision, updatedByUserId: userId },
          });
        } else {
          const updated = await tx.navigationTenantDefaultPins.updateMany({
            where: { tenantId, revision: expectedRevision },
            data: { appIds, revision, updatedByUserId: userId, updatedAt: new Date() },
          });
          if (updated.count === 0) {
            // read again after a collision — `before` may be stale if another admin committed in the meantime
            const current = await tx.navigationTenantDefaultPins.findUnique({
              where: { tenantId },
              select: { revision: true },
            });
            throw fail('REVISION_CONFLICT', 409, { currentRevision: current?.revision ?? 0 });
          }
        }
        await tx.navigationAuditEvent.create({
          data: {
            tenantId,
            actorUserId: userId,
            action: 'TENANT_DEFAULT_PINS_UPDATED',
            details: { beforeAppIds: before?.appIds ?? null, afterAppIds: appIds, revision },
            correlationId: request.correlationId ?? 'unknown',
          },
        });
        return { appIds, revision };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw await this.tenantConflict(tenantId);
      throw error;
    }
  }

  private async userConflict(tenantId: string, userId: string) {
    const current = await withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
      tx.navigationUserPins.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { revision: true },
      }),
    );
    return fail('REVISION_CONFLICT', 409, { currentRevision: current?.revision ?? 0 });
  }

  private async tenantConflict(tenantId: string) {
    const current = await withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
      tx.navigationTenantDefaultPins.findUnique({
        where: { tenantId },
        select: { revision: true },
      }),
    );
    return fail('REVISION_CONFLICT', 409, { currentRevision: current?.revision ?? 0 });
  }
}

export const NAVIGATION_REGISTRY_PROVIDER = {
  provide: NAVIGATION_REGISTRY,
  useValue: NAVIGATION_APPS,
};
