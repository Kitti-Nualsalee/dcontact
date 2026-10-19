/** HTTP adapter เฉพาะ tests ของ public command engine ไม่ถูก mount จาก runtime entrypoint */
import { Body, Controller, Get, Inject, Post, Req, Res, UseFilters } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { type PrismaClient } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { coreRequestIdentity, TENANT_CORE_DATABASE } from './tenant-core-api.js';
import {
  coreActor,
  coreTransaction,
  executeCoreCommand,
  prepareCoreCommand,
  type CoreCommandOptions,
} from './tenant-core-command.js';
import { coreFail, TenantCoreErrors } from './tenant-core-errors.js';

export const probeHooks = new Map<string, CoreCommandOptions>();
@UseFilters(TenantCoreErrors)
@Controller('api/v1/tenant/core-settings/_test')
@GatewayRoles('admin')
export class CoreCommandProbeController {
  constructor(@Inject(TENANT_CORE_DATABASE) private readonly db: PrismaClient) {}
  @Get('organization')
  async read(@Req() req: AuthenticatedGatewayRequest) {
    const identity = coreRequestIdentity(req);
    return coreTransaction(this.db, identity.tenantId, async (tx) => {
      await coreActor(tx, identity);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: identity.tenantId } });
      const revision = await tx.tenantCoreProfileRevision.findUnique({
        where: { tenantId: identity.tenantId },
      });
      return {
        id: tenant.id,
        displayName: tenant.name,
        revision: revision?.revision.toString() ?? '0',
      };
    });
  }
  @Post('organization')
  async mutate(
    @Req() req: AuthenticatedGatewayRequest,
    @Body() body: Record<string, unknown>,
    @Res() response: ServerResponse,
  ) {
    const identity = coreRequestIdentity(req);
    if (typeof body.displayName !== 'string') coreFail('INVALID_REQUEST', 400);
    const name = body.displayName.trim();
    const command = prepareCoreCommand({
      commandId: body.commandId,
      action: 'ORGANIZATION_UPDATE',
      resourceType: 'ORGANIZATION',
      resourceId: identity.tenantId,
      expectedRevision: body.expectedRevision,
      payload: { displayName: name },
    });
    const result = await executeCoreCommand(
      this.db,
      identity,
      command,
      async (tx) => {
        const locks = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`core-profile:${identity.tenantId}`},0)) AS locked`;
        if (!locks[0]?.locked) coreFail('CONFIG_BUSY', 409, { retryable: true });
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: identity.tenantId } });
        const revision =
          (
            await tx.tenantCoreProfileRevision.findUnique({
              where: { tenantId: identity.tenantId },
            })
          )?.revision ?? 0n;
        if (revision.toString() !== command.expectedRevision)
          coreFail('REVISION_CONFLICT', 409, { currentRevision: revision.toString() });
        if (name.length < 2)
          coreFail('VALIDATION_FAILED', 422, {
            fieldErrors: { displayName: 'core.validation.name' },
          });
        if (tenant.name === name)
          return {
            outcome: 'NO_OP' as const,
            revision,
            snapshot: { id: tenant.id, displayName: name, revision: revision.toString() },
          };
        await tx.tenant.update({ where: { id: identity.tenantId }, data: { name } });
        await tx.tenantCoreProfileRevision.upsert({
          where: { tenantId: identity.tenantId },
          create: { tenantId: identity.tenantId, revision: 1n },
          update: { revision: { increment: 1n } },
        });
        return {
          outcome: 'APPLIED' as const,
          revision: revision + 1n,
          beforeRevision: revision,
          before: { id: tenant.id, displayName: tenant.name, revision: revision.toString() },
          snapshot: { id: tenant.id, displayName: name, revision: (revision + 1n).toString() },
        };
      },
      probeHooks.get(command.commandId),
    );
    response.statusCode = result.status;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify(result.body));
  }
}
