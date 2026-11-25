/**
 * Builds the control plane services from Prisma connected with the `dcontact_platform` role only
 * (#387: the Platform API uses a control-plane-only database role — no access to business data)
 */
import type { PrismaClient } from '@d-contact/db';
import {
  OperatorCommandIntake,
  PlatformCatalog,
  PlatformQueries,
  ProvisioningControlRepository,
  ProvisioningRequestEditor,
} from '@d-contact/platform-control';
import type { PlatformServices } from './provisioning.controller.js';

export function createPlatformServices(
  database: PrismaClient,
  options: { sipBaseDomain: string; now?: () => Date },
): PlatformServices {
  const clock = options.now ? { now: options.now } : {};
  return {
    queries: new PlatformQueries(database),
    intake: new OperatorCommandIntake(database, clock),
    editor: new ProvisioningRequestEditor(database, clock),
    catalog: new PlatformCatalog(database),
    repository: new ProvisioningControlRepository(database, {
      sipBaseDomain: options.sipBaseDomain,
      ...clock,
    }),
  };
}
