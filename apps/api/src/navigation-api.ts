/**
 * D1.12 (#451): Navigation API ของ app shell (Phase Contract D1.8 #428, D1.2 #422)
 *
 * - `GET  /api/v1/me/navigation`                แอปที่มองเห็น + หมุดที่มีผล
 * - `PUT  /api/v1/me/navigation/pins`            หมุดของผู้ใช้ (≤15, เฉพาะแอปที่มองเห็น, expectedRevision)
 * - `PUT  /api/v1/tenant/navigation/default-pins` ชุดเริ่มต้นของ tenant (ADMIN เท่านั้น + audit)
 *
 * tenant/actor/role มาจาก bearer token เท่านั้น และทุก query อยู่ใน tenant transaction (RLS, ADR-005)
 * error envelope เดียวกับ API อื่น: `{ code, safeParams? }`
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  MAX_PINS,
  NAVIGATION_APPS,
  NAVIGATION_GROUPS,
  effectivePins,
  pinValidationError,
  tenantAvailableApps,
  visibleApps,
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
  pins: { appIds: string[]; source: PinSource; revision: number };
  /** เฉพาะผู้เรียกที่เป็น ADMIN — ใช้ตั้ง expectedRevision ของชุดเริ่มต้น */
  tenantDefaultPins?: { appIds: string[]; revision: number };
  limits: { maxPins: number };
}

type NavigationErrorCode =
  'REQUEST_MALFORMED' | 'PIN_LIMIT_EXCEEDED' | 'APP_NOT_AVAILABLE' | 'REVISION_CONFLICT';

function fail(code: NavigationErrorCode, status: number, safeParams?: Record<string, unknown>) {
  return new HttpException({ code, ...(safeParams ? { safeParams } : {}) }, status);
}

const APP_ID = /^[a-z][a-z0-9-]{1,47}$/;

/** body เข้มงวด: มีแค่ `appIds` กับ `expectedRevision` */
export function parsePinsBody(body: unknown): { appIds: string[]; expectedRevision: number } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw fail('REQUEST_MALFORMED', 400, { field: 'body' });
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => key !== 'appIds' && key !== 'expectedRevision');
  if (extra) throw fail('REQUEST_MALFORMED', 400, { field: extra });
  const { appIds, expectedRevision } = record;
  // จำกัดขนาดก่อนตรวจรายตัว — 422 เฉพาะความยาวเกินเพดาน ส่วน payload ใหญ่ผิดปกติเป็น 400
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

async function loadEntitlements(tx: Transaction, tenantId: string): Promise<EffectiveEntitlements> {
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
  ) {}

  @Get('me/navigation')
  async navigation(@Req() request: AuthenticatedGatewayRequest): Promise<NavigationV1> {
    const { tenantId, userId, roles } = identityOf(request);
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const entitlements = await loadEntitlements(tx, tenantId);
      const visible = visibleApps({ roles, entitlements }, this.registry);
      const [userRow, tenantRow] = await Promise.all([
        tx.navigationUserPins.findUnique({ where: { tenantId_userId: { tenantId, userId } } }),
        tx.navigationTenantDefaultPins.findUnique({ where: { tenantId } }),
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
        pins: { ...pins, revision: userRow?.revision ?? 0 },
        ...(roles.includes('admin')
          ? {
              tenantDefaultPins: {
                appIds: (tenantRow?.appIds ?? []).filter((id) =>
                  tenantAvailableApps(entitlements, this.registry).some((app) => app.id === id),
                ),
                revision: tenantRow?.revision ?? 0,
              },
            }
          : {}),
        limits: { maxPins: MAX_PINS },
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
        const visible = visibleApps(
          { roles, entitlements: await loadEntitlements(tx, tenantId) },
          this.registry,
        );
        const invalid = pinValidationError(appIds, visible);
        if (invalid === 'PIN_LIMIT_EXCEEDED') throw fail(invalid, 422, { limit: MAX_PINS });
        if (invalid) throw fail(invalid, 422, { field: 'appIds' });

        const revision = expectedRevision + 1;
        if (expectedRevision === 0) {
          // สร้างแถวแรก: ชนกับคำขอพร้อมกันจะได้ unique violation → REVISION_CONFLICT
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
        const available = tenantAvailableApps(await loadEntitlements(tx, tenantId), this.registry);
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
            // อ่านใหม่หลังชน — `before` อาจเก่าถ้า admin อีกคน commit ระหว่างทาง
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
